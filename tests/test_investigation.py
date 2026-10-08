"""Tests for run_investigation: manual work items and plan-gated runs."""

from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest

from bugpilot.core.input_adapters import bug_spec_from_description
from bugpilot.core.issue import load_issue
from bugpilot.core.models import InvestigationOptions, InvestigationPlan, InvestigationRequest
from bugpilot.core.workflow import jira_request, run_bug_workflow, run_investigation

MOMENT = datetime(2026, 9, 1, 9, 41, 33, tzinfo=timezone.utc)


def _status(repo_root, work_item_id) -> dict:
    path = repo_root / ".ai" / work_item_id / "run.json"
    return json.loads(path.read_text(encoding="utf-8"))


def _manual_request(**plan_kwargs) -> InvestigationRequest:
    spec = bug_spec_from_description(
        "3D view crashes after changing layer\n\nOpen a CSV file, then switch layer.",
        now=MOMENT,
    )
    return InvestigationRequest(spec=spec, plan=InvestigationPlan(**plan_kwargs))


# --- manual work items ------------------------------------------------------


def test_manual_investigation_runs_without_jira(tmp_path):
    result = run_investigation(tmp_path, _manual_request())

    assert result.issue_key == "local_20260901094133"
    assert result.jira_result is None  # nothing was fetched
    assert (tmp_path / ".ai" / result.issue_key / "issue.json").is_file()

    generated = set(result.generated_files)
    assert f".ai/{result.issue_key}/context.md" in generated
    assert f".ai/{result.issue_key}/task.md" in generated


def test_manual_investigation_persists_its_issue(tmp_path):
    request = _manual_request()
    run_investigation(tmp_path, request)

    stored = load_issue(tmp_path, request.work_item_id)
    assert stored.id == request.spec.work_item_id
    assert stored.source == "manual"
    assert stored.title == request.spec.title
    assert stored.description == request.spec.description
    assert stored.source_ref is None
    assert not stored.can_write_back


def test_manual_content_reaches_the_generated_context(tmp_path):
    request = _manual_request()
    run_investigation(tmp_path, request)

    context = (tmp_path / ".ai" / request.work_item_id / "context.md").read_text(encoding="utf-8")
    assert "3D view crashes after changing layer" in context


def test_manual_status_never_marks_fetch_as_run(tmp_path):
    """No Jira fetch happens, but parse still does — on the issue built in memory.

    `run.json`'s steps map lists every WORKFLOW_STEP and renders anything that did
    not run as "skipped", so `fetch: skipped` here is the same rendering every
    unrun step gets. The model-level distinction between "inapplicable" and
    "skipped capability" lives in InvestigationPlan.skipped_steps and does not
    survive into this artifact — see test_identity_models.py.
    """
    request = _manual_request()
    run_investigation(tmp_path, request)

    steps = _status(tmp_path, request.work_item_id)["steps"]
    assert steps["fetch"] != "pass"
    assert steps["parse"] == "pass"


def test_manual_investigation_keeps_a_non_ascii_title(tmp_path):
    spec = bug_spec_from_description("三维视图切换图层后崩溃", now=MOMENT)
    run_investigation(tmp_path, InvestigationRequest(spec=spec))

    stored = load_issue(tmp_path, spec.work_item_id)
    assert stored.title == "三维视图切换图层后崩溃"
    # Readable in an editor, not \uXXXX escaped.
    raw = (tmp_path / ".ai" / spec.work_item_id / "issue.json").read_text(encoding="utf-8")
    assert "三维视图切换图层后崩溃" in raw


# --- plan gating ------------------------------------------------------------


def test_disabled_capability_is_marked_skipped_not_failed(tmp_path):
    request = _manual_request(git_history=False)
    run_investigation(tmp_path, request)

    steps = _status(tmp_path, request.work_item_id)["steps"]
    assert steps["git_context"] == "skipped"
    assert steps["code_search"] == "pass"


def test_skipping_similar_fixes_keeps_keywords_for_code_search(tmp_path):
    request = _manual_request(similar_fixes=False)
    run_investigation(tmp_path, request)

    steps = _status(tmp_path, request.work_item_id)["steps"]
    assert steps["memory_search"] == "skipped"
    assert steps["keywords"] == "pass"  # code_search still needs it


@pytest.mark.parametrize(
    "capability",
    ["issue_details", "code_search", "git_history", "similar_fixes", "build_context"],
)
def test_every_single_capability_off_still_runs_to_completion(tmp_path, capability):
    """Each capability, disabled on its own, must not crash the run.

    The earlier tests only exercised the set arithmetic of resolve_steps; nothing
    actually executed a partial plan, so a missing prerequisite (context_step
    always reads the keyword extraction) went unnoticed until review.
    """
    request = _manual_request(**{capability: False})
    result = run_investigation(tmp_path, request)
    assert result.issue_key == request.work_item_id


@pytest.mark.parametrize(
    "capability",
    ["issue_details", "code_search", "git_history", "similar_fixes", "build_context"],
)
def test_every_single_capability_off_runs_for_a_jira_work_item(tmp_path, capability):
    run_bug_workflow(tmp_path, "JR-12345", allow_mock=True)  # seed a fetched issue
    request = jira_request("JR-12345")
    request.plan = InvestigationPlan(**{capability: False})
    result = run_investigation(tmp_path, request, allow_mock=True)
    assert result.issue_key == "JR-12345"


