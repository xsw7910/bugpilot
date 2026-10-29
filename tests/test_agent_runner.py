from __future__ import annotations

import os
import sys
from pathlib import Path

import pytest

from bugpilot.cli import main
from bugpilot.core.agent_runner import AgentRunResult, build_agent_command, run_agent
from bugpilot.core.config import data_dir, issue_dir, load_config, prompt_path, writable_issue_dir
from bugpilot.core.handoff import work_item_handoff
from bugpilot.core.safe_paths import UnsafePathError


def _handoff(root: Path) -> str:
    """The sentence an agent is launched with: the work item's task.md, named absolutely (0.1.7)."""
    return work_item_handoff(root, "JR-12345")


def _prepared(root: Path, key: str = "JR-12345") -> Path:
    """The work item's folder, made by storage as a preparation makes it: Claude is granted only a folder that is there."""
    return writable_issue_dir(root, key)


def _grant(root: Path, key: str = "JR-12345") -> str:
    """The one word that gives Claude Code the work item's folder (0.1.7)."""
    return f"--add-dir={prompt_path(issue_dir(root, key))}"


@pytest.fixture(autouse=True)
def clear_env(monkeypatch):
    for name in (
        "JIRA_BASE_URL", "JIRA_EMAIL", "JIRA_TOKEN",
        "BUGPILOT_CLAUDE_COMMAND", "BUGPILOT_CLAUDE_ARGS",
        "BUGPILOT_COPILOT_COMMAND", "BUGPILOT_COPILOT_ARGS",
    ):
        monkeypatch.delenv(name, raising=False)


class _Done:
    returncode = 0


def test_build_agent_command_claude_defaults(tmp_path):
    _prepared(tmp_path)
    cmd = build_agent_command("claude", "JR-12345", load_config(tmp_path))
    assert cmd == ["claude", "--permission-mode", "acceptEdits", _grant(tmp_path), _handoff(tmp_path)]


def test_build_agent_command_copilot_defaults(tmp_path):
    cmd = build_agent_command("copilot", "JR-12345", load_config(tmp_path))
    assert cmd == ["copilot", _handoff(tmp_path)]


def test_build_agent_command_respects_env(tmp_path, monkeypatch):
    _prepared(tmp_path)
    monkeypatch.setenv("BUGPILOT_CLAUDE_COMMAND", "claude.cmd")
    monkeypatch.setenv("BUGPILOT_CLAUDE_ARGS", "--dangerously-skip-permissions")
    cmd = build_agent_command("claude", "JR-12345", load_config(tmp_path))
    assert cmd[0] == "claude.cmd"
    assert "--dangerously-skip-permissions" in cmd
    assert cmd[-1] == _handoff(tmp_path)


def test_run_agent_skips_when_binary_missing(tmp_path, monkeypatch):
    _prepared(tmp_path)
    monkeypatch.setattr("bugpilot.core.agent_runner.find_executable", lambda c: None)
    called = {"v": False}
    monkeypatch.setattr(
        "bugpilot.core.agent_runner.subprocess.run",
        lambda *a, **k: called.__setitem__("v", True),
    )
    result = run_agent(tmp_path, "JR-12345", "claude")
    assert result.ran is False
    assert "not found" in (result.skipped_reason or "")
    assert called["v"] is False


def test_run_agent_invokes_subprocess_in_repo_root(tmp_path, monkeypatch):
    _prepared(tmp_path)
    monkeypatch.setattr("bugpilot.core.agent_runner.find_executable", lambda c: "/usr/bin/claude")
    calls = {}

    def fake_run(cmd, cwd=None, env=None):
        calls["cmd"] = cmd
        calls["cwd"] = cwd
        return _Done()

    monkeypatch.setattr("bugpilot.core.agent_runner.subprocess.run", fake_run)
    result = run_agent(tmp_path, "JR-12345", "claude")
    assert result.ran is True
    assert result.returncode == 0
    assert Path(calls["cwd"]) == tmp_path
    assert calls["cmd"][0] == "/usr/bin/claude"
    assert calls["cmd"][-1] == _handoff(tmp_path)


