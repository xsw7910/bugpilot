from __future__ import annotations

from pathlib import Path

import pytest

from bugpilot.cli import main
from bugpilot.core.agent_runner import AgentRunResult, build_agent_command, run_agent
from bugpilot.core.config import load_config

HANDOFF = "Read .ai/JR-12345/agent_task.md and complete the workflow."


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
    cmd = build_agent_command("claude", "JR-12345", load_config(tmp_path))
    assert cmd == ["claude", "--permission-mode", "acceptEdits", HANDOFF]


def test_build_agent_command_copilot_defaults(tmp_path):
    cmd = build_agent_command("copilot", "JR-12345", load_config(tmp_path))
    assert cmd == ["copilot", HANDOFF]


def test_build_agent_command_respects_env(tmp_path, monkeypatch):
    monkeypatch.setenv("BUGPILOT_CLAUDE_COMMAND", "claude.cmd")
    monkeypatch.setenv("BUGPILOT_CLAUDE_ARGS", "--dangerously-skip-permissions")
    cmd = build_agent_command("claude", "JR-12345", load_config(tmp_path))
    assert cmd[0] == "claude.cmd"
    assert "--dangerously-skip-permissions" in cmd
    assert cmd[-1] == HANDOFF


def test_run_agent_skips_when_binary_missing(tmp_path, monkeypatch):
    monkeypatch.setattr("bugpilot.core.agent_runner.shutil.which", lambda c: None)
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
    monkeypatch.setattr("bugpilot.core.agent_runner.shutil.which", lambda c: "/usr/bin/claude")
    calls = {}

    def fake_run(cmd, cwd=None):
        calls["cmd"] = cmd
        calls["cwd"] = cwd
        return _Done()

    monkeypatch.setattr("bugpilot.core.agent_runner.subprocess.run", fake_run)
    result = run_agent(tmp_path, "JR-12345", "claude")
    assert result.ran is True
    assert result.returncode == 0
    assert Path(calls["cwd"]) == tmp_path
    assert calls["cmd"][0] == "/usr/bin/claude"
    assert calls["cmd"][-1] == HANDOFF


def test_run_agent_wraps_windows_cmd_shim(tmp_path, monkeypatch):
    monkeypatch.setattr("bugpilot.core.agent_runner.sys.platform", "win32")
    monkeypatch.setattr("bugpilot.core.agent_runner.shutil.which", lambda c: r"C:\npm\claude.cmd")
    calls = {}

    def fake_run(cmd, cwd=None):
        calls["cmd"] = cmd
        return _Done()

    monkeypatch.setattr("bugpilot.core.agent_runner.subprocess.run", fake_run)
    run_agent(tmp_path, "JR-12345", "claude")
    assert calls["cmd"][:3] == ["cmd", "/c", r"C:\npm\claude.cmd"]
    assert calls["cmd"][-1] == HANDOFF


def _spy_run_agent(monkeypatch, captured):
    def spy(repo_root, issue_key, agent, config=None, prompt=None):
        captured["repo_root"] = repo_root
        captured["issue_key"] = issue_key
        captured["agent"] = agent
        captured["prompt"] = prompt
        return AgentRunResult(agent=agent, ran=True, command=[agent, HANDOFF], returncode=0)

    monkeypatch.setattr("bugpilot.core.agent_runner.run_agent", spy)


def test_bug_launches_claude_by_default(tmp_path, monkeypatch, capsys):
    captured = {}
    _spy_run_agent(monkeypatch, captured)
    monkeypatch.chdir(tmp_path)

    assert main(["bug", "JR-12345", "--allow-mock"]) == 0
    out = capsys.readouterr().out

    assert "Launching claude to complete the workflow" in out
    assert captured["agent"] == "claude"
    assert captured["issue_key"] == "JR-12345"
    assert Path(captured["repo_root"]) == tmp_path


def test_bug_prepare_only_does_not_invoke_agent(tmp_path, monkeypatch):
    captured = {}
    _spy_run_agent(monkeypatch, captured)
    monkeypatch.chdir(tmp_path)

    assert main(["bug", "JR-12345", "--prepare-only", "--allow-mock"]) == 0
    assert captured == {}


def test_bug_copilot_flag_launches_copilot(tmp_path, monkeypatch):
    captured = {}
    _spy_run_agent(monkeypatch, captured)
    monkeypatch.chdir(tmp_path)

    assert main(["bug", "JR-12345", "--copilot", "--allow-mock"]) == 0
    assert captured["agent"] == "copilot"


def test_bug_missing_binary_warns(tmp_path, monkeypatch, capsys):
    monkeypatch.setattr("bugpilot.core.agent_runner.shutil.which", lambda c: None)
    monkeypatch.chdir(tmp_path)

    assert main(["bug", "JR-12345", "--allow-mock"]) == 1
    err = capsys.readouterr().err
    assert "could not launch claude" in err
    assert "Read .ai/JR-12345/agent_task.md" in err


def test_launching_an_agent_says_it_is_deprecated(tmp_path, monkeypatch, capsys):
    """Phase 7 marks this path deprecated; V1 still ships it working.

    The notice goes to stderr so requirement R1 holds: every existing command's
    human-readable stdout is unchanged.
    """
    monkeypatch.setattr("bugpilot.core.agent_runner.shutil.which", lambda c: None)
    result = run_agent(tmp_path, "JR-1", "claude")

    captured = capsys.readouterr()
    assert result.ran is False
    assert "deprecated" in captured.err
    assert "--prepare-only" in captured.err
    assert captured.out == "", "the deprecation notice must not touch stdout"
