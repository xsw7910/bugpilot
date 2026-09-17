"""Tests for JSONL streaming, list, the Jira gates, and the retry closure."""

from __future__ import annotations

import json

import pytest

from bugpilot.cli import main
from bugpilot.core import errors
from bugpilot.core.agent_runner import RETRY_HANDOFF_PROMPT, AgentRunResult


def _events(capsys) -> list[dict]:
    return [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.strip()]


def _prepare_manual(capsys, description: str = "crash on save") -> str:
    main(["bug", "--description", description, "--prepare-only", "--json"])
    return json.loads(capsys.readouterr().out)["work_item_id"]


# --- 2.3 JSONL stream -------------------------------------------------------


def test_json_lines_brackets_the_run(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    main(["bug", "--description", "crash on save", "--prepare-only", "--json-lines"])
    events = _events(capsys)

    assert events[0]["type"] == "started"
    assert events[0]["source"] == "manual"
    assert events[-1] == {"schema_version": 1, "type": "completed", "ok": True}


def test_every_started_step_is_closed(tmp_path, monkeypatch, capsys):
    """A step left open is how a consumer tells a crash from a completion."""
    monkeypatch.chdir(tmp_path)
    main(["bug", "--description", "crash on save", "--prepare-only", "--json-lines"])
    events = _events(capsys)

    started = [e["step"] for e in events if e["type"] == "step_started"]
    completed = [e["step"] for e in events if e["type"] == "step_completed"]
    assert started == completed
    assert "doctor" in started


def test_skipped_steps_are_announced_before_the_run(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    main([
        "bug", "--description", "crash on save", "--skip-git-history",
        "--prepare-only", "--json-lines",
    ])
    events = _events(capsys)

    skipped = [e for e in events if e["type"] == "step_skipped"]
    assert any(e["step"] == "git_context" and e["reason"] == "plan" for e in skipped)
    assert "git_context" not in [e["step"] for e in events if e["type"] == "step_started"]


def test_artifacts_are_reported_before_completion(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    main(["bug", "--description", "crash on save", "--prepare-only", "--json-lines"])
    events = _events(capsys)

    artifacts = [e["path"] for e in events if e["type"] == "artifact"]
    assert any(path.endswith("agent_task.md") for path in artifacts)
    assert events[-1]["type"] == "completed"


def test_every_line_is_its_own_object(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    main(["bug", "--description", "crash on save", "--prepare-only", "--json-lines"])
    for line in capsys.readouterr().out.splitlines():
        if line.strip():
            assert json.loads(line)["schema_version"] == 1


# --- 2.4 list ---------------------------------------------------------------


def test_list_json_shows_source_and_title(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    work_item = _prepare_manual(capsys, "三维视图切换层位后崩溃")
    main(["bug", "JR-12345", "--allow-mock", "--prepare-only", "--json"])
    capsys.readouterr()

    main(["list", "--json"])
    payload = json.loads(capsys.readouterr().out)
    by_id = {entry["work_item_id"]: entry for entry in payload["work_items"]}

    assert by_id[work_item]["source"] == "manual"
    assert by_id[work_item]["title"] == "三维视图切换层位后崩溃"
    assert by_id["JR-12345"]["source"] == "jira"
    assert all(entry["prepared"] for entry in payload["work_items"])


def test_list_is_empty_before_anything_runs(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    main(["list", "--json"])
    assert json.loads(capsys.readouterr().out)["work_items"] == []


def test_list_human_output_shows_the_title(tmp_path, monkeypatch, capsys):
    """The terminal-side answer to local ids carrying no readable slug."""
    monkeypatch.chdir(tmp_path)
    _prepare_manual(capsys, "3D view crashes after changing horizon")

    main(["list"])
    out = capsys.readouterr().out
    assert "manual" in out
    assert "3D view crashes after changing horizon" in out


def test_list_survives_a_directory_with_no_spec(tmp_path, monkeypatch, capsys):
    """One unreadable work item must not break the listing."""
    monkeypatch.chdir(tmp_path)
    _prepare_manual(capsys)
    (tmp_path / ".ai" / "JR-99999").mkdir(parents=True)

    main(["list", "--json"])
    payload = json.loads(capsys.readouterr().out)
    orphan = next(e for e in payload["work_items"] if e["work_item_id"] == "JR-99999")
    assert orphan["source"] is None
    assert orphan["prepared"] is False


# --- 2.5 Jira gates for manual work items -----------------------------------


@pytest.mark.parametrize("command", ["fetch", "jira-validate"])
def test_jira_only_commands_refuse_a_manual_work_item(tmp_path, monkeypatch, capsys, command):
    monkeypatch.chdir(tmp_path)
    work_item = _prepare_manual(capsys)

    assert main([command, work_item]) == 1
    assert "only applies to a Jira work item" in capsys.readouterr().err


def test_fetch_json_refusal_carries_the_code(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    work_item = _prepare_manual(capsys)

    assert main(["fetch", work_item, "--json"]) == 1
    payload = json.loads(capsys.readouterr().out)
    assert payload["error"]["code"] == errors.JIRA_ONLY_COMMAND


@pytest.mark.parametrize("command", ["jira-comment-draft", "jira-comment"])
def test_jira_write_back_refuses_without_a_target(tmp_path, monkeypatch, capsys, command):
    monkeypatch.chdir(tmp_path)
    work_item = _prepare_manual(capsys)

    assert main([command, work_item]) == 1
    assert "no Jira issue to comment on" in capsys.readouterr().err


def test_summarize_results_refuses_the_jira_comment_flag(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    work_item = _prepare_manual(capsys)

    assert main(["summarize-results", work_item, "--jira-comment", "--json"]) == 1
    payload = json.loads(capsys.readouterr().out)
    assert payload["error"]["code"] == errors.NO_JIRA_TARGET


def test_summarize_results_without_the_flag_still_works(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    work_item = _prepare_manual(capsys)

    assert main(["summarize-results", work_item, "--json"]) == 0
    assert json.loads(capsys.readouterr().out)["ok"] is True


def test_jira_commands_still_work_for_a_jira_work_item(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    main(["bug", "JR-12345", "--allow-mock", "--prepare-only"])
    capsys.readouterr()

    assert main(["jira-comment-draft", "JR-12345"]) == 0


# --- 2.6 retry closure ------------------------------------------------------


def _stub_agent(monkeypatch, captured):
    def spy(repo_root, issue_key, agent, config=None, prompt=None):
        captured["prompt"] = prompt
        return AgentRunResult(agent=agent, ran=True, command=[agent], returncode=0)

    monkeypatch.setattr("bugpilot.core.agent_runner.run_agent", spy)


def test_retry_generates_feedback_and_prompt(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    work_item = _prepare_manual(capsys)

    assert main(["bug", work_item, "--retry", "--prepare-only"]) == 0
    target = tmp_path / ".ai" / work_item
    assert (target / "user_feedback.md").exists()
    assert (target / "agent_retry_prompt.md").exists()


def test_first_retry_stops_for_feedback_instead_of_launching(tmp_path, monkeypatch, capsys):
    """The template holds placeholders, not the developer's account of the failure.

    Handing that to an agent would supply an empty correction — the one input the
    retry loop exists to carry.
    """
    monkeypatch.chdir(tmp_path)
    work_item = _prepare_manual(capsys)
    captured: dict = {}
    _stub_agent(monkeypatch, captured)

    assert main(["bug", work_item, "--retry"]) == 0
    assert captured == {}
    assert "describe what the previous attempt got wrong" in capsys.readouterr().out


def test_retry_hands_the_agent_the_retry_prompt(tmp_path, monkeypatch, capsys):
    """The agent must be pointed at the retry prompt, not the original task."""
    monkeypatch.chdir(tmp_path)
    work_item = _prepare_manual(capsys)
    main(["bug", work_item, "--retry", "--prepare-only"])
    (tmp_path / ".ai" / work_item / "user_feedback.md").write_text(
        "the fix missed the writer path", encoding="utf-8"
    )
    capsys.readouterr()
    captured: dict = {}
    _stub_agent(monkeypatch, captured)

    assert main(["bug", work_item, "--retry"]) == 0
    assert captured["prompt"] == RETRY_HANDOFF_PROMPT.format(
        prompt_file=f".ai/{work_item}/agent_retry_prompt.md"
    )


def test_retry_json_reports_the_files(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    work_item = _prepare_manual(capsys)

    assert main(["bug", work_item, "--retry", "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)
    assert payload["retry"] is True
    assert payload["feedback_created"] is True
    assert payload["retry_prompt"].endswith("agent_retry_prompt.md")


def test_retry_keeps_existing_feedback(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    work_item = _prepare_manual(capsys)
    feedback = tmp_path / ".ai" / work_item / "user_feedback.md"
    main(["bug", work_item, "--retry", "--prepare-only"])
    feedback.write_text("my own notes", encoding="utf-8")
    capsys.readouterr()

    main(["bug", work_item, "--retry", "--prepare-only", "--json"])
    payload = json.loads(capsys.readouterr().out)
    assert payload["feedback_created"] is False
    assert feedback.read_text(encoding="utf-8") == "my own notes"


def test_retry_needs_a_work_item(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    assert main(["bug", "--retry", "--json"]) == 1
    assert json.loads(capsys.readouterr().out)["error"]["code"] == errors.INVALID_INPUT


def test_retry_on_an_unknown_work_item_fails_clearly(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    assert main(["bug", "JR-99999", "--retry", "--json"]) == 1
    assert json.loads(capsys.readouterr().out)["error"]["code"] == errors.WORK_ITEM_NOT_FOUND


def test_check_results_points_at_the_retry_command(tmp_path, monkeypatch, capsys):
    """Discoverability: retry-prompt existed but the flow never mentioned it."""
    monkeypatch.chdir(tmp_path)
    main(["bug", "JR-12345", "--allow-mock", "--prepare-only"])
    capsys.readouterr()

    main(["check-results", "JR-12345"])
    assert "bugpilot bug JR-12345 --retry" in capsys.readouterr().out


# --- review follow-ups ------------------------------------------------------


def test_env_var_cannot_post_a_jira_comment_for_a_manual_item(tmp_path, monkeypatch, capsys):
    """R5: an env var must not slip past the write-back gate."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("BUGPILOT_AUTO_JIRA_COMMENT", "1")
    work_item = _prepare_manual(capsys)
    posted = {"called": False}
    monkeypatch.setattr(
        "bugpilot.cli._post_jira_comment_auto",
        lambda *a, **k: posted.__setitem__("called", True),
    )

    assert main(["summarize-results", work_item]) == 1
    assert posted["called"] is False
    assert "no Jira issue to comment on" in capsys.readouterr().err


def test_json_mode_still_posts_a_requested_jira_comment(tmp_path, monkeypatch, capsys):
    """--json used to return before the auto-comment block, silently skipping it."""
    monkeypatch.chdir(tmp_path)
    main(["bug", "JR-12345", "--allow-mock", "--prepare-only"])
    capsys.readouterr()
    posted = {"called": False}
    monkeypatch.setattr(
        "bugpilot.cli._post_jira_comment_auto",
        lambda *a, **k: posted.__setitem__("called", True),
    )

    assert main(["summarize-results", "JR-12345", "--jira-comment", "--json"]) == 0
    assert posted["called"] is True
    assert json.loads(capsys.readouterr().out)["jira_comment_requested"] is True


@pytest.mark.parametrize("command", ["search", "context"])
def test_unexpected_failures_still_produce_one_json_object(tmp_path, monkeypatch, capsys, command):
    """Without this a traceback goes to stderr and stdout stays empty."""
    monkeypatch.chdir(tmp_path)
    assert main([command, "JR-99999", "--json"]) == 1
    payload = json.loads(capsys.readouterr().out)
    assert payload["ok"] is False
    assert payload["error"]["code"] == errors.ARTIFACT_NOT_FOUND


def test_json_lines_preflight_failure_closes_the_stream(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    assert main(["bug", "--json-lines"]) == 1
    events = _events(capsys)
    assert events[-1]["type"] == "completed"
    assert events[-1]["ok"] is False


def test_bug_json_reports_the_real_jira_title(tmp_path, monkeypatch, capsys):
    """request.spec is the pre-fetch stub; the title only exists after parse."""
    monkeypatch.chdir(tmp_path)
    main(["bug", "JR-12345", "--allow-mock", "--prepare-only", "--json"])
    payload = json.loads(capsys.readouterr().out)
    assert payload["title"]
    assert payload["source_ref"] == "JR-12345"


def test_only_issue_details_reports_no_agent_task(tmp_path, monkeypatch, capsys):
    """The prompt step is skipped, so claiming a task file would point nowhere."""
    monkeypatch.chdir(tmp_path)
    main([
        "bug", "--description", "crash on save", "--only-issue-details",
        "--prepare-only", "--json",
    ])
    payload = json.loads(capsys.readouterr().out)
    assert payload["agent_task"] is None
    assert not (tmp_path / ".ai" / payload["work_item_id"] / "agent_task.md").exists()


def test_only_issue_details_does_not_launch_an_agent(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    captured: dict = {}
    _stub_agent(monkeypatch, captured)

    assert main(["bug", "--description", "crash on save", "--only-issue-details"]) == 0
    assert captured == {}
    assert "nothing to hand to an agent" in capsys.readouterr().out


def test_manual_bug_refuses_the_jira_comment_flag(tmp_path, monkeypatch, capsys):
    """Otherwise agent_task.md instructs a post that jira-comment later refuses."""
    monkeypatch.chdir(tmp_path)
    assert main(["bug", "--description", "crash on save", "--jira-comment", "--json"]) == 1
    payload = json.loads(capsys.readouterr().out)
    assert payload["error"]["code"] == errors.INVALID_INPUT


@pytest.mark.parametrize("flag, value", [("--max-files", "0"), ("--max-search-lines", "-1")])
def test_nonsense_caps_are_rejected(tmp_path, monkeypatch, capsys, flag, value):
    """0 empties the results and a negative slices from the end."""
    monkeypatch.chdir(tmp_path)
    assert main(["bug", "--description", "x", flag, value, "--json"]) == 1
    assert json.loads(capsys.readouterr().out)["error"]["code"] == errors.INVALID_INPUT


def test_supplied_keywords_reach_the_extraction(tmp_path, monkeypatch, capsys):
    """--keywords was written into the options and read nowhere."""
    monkeypatch.chdir(tmp_path)
    main([
        "bug", "--description", "something goes wrong", "--keywords", "OpenVdsStatistics",
        "--prepare-only", "--json",
    ])
    work_item = json.loads(capsys.readouterr().out)["work_item_id"]

    extracted = json.loads(
        (tmp_path / ".ai" / work_item / "extracted_keywords.json").read_text(encoding="utf-8")
    )
    assert extracted["high_value_keywords"][0] == "OpenVdsStatistics"


def test_manual_email_draft_falls_back_to_the_spec(tmp_path, monkeypatch, capsys):
    """No jira_summary.md exists, so title and problem come from the BugSpec."""
    monkeypatch.chdir(tmp_path)
    work_item = _prepare_manual(capsys, "三维视图切换层位后崩溃\n\n打开 VDS 后切换层位即崩溃。")
    main(["summarize-results", work_item])
    capsys.readouterr()

    from bugpilot.core.email_notify import build_email_draft

    draft = build_email_draft(tmp_path, work_item)
    assert "三维视图切换层位后崩溃" in draft.subject
    assert "打开 VDS 后切换层位即崩溃" in draft.body
    assert "## Work Item" in draft.body
    assert "Not available in local artifacts." not in draft.body.split("## Bug Cause")[0]


def test_manual_email_draft_has_no_jira_link(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("JIRA_BASE_URL", "https://example.atlassian.net")
    work_item = _prepare_manual(capsys)
    main(["summarize-results", work_item])
    capsys.readouterr()

    from bugpilot.core.email_notify import build_email_draft

    draft = build_email_draft(tmp_path, work_item)
    assert "browse/" not in draft.body


def test_jira_email_draft_is_unchanged(tmp_path, monkeypatch, capsys):
    """R1: the Jira path keeps its heading and its link."""
    monkeypatch.chdir(tmp_path)
    monkeypatch.setenv("JIRA_BASE_URL", "https://example.atlassian.net")
    main(["bug", "JR-12345", "--allow-mock", "--prepare-only"])
    main(["summarize-results", "JR-12345"])
    capsys.readouterr()

    from bugpilot.core.email_notify import build_email_draft

    draft = build_email_draft(tmp_path, "JR-12345")
    assert "## Jira Item" in draft.body
    assert "browse/JR-12345" in draft.body
