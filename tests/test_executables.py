"""No program is ever started from the repository just because it is the cwd.

On Windows a bare program name is looked up in the
current directory before PATH — by CreateProcess and by ``shutil.which`` alike
— unless ``NoDefaultCurrentDirectoryInExePath`` is set. BugPilot runs with the
repository as its current directory, so a committed ``git.exe`` or ``rg.exe``
would have run in place of the real tool. These tests plant harmless fakes (a
copy of ``whoami.exe`` on Windows, a script elsewhere) and prove they are never
the program that runs.
"""

from __future__ import annotations

import os
import shutil
import stat
import sys
from pathlib import Path

import pytest

from bugpilot.core import agent_runner, executables, git_ops
from bugpilot.core.executables import child_environment, find_executable

WINDOWS = sys.platform == "win32"


def _plant(directory: Path, name: str) -> Path:
    """A fake program named ``name`` in ``directory``: harmless, and identifiable."""
    if WINDOWS:
        target = directory / f"{name}.exe"
        shutil.copyfile(Path(os.environ.get("SystemRoot", r"C:\Windows")) / "System32" / "whoami.exe", target)
    else:
        target = directory / name
        target.write_text("#!/bin/sh\necho FAKE-FROM-REPOSITORY\n", encoding="utf-8")
        target.chmod(target.stat().st_mode | stat.S_IXUSR)
    return target


@pytest.fixture
def hostile_repo(tmp_path, monkeypatch):
    """A repository root holding fake git, rg, claude and bugpilot, as the cwd."""
    repo = tmp_path / "repo"
    repo.mkdir()
    for name in ("git", "rg", "claude", "bugpilot", "onlyhere"):
        _plant(repo, name)
    # A normal user's environment: this switch is what hides the problem.
    monkeypatch.delenv("NoDefaultCurrentDirectoryInExePath", raising=False)
    monkeypatch.chdir(repo)
    return repo


def _inside(path: str | None, directory: Path) -> bool:
    return path is not None and Path(path).resolve().parent == directory.resolve()


@pytest.mark.skipif(not WINDOWS, reason="the current-directory lookup is Windows behaviour")
def test_the_hazard_is_real_on_this_platform(hostile_repo):
    """shutil.which picks the repository's fake — which is why BugPilot no longer uses it."""
    assert _inside(shutil.which("onlyhere"), hostile_repo)


def test_a_bare_name_never_resolves_to_the_repository(hostile_repo):
    for name in ("git", "rg", "claude", "bugpilot", "onlyhere"):
        assert not _inside(find_executable(name), hostile_repo), name
    assert find_executable("onlyhere") is None


def test_dot_empty_and_relative_path_entries_are_not_searched(hostile_repo, monkeypatch):
    elsewhere = hostile_repo.parent / "tools"
    elsewhere.mkdir()
    real = _plant(elsewhere, "toolx")
    _plant(hostile_repo, "toolx")
    for path in (f".{os.pathsep}{elsewhere}", f"{os.pathsep}{elsewhere}", f"repo{os.pathsep}{elsewhere}"):
        monkeypatch.setenv("PATH", path)
        assert Path(find_executable("toolx")) == real, path


def test_an_absolute_path_is_kept_and_a_relative_one_with_a_directory_is_refused(hostile_repo):
    fake = next(hostile_repo.glob("git*"))
    assert find_executable(str(fake)) == str(fake)
    assert find_executable(f"./{fake.name}") is None
    assert find_executable(f"sub{os.sep}{fake.name}") is None
    assert find_executable("") is None


@pytest.mark.skipif(shutil.which("git", path=os.environ.get("PATH")) is None, reason="needs git on PATH")
def test_git_runs_the_real_git(hostile_repo):
    code, output = git_ops.run_command(["git", "--version"], hostile_repo)
    assert code == 0 and output.startswith("git version"), output
    assert git_ops.command_available("git")
    assert not git_ops.command_available("onlyhere")


def test_a_program_only_in_the_repository_is_not_found(hostile_repo):
    code, output = git_ops.run_command(["onlyhere"], hostile_repo)
    assert code == 127 and "not found" in output


def test_the_deprecated_agent_launcher_never_starts_the_repository_claude(hostile_repo, monkeypatch):
    monkeypatch.setenv("PATH", str(hostile_repo.parent / "nowhere"))
    assert agent_runner._resolve_launch_command(["claude", "Read the task."]) is None


@pytest.mark.skipif(not WINDOWS, reason="Windows batch shims")
def test_a_batch_shim_runs_through_the_system_cmd_by_absolute_path(hostile_repo, monkeypatch):
    shims = hostile_repo.parent / "npm"
    shims.mkdir()
    (shims / "claude.cmd").write_text("@echo off\r\n", encoding="utf-8")
    monkeypatch.setenv("PATH", f"{shims}{os.pathsep}{os.environ['SystemRoot']}\\System32")
    launch = agent_runner._resolve_launch_command(["claude", "Read the task."])
    assert launch is not None
    assert Path(launch[0]).name.lower() == "cmd.exe" and Path(launch[0]).is_absolute()
    assert not _inside(launch[0], hostile_repo)
    assert launch[1] == "/c"
    assert os.path.normcase(launch[2]) == os.path.normcase(str(shims / "claude.cmd"))


def test_children_inherit_the_switch_that_keeps_the_cwd_out_of_their_lookups():
    env = child_environment({"PATH": "x"})
    assert env["PATH"] == "x"
    assert env.get("NoDefaultCurrentDirectoryInExePath") == ("1" if WINDOWS else None)


