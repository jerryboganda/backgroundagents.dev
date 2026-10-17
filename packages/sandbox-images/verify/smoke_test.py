#!/usr/bin/env python3
"""Build-time image contract: check required tools and services before use."""

from __future__ import annotations

import argparse
import json
import os
import re
import signal
import socket
import subprocess
import tempfile
import time
import urllib.request
from pathlib import Path
from typing import Any

try:
    import pwd
except ImportError:  # Windows: only the Linux image runs the probes that need pwd
    pwd = None

PNPM_GLOBAL_PROBE = r"""
import json, os, pathlib, shutil, subprocess, tempfile, uuid
name = "oi-image-probe-" + uuid.uuid4().hex
home = pathlib.Path(os.environ["PNPM_HOME"])
assert str(home) in os.environ["PATH"].split(":")
with tempfile.TemporaryDirectory(prefix="openinspect-pnpm-") as directory:
    root = pathlib.Path(directory)
    package = root / "package"
    package.mkdir()
    (package / "package.json").write_text(json.dumps({
        "name": name, "version": "1.0.0", "bin": {name: "command.js"}
    }))
    executable = package / "command.js"
    executable.write_text('#!/usr/bin/env node\nconsole.log("global-bin-ok")\n')
    executable.chmod(0o755)
    try:
        subprocess.run([
            "pnpm", "add", "--global", "--offline", "--ignore-scripts",
            "--global-dir", str(root / "global"), "--store-dir", str(root / "store"),
            str(package),
        ], check=True, timeout=60, capture_output=True)
        assert shutil.which(name) == str(home / name)
        assert subprocess.check_output([name], text=True, timeout=10).strip() == "global-bin-ok"
    finally:
        (home / name).unlink(missing_ok=True)
"""


class Probe:
    def __init__(self, plan: dict[str, Any]) -> None:
        self.environment = os.environ | plan["runtimeEnv"]
        self.environment.pop("VIRTUAL_ENV", None)
        self.user = pwd.getpwnam(plan["target"]["user"])
        self.options: dict[str, Any] = {"env": self.environment, "cwd": "/workspace", "text": True}
        if os.geteuid() == 0:
            self.options.update(user=self.user.pw_uid, group=self.user.pw_gid, extra_groups=[])
        elif os.geteuid() != self.user.pw_uid:
            raise RuntimeError("Verification must run as the configured runtime user or root")

    def run(self, command: list[str], *, timeout_seconds: int = 120) -> str:
        result = subprocess.run(
            command, capture_output=True, timeout=timeout_seconds, check=False, **self.options
        )
        if result.returncode:
            raise RuntimeError(
                f"Image probe failed: {command[0]} (exit {result.returncode}): {result.stderr[-2000:]}"
            )
        return result.stdout.strip()

    def desktop(self) -> None:
        display = next(
            number for number in range(90, 190) if not Path(f"/tmp/.X11-unix/X{number}").exists()
        )
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        processes = []
        with tempfile.TemporaryFile(mode="w+") as output:
            try:
                processes.append(
                    subprocess.Popen(
                        ["Xvfb", f":{display}", "-screen", "0", "640x480x24", "-nolisten", "tcp"],
                        stdout=output,
                        stderr=output,
                        start_new_session=True,
                        **self.options,
                    )
                )
                deadline = time.monotonic() + 20
                while not Path(f"/tmp/.X11-unix/X{display}").exists():
                    if processes[0].poll() is not None or time.monotonic() > deadline:
                        raise RuntimeError("Xvfb failed to become ready")
                    time.sleep(0.1)
                for command in (
                    ["fluxbox", "-display", f":{display}"],
                    [
                        "x11vnc",
                        "-display",
                        f":{display}",
                        "-rfbport",
                        str(port),
                        "-localhost",
                        "-nopw",
                        "-forever",
                    ],
                ):
                    processes.append(
                        subprocess.Popen(
                            command,
                            stdout=output,
                            stderr=output,
                            start_new_session=True,
                            **self.options,
                        )
                    )
                wait_for_rfb(port, processes, deadline=time.monotonic() + 20)
                self.service(
                    [
                        "websockify",
                        "--web=/usr/share/novnc",
                        "127.0.0.1:{port}",
                        f"127.0.0.1:{port}",
                    ],
                    "/vnc.html",
                    websocket_rfb=True,
                )
            except Exception as error:
                output.seek(0)
                raise RuntimeError(f"{error}: {output.read()[-4000:]}") from error
            finally:
                for process in reversed(processes):
                    stop_process(process)

    def service(self, command: list[str], path: str = "/", *, websocket_rfb: bool = False) -> None:
        with socket.socket() as listener:
            listener.bind(("127.0.0.1", 0))
            port = listener.getsockname()[1]
        command = [arg.replace("{port}", str(port)) for arg in command]
        with tempfile.TemporaryFile(mode="w+") as output:
            process = subprocess.Popen(
                command, stdout=output, stderr=output, start_new_session=True, **self.options
            )
            try:
                deadline = time.monotonic() + 60
                while time.monotonic() < deadline:
                    if process.poll() is not None:
                        output.seek(0)
                        raise RuntimeError(
                            f"Image service exited: {command[0]}: {output.read()[-2000:]}"
                        )
                    try:
                        with urllib.request.urlopen(
                            f"http://127.0.0.1:{port}{path}", timeout=1
                        ) as response:
                            if response.status == 200:
                                if websocket_rfb:
                                    verify_rfb_proxy(port)
                                return
                    except OSError:
                        pass
                    time.sleep(0.2)
                raise RuntimeError(f"Image service readiness timeout: {command[0]}")
            finally:
                stop_process(process)


