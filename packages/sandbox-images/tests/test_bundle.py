"""Shared payload staging and conservative build invalidation."""

import json
import os
import re
import shutil
from pathlib import Path

import pytest

from sandbox_images.bundle import (
    PROVIDERS,
    pack_bundle,
    packed_file,
    plan_image,
    validate_toolchain,
)
from sandbox_images.configuration import runtime_environment
from sandbox_images.native import build_image

REPO_ROOT = Path(__file__).resolve().parents[3]
# Standard packs keep their modes only on POSIX; the refusal test covers other hosts.
POSIX_PACK = pytest.mark.skipif(os.name != "posix", reason="standard packs need POSIX file modes")


@pytest.fixture
def checkout(tmp_path):
    path = tmp_path / "checkout"
    shutil.copytree(
        REPO_ROOT,
        path,
        ignore=shutil.ignore_patterns(
            ".git", "node_modules", ".venv", ".cache", "__pycache__", ".terraform"
        ),
    )
    return path


@pytest.mark.parametrize("provider", PROVIDERS)
def test_runtime_user_global_pnpm_commands_are_on_path(provider):
    environment = plan_image(REPO_ROOT, provider)["runtimeEnv"]
    assert environment["PNPM_HOME"] in environment["PATH"].split(":")
    assert "VIRTUAL_ENV" not in environment


def test_binary_checksum_and_minimum_tool_version_are_required():
    tools = json.loads((REPO_ROOT / "packages/sandbox-images/toolchain.json").read_text())
    validate_toolchain(tools)
    tools["opencode"] = "1.18.14"
    with pytest.raises(ValueError, match="OpenCode"):
        validate_toolchain(tools)
    tools["opencode"] = "1.18.29"
    del tools["agentBrowserSha256"]
    with pytest.raises(ValueError, match="agent-browser"):
        validate_toolchain(tools)


def test_codex_pin_matches_protocol_and_requires_checksum():
    tools = json.loads((REPO_ROOT / "packages/sandbox-images/toolchain.json").read_text())
    source = (
        REPO_ROOT / "packages/sandbox-runtime/src/sandbox_runtime/harness/codex/env.py"
    ).read_text()
    assert f'CODEX_VERSION = "{tools["codex"]["version"]}"' in source
    tools["codex"]["sha256"] = "invalid"
    with pytest.raises(ValueError, match="SHA-256"):
        validate_toolchain(tools)


def test_debian_installs_disable_recommended_packages():
    script = (REPO_ROOT / "packages/sandbox-images/install/os/debian.sh").read_text()
    install_commands = [line for line in script.splitlines() if line.startswith("apt-get install ")]
    assert install_commands
    assert all("--no-install-recommends" in command for command in install_commands)


def test_debian_restores_shared_tmp_before_using_apt():
    script = (REPO_ROOT / "packages/sandbox-images/install/os/debian.sh").read_text()
    assert script.index("install -d -m 1777 /tmp") < script.index("apt-get update")


def test_agent_browser_installs_as_checked_native_binary():
    script = (REPO_ROOT / "packages/sandbox-images/install/tools.sh").read_text()
    assert 'install -m 0755 "$download_dir/agent-browser" /usr/local/bin/agent-browser' in script
    assert "node_modules/agent-browser" not in script
    loop = next(line for line in script.splitlines() if line.startswith("for command in "))
    commands = loop.removeprefix("for command in ").removesuffix("; do").split()
    assert "agent-browser" not in commands


@pytest.mark.parametrize("provider", PROVIDERS)
def test_pack_rejects_stale_locks_before_creating_context(checkout, tmp_path, provider):
    path = checkout / "packages/sandbox-images/locks/runtime.txt"
    path.write_text(path.read_text() + "\n")
    with pytest.raises(ValueError, match="stale"):
        pack_bundle(checkout, provider, tmp_path / "bundles")
    assert not (tmp_path / "bundles").exists()


