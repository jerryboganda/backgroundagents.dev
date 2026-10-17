"""Session-context start: the authenticated boot of a VPS sandbox.

The executor creates the sandbox dormant (``OI_DEFERRED_START=true``, so the entrypoint holds the container open),
then execs the entrypoint once more with ``SESSION_CONTEXT_START_ARGUMENT`` and writes one JSON line to its stdin.
That line is the session environment. It reaches the runtime through this process's memory and its children's
environment only: never the container's configuration, never a file, never a command line.

The runtime writes ``SESSION_CONTEXT_ACCEPTED_LINE`` to stdout once the context is validated, composed, and the
supervisor is built. That line is the only proof the executor takes that a supervisor started. Every rejection exits
non-zero before it, and reason codes never quote the payload.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import signal
import sys
from dataclasses import dataclass
from typing import TYPE_CHECKING, Protocol

from .constants import DOCKER_ENABLED_ENV_VAR
from .image_build_context_start import DEFERRED_START_ENV_VAR
from .log_config import get_logger
from .runtime_config import RuntimeConfig

if TYPE_CHECKING:
    from collections.abc import Callable, Mapping, MutableMapping

SESSION_CONTEXT_START_ARGUMENT = "--session-context-stdin-v1"
SESSION_CONTEXT_VERSION = 1
SESSION_CONTEXT_ACCEPTED_LINE = "open-inspect:session-context:accepted"
#: Largest accepted context line, newline excluded. The executor bounds its own frame below this.
MAX_SESSION_CONTEXT_BYTES = 256 * 1024
MAX_SESSION_ENV_ENTRIES = 256
MAX_SESSION_ENV_VALUE_BYTES = 64 * 1024
#: One launch per container. The exclusive create is the whole mechanism, so a redelivered launch cannot start a
#: second supervisor over the first one's workspace.
SESSION_CONTEXT_LAUNCH_GUARD_PATH = "/tmp/oi-session-context.launched"

_SANDBOX_ID_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$")
_ENV_KEY_PATTERN = re.compile(r"^[A-Z][A-Z0-9_]{0,127}$")
_REQUIRED_ENV_KEYS = ("CONTROL_PLANE_URL", "SANDBOX_AUTH_TOKEN")

#: Keys the runtime owns. This mirrors the executor's refusal list in session-context.ts. A context that carries one
#: is refused, so no session can choose its boot mode, enable nested Docker or tunnels, or stay dormant.
RESERVED_SESSION_ENV_KEYS: frozenset[str] = frozenset(
    {
        DEFERRED_START_ENV_VAR,
        DOCKER_ENABLED_ENV_VAR,
        "EXPECTED_TUNNEL_PORTS",
        "IMAGE_BUILD_MODE",
        "RESTORED_FROM_SNAPSHOT",
        "FROM_REPO_IMAGE",
        "REPO_IMAGE_SHA",
        "OPENINSPECT_BOOT_MODE",
        "HOME",
        "PATH",
        "PYTHONPATH",
    }
)


class SessionContextStartCancelled(Exception):
    """Shutdown won while the sandbox waited for its session context."""


class SessionContextError(ValueError):
    """The session context is unusable. Its message is a fixed reason code, never the payload."""


class SessionSupervisor(Protocol):
    """Supervisor surface the session start needs."""

    async def run(self) -> object: ...


@dataclass(frozen=True)
class SessionContext:
    """One validated session context: the identity it binds, and the environment it lays down."""

    sandbox_id: str
    session_id: str
    env: Mapping[str, str]


def parse_session_context(raw: bytes) -> SessionContext:
    """Validate one context line. Raises SessionContextError on anything else."""
    try:
        payload = json.loads(raw.decode("utf-8"))
    except UnicodeDecodeError as error:
        raise SessionContextError("invalid_encoding") from error
    except ValueError as error:
        raise SessionContextError("invalid_json") from error
    if not isinstance(payload, dict):
        raise SessionContextError("invalid_context")
    if payload.get("version") != SESSION_CONTEXT_VERSION:
        raise SessionContextError("unsupported_version")

    sandbox_id = payload.get("sandbox_id")
    if not isinstance(sandbox_id, str) or not _SANDBOX_ID_PATTERN.fullmatch(sandbox_id):
        raise SessionContextError("invalid_field:sandbox_id")
    session_id = payload.get("session_id")
    if not isinstance(session_id, str) or not 0 < len(session_id) <= 256:
        raise SessionContextError("invalid_field:session_id")
    return SessionContext(
        sandbox_id=sandbox_id, session_id=session_id, env=_session_env(payload.get("env"))
    )


def _session_env(value: object) -> dict[str, str]:
    if not isinstance(value, dict) or len(value) > MAX_SESSION_ENV_ENTRIES:
        raise SessionContextError("invalid_field:env")
    env: dict[str, str] = {}
    for key, item in value.items():
        if not isinstance(key, str) or not _ENV_KEY_PATTERN.fullmatch(key):
            raise SessionContextError("invalid_field:env")
        if key in RESERVED_SESSION_ENV_KEYS:
            raise SessionContextError("reserved_env_key")
        if not isinstance(item, str) or len(item.encode("utf-8")) > MAX_SESSION_ENV_VALUE_BYTES:
            raise SessionContextError("invalid_field:env")
        env[key] = item
    return env


def validate_session_context(context: SessionContext) -> None:
    """The runtime's own check of the session: RuntimeConfig parses it, and it must name the context's identity."""
    if context.env.get("SANDBOX_ID") != context.sandbox_id:
        raise SessionContextError("sandbox_mismatch")
    for key in _REQUIRED_ENV_KEYS:
        if not context.env.get(key):
            raise SessionContextError(f"missing_field:{key}")
    try:
        config = RuntimeConfig.from_env(context.env)
    except ValueError as error:
        raise SessionContextError("invalid_session_config") from error
    if config.session_id != context.session_id:
        raise SessionContextError("session_mismatch")


def compose_session_environment(
    context: SessionContext, environment: MutableMapping[str, str]
) -> None:
    """Lay the session's environment down over the container's own.

    The deferred marker is removed, so the runtime boots as a session rather than as a holding container. Nothing else
    the container carries is removed: the image's own paths are the runtime's to keep.
    """
    environment.pop(DEFERRED_START_ENV_VAR, None)
    environment.update(context.env)


async def run_session_context_start[SupervisorT: SessionSupervisor](
    build_supervisor: Callable[[asyncio.Event], SupervisorT],
    install_signal_handlers: Callable[[SupervisorT], None],
) -> int:
    """Read one session context, compose the environment, and run the session it describes.

    The supervisor is built only after the environment is composed, so it reads the session's configuration. The
    acceptance line is written after the supervisor is built and before it runs, so the executor counts an
    acceptance as a started supervisor. Every rejection returns 1 before that line.
    """
    log = get_logger("session_context_start")
    shutdown_event = asyncio.Event()
    _install_shutdown_handlers(shutdown_event)

    try:
        guard_fd = _claim_launch_guard()
    except SessionContextError as error:
        log.error("session_context.launch_failed", reason=str(error))
        return 1

    transport: asyncio.ReadTransport | None = None
    try:
        reader, transport = await _connect_stdin_reader()
        context = parse_session_context(await _read_context_line(reader, shutdown_event))
        validate_session_context(context)
    except SessionContextStartCancelled:
        log.info("session_context.launch_cancelled")
        return 0
    except SessionContextError as error:
        log.error("session_context.launch_failed", reason=str(error))
        return 1
    finally:
        os.close(guard_fd)
        if transport is not None:
            transport.close()
            _detach_stdin()

    compose_session_environment(context, os.environ)
    supervisor = build_supervisor(shutdown_event)
    install_signal_handlers(supervisor)
    sys.stdout.write(f"{SESSION_CONTEXT_ACCEPTED_LINE}\n")
    sys.stdout.flush()
    log.info(
        "session_context.accepted", sandbox_id=context.sandbox_id, session_id=context.session_id
    )
    await supervisor.run()
    return 0


def _install_shutdown_handlers(shutdown_event: asyncio.Event) -> None:
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, shutdown_event.set)


def _detach_stdin() -> None:
    """Point fd 0 at /dev/null once the stdin transport is closed.

    Closing the transport may free descriptor 0, and the next open would take that number, so a child that inherits
    stdin would read that file. No await runs between the close and this call. A failure propagates, so the launch
    exits non-zero instead of continuing with an unowned stdin.
    """
    devnull_fd = os.open(os.devnull, os.O_RDONLY)
    try:
        os.dup2(devnull_fd, 0)
    finally:
        os.close(devnull_fd)


def _claim_launch_guard() -> int:
    try:
        return os.open(
            SESSION_CONTEXT_LAUNCH_GUARD_PATH, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o600
        )
    except FileExistsError as error:
        raise SessionContextError("duplicate_launch") from error


async def _connect_stdin_reader() -> tuple[asyncio.StreamReader, asyncio.ReadTransport]:
    """Attach a bounded asyncio reader to this process's stdin."""
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=MAX_SESSION_CONTEXT_BYTES + 1)
    protocol = asyncio.StreamReaderProtocol(reader)
    transport, _ = await loop.connect_read_pipe(lambda: protocol, sys.stdin.buffer)
    return reader, transport


async def _read_context_line(reader: asyncio.StreamReader, shutdown_event: asyncio.Event) -> bytes:
    """Read the one newline-terminated context line, or give up on shutdown."""
    read_task = asyncio.create_task(reader.readline())
    shutdown_task = asyncio.create_task(shutdown_event.wait())
    tasks = {read_task, shutdown_task}
    try:
        done, _pending = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    if read_task not in done:
        raise SessionContextStartCancelled
    try:
        raw = read_task.result()
    except ValueError as error:
        raise SessionContextError("oversized_context") from error
    if not raw:
        raise SessionContextError("stdin_closed")
    if not raw.endswith(b"\n"):
        raise SessionContextError("incomplete_context")
    if len(raw) > MAX_SESSION_CONTEXT_BYTES + 1:
        raise SessionContextError("oversized_context")
    return raw[:-1]
