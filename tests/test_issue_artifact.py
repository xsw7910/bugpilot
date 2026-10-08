"""issue.json: the one canonical issue artifact (plan §37, Batch 1).

A Jira issue and a hand-written description both become one ``IssueArtifact``,
carried in memory through the run and persisted once as ``issue.json``. These
tests hold the schema, the absence of every file it replaced, the guidance a
resumed run inherits, and — because this batch must not move retrieval — that
keyword extraction sees exactly the text it saw before.
"""

from __future__ import annotations

import copy
import json
from dataclasses import replace
from pathlib import Path

import pytest

from bugpilot.core import issue as issue_module
from bugpilot.core import workflow
from bugpilot.core.fix_mode_state import select_fix_mode
from bugpilot.core.input_adapters import bug_spec_from_description
from bugpilot.core.issue import (
    IssueArtifact,
    IssueArtifactError,
    IssueAttachment,
    IssueComment,
    IssueDetails,
    IssueGuidance,
    IssueSignals,
    issue_from_dict,
    issue_from_jira,
    issue_from_spec,
    issue_to_dict,
    load_issue,
    read_issue_quietly,
    save_issue,
)
from bugpilot.core.jira import JiraFetchResult, parse_issue
from bugpilot.core.keywords import extract_keywords
from bugpilot.core.models import InvestigationOptions, InvestigationPlan, InvestigationRequest

ISSUE_KEYS = {
    "schema_version",
    "id",
    "source",
    "title",
    "description",
    "comments",
    "signals",
    "details",
    "guidance",
}

# Every issue-stage file issue.json replaced. Normal execution writes none.
LEGACY_ISSUE_FILES = (
    "jira.json",
    "jira_summary.md",
    "jira_parsed.md",
    "bug_spec.json",
    "developer_hint.md",
    "fix_mode.json",
)

PAYLOAD = {
    "key": "JR-12345",
    "self": "https://jira.example.test/rest/api/3/issue/10001",
    "fields": {
        "summary": "WidgetController rejects a valid output type",
        "description": (
            "Steps to Reproduce\n"
            "1. Open sample-repo\n"
            "2. Select the CSV output type\n\n"
            "Actual Result\n"
            "Error: InvalidOutputType: CSV is not allowed\n"
            "    at WidgetController.validate(WidgetController.cpp:42)\n"
            "    at WidgetController.apply(WidgetController.cpp:17)\n\n"
            "Expected Result\n"
            "CSV is accepted.\n"
        ),
        "issuetype": {"name": "Bug"},
        "status": {"name": "Open"},
        "priority": {"name": "High"},
        "labels": ["output"],
        "components": [{"name": "Output"}],
        "fixVersions": [{"name": "2026.2"}],
        "versions": [{"name": "2026.1"}],
        "assignee": {"displayName": "Jane Dev", "accountId": "acct-assignee"},
        "reporter": {"displayName": "QA Person", "accountId": "acct-reporter"},
        "comment": {
            "comments": [
                {
                    "author": {"displayName": "QA Person", "accountId": "acct-reporter"},
                    "created": "2026-05-10T09:00:00.000+0000",
                    "body": "Still broken on 2026.1, see crash.log",
                }
            ]
        },
        "attachment": [
            {
                "filename": "crash.log",
                "mimeType": "text/plain",
                "size": 4096,
                "created": "2026-05-10T09:05:00.000+0000",
                "author": {"displayName": "QA Person"},
                "content": "https://jira.example.test/secure/attachment/1/crash.log?token=secret",
            }
        ],
    },
}

HINT = "Investigate WidgetController output validation."
IMPROVED_HINT = "Check WidgetController::validate, which filters the CSV output type."


@pytest.fixture
def fake_jira(monkeypatch):
    """The Jira client returns PAYLOAD. Fetch behaviour itself is not under test."""

    def fetch(repo_root, issue_key, allow_mock=False):
        return JiraFetchResult(issue_key, "jira", True, None, None, copy.deepcopy(PAYLOAD))

    monkeypatch.setattr(workflow, "fetch_issue", fetch)


