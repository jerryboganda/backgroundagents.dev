"""Session-context start: the runtime side of the executor's stdin launch."""

from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path

import pytest

from sandbox_runtime import entrypoint, session_context_start
from sandbox_runtime.image_build_context_start import DEFERRED_START_ENV_VAR
from sandbox_runtime.session_context_start import (
    MAX_SESSION_CONTEXT_BYTES,
    SESSION_CONTEXT_ACCEPTED_LINE,
    SESSION_CONTEXT_START_ARGUMENT,
    SessionContextError,
    SessionContextStartCancelled,
    compose_session_environment,
    parse_session_context,
    run_session_context_start,
    validate_session_context,
)

SANDBOX_ID = "sandbox-1"
SESSION_ID = "session-1"
# Stands in for a sandbox's auth token. Never a real credential.
SYNTHETIC_TOKEN = "synthetic-sandbox-token-7f3a9c2e1b0d4e5f"


def session_env(**overrides: str) -> dict[str, str]:
    env = {
        "PYTHONUNBUFFERED": "1",
        "SANDBOX_ID": SANDBOX_ID,
        "CONTROL_PLANE_URL": "https://cp.example.test",
        "SANDBOX_AUTH_TOKEN": SYNTHETIC_TOKEN,
        "REPO_OWNER": "acme",
        "REPO_NAME": "widgets",
        "SESSION_CONFIG": json.dumps({"session_id": SESSION_ID, "branch": "main"}),
    }
    env.update(overrides)
    return env


def context_line(env: dict[str, object] | None = None, **fields: object) -> bytes:
    payload: dict[str, object] = {
        "version": 1,
        "sandbox_id": SANDBOX_ID,
        "session_id": SESSION_ID,
        "env": session_env() if env is None else env,
    }
    payload.update(fields)
    return json.dumps(payload).encode("utf-8") + b"\n"


class FakeTransport:
    closed = False

    def close(self) -> None:
        self.closed = True


class FakeSupervisor:
    def __init__(self, shutdown_event: asyncio.Event, observed_env: dict[str, str]) -> None:
        self.shutdown_event = shutdown_event
        self.observed_env = observed_env
        self.ran = False

    async def run(self) -> bool:
        self.ran = True
        return True


@pytest.fixture
def launch(monkeypatch: pytest.MonkeyPatch, tmp_path):
    """A process that has not launched yet, whose stdin the test feeds."""
    environment = {"PATH": "/usr/bin", DEFERRED_START_ENV_VAR: "true"}
    monkeypatch.setattr(os, "environ", environment)
    monkeypatch.setattr(
        session_context_start, "SESSION_CONTEXT_LAUNCH_GUARD_PATH", str(tmp_path / "guard")
    )
    monkeypatch.setattr(session_context_start, "_install_shutdown_handlers", lambda _event: None)
    # Keeps the test process's own descriptor 0 untouched; the fd test below exercises the real rebind.
    monkeypatch.setattr(session_context_start, "_detach_stdin", lambda: None)
    built: list[FakeSupervisor] = []
    stdin: dict[str, object] = {}

    async def connect() -> tuple[asyncio.StreamReader, FakeTransport]:
        reader = asyncio.StreamReader(limit=MAX_SESSION_CONTEXT_BYTES + 1)
        reader.feed_data(stdin["data"])
        reader.feed_eof()
        transport = FakeTransport()
        stdin["transport"] = transport
        return reader, transport

    monkeypatch.setattr(session_context_start, "_connect_stdin_reader", connect)

    def build(shutdown_event: asyncio.Event) -> FakeSupervisor:
        supervisor = FakeSupervisor(shutdown_event, dict(environment))
        built.append(supervisor)
        return supervisor

    class Launch:
        def __init__(self) -> None:
            self.built = built
            self.environment = environment
            self.stdin = stdin

        def run(self, data: bytes) -> int:
            stdin["data"] = data
            return asyncio.run(run_session_context_start(build, lambda _supervisor: None))

    return Launch()


