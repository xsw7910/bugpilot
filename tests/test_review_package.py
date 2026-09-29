"""`review-package --json`: the review prompt and the validation checklist, as a query.

The extension's Fix result row asks for both (Batch 9). What it may not do is
what the step versions do on the way: create the work item directory, record a
step mark in `run.json` (a read-modify-write that would race a re-run of the same
work item, and a `fail` mark that would turn its History row "failed"), or post
to Jira. So the JSON mode is read-only, and its content is built by the same
functions the human outputs render — these tests pin both halves.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from bugpilot.cli import main
from bugpilot.core import workflow
from bugpilot.core.issue import IssueArtifact, save_issue
from bugpilot.core.retrieval import RelatedFile, RetrievalArtifact, save_retrieval

REPORT = (
    "# Fix Report: JR-12345\n\n"
    "## Summary\n\nFixed the output-type validation in WidgetController.\n\n"
    "## Analysis\n\nWhy.\n\n"
    "## Changes\n\nWhat.\n\n"
    "## Tests\n\nNot run: no build environment.\n\n"
    "## Review Notes\n\n"
    "- Check the other enum comparisons in the widget module.\n"
    "\n"
    "- The legacy VDS path is untested.\n"
)

RUN_JSON = json.dumps({
    "schema_version": 1,
    "work_item_id": "JR-12345",
    "status": "prepared",
    "steps": {"fetch": "pass", "context": "pass", "prompt": "pass"},
    "generated_files": [],
})


def _work_item(
    root: Path,
    *,
    report: str | None = REPORT,
    files: tuple[str, ...] = ("src/WidgetController.cpp", "src/WidgetController.h"),
    work_item: str = "JR-12345",
    source: str = "jira",
) -> Path:
    target = root / ".ai" / work_item
    target.mkdir(parents=True)
    save_issue(root, IssueArtifact(id=work_item, source=source, title="VDS rejected"))
    (target / "context.md").write_text("# Bug Context\n", encoding="utf-8")
    (target / "run.json").write_text(RUN_JSON.replace("JR-12345", work_item), encoding="utf-8")
    save_retrieval(
        root,
        work_item,
        RetrievalArtifact(
            related_files=tuple(
                RelatedFile(file=path, documentation=False, score=10 - index, confidence="high", match_count=1)
                for index, path in enumerate(files)
            )
        ),
    )
    if report is not None:
        (target / "fix_report.md").write_text(report, encoding="utf-8")
    return target


def _json(capsys) -> dict:
    return json.loads(capsys.readouterr().out)


def test_the_json_carries_the_prompt_and_the_checklist(tmp_path, monkeypatch, capsys):
    _work_item(tmp_path)
    monkeypatch.chdir(tmp_path)

    assert main(["review-package", "JR-12345", "--json"]) == 0
    payload = _json(capsys)

    assert payload["ok"] is True
    assert payload["command"] == "review-package"
    assert payload["work_item_id"] == "JR-12345"
    assert payload["validation"] == {
        "steps": [
            "Reproduce the original issue if possible.",
            "Confirm the failure no longer occurs.",
            "If source changes were made, confirm they do not affect unrelated behavior.",
            "Run the focused tests named in fix_report.md's Tests section, if any.",
            "Check regression areas mentioned in context.md and retrieval.json.",
        ],
        "regression_files": ["src/WidgetController.cpp", "src/WidgetController.h"],
        # The report's own lines, blank ones dropped, as written otherwise.
        "review_risks": [
            "- Check the other enum comparisons in the widget module.",
            "- The legacy VDS path is untested.",
        ],
    }


def test_the_json_prompt_is_exactly_what_the_human_command_prints(tmp_path, monkeypatch, capsys):
    _work_item(tmp_path)
    monkeypatch.chdir(tmp_path)

    assert main(["review-package", "JR-12345"]) == 0
    human = capsys.readouterr().out
    assert main(["review-package", "JR-12345", "--json"]) == 0

    assert _json(capsys)["prompt"] == human
    assert human.startswith("# Final Review Request\n")


def test_the_json_mode_writes_nothing_at_all(tmp_path, monkeypatch, capsys):
    # No step mark, no new file, no touched file: the directory is byte-for-byte
    # what it was.
    target = _work_item(tmp_path)
    monkeypatch.setenv("BUGPILOT_AUTO_JIRA_COMMENT", "1")
    monkeypatch.chdir(tmp_path)
    before = {path.name: path.read_bytes() for path in target.iterdir()}

    assert main(["review-package", "JR-12345", "--json"]) == 0
    capsys.readouterr()

    assert {path.name: path.read_bytes() for path in target.iterdir()} == before
    assert "final_review_prompt" not in json.loads((target / "run.json").read_text(encoding="utf-8"))["steps"]


def test_the_human_command_records_nothing_either(tmp_path, monkeypatch, capsys):
    # It used to mark `final_review_prompt: pass`, which `status` showed as a
    # review that had passed. Printing a prompt is not a review: run.json is
    # byte-for-byte what it was (§37.70).
    target = _work_item(tmp_path)
    monkeypatch.chdir(tmp_path)
    before = (target / "run.json").read_bytes()

    assert main(["review-package", "JR-12345"]) == 0
    capsys.readouterr()

    assert (target / "run.json").read_bytes() == before


def test_a_missing_or_unsafe_work_item_is_refused_and_nothing_is_created(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    for work_item, code in (
        ("JR-99999", "WORK_ITEM_NOT_FOUND"),
        # Not a work item id at all: a path out of .ai/, or not a name one could be.
        ("../escape_1", "INVALID_INPUT"),
        ("JR 1", "INVALID_INPUT"),
    ):
        assert main(["review-package", work_item, "--json"]) == 1
        payload = _json(capsys)
        assert payload["ok"] is False
        assert payload["error"]["code"] == code, work_item
    assert not (tmp_path / ".ai").exists(), "a query created a work item directory"


def test_a_partial_report_or_none_still_has_a_checklist(tmp_path, monkeypatch, capsys):
    # The checklist is guidance about what to try, so a report without Review
    # Notes — or without anything yet — still gets the five steps.
    _work_item(tmp_path, report="# Fix Report: JR-12345\n\n## Summary\n\nAttempted.\n")
    monkeypatch.chdir(tmp_path)
    assert main(["review-package", "JR-12345", "--json"]) == 0
    partial = _json(capsys)["validation"]
    assert len(partial["steps"]) == 5
    assert partial["review_risks"] == []

    (tmp_path / ".ai" / "JR-12345" / "fix_report.md").unlink()
    assert main(["review-package", "JR-12345", "--json"]) == 0
    assert _json(capsys)["validation"]["review_risks"] == []


def test_the_rendered_checklist_is_unchanged_by_the_refactor(tmp_path):
    # summarize-results renders the checklist from the same structure the JSON
    # carries; its Markdown must be exactly what it was before the structure.
    _work_item(tmp_path)
    assert workflow._build_manual_validation(tmp_path, "JR-12345") == (
        "## Suggested Validation Steps\n\n"
        "1. Reproduce the original issue if possible.\n"
        "2. Confirm the failure no longer occurs.\n"
        "3. If source changes were made, confirm they do not affect unrelated behavior.\n"
        "4. Run the focused tests named in fix_report.md's Tests section, if any.\n"
        "5. Check regression areas mentioned in context.md and retrieval.json.\n\n"
        "## Regression Areas\n\n"
        "- src/WidgetController.cpp\n"
        "- src/WidgetController.h\n"
        "- Risks from the report's Review Notes:\n"
        "  - Check the other enum comparisons in the widget module.\n"
        "  - The legacy VDS path is untested.\n"
    )


def test_with_nothing_to_list_the_rendered_checklist_says_so(tmp_path):
    _work_item(tmp_path, report=None, files=())
    assert workflow._build_manual_validation(tmp_path, "JR-12345").endswith(
        "## Regression Areas\n\n- No related files or review risks available yet.\n"
    )


# --- the prompt says what it can know, and no more -----------------------------------


def test_the_prompt_is_neutral_about_where_the_bug_came_from_and_how_it_ended(tmp_path, monkeypatch, capsys):
    # A Jira issue or a hand-written bug; a fix, an attempt, a no-op or an
    # investigation. The prompt names the work item and leaves the outcome to
    # fix_report.md, which the reviewer reads.
    _work_item(tmp_path)
    _work_item(tmp_path, work_item="local_20260926010922", source="manual")
    monkeypatch.chdir(tmp_path)

    for work_item in ("JR-12345", "local_20260926010922"):
        assert main(["review-package", work_item]) == 0
        prompt = capsys.readouterr().out
        assert prompt.startswith(f"# Final Review Request\n\nReview the BugPilot result for work item {work_item}.\n")
        for claim in ("completed fix", "Jira issue", "the fix matches", "the fix is"):
            assert claim not in prompt, (work_item, claim)
        assert "3. Whether the result matches the reported issue" in prompt
        assert "4. Whether any source change is minimal and safe" in prompt
        assert f".ai/{work_item}/fix_report.md if present" in prompt


def test_the_prompt_asks_for_review_report_sections_and_no_verdict():
    # The answer comes back in review_report.md's own four sections, in its
    # order, so Paste Review Output can fill the Review Result form from it. No
    # verdict, approval or "verified" is asked for: BugPilot records what the
    # reviewer said, and the reviewer is told to keep inspection apart from
    # anything actually run.
    from bugpilot.core.review_report import REVIEW_SECTIONS

    prompt = workflow._build_final_review_prompt("JR-12345")
    lines = prompt.split("\n")
    headings = [line for line in lines if line.startswith("## ")]
    assert headings == [heading for _key, heading in REVIEW_SECTIONS]
    for claim in ("Verdict", "PASS", "NEEDS CHANGES", "LGTM"):
        assert claim not in prompt, claim
    assert "Do not approve the change or call it safe to merge." in prompt
    assert "Do not claim that a test or check ran unless you ran it and saw its result." in prompt
    assert "Do not describe the result as verified unless you name the evidence." in prompt
    assert "If a section has nothing to report, write: Nothing to report." in prompt


def test_the_json_prompt_is_the_human_prompt_for_every_kind_of_work_item(tmp_path, monkeypatch, capsys):
    _work_item(tmp_path)
    _work_item(tmp_path, work_item="local_20260926010922", source="manual")
    monkeypatch.chdir(tmp_path)

    for work_item in ("JR-12345", "local_20260926010922"):
        assert main(["review-package", work_item]) == 0
        human = capsys.readouterr().out
        assert main(["review-package", work_item, "--json"]) == 0
        assert _json(capsys)["prompt"] == human, work_item


# --- the prompt Review with AI puts on a command line (Batch 10) ---------------


def test_the_prompt_stays_plain_enough_for_a_terminal_handoff():
    # The extension's Review with AI hands this prompt to an agent on a command
    # line, quoted the way every handoff is — which is safe only for text no
    # shell expands anything in. So the extension refuses anything outside this
    # class (`isPlainPrompt` in agents.ts), and this pins the builder to
    # it: a `$`, a quote or a backtick added here would turn Review with AI into
    # an error, and this test says so first.
    for work_item in ("JR-12345", "local_20260926010922"):
        prompt = workflow._build_final_review_prompt(work_item)
        assert re.fullmatch(r"\s*[A-Za-z0-9#][A-Za-z0-9\s.,:#/_-]*", prompt), work_item


# --- what run.json says these commands did (§37.70) ------------------------------


def test_status_never_reports_a_validation_or_a_review_that_did_not_happen(tmp_path, monkeypatch, capsys):
    # Printing a checklist is not a manual validation, and printing a prompt is
    # not a review. `result_summary` stays, meaning the overview was rendered —
    # a command having run, never a verdict on the fix.
    _work_item(tmp_path)
    monkeypatch.chdir(tmp_path)
    assert main(["summarize-results", "JR-12345", "--no-jira-comment"]) == 0
    assert main(["review-package", "JR-12345"]) == 0
    capsys.readouterr()

    assert main(["status", "JR-12345", "--json"]) == 0
    payload = _json(capsys)
    steps = payload["steps"]
    assert steps["result_summary"] == "pass"
    assert "manual_validation" not in steps
    assert "final_review_prompt" not in steps
    # Nothing else moved: the run is still prepared, and the report is there.
    assert payload["status"] == "prepared"
    assert (tmp_path / ".ai" / "JR-12345" / "fix_report.md").exists()

    assert main(["status", "JR-12345"]) == 0
    human = capsys.readouterr().out
    assert "result_summary: pass" in human
    assert "manual_validation" not in human
    assert "final_review_prompt" not in human


def test_marks_an_older_run_json_still_carries_are_not_reported(tmp_path, monkeypatch, capsys):
    # A package summarized before this change has `manual_validation: pass` and
    # `final_review_prompt: pass` on disk. They are not steps any more, so no
    # status shows them, and the next write of run.json drops them.
    target = _work_item(tmp_path)
    run = json.loads((target / "run.json").read_text(encoding="utf-8"))
    run["steps"].update({"manual_validation": "pass", "final_review_prompt": "pass"})
    (target / "run.json").write_text(json.dumps(run), encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    assert main(["status", "JR-12345", "--json"]) == 0
    steps = _json(capsys)["steps"]
    assert "manual_validation" not in steps and "final_review_prompt" not in steps

    assert main(["summarize-results", "JR-12345", "--no-jira-comment"]) == 0
    capsys.readouterr()
    on_disk = json.loads((target / "run.json").read_text(encoding="utf-8"))["steps"]
    assert "manual_validation" not in on_disk and "final_review_prompt" not in on_disk
    assert on_disk["result_summary"] == "pass"