def test_run_agent_wraps_windows_cmd_shim(tmp_path, monkeypatch):
    _prepared(tmp_path)
    monkeypatch.setattr("bugpilot.core.agent_runner.sys.platform", "win32")
    found = {"claude": r"C:\npm\claude.cmd", r"C:\Windows\System32\cmd.exe": r"C:\Windows\System32\cmd.exe"}
    monkeypatch.setenv("ComSpec", r"C:\Windows\System32\cmd.exe")
    monkeypatch.setattr("bugpilot.core.agent_runner.find_executable", lambda c: found.get(c))
    calls = {}

    def fake_run(cmd, cwd=None, env=None):
        calls["cmd"] = cmd
        return _Done()

    monkeypatch.setattr("bugpilot.core.agent_runner.subprocess.run", fake_run)
    run_agent(tmp_path, "JR-12345", "claude")
    # The system's cmd.exe by absolute path, never a bare `cmd` a repository could shadow.
    assert calls["cmd"][:3] == [r"C:\Windows\System32\cmd.exe", "/c", r"C:\npm\claude.cmd"]
    # One argument for the folder, then the prompt as its own: argv, never a shell line.
    assert calls["cmd"][-2:] == [_grant(tmp_path), _handoff(tmp_path)]


def _spy_run_agent(monkeypatch, captured):
    def spy(repo_root, issue_key, agent, config=None, prompt=None):
        captured["repo_root"] = repo_root
        captured["issue_key"] = issue_key
        captured["agent"] = agent
        captured["prompt"] = prompt
        return AgentRunResult(agent=agent, ran=True, command=[agent, prompt or _handoff(repo_root)], returncode=0)

    monkeypatch.setattr("bugpilot.core.agent_runner.run_agent", spy)


def test_bare_bug_prepares_only_and_launches_no_agent(tmp_path, monkeypatch, capsys):
    """The public default: prepare, then stop. No agent unless a flag names one."""
    captured = {}
    _spy_run_agent(monkeypatch, captured)
    monkeypatch.chdir(tmp_path)

    assert main(["bug", "JR-12345", "--allow-mock"]) == 0
    out = capsys.readouterr().out

    assert captured == {}, "a bare bug command launched an agent"
    assert "Launching" not in out
    assert "Next manual agent instruction:" in out
    assert _handoff(tmp_path) in out


def test_the_default_command_form_launches_no_agent_either(tmp_path, monkeypatch):
    # `bugpilot JR-12345` is `bugpilot bug JR-12345`, default included.
    captured = {}
    _spy_run_agent(monkeypatch, captured)
    monkeypatch.chdir(tmp_path)

    assert main(["JR-12345", "--allow-mock"]) == 0
    assert captured == {}


def test_bug_prepare_only_does_not_invoke_agent(tmp_path, monkeypatch):
    captured = {}
    _spy_run_agent(monkeypatch, captured)
    monkeypatch.chdir(tmp_path)

    assert main(["bug", "JR-12345", "--prepare-only", "--allow-mock"]) == 0
    assert captured == {}


def test_launch_agent_claude_launches_claude(tmp_path, monkeypatch, capsys):
    captured = {}
    _spy_run_agent(monkeypatch, captured)
    monkeypatch.chdir(tmp_path)

    assert main(["bug", "JR-12345", "--launch-agent", "claude", "--allow-mock"]) == 0
    out = capsys.readouterr().out

    assert "Launching claude to complete the workflow" in out
    assert captured["agent"] == "claude"
    assert captured["issue_key"] == "JR-12345"
    assert Path(captured["repo_root"]) == tmp_path


def test_launch_agent_copilot_launches_copilot(tmp_path, monkeypatch):
    captured = {}
    _spy_run_agent(monkeypatch, captured)
    monkeypatch.chdir(tmp_path)

    assert main(["bug", "JR-12345", "--launch-agent=copilot", "--allow-mock"]) == 0
    assert captured["agent"] == "copilot"


@pytest.mark.parametrize(
    "argv",
    [
        ["bug", "JR-12345", "--copilot"],
        ["bug", "JR-12345", "--claude"],
        ["bug", "JR-12345", "--launch-agent", "gpt"],
        ["bug", "JR-12345", "--launch-agent", "claude", "--prepare-only"],
    ],
)
def test_agent_launch_is_one_explicit_flag(tmp_path, monkeypatch, argv):
    """No implicit agent, no second spelling, and never both prepare-only and a launch."""
    captured = {}
    _spy_run_agent(monkeypatch, captured)
    monkeypatch.chdir(tmp_path)

    with pytest.raises(SystemExit) as exc:
        main(argv)
    assert exc.value.code == 2
    assert captured == {}
    assert not ((data_dir(tmp_path) / "work")).exists()