def _read(repo: Path, work_item_id: str) -> dict:
    return json.loads((repo / ".ai" / work_item_id / "issue.json").read_text(encoding="utf-8"))


def _task(repo: Path, work_item_id: str) -> str:
    return (repo / ".ai" / work_item_id / "task.md").read_text(encoding="utf-8")


def _assert_no_legacy_issue_files(repo: Path, work_item_id: str) -> None:
    target = repo / ".ai" / work_item_id
    present = [name for name in LEGACY_ISSUE_FILES if (target / name).exists()]
    assert present == [], f"legacy issue files written: {present}"


def _jira(repo: Path, *, hint: str | None = None, fix_mode_id: str | None = None, fresh: bool = True):
    request = workflow.jira_request("JR-12345")
    request.fix_mode_id = fix_mode_id
    return workflow.run_investigation(repo, request, hint=hint, fresh=fresh)


def _manual_spec(title: str | None = "Crash after changing output type"):
    return bug_spec_from_description(
        "WidgetController crashes after changing the output type.\n\n"
        "Error: NullReferenceException in WidgetController.apply",
        title=title,
        repo_root=None,
    )


# --- Jira source ---------------------------------------------------------------


def test_a_jira_run_writes_one_canonical_issue_artifact(tmp_path, fake_jira):
    _jira(tmp_path, hint=HINT, fix_mode_id="conservative")
    data = _read(tmp_path, "JR-12345")
    parsed = parse_issue(copy.deepcopy(PAYLOAD))

    assert set(data) == ISSUE_KEYS
    assert data["schema_version"] == 1
    assert data["id"] == "JR-12345"
    assert data["source"] == "jira"
    assert data["title"] == "WidgetController rejects a valid output type"
    assert "Select the CSV output type" in data["description"]
    assert data["comments"] == [
        {"created": "2026-05-10T09:00:00.000+0000", "body": "Still broken on 2026.1, see crash.log"}
    ]
    # The parser's own extraction, not a second copy of it.
    assert data["signals"] == {
        "stack_traces": parsed["stack_traces"],
        "error_messages": parsed["error_messages"],
        "log_signals": parsed["log_signals"],
    }
    assert data["signals"]["error_messages"], "the fixture has an error message to find"
    details = data["details"]
    assert (details["issue_type"], details["status"], details["priority"]) == ("Bug", "Open", "High")
    assert details["components"] == ["Output"]
    assert details["fix_versions"] == ["2026.2"]
    assert details["affected_versions"] == ["2026.1"]
    assert details["attachments"][0]["filename"] == "crash.log"
    assert data["guidance"]["hint"] == HINT
    assert data["guidance"]["fix_mode"]["id"] == "conservative"
    _assert_no_legacy_issue_files(tmp_path, "JR-12345")


def test_issue_json_keeps_no_raw_payload_urls_tokens_or_people(tmp_path, fake_jira):
    _jira(tmp_path)
    raw = (tmp_path / ".ai" / "JR-12345" / "issue.json").read_text(encoding="utf-8")

    for absent in (
        "token=secret",
        "jira.example.test",
        "acct-assignee",
        "acct-reporter",
        "Jane Dev",
        "QA Person",
        "bugpilot_normalized",
        "customfield",
    ):
        assert absent not in raw, absent


def test_the_status_file_still_reports_the_recorded_mode(tmp_path, fake_jira):
    """The extension reads the mode from `run.json`; its source moved."""
    _jira(tmp_path, fix_mode_id="investigate-first")
    status = json.loads((tmp_path / ".ai" / "JR-12345" / "run.json").read_text(encoding="utf-8"))

    assert status["fix_mode"]["id"] == "investigate-first"
    assert ".ai/JR-12345/issue.json" in status["generated_files"]


# --- manual source -------------------------------------------------------------