@pytest.mark.parametrize(
    "source",
    [
        "packages/sandbox-runtime/src/sandbox_runtime/skills/agent-browser/SKILL.md",
        "packages/modal-infra/src/images/base.py",
        "packages/modal-infra/deploy.py",
        "terraform/modules/modal-app/scripts/deploy.sh",
        "packages/sandbox-images/src/sandbox_images/native.py",
    ],
)
def test_one_hash_covers_payload_builder_and_deployment(checkout, source):
    before = plan_image(checkout, "modal")["buildHash"]
    path = checkout / source
    path.write_text(path.read_text() + "\n")
    assert plan_image(checkout, "modal")["buildHash"] != before


@pytest.mark.parametrize(
    "source",
    [
        "package-lock.json",
        "packages/control-plane/src/logger.ts",
        "packages/control-plane/src/sandbox/request-deadline.ts",
        "packages/shared/src/logger.ts",
    ],
)
def test_vercel_transitive_build_inputs_are_covered(checkout, source):
    before = plan_image(checkout, "vercel")["buildHash"]
    path = checkout / source
    path.write_text(path.read_text() + "\n")
    assert plan_image(checkout, "vercel")["buildHash"] != before


@POSIX_PACK
def test_runtime_assets_are_packed_without_per_file_manifest(checkout, tmp_path):
    skill = "packages/sandbox-runtime/src/sandbox_runtime/skills/agent-browser/SKILL.md"
    (checkout / skill).write_text("updated skill")
    packed = pack_bundle(checkout, "e2b", tmp_path / "bundles")
    assert (packed.directory / skill).read_text() == "updated skill"
    config = json.loads((packed.directory / "build-config.json").read_text())
    assert config == packed.plan
    assert set(config) == {"provider", "target", "runtimeVersion", "runtimeEnv", "buildHash"}
    assert not (packed.directory / "packages/e2b-infra").exists()


@POSIX_PACK
def test_each_caller_gets_a_fresh_context_without_reusing_extra_files(tmp_path):
    first = pack_bundle(REPO_ROOT, "e2b", tmp_path)
    (first.directory / ".env").write_text("must not leak")
    second = pack_bundle(REPO_ROOT, "e2b", tmp_path)
    assert first.directory != second.directory
    assert not (second.directory / ".env").exists()


def test_missing_payload_fails_closed(checkout):
    (checkout / "packages/sandbox-runtime/uv.lock").unlink()
    with pytest.raises(FileNotFoundError):
        plan_image(checkout, "e2b")


@POSIX_PACK
def test_symlinks_and_executable_modes(checkout, tmp_path):
    directory = checkout / "packages/sandbox-runtime/src/sandbox_runtime"
    (directory / "probe.sh").write_text("#!/bin/sh\nexit 0\n")
    (directory / "probe.sh").chmod(0o755)
    (directory / "probe-link.sh").symlink_to("probe.sh")
    before = plan_image(checkout, "e2b")["buildHash"]
    packed = pack_bundle(checkout, "e2b", tmp_path / "bundles")
    copied = packed.directory / "packages/sandbox-runtime/src/sandbox_runtime"
    assert (copied / "probe-link.sh").is_symlink()
    assert (copied / "probe.sh").stat().st_mode & 0o777 == 0o755
    pyproject = packed.directory / "packages/sandbox-runtime/pyproject.toml"
    assert pyproject.stat().st_mode & 0o777 == 0o644
    # The packing rule sets the mode, so a checkout chmod leaves the hash unchanged.
    (directory / "probe.sh").chmod(0o644)
    assert plan_image(checkout, "e2b")["buildHash"] == before
    (directory / "escape.sh").symlink_to(tmp_path / "outside")
    with pytest.raises(ValueError, match="symlink"):
        plan_image(checkout, "e2b")


def test_standard_pack_refuses_when_chmod_does_not_keep_modes(checkout, tmp_path, monkeypatch):
    # Stands in for NTFS, which ignores chmod: the pack must refuse, not ship other modes.
    script = checkout / "packages/sandbox-runtime/src/sandbox_runtime/probe.sh"
    script.write_text("#!/bin/sh\nexit 0\n")
    script.chmod(0o644)
    monkeypatch.setattr(Path, "chmod", lambda self, mode, **kwargs: None)
    with pytest.raises(RuntimeError, match="POSIX"):
        pack_bundle(checkout, "e2b", tmp_path / "bundles")
    assert list((tmp_path / "bundles").iterdir()) == []


