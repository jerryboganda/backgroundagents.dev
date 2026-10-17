"""Seeding in vps/entrypoint.sh, run through bash on real directories."""

import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

ENTRYPOINT = Path(__file__).resolve().parents[1] / "vps/entrypoint.sh"
BASH = shutil.which("bash")
pytestmark = pytest.mark.skipif(BASH is None, reason="the seed is exercised through bash")


def write_files(root, files):
    for name, text in files.items():
        path = root / name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)


def seed(seed_dir, home):
    # Sourcing defines seed_home without running the entrypoint's main block.
    return subprocess.run(
        [
            BASH,
            "-c",
            'source "$1"; seed_home "$2" "$3"',
            "entrypoint",
            ENTRYPOINT.as_posix(),
            seed_dir.as_posix(),
            home.as_posix(),
        ],
        capture_output=True,
        text=True,
    )


@pytest.fixture
def dirs(tmp_path):
    seed_dir, home = tmp_path / "seed", tmp_path / "home"
    seed_dir.mkdir()
    home.mkdir()
    return seed_dir, home


def test_seed_adds_missing_paths_and_keeps_user_entries(dirs):
    seed_dir, home = dirs
    write_files(
        seed_dir,
        {".bashrc": "seed", ".config/opencode/opencode.json": "{}", ".local/bin/tool": "t"},
    )
    write_files(
        home, {".bashrc": "user", ".config/opencode/mine.json": "mine", ".openinspect-marker": "m"}
    )

    result = seed(seed_dir, home)

    assert result.returncode == 0, result.stderr
    assert (home / ".bashrc").read_text() == "user"
    assert (home / ".config/opencode/mine.json").read_text() == "mine"
    assert (home / ".openinspect-marker").read_text() == "m"
    assert (home / ".config/opencode/opencode.json").read_text() == "{}"
    assert (home / ".local/bin/tool").read_text() == "t"
    assert seed(seed_dir, home).returncode == 0
    assert (home / ".bashrc").read_text() == "user"


def test_seed_refuses_a_symlinked_parent_before_writing(dirs, tmp_path):
    seed_dir, home = dirs
    outside = tmp_path / "outside"
    outside.mkdir()
    write_files(seed_dir, {".config/opencode/opencode.json": "{}"})
    try:
        (home / ".config").symlink_to(outside, target_is_directory=True)
    except OSError as error:
        pytest.skip(f"creating symlinks needs OS privilege: {error}")

    result = seed(seed_dir, home)

    assert result.returncode != 0
    assert "refusing to seed through it" in result.stderr
    assert list(outside.iterdir()) == []


def test_seed_refuses_a_file_where_the_seed_needs_a_directory(dirs):
    seed_dir, home = dirs
    write_files(seed_dir, {".config/opencode/opencode.json": "{}"})
    write_files(home, {".config": "user file"})

    result = seed(seed_dir, home)

    assert result.returncode != 0
    assert "needs a directory" in result.stderr
    assert (home / ".config").read_text() == "user file"


def test_seed_refuses_a_directory_where_the_seed_needs_a_file(dirs):
    seed_dir, home = dirs
    write_files(seed_dir, {".bashrc": "seed"})
    (home / ".bashrc").mkdir()

    result = seed(seed_dir, home)

    assert result.returncode != 0
    assert "needs a file" in result.stderr
    assert (home / ".bashrc").is_dir()


@pytest.mark.skipif(
    sys.platform == "win32" or os.geteuid() == 0, reason="needs POSIX modes as non-root"
)
def test_seed_refuses_an_unreadable_entry(dirs):
    seed_dir, home = dirs
    write_files(seed_dir, {"secret.json": "{}"})
    (seed_dir / "secret.json").chmod(0)

    result = seed(seed_dir, home)

    assert result.returncode != 0
    assert "not readable by UID" in result.stderr


def test_seed_refuses_a_symlink_where_the_user_has_a_directory(dirs):
    seed_dir, home = dirs
    write_files(seed_dir, {".bashrc": "seed"})
    try:
        (seed_dir / "tool").symlink_to("bin/tool")
    except OSError as error:
        pytest.skip(f"creating symlinks needs OS privilege: {error}")
    write_files(home, {"tool/mine": "mine"})

    result = seed(seed_dir, home)

    assert result.returncode != 0
    assert "needs a file" in result.stderr
    assert (home / "tool/mine").read_text() == "mine"
    # Refusals happen before the first write, so the seed's other entries are not copied either.
    assert not (home / ".bashrc").exists()