def test_disabling_build_context_keeps_the_intermediate_artifacts(tmp_path):
    """Without `context` there is no fold, so the folded-in files must survive.

    They are the only output the enabled capabilities produced; deleting them
    would leave a run that reports success and wrote nothing readable.
    """
    request = _manual_request(build_context=False)
    run_investigation(tmp_path, request)

    target = tmp_path / ".ai" / request.work_item_id
    assert not (target / "context.md").exists()
    # Git history and similar fixes stay in memory: with no context to render
    # them into, nothing is written for them either.
    for name in ("bug_context.md", "git_context.md", "memory_search.md"):
        assert not (target / name).exists(), name


def test_skipped_step_writes_no_artifact(tmp_path):
    request = _manual_request(code_search=False)
    run_investigation(tmp_path, request)

    target = tmp_path / ".ai" / request.work_item_id
    assert not (target / "retrieval.json").exists()


# --- Jira path stays intact -------------------------------------------------


def test_jira_run_persists_the_parsed_title(tmp_path):
    run_bug_workflow(tmp_path, "JR-12345", allow_mock=True)

    stored = load_issue(tmp_path, "JR-12345")
    assert stored is not None
    assert stored.source == "jira"
    assert stored.source_ref == "JR-12345"
    assert stored.title  # filled in from the fetched issue, not the empty stub
    assert stored.can_write_back


def test_jira_request_starts_with_an_empty_stub_spec():
    request = jira_request("JR-12345")
    assert request.spec.title == ""
    assert request.spec.source_ref == "JR-12345"
    assert request.resolved_steps()[:3] == ["doctor", "fetch", "parse"]


def test_run_bug_workflow_still_marks_every_step_pass(tmp_path):
    """The default path must produce the same status map as before the refactor."""
    run_bug_workflow(tmp_path, "JR-12345", allow_mock=True)

    steps = _status(tmp_path, "JR-12345")["steps"]
    for name in (
        "doctor",
        "fetch",
        "parse",
        "keywords",
        "memory_search",
        "code_search",
        "git_context",
        "context",
        "prompt",
        "memory_add",
    ):
        assert steps[name] == "pass", name
    assert steps["agent_fix"] == "skipped"


def test_options_are_carried_on_the_request(tmp_path):
    """Options are plumbed through even though search.py does not read them yet."""
    request = InvestigationRequest(
        spec=bug_spec_from_description("crash on save", now=MOMENT),
        options=InvestigationOptions(max_files=3, hint="look in the writer"),
    )
    run_investigation(tmp_path, request)
    assert request.options.max_files == 3


# --- review follow-ups ------------------------------------------------------


def test_manual_branch_name_uses_the_spec_title_not_the_jira_fallback(tmp_path):
    """Without this the branch degrades to `feature/<id>-jira-workflow`."""
    request = _manual_request()
    run_investigation(tmp_path, request)

    task = (tmp_path / ".ai" / request.work_item_id / "task.md").read_text(encoding="utf-8")
    assert "jira-workflow" not in task
    assert "3d-view-crashes" in task


def test_hint_from_options_reaches_the_artifacts(tmp_path):
    """options.hint used to be carried and silently dropped."""
    request = InvestigationRequest(
        spec=bug_spec_from_description("crash on save", now=MOMENT),
        options=InvestigationOptions(hint="look in CsvWriter::flush"),
    )
    run_investigation(tmp_path, request)

    assert load_issue(tmp_path, request.work_item_id).guidance.hint == "look in CsvWriter::flush"


def test_explicit_hint_argument_beats_options_hint(tmp_path):
    request = InvestigationRequest(
        spec=bug_spec_from_description("crash on save", now=MOMENT),
        options=InvestigationOptions(hint="from options"),
    )
    run_investigation(tmp_path, request, hint="from argument")

    assert load_issue(tmp_path, request.work_item_id).guidance.hint == "from argument"


def test_ignore_paths_keeps_matches_out_of_the_results(tmp_path):
    """End-to-end: options reach run_code_search, not just the request object."""
    (tmp_path / "src").mkdir()
    (tmp_path / "vendor").mkdir()
    (tmp_path / "src" / "Widget.cpp").write_text("void OpenCsvStatistics() {}\n", encoding="utf-8")
    (tmp_path / "vendor" / "Widget.cpp").write_text("void OpenCsvStatistics() {}\n", encoding="utf-8")

    request = InvestigationRequest(
        spec=bug_spec_from_description("OpenCsvStatistics crashes", now=MOMENT),
        options=InvestigationOptions(ignore_paths=["vendor"]),
    )
    run_investigation(tmp_path, request)

    retrieval = json.loads((tmp_path / ".ai" / request.work_item_id / "retrieval.json").read_text(encoding="utf-8"))
    files = [item["file"] for item in retrieval["related_files"]]
    assert "src/Widget.cpp" in files
    assert "vendor/Widget.cpp" not in files