def test_a_manual_run_writes_the_same_schema(tmp_path):
    spec = _manual_spec()
    request = InvestigationRequest(spec=spec, options=InvestigationOptions(hint=HINT))
    workflow.run_investigation(tmp_path, request)
    data = _read(tmp_path, spec.work_item_id)

    assert set(data) == ISSUE_KEYS
    assert data["schema_version"] == 1
    assert data["id"] == spec.work_item_id
    assert data["source"] == "manual"
    assert data["title"] == "Crash after changing output type"
    assert data["description"] == spec.description
    assert data["comments"] == []
    assert data["signals"]["error_messages"], "the parser runs on a manual bug too"
    assert data["details"]["issue_type"] == ""
    assert data["guidance"]["hint"] == HINT
    assert data["guidance"]["fix_mode"]["id"] == "standard"
    _assert_no_legacy_issue_files(tmp_path, spec.work_item_id)


def test_a_manual_title_is_derived_when_none_is_given(tmp_path):
    spec = _manual_spec(title=None)
    workflow.run_investigation(tmp_path, InvestigationRequest(spec=spec))

    assert _read(tmp_path, spec.work_item_id)["title"] == (
        "WidgetController crashes after changing the output type."
    )


def test_a_manual_issue_cannot_write_back_to_jira():
    issue = issue_from_spec(_manual_spec(), IssueGuidance())

    assert issue.source_ref is None
    assert not issue.can_write_back
    jira = issue_from_jira(copy.deepcopy(PAYLOAD), "JR-12345", IssueGuidance())
    assert jira.source_ref == "JR-12345"
    assert jira.can_write_back


# --- retrieval inputs are unchanged ---------------------------------------------


def _keywords_the_old_way(parsed: dict) -> dict:
    """What keywords_step did with the parsed dict before this batch."""
    priority_parts: list[str] = []
    for field in ("stack_traces", "error_messages", "log_signals"):
        value = parsed.get(field)
        if isinstance(value, list):
            priority_parts.extend(str(item) for item in value)
        elif value:
            priority_parts.append(str(value))
    return extract_keywords(str(parsed.get("combined_text", "")), priority_text="\n".join(priority_parts))


def test_jira_keyword_extraction_sees_the_same_input():
    parsed = parse_issue(copy.deepcopy(PAYLOAD))
    issue = issue_from_jira(copy.deepcopy(PAYLOAD), "JR-12345", IssueGuidance())

    assert extract_keywords(issue.combined_text, priority_text=issue.priority_text) == _keywords_the_old_way(parsed)


def test_manual_keyword_extraction_sees_the_same_input():
    from bugpilot.core.input_adapters import manual_issue_payload

    spec = _manual_spec()
    parsed = parse_issue(manual_issue_payload(spec))
    issue = issue_from_spec(spec, IssueGuidance())

    assert extract_keywords(issue.combined_text, priority_text=issue.priority_text) == _keywords_the_old_way(parsed)


def test_keywords_survive_the_round_trip_through_issue_json(tmp_path, fake_jira):
    """A standalone `search` recomputes the keywords from issue.json.

    It must search exactly what the live run searched, and rank the same files.
    """
    _jira(tmp_path)
    target = tmp_path / ".ai" / "JR-12345"
    live = json.loads((target / "retrieval.json").read_text(encoding="utf-8"))

    workflow.code_search_step(tmp_path, "JR-12345")

    # Code Search's part, exactly. Git history's section is not the search's to
    # keep: it was ranked against the files the earlier search found, so a new
    # search writes the file without it (Git History v2, Batch 3).
    live.pop("git_history", None)
    assert json.loads((target / "retrieval.json").read_text(encoding="utf-8")) == live


# --- the on-disk form ------------------------------------------------------------


def _full_issue() -> IssueArtifact:
    return IssueArtifact(
        id="JR-12345",
        source="jira",
        title="WidgetController rejects a valid output type",
        description="CSV is rejected.",
        comments=(IssueComment(created="2026-05-10T09:00:00.000+0000", body="Still broken"),),
        signals=IssueSignals(stack_traces=("at WidgetController.validate",), error_messages=("InvalidOutputType",)),
        details=IssueDetails(
            issue_type="Bug",
            status="Open",
            labels=("output",),
            fix_versions=("2026.2",),
            mock=True,
            reproduction_steps=("Open sample-repo",),
            attachments=(IssueAttachment(filename="crash.log", kind="log", size=4096),),
        ),
        guidance=IssueGuidance(hint=HINT, fix_mode={"id": "conservative", "version": 1}),
    )