def wait_for_rfb(port: int, processes: list[subprocess.Popen], *, deadline: float) -> None:
    """Wait for the VNC server on ``port`` to send its RFB banner.

    Reconnects only while nothing is listening. Once connected, one connection
    waits out the deadline: the kernel accepts connections before x11vnc does,
    and abandoning a connection x11vnc has not yet picked up only queues it
    ahead of the next attempt. The desktop processes are checked throughout the
    wait and again once the banner arrives.
    """

    def require_processes_running() -> None:
        if any(process.poll() is not None for process in processes):
            raise RuntimeError("Desktop process exited during verification")

    while True:
        require_processes_running()
        try:
            connection = socket.create_connection(("127.0.0.1", port), timeout=1)
        except OSError:
            if time.monotonic() > deadline:
                raise RuntimeError("VNC readiness timeout") from None
            time.sleep(0.1)
            continue
        with connection:
            while True:
                remaining = deadline - time.monotonic()
                if remaining <= 0:
                    raise RuntimeError("VNC readiness timeout")
                connection.settimeout(min(remaining, 0.5))
                try:
                    banner = connection.recv(12)
                    break
                except TimeoutError:
                    require_processes_running()
        require_processes_running()
        if not banner.startswith(b"RFB "):
            raise RuntimeError("VNC server did not speak RFB")
        return


def verify_rfb_proxy(port: int) -> None:
    """Require the WebSocket proxy to exchange RFB with its VNC backend."""
    from websockets.sync.client import connect

    with connect(
        f"ws://127.0.0.1:{port}/websockify",
        subprotocols=["binary"],
        open_timeout=5,
        close_timeout=1,
        proxy=None,
    ) as connection:
        banner = connection.recv(timeout=5)
        if not isinstance(banner, bytes) or not banner.startswith(b"RFB ") or len(banner) != 12:
            raise RuntimeError("Desktop WebSocket proxy did not deliver an RFB banner")
        connection.send(banner)
        security = connection.recv(timeout=5)
        if not isinstance(security, bytes) or len(security) < 2 or security[0] == 0:
            raise RuntimeError("Desktop WebSocket proxy did not complete the RFB version exchange")