@pytest.mark.parametrize("mode", ["--json", "--json-lines"])
def test_launch_agent_is_refused_in_machine_readable_modes(tmp_path, monkeypatch, capsys, mode):
    captured = {}
    _spy_run_agent(monkeypatch, captured)
    monkeypatch.chdir(tmp_path)

    assert main(["bug", "JR-12345", "--allow-mock", "--launch-agent", "claude", mode]) == 1
    out = capsys.readouterr().out

    assert captured == {}
    assert "INVALID_INPUT" in out
    assert not ((data_dir(tmp_path) / "work")).exists()


def test_retry_prepares_only_unless_an_agent_is_named(tmp_path, monkeypatch, capsys):
    captured = {}
    _spy_run_agent(monkeypatch, captured)
    monkeypatch.chdir(tmp_path)
    assert main(["bug", "JR-12345", "--allow-mock"]) == 0
    assert main(["bug", "JR-12345", "--retry"]) == 0  # creates user_feedback.md and stops
    capsys.readouterr()

    assert main(["bug", "JR-12345", "--retry"]) == 0
    assert captured == {}
    retry = f"Read {prompt_path(issue_dir(tmp_path, 'JR-12345') / 'agent_retry_prompt.md')} and continue the workflow."
    assert retry in capsys.readouterr().out

    assert main(["bug", "JR-12345", "--retry", "--launch-agent", "claude"]) == 0
    assert captured["agent"] == "claude"
    assert captured["prompt"] == retry