def test_a_well_formed_context_parses_and_validates_as_the_runtime_reads_it():
    context = parse_session_context(context_line()[:-1])
    assert (context.sandbox_id, context.session_id) == (SANDBOX_ID, SESSION_ID)
    validate_session_context(context)


# Ids are short names: pytest puts each id in an environment variable, so a payload as an id would overflow it.
@pytest.mark.parametrize(
    ("line", "reason"),
    [
        (b"not json", "invalid_json"),
        (b"[]", "invalid_context"),
        (context_line(version=2), "unsupported_version"),
        (context_line(sandbox_id="--privileged"), "invalid_field:sandbox_id"),
        (context_line(session_id=""), "invalid_field:session_id"),
        (context_line({"lower": "x"}), "invalid_field:env"),
        (context_line({"NUMERIC": 1}), "invalid_field:env"),
        (context_line({"BIG": "x" * (65 * 1024)}), "invalid_field:env"),
        (context_line({f"KEY_{n}": "v" for n in range(257)}), "invalid_field:env"),
        (context_line({DEFERRED_START_ENV_VAR: "false"}), "reserved_env_key"),
        (context_line({"OPENINSPECT_DOCKER_ENABLED": "true"}), "reserved_env_key"),
        (context_line({"EXPECTED_TUNNEL_PORTS": "3000"}), "reserved_env_key"),
        (context_line({"IMAGE_BUILD_MODE": "true"}), "reserved_env_key"),
        (context_line({"PATH": "/tmp"}), "reserved_env_key"),
        # Keys the control plane refuses at save: the runtime refuses them too, so they never reach a boot.
        (context_line({"_TOKEN": "x"}), "invalid_field:env"),
        (context_line({"A" * 129: "x"}), "invalid_field:env"),
    ],
    ids=[
        "not-json",
        "not-object",
        "version",
        "sandbox-id",
        "session-id",
        "lowercase-key",
        "non-string-value",
        "oversized-value",
        "too-many-keys",
        "deferred-marker",
        "nested-docker",
        "tunnels",
        "build-mode",
        "path",
        "underscore-key",
        "over-long-key",
    ],
)
def test_a_malformed_or_reserved_context_is_refused_with_a_fixed_code(line: bytes, reason: str):
    with pytest.raises(SessionContextError) as refused:
        parse_session_context(line.rstrip(b"\n"))
    assert str(refused.value) == reason
    assert SYNTHETIC_TOKEN not in str(refused.value)


@pytest.mark.parametrize(
    ("env", "reason"),
    [
        (session_env(SANDBOX_ID="sandbox-2"), "sandbox_mismatch"),
        (session_env(SESSION_CONFIG=json.dumps({"session_id": "session-2"})), "session_mismatch"),
        (session_env(SANDBOX_AUTH_TOKEN=""), "missing_field:SANDBOX_AUTH_TOKEN"),
        (session_env(CONTROL_PLANE_URL="http://cp.example.test"), "invalid_session_config"),
        (session_env(SESSION_CONFIG="not json"), "invalid_session_config"),
    ],
)
def test_a_context_that_the_runtime_would_not_boot_is_refused(env: dict[str, str], reason: str):
    context = parse_session_context(context_line(env)[:-1])
    with pytest.raises(SessionContextError) as refused:
        validate_session_context(context)
    assert str(refused.value) == reason
    assert SYNTHETIC_TOKEN not in str(refused.value)


def test_composing_removes_the_deferred_marker_and_keeps_the_image_paths():
    environment = {
        DEFERRED_START_ENV_VAR: "true",
        "HOME": "/home/sandbox",
        "PATH": "/usr/bin",
        "SANDBOX_ID": "stale",
    }
    compose_session_environment(parse_session_context(context_line()[:-1]), environment)
    assert DEFERRED_START_ENV_VAR not in environment
    assert environment["SANDBOX_ID"] == SANDBOX_ID
    assert environment["HOME"] == "/home/sandbox"
    assert environment["PATH"] == "/usr/bin"