def stop_process(process: subprocess.Popen) -> None:
    if process.poll() is None:
        try:
            os.killpg(process.pid, signal.SIGTERM)
        except ProcessLookupError:
            return
        try:
            process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            os.killpg(process.pid, signal.SIGKILL)
            process.wait()


def observed_tool_version(command: str, expected: str, output: str) -> str:
    """Normalize the command's leading version, not an expected substring."""
    prefixes = {
        "node": r"v",
        "opencode": r"",
        "codex": r"codex-cli ",
        "bun": r"",
        "pnpm": r"",
        "agent-browser": r"agent-browser\s+",
        "code-server": r"",
        "ttyd": r"ttyd version\s+",
        "google-chrome": r"Google Chrome(?: for Testing)?\s+",
    }
    # ttyd's pinned release appends its source commit, not a prerelease label.
    suffix = r"(?:-[a-f0-9]{7,40})?" if command == "ttyd" else ""
    pattern = prefixes[command] + r"(\d+(?:\.\d+){2,3})" + suffix + r"(?=\s|$)"
    matches = [
        match.group(1) for line in output.splitlines() if (match := re.match(pattern, line.strip()))
    ]
    observed = matches[0] if len(matches) == 1 else None
    if observed != expected:
        raise RuntimeError(f"{command} version mismatch: expected {expected}, got {output}")
    return observed


def inspect_image(plan: dict[str, Any], tools: dict[str, Any], *, services: bool) -> None:
    probe = Probe(plan)
    for command, version in (
        ("node", tools["node"][plan["target"]["node"]]["version"]),
        ("opencode", tools["opencode"]),
        ("codex", tools["codex"]["version"]),
        ("bun", tools["bun"]),
        ("pnpm", tools["pnpm"]),
        ("agent-browser", tools["agentBrowser"]),
        ("code-server", tools["codeServer"]["version"]),
        ("ttyd", tools["ttyd"]["version"]),
        ("google-chrome", tools["chrome"]["version"]),
    ):
        observed = probe.run([command, "--version"])
        observed_tool_version(command, version, observed)
    installed_runtime = probe.run(
        [
            "python3",
            "-I",
            "-c",
            "import sandbox_runtime, sandbox_runtime.runtime_manifest, httpx, websockets, pydantic, jwt, cryptography; print(sandbox_runtime.runtime_manifest.RUNTIME_VERSION)",
        ]
    )
    if installed_runtime != plan["runtimeVersion"]:
        raise RuntimeError("Installed runtime manifest does not match the recipe")
    probe.run(["python3", "-m", "sandbox_runtime.harness.codex.probe"], timeout_seconds=30)
    probe.run(
        [
            "python3",
            "-c",
            "import os, pathlib, shutil, tempfile; assert shutil.which('gh') == '/usr/local/bin/gh'; assert os.access('/usr/bin/gh', os.X_OK); assert pathlib.Path('/app/sandbox_runtime/skills/agent-browser/SKILL.md').is_file(); f=tempfile.TemporaryFile(dir='/workspace'); f.close(); f=tempfile.TemporaryFile(dir=pathlib.Path.home()); f.close()",
        ]
    )
    probe.run(["gh", "--version"])
    if probe.run(["git", "config", "--system", "credential.useHttpPath"]) != "true":
        raise RuntimeError("SCM credential helper is not repository-path scoped")
    probe.run(
        [
            "node",
            "--input-type=module",
            "-e",
            "const p = await import('/app/opencode-deps/node_modules/@opencode-ai/plugin/dist/index.js'); if (typeof p.tool !== 'function') process.exit(1)",
        ]
    )
    for command in ("Xvfb", "fluxbox", "x11vnc", "websockify"):
        probe.run(["python3", "-c", "import shutil,sys; assert shutil.which(sys.argv[1])", command])
    if not Path("/usr/share/novnc/vnc.html").is_file():
        raise RuntimeError("noVNC assets missing")
    video = (
        subprocess.run(
            ["sh", "-c", "command -v ffmpeg"], capture_output=True, **probe.options
        ).returncode
        == 0
    )
    if not video and plan["provider"] != "vercel":
        raise RuntimeError("Required video encoder missing")
    if services:
        probe.run(["python3", "-c", PNPM_GLOBAL_PROBE])
        probe.desktop()
        probe.service(
            ["opencode", "serve", "--hostname", "127.0.0.1", "--port", "{port}"], "/global/health"
        )
        probe.service(
            [
                "code-server",
                "--bind-addr",
                "127.0.0.1:{port}",
                "--auth",
                "none",
                "--disable-telemetry",
                "/workspace",
            ],
            "/healthz",
        )
        probe.service(["ttyd", "--interface", "127.0.0.1", "--port", "{port}", "bash"])
        try:
            probe.run(
                ["agent-browser", "--session", "openinspect-image-verify", "open", "about:blank"]
            )
            probe.run(
                [
                    "agent-browser",
                    "--session",
                    "openinspect-image-verify",
                    "screenshot",
                    "/tmp/openinspect-image-verify.png",
                ]
            )
        finally:
            probe.run(["agent-browser", "--session", "openinspect-image-verify", "close"])
            Path("/tmp/openinspect-image-verify.png").unlink(missing_ok=True)