def test_bug_missing_binary_warns(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr("bugpilot.core.agent_runner.find_executable", lambda c: None)
    monkeypatch.chdir(tmp_path)

    assert main(["bug", "JR-12345", "--allow-mock", "--launch-agent", "claude"]) == 1
    err = capsys.readouterr().err
    assert "could not launch claude" in err
    assert _handoff(tmp_path) in err


def test_agent_check_describes_the_real_default(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)

    assert main(["agent-check"]) == 0
    out = capsys.readouterr().out

    assert "default_mode: prepare-only" in out
    assert "--launch-agent claude|copilot" in out
    assert "--claude" not in out


def test_launching_an_agent_says_it_is_deprecated(tmp_path, monkeypatch, capsys):
    """Phase 7 marks this path deprecated; V1 still ships it working.

    The notice goes to stderr so requirement R1 holds: every existing command's
    human-readable stdout is unchanged.
    """
    monkeypatch.setattr("bugpilot.core.agent_runner.find_executable", lambda c: None)
    result = run_agent(tmp_path, "JR-1", "claude")

    captured = capsys.readouterr()
    assert result.ran is False
    assert "deprecated" in captured.err
    assert "prepare-only is the default" in captured.err
    assert captured.out == "", "the deprecation notice must not touch stdout"


# --- the work folder for Claude Code (0.1.7) ---------------------------------------


def _fake_run(monkeypatch):
    monkeypatch.setattr("bugpilot.core.agent_runner.find_executable", lambda c: "/usr/bin/" + c)
    calls = []

    def fake_run(cmd, cwd=None, env=None):
        calls.append(cmd)
        return _Done()

    monkeypatch.setattr("bugpilot.core.agent_runner.subprocess.run", fake_run)
    return calls


def test_claude_is_given_the_work_folder_in_one_argument_with_spaces_and_unicode(tmp_path, monkeypatch):
    """The work folder may hold spaces and any letter: one argv element, `--add-dir=<folder>`, never split,
    then the prompt as its own element. `--add-dir` takes several folders, so as two words the prompt would
    be read as another one."""
    home = tmp_path / "Zoë Müller" / "data folder"
    home.parent.mkdir()
    monkeypatch.setenv("BUGPILOT_HOME", str(home))
    root = tmp_path / "repo"
    root.mkdir()
    folder = _prepared(root)
    assert " " in str(folder) and "ë" in str(folder)
    calls = _fake_run(monkeypatch)

    assert run_agent(root, "JR-12345", "claude").ran is True
    (cmd,) = calls
    grants = [arg for arg in cmd if arg.startswith("--add-dir")]
    assert grants == [f"--add-dir={folder.as_posix()}"]
    assert cmd[-1] == _handoff(root)
    assert cmd.index(grants[0]) == len(cmd) - 2


def test_the_grant_is_the_work_items_folder_never_the_data_folder(tmp_path):
    _prepared(tmp_path)
    (grant,) = [arg for arg in build_agent_command("claude", "JR-12345", load_config(tmp_path)) if arg.startswith("--add-dir")]
    assert grant == f"--add-dir={prompt_path(data_dir(tmp_path) / 'work' / 'JR-12345')}"


@pytest.mark.parametrize("form", ["two words", "equals", "other spelling"])
def test_a_folder_the_configured_arguments_grant_already_is_not_granted_twice(tmp_path, monkeypatch, form):
    folder = _prepared(tmp_path)
    if form == "two words":
        given = f'--add-dir "{folder}"'
    elif form == "equals":
        given = f'"--add-dir={folder.as_posix()}"'
    else:  # the same folder, written differently: other separators, other case where the system ignores case
        written = str(folder).replace("\\", "/")
        given = f'--add-dir "{written.upper() if sys.platform == "win32" else written}/"'
    monkeypatch.setenv("BUGPILOT_CLAUDE_ARGS", f"--permission-mode acceptEdits {given} --verbose")
    cmd = build_agent_command("claude", "JR-12345", load_config(tmp_path))
    assert sum(arg.startswith("--add-dir") for arg in cmd) == 1
    assert cmd[-1] == _handoff(tmp_path)


def test_the_configured_arguments_are_kept_as_they_are_and_another_folder_does_not_count(tmp_path, monkeypatch):
    _prepared(tmp_path)
    elsewhere = tmp_path / "elsewhere"
    monkeypatch.setenv("BUGPILOT_CLAUDE_ARGS", f'--model sonnet --add-dir "{elsewhere}"')
    cmd = build_agent_command("claude", "JR-12345", load_config(tmp_path))
    # The developer's arguments first and unchanged; the grant is its own option after them, so the prompt is
    # never read as one more folder of theirs.
    assert cmd == ["claude", "--model", "sonnet", "--add-dir", str(elsewhere), _grant(tmp_path), _handoff(tmp_path)]


def test_copilot_is_launched_as_before(tmp_path, monkeypatch):
    """Only Claude Code: Copilot's command is not changed."""
    _prepared(tmp_path)
    monkeypatch.setenv("BUGPILOT_COPILOT_ARGS", "--allow-tool write")
    cmd = build_agent_command("copilot", "JR-12345", load_config(tmp_path))
    assert cmd == ["copilot", "--allow-tool", "write", _handoff(tmp_path)]
    assert not any("add-dir" in arg for arg in cmd)


def test_a_retry_grants_the_same_folder(tmp_path):
    _prepared(tmp_path)
    retry = f"Read {prompt_path(issue_dir(tmp_path, 'JR-12345') / 'agent_retry_prompt.md')} and continue the workflow."
    cmd = build_agent_command("claude", "JR-12345", load_config(tmp_path), prompt=retry)
    assert cmd[-2:] == [_grant(tmp_path), retry]


def test_without_its_folder_claude_is_not_started(tmp_path, monkeypatch, capsys):
    """Claude Code refuses a folder that is not there; BugPilot says so first and starts nothing."""
    calls = _fake_run(monkeypatch)
    result = run_agent(tmp_path, "JR-12345", "claude")
    assert result.ran is False
    assert "is not there" in (result.skipped_reason or "")
    assert calls == []
    assert not (data_dir(tmp_path) / "work").exists()


def test_an_invalid_work_item_id_is_never_granted(tmp_path, monkeypatch):
    calls = _fake_run(monkeypatch)
    with pytest.raises(UnsafePathError):
        build_agent_command("claude", "../JR-1", load_config(tmp_path))
    assert run_agent(tmp_path, "../JR-1", "claude").ran is False
    assert calls == []


def test_a_linked_work_folder_is_never_granted(tmp_path, monkeypatch):
    """A link or junction at work/<id> is refused by storage's checks, as for every other use of the folder."""
    if sys.platform != "win32":
        target = tmp_path / "elsewhere"
        target.mkdir()
        _prepared(tmp_path, "JR-1").parent.mkdir(exist_ok=True)
        try:
            os.symlink(target, issue_dir(tmp_path, "JR-12345"), target_is_directory=True)
        except (OSError, NotImplementedError) as exc:
            pytest.skip(f"cannot create a symbolic link here: {exc}")
    else:
        import _winapi

        target = tmp_path / "elsewhere"
        target.mkdir()
        _prepared(tmp_path, "JR-1")
        _winapi.CreateJunction(str(target), str(issue_dir(tmp_path, "JR-12345")))
    calls = _fake_run(monkeypatch)
    result = run_agent(tmp_path, "JR-12345", "claude")
    assert result.ran is False
    assert result.skipped_reason
    assert calls == []