def test_docker_variant_pins_debian_packages_by_checksum():
    tools = json.loads((REPO_ROOT / "packages/sandbox-images/toolchain.json").read_text())
    assert set(tools["docker"]) == {"engine", "cli", "containerd", "buildx", "compose"}
    tools["docker"]["engine"]["file"] = "docker-ce_latest.tgz"
    with pytest.raises(ValueError, match="Debian amd64"):
        validate_toolchain(tools)
    tools = json.loads((REPO_ROOT / "packages/sandbox-images/toolchain.json").read_text())
    tools["docker"]["compose"]["sha256"] = "deadbeef"
    with pytest.raises(ValueError, match="SHA-256"):
        validate_toolchain(tools)
    del tools["docker"]["buildx"]
    with pytest.raises(ValueError, match="exactly"):
        validate_toolchain(tools)


def test_docker_variant_installs_only_checked_packages_and_never_runs_at_boot():
    script = (REPO_ROOT / "packages/sandbox-images/install/docker.sh").read_text()
    assert "download_checked" in script
    assert "get.docker.com" not in script
    assert "docker pull" not in script
    install_commands = [line for line in script.splitlines() if "apt-get install" in line]
    assert install_commands
    assert all("--no-install-recommends" in command for command in install_commands)
    assert "/etc/docker/daemon.json" in script
    # The default image's installer never includes the Docker phase.
    install = (REPO_ROOT / "packages/sandbox-images/install/install.sh").read_text()
    assert "docker" not in install


def test_docker_daemon_config_uses_overlay2_and_avoids_modal_networks():
    config = json.loads(
        (REPO_ROOT / "packages/sandbox-images/install/docker-daemon.json").read_text()
    )
    assert config["storage-driver"] == "overlay2"
    assert config["features"]["containerd-snapshotter"] is False
    assert config["bip"].startswith("10.")
    assert all(pool["base"].startswith("10.") for pool in config["default-address-pools"])


@POSIX_PACK
def test_docker_pins_reach_the_installer_as_shell_variables(checkout, tmp_path):
    bundle = pack_bundle(checkout, "modal", tmp_path / "out")
    config = (bundle.directory / "image-config.sh").read_text()
    for package in ("ENGINE", "CLI", "CONTAINERD", "BUILDX", "COMPOSE"):
        assert f"export DOCKER_{package}_FILE=" in config
        assert f"export DOCKER_{package}_SHA256=" in config


def test_docker_daemon_shutdown_timeout_fits_inside_the_runtime_stop_deadline():
    config = json.loads(
        (REPO_ROOT / "packages/sandbox-images/install/docker-daemon.json").read_text()
    )
    runtime = (
        REPO_ROOT / "packages/sandbox-runtime/src/sandbox_runtime/docker_service.py"
    ).read_text()
    stop_deadline = float(
        re.search(r"^DOCKER_STOP_TIMEOUT_SECONDS = ([0-9.]+)", runtime, re.M).group(1)
    )
    assert config["shutdown-timeout"] < stop_deadline


def test_vps_image_pins_runtime_user_base_and_entrypoint():
    target = json.loads((REPO_ROOT / "packages/sandbox-images/targets.json").read_text())["vps"]
    assert (target["user"], target["home"], target["uid"], target["gid"]) == (
        "sandbox",
        "/home/sandbox",
        1000,
        1000,
    )
    dockerfile = (REPO_ROOT / "packages/sandbox-images/Dockerfile.vps").read_text()
    assert f"ARG BASE_IMAGE={target['base']}\n" in dockerfile
    assert "\nUSER 1000:1000\n" in dockerfile
    assert '\nENTRYPOINT ["/usr/local/bin/openinspect-entrypoint"]\n' in dockerfile
    assert (
        '\nCMD ["/opt/openinspect/python/bin/python", "-m", "sandbox_runtime.entrypoint"]\n'
        in dockerfile
    )
    # Nested Docker and its install phase stay out of the VPS image.
    assert "install.sh docker" not in dockerfile