def mount_details(mount_point: str) -> tuple[str, list[str], list[str]]:
    """Filesystem type, per-mount options and superblock options of the topmost mount at a path."""
    matches = []
    for line in Path("/proc/self/mountinfo").read_text().splitlines():
        before, after = line.split(" - ", 1)
        fields = before.split()
        if fields[4] == mount_point:
            fstype, _source, superblock = after.split(maxsplit=2)
            matches.append((fstype, fields[5].split(","), superblock.split(",")))
    if not matches:
        raise RuntimeError(f"{mount_point} is not a mount point")
    return matches[-1]


# Session and auth state the seed must never hold. The build writes OpenCode's model catalog and the empty SCM
# cache directory under .cache, so nothing else may appear there. Other OpenCode output is not validated here;
# the first Linux build runs this contract on the real seed.
SEED_SESSION_PATHS = (
    ".codex",
    ".claude",
    ".config/gh",
    ".ssh",
    ".netrc",
    ".npmrc",
    ".git-credentials",
    ".local/share/opencode/storage",
    ".local/share/opencode/snapshot",
)
SEED_CACHE_ROOTS = (".cache/opencode", ".cache/openinspect/scm")


def check_seed_entries(seed: Path) -> None:
    for entry in seed.rglob("*"):
        relative = entry.relative_to(seed).as_posix()
        if (
            entry.name == "auth.json"
            or entry.name.startswith("opencode.db")
            or any(
                relative == path or relative.startswith(f"{path}/") for path in SEED_SESSION_PATHS
            )
        ):
            raise RuntimeError(f"Home seed carries session or auth state: {relative}")
        if relative.startswith(".cache/openinspect/") and entry.is_file():
            raise RuntimeError(f"Home seed carries session state: {relative}")
        if relative.startswith(".cache/") and not any(
            relative == root or relative.startswith(f"{root}/") or root.startswith(f"{relative}/")
            for root in SEED_CACHE_ROOTS
        ):
            raise RuntimeError(f"Home seed cache is not OpenCode catalog or SCM cache: {relative}")


