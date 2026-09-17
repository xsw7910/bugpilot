"""Tests for run_investigation: manual work items and plan-gated runs."""

from __future__ import annotations

import json
from datetime import datetime, timezone

import pytest

from bugpilot.core.input_adapters import bug_spec_from_description, load_bug_spec
from bugpilot.core.models import InvestigationOptions, InvestigationPlan, InvestigationRequest
from bugpilot.core.workflow import jira_request, run_bug_workflow, run_investigation

MOMENT = datetime(2026, 9, 1, 9, 41, 33, tzinfo=timezone.utc)


def _status(repo_root, work_item_id) -> dict:
    path = repo_root / ".ai" / work_item_id / "workflow_status.json"
    return json.loads(path.read_text(encoding="utf-8"))


def _manual_request(**plan_kwargs) -> InvestigationRequest:
    spec = bug_spec_from_description(
        "3D view crashes after changing horizon\n\nOpen a VDS file, then switch horizon.",
        now=MOMENT,
    )
    return InvestigationRequest(spec=spec, plan=InvestigationPlan(**plan_kwargs))


# --- manual work items ------------------------------------------------------


def test_manual_investigation_runs_without_jira(tmp_path):
    result = run_investigation(tmp_path, _manual_request())

    assert result.issue_key == "local_20260901094133"
    assert result.jira_result is None  # nothing was fetched
    assert not (tmp_path / ".ai" / result.issue_key / "jira.json").exists()

    generated = set(result.generated_files)
    assert f".ai/{result.issue_key}/bug_context.md" in generated
    assert f".ai/{result.issue_key}/agent_task.md" in generated


def test_manual_investigation_persists_its_spec(tmp_path):
    request = _manual_request()
    run_investigation(tmp_path, request)

    stored = load_bug_spec(tmp_path, request.work_item_id)
    assert stored == request.spec
    assert stored.source_ref is None
    assert not stored.can_write_back


def test_manual_content_reaches_the_generated_context(tmp_path):
    request = _manual_request()
    run_investigation(tmp_path, request)

    context = (tmp_path / ".ai" / request.work_item_id / "bug_context.md").read_text(encoding="utf-8")
    assert "3D view crashes after changing horizon" in context


def test_manual_status_never_marks_fetch_as_run(tmp_path):
    """No Jira fetch happens, but parse still does — from the persisted spec.

    `workflow_status.json` lists every WORKFLOW_STEP and renders anything that did
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
    spec = bug_spec_from_description("三维视图切换层位后崩溃", now=MOMENT)
    run_investigation(tmp_path, InvestigationRequest(spec=spec))

    stored = load_bug_spec(tmp_path, spec.work_item_id)
    assert stored.title == "三维视图切换层位后崩溃"


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
    always reads extracted_keywords.json) went unnoticed until review.
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
    assert not (target / "bug_context.md").exists()
    assert (target / "git_context.md").exists()
    assert (target / "memory_search.md").exists()


def test_skipped_step_writes_no_artifact(tmp_path):
    request = _manual_request(code_search=False)
    run_investigation(tmp_path, request)

    target = tmp_path / ".ai" / request.work_item_id
    assert not (target / "code_search.md").exists()
    assert not (target / "related_files.json").exists()


# --- Jira path stays intact -------------------------------------------------


def test_jira_run_persists_the_parsed_title(tmp_path):
    run_bug_workflow(tmp_path, "JR-12345", allow_mock=True)

    stored = load_bug_spec(tmp_path, "JR-12345")
    assert stored is not None
    assert stored.source == "jira"
    assert stored.source_ref == "JR-12345"
    assert stored.title  # filled in from the parsed issue, not the empty stub
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

    task = (tmp_path / ".ai" / request.work_item_id / "agent_task.md").read_text(encoding="utf-8")
    assert "jira-workflow" not in task
    assert "3d-view-crashes" in task


def test_hint_from_options_reaches_the_artifacts(tmp_path):
    """options.hint used to be carried and silently dropped."""
    request = InvestigationRequest(
        spec=bug_spec_from_description("crash on save", now=MOMENT),
        options=InvestigationOptions(hint="look in VdsWriter::flush"),
    )
    run_investigation(tmp_path, request)

    hint_file = tmp_path / ".ai" / request.work_item_id / "developer_hint.md"
    assert hint_file.read_text(encoding="utf-8").strip() == "look in VdsWriter::flush"


def test_explicit_hint_argument_beats_options_hint(tmp_path):
    request = InvestigationRequest(
        spec=bug_spec_from_description("crash on save", now=MOMENT),
        options=InvestigationOptions(hint="from options"),
    )
    run_investigation(tmp_path, request, hint="from argument")

    hint_file = tmp_path / ".ai" / request.work_item_id / "developer_hint.md"
    assert hint_file.read_text(encoding="utf-8").strip() == "from argument"


def test_ignore_paths_keeps_matches_out_of_the_results(tmp_path):
    """End-to-end: options reach run_code_search, not just the request object."""
    (tmp_path / "src").mkdir()
    (tmp_path / "vendor").mkdir()
    (tmp_path / "src" / "Widget.cpp").write_text("void OpenVdsStatistics() {}\n", encoding="utf-8")
    (tmp_path / "vendor" / "Widget.cpp").write_text("void OpenVdsStatistics() {}\n", encoding="utf-8")

    request = InvestigationRequest(
        spec=bug_spec_from_description("OpenVdsStatistics crashes", now=MOMENT),
        options=InvestigationOptions(ignore_paths=["vendor"]),
    )
    run_investigation(tmp_path, request)

    related = (tmp_path / ".ai" / request.work_item_id / "related_files.json").read_text(encoding="utf-8")
    assert "vendor/Widget.cpp" not in related