def test_the_dict_form_round_trips():
    issue = _full_issue()

    assert issue_from_dict(issue_to_dict(issue), "JR-12345") == issue


def test_save_and_load_round_trip_as_readable_utf8(tmp_path):
    issue = replace(_full_issue(), title="三维视图切换图层后崩溃")
    path = save_issue(tmp_path, issue)

    assert path == tmp_path / ".ai" / "JR-12345" / "issue.json"
    assert "三维视图切换图层后崩溃" in path.read_text(encoding="utf-8")
    assert load_issue(tmp_path, "JR-12345") == issue


def test_issue_json_is_written_atomically(tmp_path, monkeypatch):
    """Other processes read it mid-run; a torn write must not be possible."""
    written: list[Path] = []
    real = issue_module.atomic_write_text

    def recording(path, text):
        written.append(path)
        real(path, text)

    monkeypatch.setattr(issue_module, "atomic_write_text", recording)
    save_issue(tmp_path, _full_issue())

    assert written == [tmp_path / ".ai" / "JR-12345" / "issue.json"]


def test_a_missing_issue_is_none(tmp_path):
    assert load_issue(tmp_path, "JR-12345") is None
    assert read_issue_quietly(tmp_path, "JR-12345") is None


@pytest.mark.parametrize(
    "contents",
    [
        "{not json",
        "[]",
        json.dumps({"id": "JR-12345", "source": "jira"}),  # no schema_version
        json.dumps({"schema_version": 2, "id": "JR-12345", "source": "jira"}),
        json.dumps({"schema_version": 1, "id": "JR-99999", "source": "jira"}),
        json.dumps({"schema_version": 1, "id": "JR-12345", "source": "github"}),
    ],
)
def test_an_unusable_issue_file_is_an_error_not_a_fallback(tmp_path, contents):
    target = tmp_path / ".ai" / "JR-12345"
    target.mkdir(parents=True)
    (target / "issue.json").write_text(contents, encoding="utf-8")

    with pytest.raises(IssueArtifactError):
        load_issue(tmp_path, "JR-12345")
    # A listing degrades instead of failing on one directory.
    assert read_issue_quietly(tmp_path, "JR-12345") is None


def test_non_utf8_bytes_are_an_error_not_a_crash(tmp_path):
    target = tmp_path / ".ai" / "JR-12345"
    target.mkdir(parents=True)
    (target / "issue.json").write_bytes(b'{"schema_version": 1, "id": "\xff\xfe"}')

    with pytest.raises(IssueArtifactError):
        load_issue(tmp_path, "JR-12345")


# --- resume: issue.json only -----------------------------------------------------


def test_resume_keeps_the_hint_and_the_mode(tmp_path, fake_jira):
    _jira(tmp_path, hint=HINT, fix_mode_id="conservative")

    _jira(tmp_path, fresh=False)

    data = _read(tmp_path, "JR-12345")
    assert data["guidance"]["hint"] == HINT
    assert data["guidance"]["fix_mode"]["id"] == "conservative"
    task = _task(tmp_path, "JR-12345")
    assert HINT in task
    assert "- Mode: Conservative Fix" in task


def test_resume_searches_with_the_recorded_hint(tmp_path, fake_jira, monkeypatch):
    """Hint-aware retrieval (§33.5) must get the hint issue.json carries."""
    _jira(tmp_path, hint=HINT)
    seen: list[str | None] = []
    real = workflow.code_search_step

    def spy(repo_root, issue_key, options=None, keywords=None):
        seen.append(options.hint if options else None)
        return real(repo_root, issue_key, options, keywords=keywords)

    monkeypatch.setattr(workflow, "code_search_step", spy)
    _jira(tmp_path, fresh=False)

    assert seen == [HINT]