def check_runtime_contract(plan: dict[str, Any]) -> None:
    """Run as the runtime user on a read-only root, with an exec tmpfs /tmp and bind-mounted HOME and /workspace."""
    from sandbox_runtime.claude_stager import resolve_claude_config_dir
    from sandbox_runtime.codex_stager import resolve_codex_config_dir
    from sandbox_runtime.harness.base import HarnessId
    from sandbox_runtime.opencode_server import resolve_opencode_global_config_dir

    target = plan["target"]
    if (os.getuid(), os.getgid()) != (target["uid"], target["gid"]):
        raise RuntimeError(
            f"Runtime identity is {os.getuid()}:{os.getgid()}, expected {target['uid']}:{target['gid']}"
        )
    if pwd.getpwuid(os.getuid()).pw_name != target["user"]:
        raise RuntimeError("Runtime user name does not match the image contract")
    _, root_options, _ = mount_details("/")
    if "ro" not in root_options:
        raise RuntimeError("Root filesystem is writable; the contract requires a read-only root")
    fstype, options, superblock = mount_details("/tmp")
    if (
        fstype != "tmpfs"
        or "noexec" in options
        or not any(item.startswith("size=") for item in superblock)
    ):
        raise RuntimeError("/tmp must be an exec tmpfs with a size bound")
    directory = Path(tempfile.mkdtemp(dir="/tmp"))
    probe = directory / "exec-probe"
    try:
        probe.write_text("#!/bin/sh\nexit 0\n")
        probe.chmod(0o755)
        subprocess.run([str(probe)], check=True, timeout=10)
    finally:
        probe.unlink(missing_ok=True)
        directory.rmdir()
    home = Path(target["home"])
    for path in (home, Path("/workspace")):
        if not path.is_mount():
            raise RuntimeError(f"{path} must be a bind mount")
        with tempfile.TemporaryFile(dir=path):
            pass
    seed = Path("/app/home-seed")
    if not seed.is_dir():
        raise RuntimeError("Image home seed /app/home-seed is missing")
    for entry in seed.rglob("*"):
        copied = home / entry.relative_to(seed)
        if not (copied.exists() or copied.is_symlink()):
            raise RuntimeError(
                f"Home seed entry was not copied into HOME: {entry.relative_to(seed)}"
            )
        if not (entry.is_symlink() or os.access(entry, os.R_OK)):
            raise RuntimeError(
                f"Home seed entry is not readable by UID {os.getuid()}: {entry.relative_to(seed)}"
            )
    for required in (
        ".agent-browser/config.json",
        ".config/opencode",
        ".npm-cache",
        ".npm-global",
        ".local/bin",
        ".cache/openinspect/scm",
    ):
        if not (home / required).exists():
            raise RuntimeError(f"Required home path is missing: {required}")
    check_seed_entries(seed)
    resolvers = {
        "opencode": resolve_opencode_global_config_dir,
        "claude": resolve_claude_config_dir,
        "codex": resolve_codex_config_dir,
    }
    if set(resolvers) != set(HarnessId):
        raise RuntimeError("Harness contract does not cover every runtime harness")
    for resolve in resolvers.values():
        config_dir = resolve()
        config_dir.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryFile(dir=config_dir):
            pass
    opencode = Path("/tmp/opencode")
    if not opencode.is_dir() or opencode.stat().st_uid != os.getuid():
        raise RuntimeError("/tmp/opencode must be a directory owned by the runtime user")
    with tempfile.TemporaryFile(dir=opencode):
        pass
    # Harness processes start under the same contract: OpenCode serves from the seeded config, Codex probes.
    harness_probe = Probe(plan)
    harness_probe.run(["python3", "-m", "sandbox_runtime.harness.codex.probe"], timeout_seconds=30)
    harness_probe.service(
        ["opencode", "serve", "--hostname", "127.0.0.1", "--port", "{port}"], "/global/health"
    )


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=("install", "verify", "contract"))
    args = parser.parse_args()
    plan = json.loads(Path("/app/openinspect-build-config.json").read_text())
    tools = json.loads(Path("/app/openinspect-toolchain.json").read_text())
    environment = json.loads(Path("/app/openinspect-runtime-environment.json").read_text())
    if environment != plan["runtimeEnv"]:
        raise RuntimeError("Baked launch environment does not match build configuration")
    if args.command == "contract":
        check_runtime_contract(plan)
        return
    inspect_image(plan, tools, services=args.command == "verify")


if __name__ == "__main__":
    main()
