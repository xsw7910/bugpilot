"""fix_report.md: the one post-agent report (plan §37, Batch 5).

The agent owns the report; BugPilot reads it and renders every derivation in
memory. These tests hold the section contract and its tolerant parsing, the
honest-outcome semantics (nothing synthesizes a fix, a pass, or a change), the
5 + optional-report core contract, and that the old result files are neither
written nor accepted.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from bugpilot.cli import main
from bugpilot.core import workflow
from bugpilot.core.email_notify import build_email_draft
from bugpilot.core.fix_report import (
    FIX_REPORT_SECTIONS,
    manual_fix_report_template,
    read_fix_report,
    section_of,
)
from bugpilot.core.input_adapters import bug_spec_from_description
from bugpilot.core.issue import IssueArtifact, save_issue
from bugpilot.core.models import InvestigationOptions, InvestigationRequest

needs_rg = pytest.mark.skipif(shutil.which("rg") is None, reason="code search needs ripgrep")

CORE_PREPARE = {"issue.json", "retrieval.json", "context.md", "task.md", "run.json"}

FIXED_REPORT = (
    "# Fix Report: JR-12345\n\n"
    "## Summary\n\nFixed: the filter no longer rejects CSV.\n\n"
    "## Analysis\n\nvalidate() filtered the CSV output type.\n\n"
    "## Changes\n\nRemoved the filter in src/WidgetController.cpp.\n\n"
    "### Files touched\n\n- src/WidgetController.cpp\n\n"
    "## Tests\n\npytest tests/widgets -q: 12 passed.\n\n"
    "## Review Notes\n\nLow risk; watch the exporter path.\n"
)


def _package(root: Path, work_item: str = "JR-12345") -> Path:
    target = root / ".ai" / work_item
    target.mkdir(parents=True)
    save_issue(root, IssueArtifact(id=work_item, source="jira", title="CSV rejected"))
    (target / "context.md").write_text("# Bug Context\n", encoding="utf-8")
    return target


# --- the section contract and its parsing ------------------------------------------


def test_the_report_parses_into_its_sections(tmp_path):
    target = _package(tmp_path)
    (target / "fix_report.md").write_text(FIXED_REPORT, encoding="utf-8")

    report = read_fix_report(tmp_path, "JR-12345")

    assert report is not None
    assert report.summary == "Fixed: the filter no longer rejects CSV."
    assert report.analysis.startswith("validate() filtered")
    # A `###` subheading stays inside its section.
    assert "### Files touched" in report.changes
    assert "src/WidgetController.cpp" in report.changes
    assert report.tests == "pytest tests/widgets -q: 12 passed."
    assert report.review_notes == "Low risk; watch the exporter path."
    assert report.missing_sections == ()


def test_a_missing_heading_is_an_empty_section_not_an_error(tmp_path):
    target = _package(tmp_path)
    (target / "fix_report.md").write_text(
        "# Fix Report: JR-12345\n\n## Summary\n\nAttempted; ran out of evidence.\n",
        encoding="utf-8",
    )

    report = read_fix_report(tmp_path, "JR-12345")

    assert report is not None
    assert report.summary == "Attempted; ran out of evidence."
    assert report.tests == ""
    assert set(report.missing_sections) == set(FIX_REPORT_SECTIONS) - {"## Summary"}


def test_headings_are_matched_with_whitespace_and_case_forgiven(tmp_path):
    """The report is model-written; `## summary ` must not read as missing."""
    target = _package(tmp_path)
    (target / "fix_report.md").write_text(
        "# Fix Report: JR-12345\n\n## summary \n\nFixed.\n\n## ANALYSIS\n\nThe filter.\n",
        encoding="utf-8",
    )

    report = read_fix_report(tmp_path, "JR-12345")

    assert report.summary == "Fixed."
    assert report.analysis == "The filter."


def test_no_report_reads_as_none(tmp_path):
    _package(tmp_path)
    assert read_fix_report(tmp_path, "JR-12345") is None


def test_the_manual_template_carries_every_required_section():
    template = manual_fix_report_template("JR-12345")
    for heading in FIX_REPORT_SECTIONS:
        assert section_of(template, heading), heading


# --- honest outcomes: nothing synthesizes a fix, a pass, or a change -----------------


def test_tests_not_run_passes_through_verbatim(tmp_path, monkeypatch):
    """§42 C/D: the memory and the email say what the report says, no more."""
    target = _package(tmp_path)
    (target / "fix_report.md").write_text(
        "# Fix Report: JR-12345\n\n"
        "## Summary\n\nNo-op: the reported behavior is by design.\n\n"
        "## Analysis\n\nThe filter is intentional for legacy exports.\n\n"
        "## Changes\n\nNo source changes were made.\n\n"
        "## Tests\n\nNot run: no code changed.\n\n"
        "## Review Notes\n\nRecommend closing as working-as-intended.\n",
        encoding="utf-8",
    )
    monkeypatch.chdir(tmp_path)

    assert main(["memory", "update", "JR-12345"]) == 0
    memory = (tmp_path / ".ai_memory" / "bugs" / "JR-12345.md").read_text(encoding="utf-8")
    draft = build_email_draft(tmp_path, "JR-12345")

    assert "### Tests\nNot run: no code changed." in memory
    assert "Not run: no code changed." in draft.body
    for invented in ("tests passed", "Tests passed"):
        assert invented not in memory
        assert invented not in draft.body


def test_an_empty_report_renders_not_available_rather_than_claims(tmp_path):
    target = _package(tmp_path)
    (target / "fix_report.md").write_text("# Fix Report: JR-12345\n", encoding="utf-8")

    draft = build_email_draft(tmp_path, "JR-12345")

    assert "(not available)" in draft.body or "not available" in draft.body.lower()
    assert "fixed" not in draft.body.lower().replace("fix ready to commit", "")


def test_the_overview_names_the_empty_sections(tmp_path, monkeypatch, capsys):
    target = _package(tmp_path)
    (target / "fix_report.md").write_text(
        "# Fix Report: JR-12345\n\n## Summary\n\nAttempted.\n", encoding="utf-8"
    )
    monkeypatch.chdir(tmp_path)

    assert main(["summarize-results", "JR-12345"]) == 0
    overview = capsys.readouterr().out

    assert "- Sections still empty: ## Analysis, ## Changes, ## Tests, ## Review Notes" in overview


# --- the 5 + optional report core contract --------------------------------------------


@needs_rg
def test_prepare_stays_five_and_the_report_makes_six(tmp_path):
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "WidgetController.cpp").write_text(
        "bool WidgetController::validate(OutputType t){return t!=OutputType::CSV;}\n",
        encoding="utf-8",
    )
    spec = bug_spec_from_description("WidgetController rejects the CSV output type.", title="CSV")
    workflow.run_investigation(
        tmp_path,
        InvestigationRequest(spec=spec, options=InvestigationOptions(keywords=["WidgetController"])),
    )
    target = tmp_path / ".ai" / spec.work_item_id
    assert {p.name for p in target.iterdir()} == CORE_PREPARE

    # The agent writes its report; the core set is now exactly six.
    (target / "fix_report.md").write_text(FIXED_REPORT, encoding="utf-8")
    assert {p.name for p in target.iterdir()} == CORE_PREPARE | {"fix_report.md"}

    # And run.json's snapshot picks it up on the next step transition.
    workflow.check_results_step(tmp_path, spec.work_item_id)
    workflow.summarize_results_step(tmp_path, spec.work_item_id)
    run = json.loads((target / "run.json").read_text(encoding="utf-8"))
    assert f".ai/{spec.work_item_id}/fix_report.md" in run["generated_files"]
    assert {p.name for p in target.iterdir()} == CORE_PREPARE | {"fix_report.md"}


# --- the old result files are neither written nor accepted -----------------------------


def test_the_post_fix_flow_writes_none_of_the_old_result_files(tmp_path, monkeypatch, capsys):
    target = _package(tmp_path)
    (target / "fix_report.md").write_text(FIXED_REPORT, encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    assert main(["summarize-results", "JR-12345"]) == 0
    assert main(["review-package", "JR-12345"]) == 0
    assert main(["memory", "update", "JR-12345"]) == 0
    capsys.readouterr()

    for name in (
        "result_summary.md",
        "manual_validation.md",
        "final_review_prompt.md",
        "commit_plan.md",
        "push_plan.md",
        "bug_analysis.md",
        "fix_summary.md",
        "test_result.md",
        "diff_summary.md",
        "review_notes.md",
        "jira_comment_post_summary.md",
    ):
        assert not (target / name).exists(), name


def test_retry_reads_the_report_not_the_old_files(tmp_path, monkeypatch):
    """A pre-Batch-5 attempt's five files are not read back — no fallback."""
    target = _package(tmp_path)
    for name in ("bug_analysis.md", "test_result.md", "review_notes.md"):
        (target / name).write_text("legacy attempt text that must not surface", encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    assert main(["retry-prompt", "JR-12345"]) == 0
    prompt = (target / "agent_retry_prompt.md").read_text(encoding="utf-8")

    assert "legacy attempt text that must not surface" not in prompt
    assert "### fix_report.md" in prompt
    assert "missing" in prompt