def test_an_accepted_improved_hint_is_what_runs_and_what_resume_keeps(tmp_path, fake_jira):
    """The hint improver hands its accepted hint to the next run as --hint.

    That run must record and use it, and a later resume must not fall back to
    the hint the work item was first prepared with.
    """
    _jira(tmp_path, hint=HINT)

    _jira(tmp_path, hint=IMPROVED_HINT, fresh=False)
    assert _read(tmp_path, "JR-12345")["guidance"]["hint"] == IMPROVED_HINT
    assert IMPROVED_HINT in _task(tmp_path, "JR-12345")
    assert HINT not in _task(tmp_path, "JR-12345")

    _jira(tmp_path, fresh=False)
    assert _read(tmp_path, "JR-12345")["guidance"]["hint"] == IMPROVED_HINT


def test_a_fresh_run_starts_without_the_previous_guidance(tmp_path, fake_jira):
    _jira(tmp_path, hint=HINT, fix_mode_id="deep-analysis")

    _jira(tmp_path)

    data = _read(tmp_path, "JR-12345")
    assert data["guidance"]["hint"] is None
    assert data["guidance"]["fix_mode"]["id"] == "standard"


def test_refinement_restores_the_issue_from_issue_json(tmp_path, fake_jira):
    """Refine never re-fetches, so issue.json is all it has — and all it needs."""
    _jira(tmp_path, fix_mode_id="test-driven")
    target = tmp_path / ".ai" / "JR-12345"
    retrieval_before = (target / "retrieval.json").read_text(encoding="utf-8")

    # Same issue, same options: the same search, term for term and file for file.
    workflow.refine_investigation(tmp_path, "JR-12345")
    assert (target / "retrieval.json").read_text(encoding="utf-8") == retrieval_before

    workflow.refine_investigation(tmp_path, "JR-12345", InvestigationOptions(hint=IMPROVED_HINT))
    data = _read(tmp_path, "JR-12345")
    assert data["guidance"]["hint"] == IMPROVED_HINT
    assert data["title"] == "WidgetController rejects a valid output type"
    task = _task(tmp_path, "JR-12345")
    assert IMPROVED_HINT in task
    assert "- Mode: Test-Driven Fix" in task
    _assert_no_legacy_issue_files(tmp_path, "JR-12345")


def test_a_legacy_layout_is_not_read(tmp_path, fake_jira):
    """No fallback: the old files are ignored, not migrated."""
    target = tmp_path / ".ai" / "JR-12345"
    target.mkdir(parents=True)
    (target / "developer_hint.md").write_text("old hint\n", encoding="utf-8")
    (target / "fix_mode.json").write_text(
        json.dumps({"schema_version": 1, "id": "conservative"}), encoding="utf-8"
    )
    (target / "bug_spec.json").write_text(
        json.dumps({"work_item_id": "JR-12345", "source": "jira", "title": "old"}), encoding="utf-8"
    )

    assert load_issue(tmp_path, "JR-12345") is None
    assert select_fix_mode(tmp_path, "JR-12345").mode.id == "standard"

    _jira(tmp_path, fresh=False)
    data = _read(tmp_path, "JR-12345")
    assert data["guidance"]["hint"] is None
    assert data["guidance"]["fix_mode"]["id"] == "standard"
    assert "old hint" not in _task(tmp_path, "JR-12345")


def test_a_standalone_fetch_keeps_guidance_and_repairs_a_corrupt_issue(tmp_path, fake_jira):
    _jira(tmp_path, hint=HINT, fix_mode_id="conservative")

    workflow.fetch_step(tmp_path, "JR-12345")
    assert _read(tmp_path, "JR-12345")["guidance"]["hint"] == HINT

    (tmp_path / ".ai" / "JR-12345" / "issue.json").write_text("{torn", encoding="utf-8")
    workflow.fetch_step(tmp_path, "JR-12345")
    assert _read(tmp_path, "JR-12345")["title"] == "WidgetController rejects a valid output type"


def test_an_issue_details_only_run_still_writes_the_issue(tmp_path, fake_jira):
    request = workflow.jira_request("JR-12345")
    request.plan = InvestigationPlan(
        code_search=False, git_history=False, similar_fixes=False, build_context=False
    )
    workflow.run_investigation(tmp_path, request)

    assert _read(tmp_path, "JR-12345")["title"] == "WidgetController rejects a valid output type"
    _assert_no_legacy_issue_files(tmp_path, "JR-12345")