def test_vps_entrypoint_seeds_home_without_overwriting_then_execs():
    entrypoint = (REPO_ROOT / "packages/sandbox-images/vps/entrypoint.sh").read_text()
    assert 'tar -C "$seed" -cf - . | tar -C "$home" --skip-old-files -xf -\n' in entrypoint
    assert '\n  seed_home /app/home-seed "$HOME"\n' in entrypoint
    assert entrypoint.endswith('\n  exec "$@"\nfi\n')


def test_vps_seed_is_made_readable_by_runtime_uid_at_build_time():
    dockerfile = (REPO_ROOT / "packages/sandbox-images/Dockerfile.vps").read_text()
    assert "chmod -R a+rX /app/home-seed" in dockerfile


def test_vps_seed_drops_opencode_session_state_before_copy():
    dockerfile = (REPO_ROOT / "packages/sandbox-images/Dockerfile.vps").read_text()
    cleanup = dockerfile.index("rm -rf /home/sandbox/.local/share/opencode/opencode.db*")
    copy = dockerfile.index("cp -a --no-preserve=ownership /home/sandbox/. /app/home-seed/")
    assert cleanup < copy
    removed = dockerfile[cleanup:copy]
    for name in ("auth.json", "log", "storage", "snapshot"):
        assert f"/home/sandbox/.local/share/opencode/{name}" in removed
    # The model catalog and other build output stay in the seed.
    assert ".cache" not in removed


def test_vps_dockerfile_env_mirrors_baked_runtime_environment():
    target = json.loads((REPO_ROOT / "packages/sandbox-images/targets.json").read_text())["vps"]
    dockerfile = (REPO_ROOT / "packages/sandbox-images/Dockerfile.vps").read_text()
    env_line = next(
        line for line in dockerfile.replace("\\\n", " ").splitlines() if line.startswith("ENV ")
    )
    baked = dict(item.split("=", 1) for item in env_line.removeprefix("ENV ").split())
    assert baked == runtime_environment(target)
    assert not [key for key in baked if re.search("TOKEN|SECRET|KEY|PASSWORD|DEFERRED", key)]


@POSIX_PACK
def test_vps_pack_exports_fixed_ids_and_manifest_matches_plan(tmp_path):
    bundle = pack_bundle(REPO_ROOT, "vps", tmp_path / "bundles")
    config = (bundle.directory / "image-config.sh").read_text()
    assert "export OI_RUNTIME_UID=1000\n" in config
    assert "export OI_RUNTIME_GID=1000\n" in config
    assert json.loads((bundle.directory / "build-config.json").read_text()) == bundle.plan
    assert bundle.plan["target"]["uid"] == 1000
    assert not (bundle.directory / "packages/vps-infra").exists()
    assert (bundle.directory / "packages/sandbox-images/vps/entrypoint.sh").is_file()


def test_vps_dockerfile_is_covered_by_build_hash(checkout):
    before = plan_image(checkout, "vps")["buildHash"]
    path = checkout / "packages/sandbox-images/Dockerfile.vps"
    path.write_text(path.read_text() + "\n")
    assert plan_image(checkout, "vps")["buildHash"] != before


def test_vps_has_no_native_build():
    with pytest.raises(ValueError, match="no native build"):
        build_image(REPO_ROOT, "vps")


def _with_crlf(data: bytes) -> bytes:
    return data.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")