async def test_reading_gives_up_when_shutdown_wins():
    shutdown_event = asyncio.Event()
    shutdown_event.set()
    with pytest.raises(SessionContextStartCancelled):
        await session_context_start._read_context_line(asyncio.StreamReader(), shutdown_event)


def test_an_accepted_context_composes_the_environment_before_the_supervisor_and_announces_it(
    launch, capsys: pytest.CaptureFixture[str]
):
    assert launch.run(context_line()) == 0

    [supervisor] = launch.built
    assert supervisor.observed_env["SANDBOX_ID"] == SANDBOX_ID
    assert supervisor.observed_env["SANDBOX_AUTH_TOKEN"] == SYNTHETIC_TOKEN
    assert DEFERRED_START_ENV_VAR not in supervisor.observed_env
    assert supervisor.ran is True
    assert launch.stdin["transport"].closed is True

    output = capsys.readouterr()
    assert SESSION_CONTEXT_ACCEPTED_LINE in output.out.splitlines()
    assert SYNTHETIC_TOKEN not in output.out + output.err


def test_closing_stdin_detaches_descriptor_zero_only_after_the_transport_closes(
    launch, monkeypatch: pytest.MonkeyPatch
):
    order: list[str] = []
    original_close = FakeTransport.close

    def close(self: FakeTransport) -> None:
        order.append("close")
        original_close(self)

    monkeypatch.setattr(FakeTransport, "close", close)
    monkeypatch.setattr(session_context_start, "_detach_stdin", lambda: order.append("detach"))

    assert launch.run(context_line()) == 0

    assert order == ["close", "detach"]


def test_detaching_stdin_points_descriptor_zero_at_devnull():
    read_fd, write_fd = os.pipe()
    saved_stdin = os.dup(0)
    try:
        os.dup2(read_fd, 0)
        os.close(read_fd)
        session_context_start._detach_stdin()
        assert os.path.samestat(os.fstat(0), Path(os.devnull).stat())
    finally:
        os.dup2(saved_stdin, 0)
        os.close(saved_stdin)
        os.close(write_fd)


@pytest.mark.parametrize(
    ("data", "reason"),
    [
        (b"", "stdin_closed"),
        (b'{"version": 1}', "incomplete_context"),
        (b"x" * (MAX_SESSION_CONTEXT_BYTES + 8), "oversized_context"),
        (b"not json\n", "invalid_json"),
        (context_line({"OI_DEFERRED_START": "false"}), "reserved_env_key"),
    ],
    ids=["stdin-closed", "incomplete", "oversized", "not-json", "reserved-key"],
)
def test_a_rejected_context_exits_before_the_acceptance_line(
    launch, capsys: pytest.CaptureFixture[str], data: bytes, reason: str
):
    assert launch.run(data) == 1

    assert launch.built == []
    assert launch.stdin["transport"].closed is True
    output = capsys.readouterr()
    assert SESSION_CONTEXT_ACCEPTED_LINE not in output.out
    assert SYNTHETIC_TOKEN not in output.out + output.err


def test_a_second_launch_in_the_same_container_is_refused(
    launch, capsys: pytest.CaptureFixture[str]
):
    assert launch.run(context_line()) == 0
    assert launch.run(context_line()) == 1

    assert len(launch.built) == 1
    assert capsys.readouterr().out.count(SESSION_CONTEXT_ACCEPTED_LINE) == 1


def test_the_entrypoint_routes_the_session_argument_ahead_of_the_deferred_hold(
    monkeypatch: pytest.MonkeyPatch,
):
    async def fake_session_start(build_supervisor, install_signal_handlers) -> int:
        return 7

    async def fake_deferred_hold() -> int:
        # Misrouted, the entrypoint would reach this hold and return 99 instead of 7.
        return 99

    monkeypatch.setattr(entrypoint, "run_session_context_start", fake_session_start)
    monkeypatch.setattr(entrypoint, "run_deferred_start", fake_deferred_hold)
    monkeypatch.setattr(os, "environ", {DEFERRED_START_ENV_VAR: "true"})

    assert asyncio.run(entrypoint.main([SESSION_CONTEXT_START_ARGUMENT])) == 7