def test_no_module_starts_a_program_by_its_bare_name():
    """Every launch goes through find_executable; no shutil.which, no bare argv[0]."""
    package = Path(executables.__file__).parent
    offenders = []
    for source in package.rglob("*.py"):
        text = source.read_text(encoding="utf-8")
        if "shutil.which(" in text:
            offenders.append(f"{source.name}: shutil.which")
        for bare in ('Popen(\n            ["git"', 'Popen(["git"', 'subprocess.run(\n            args,', 'subprocess.run(args'):
            if bare in text:
                offenders.append(f"{source.name}: {bare!r}")
    assert offenders == []


# --- git and rg only as native programs, never batch files (0.1.7, S-8) ----------------------------


@pytest.fixture
def windows_lookup(monkeypatch):
    """Windows' lookup rules (PATHEXT, batch files), on any system: only `executables` is told it runs on Windows."""
    monkeypatch.setattr(executables, "_is_windows", lambda: True)
    # Lower case, so the names built from it match these files on a case-sensitive system too.
    monkeypatch.setenv("PATHEXT", ".com;.exe;.bat;.cmd")


def _file(folder: Path, name: str) -> Path:
    folder.mkdir(parents=True, exist_ok=True)
    (folder / name).write_text("@echo off\r\n" if name.endswith((".cmd", ".bat")) else "", encoding="utf-8")
    return folder / name


@pytest.mark.parametrize("batch", ["git.cmd", "git.bat"])
def test_a_batch_file_earlier_on_path_is_passed_over_for_the_program(tmp_path, monkeypatch, windows_lookup, batch):
    shim = _file(tmp_path / "shims", batch)
    program = _file(tmp_path / "Git" / "cmd", "git.exe")
    monkeypatch.setenv("PATH", os.pathsep.join([str(shim.parent), str(program.parent)]))

    assert executables.find_program("git") == str(program)
    assert executables.batch_file_only("git") is None
    # Agents keep the general lookup: the launcher's own batch-file path is gated (S-1).
    assert find_executable("git") == str(shim)


def test_git_or_rg_only_as_a_batch_file_is_not_found_and_says_why(tmp_path, monkeypatch, windows_lookup):
    shim = _file(tmp_path / "shims", "rg.cmd")
    monkeypatch.setenv("PATH", str(shim.parent))

    assert executables.find_program("rg") is None
    assert executables.batch_file_only("rg") == str(shim)
    assert git_ops.program_available("rg") is False
    sentence = executables.not_found_sentence("rg")
    assert "only as a batch file (rg.cmd)" in sentence and "cmd.exe" in sentence and "Install rg as a program" in sentence
    assert executables.find_program("rg.cmd") is None, "named with its extension, still not a program"
    assert executables.find_program(str(shim)) is None, "an absolute path to a batch file is refused too"


def test_a_missing_program_is_still_just_not_found(tmp_path, monkeypatch, windows_lookup):
    monkeypatch.setenv("PATH", str(tmp_path / "empty"))
    assert executables.find_program("git") is None and executables.batch_file_only("git") is None
    assert executables.not_found_sentence("git") == "git was not found on PATH."


def test_elsewhere_than_windows_a_program_is_found_as_before(tmp_path, monkeypatch):
    monkeypatch.setattr(executables, "_is_windows", lambda: False)
    tool = tmp_path / "bin" / "rg"
    tool.parent.mkdir()
    tool.write_text("#!/bin/sh\n", encoding="utf-8")
    tool.chmod(tool.stat().st_mode | stat.S_IXUSR)
    monkeypatch.setenv("PATH", str(tool.parent))
    assert executables.find_program("rg") == executables.find_executable("rg")


def test_git_is_never_started_as_a_batch_file_and_the_reason_is_returned(tmp_path, monkeypatch, windows_lookup):
    _file(tmp_path / "shims", "git.cmd")
    monkeypatch.setenv("PATH", str(tmp_path / "shims"))
    started = []
    monkeypatch.setattr(git_ops.subprocess, "run", lambda *args, **kwargs: started.append(args))

    code, output = git_ops.run_command(["git", "log", "--grep=a&b"], tmp_path)

    assert (code, started) == (127, [])
    assert "only as a batch file (git.cmd)" in output


def test_rg_is_never_started_as_a_batch_file(tmp_path, monkeypatch, windows_lookup):
    from bugpilot.core import search

    _file(tmp_path / "shims", "rg.bat")
    monkeypatch.setenv("PATH", str(tmp_path / "shims"))
    started = []
    monkeypatch.setattr(search.subprocess, "run", lambda *args, **kwargs: started.append(args))
    warnings: list[str] = []

    assert search._run_rg(tmp_path, "a&b", warnings) is None
    assert started == []
    assert warnings and "only as a batch file (rg.bat)" in warnings[0]


def test_every_git_and_rg_start_looks_for_a_native_program():
    """The modules that start git or rg never use the general lookup, which returns batch files (S-8)."""
    core = Path(executables.__file__).parent
    for name in ("git_ops.py", "search.py", "review_changes.py", "git_history.py"):
        text = (core / name).read_text(encoding="utf-8")
        # git_ops' `command_available` keeps the general lookup: it answers for agents (claude, copilot, gh).
        body = text.split("def command_available", 1)[0] + text.split("def program_available", 1)[-1] if name == "git_ops.py" else text
        assert "find_executable(" not in body, name
        assert "find_program(" in text, name
    doctor = (core / "doctor.py").read_text(encoding="utf-8")
    assert 'program_available("git")' in doctor and 'program_available("rg")' in doctor