@pytest.mark.parametrize("provider", ["vps", "e2b"])
@POSIX_PACK
def test_shell_scripts_pack_as_lf_and_hash_as_lf(checkout, tmp_path, provider):
    scripts = sorted((checkout / "packages/sandbox-images").rglob("*.sh"))
    assert scripts
    for script in scripts:
        script.write_bytes(script.read_bytes().replace(b"\r\n", b"\n"))
    lf = {script.relative_to(checkout): script.read_bytes() for script in scripts}
    lf_hash = plan_image(checkout, provider)["buildHash"]
    for script in scripts:
        script.write_bytes(_with_crlf(script.read_bytes()))
    assert plan_image(checkout, provider)["buildHash"] == lf_hash
    bundle = pack_bundle(checkout, provider, tmp_path / "bundles")
    for path in [*bundle.directory.rglob("*.sh"), bundle.directory / "build-config.json"]:
        assert b"\r" not in path.read_bytes(), path
    install = Path("packages/sandbox-images/install/install.sh")
    assert (bundle.directory / install).read_bytes() == lf[install]


@POSIX_PACK
def test_binary_payload_is_packed_byte_for_byte(checkout, tmp_path):
    install = checkout / "packages/sandbox-images/install"
    (install / "probe.bin").write_bytes(b"\r\n\xff\r\r\n")
    # A NUL marks the file as binary, so even a .sh name is copied unchanged.
    (install / "probe.sh").write_bytes(b"\0\r\n")
    # A shebang does not make a NUL-bearing file a script.
    (install / "probe-shebang").write_bytes(b"#!/bin/sh\0\r\n")
    bundle = pack_bundle(checkout, "vps", tmp_path / "bundles")
    packed = bundle.directory / "packages/sandbox-images/install"
    assert (packed / "probe.bin").read_bytes() == b"\r\n\xff\r\r\n"
    assert (packed / "probe.sh").read_bytes() == b"\0\r\n"
    assert (packed / "probe-shebang").read_bytes() == b"#!/bin/sh\0\r\n"


@pytest.mark.parametrize(
    ("name", "source", "packed", "mode"),
    [
        ("oi-git-sign", b"#!/bin/sh\r\nexec true\r\n", b"#!/bin/sh\nexec true\n", 0o755),
        (
            "launcher.py",
            b"#!/usr/bin/env python3\r\nprint(1)\r\n",
            b"#!/usr/bin/env python3\nprint(1)\n",
            0o755,
        ),
        (
            "upload-media.js",
            b"#!/usr/bin/env node\r\nconsole.log(1)\r\n",
            b"#!/usr/bin/env node\nconsole.log(1)\n",
            0o755,
        ),
        ("install.sh", b"set -e\r\necho ok\r\n", b"set -e\necho ok\n", 0o755),
        ("lone-cr", b"#!/bin/sh\necho a\rb\n", b"#!/bin/sh\necho a\rb\n", 0o755),
        ("module.py", b"print(1)\r\n", b"print(1)\r\n", 0o644),
        ("binary-shebang", b"#!/bin/sh\0\r\n", b"#!/bin/sh\0\r\n", 0o644),
        ("binary.sh", b"\0\r\n", b"\0\r\n", 0o644),
    ],
)
def test_packed_file_policy(tmp_path, name, source, packed, mode):
    path = tmp_path / name
    path.write_bytes(source)
    assert packed_file(path) == (packed, mode)


@POSIX_PACK
def test_real_launchers_pack_as_lf_executables_and_hash_as_lf(checkout, tmp_path):
    runtime = checkout / "packages/sandbox-runtime/src/sandbox_runtime"
    launchers = [
        runtime / "bin/oi-git-sign",  # /bin/sh launcher that git executes directly (index 100755)
        runtime / "bin/upload-media.js",  # node shebang
        runtime / "credentials/git_credential_helper.py",  # python shebang
    ]
    lf = {path: path.read_bytes().replace(b"\r\n", b"\n") for path in launchers}
    lf_hash = plan_image(checkout, "vps")["buildHash"]
    for path in launchers:
        path.write_bytes(lf[path].replace(b"\n", b"\r\n"))
    assert plan_image(checkout, "vps")["buildHash"] == lf_hash
    bundle = pack_bundle(checkout, "vps", tmp_path / "bundles")
    for path in launchers:
        packed = bundle.directory / path.relative_to(checkout)
        assert packed.read_bytes() == lf[path]
        if os.name != "nt":  # NTFS cannot store the exec bit checked here
            assert packed.stat().st_mode & 0o777 == 0o755
