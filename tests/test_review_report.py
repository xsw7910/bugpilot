"""review_report.md: a review's result, recorded (plan §19).

The report exists only because somebody recorded it; its presence says a review
result was recorded and nothing more. These tests hold the format, the refusals,
that recording touches nothing but the one file, the tolerant reader, and how
Fresh, Resume and Retry treat it — the same way they treat fix_report.md.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from bugpilot.cli import main
from bugpilot.core import errors
from bugpilot.core.review_report import (
    MAX_SECTION_CHARS,
    NOT_RECORDED,
    ReviewInput,
    ReviewReportExistsError,
    read_review_report,
    record_review,
    render_review_report,
)

WORK_ITEM = "JR-12345"

FULL = [
    "--summary", "The change is small and reads correctly.",
    "--findings", "- The null check duplicates one in the caller.",
    "--validation-notes", "The reviewer read the diff; no tests were run.",
    "--recommendations", "- Drop the duplicate check.",
]


def _package(root: Path, work_item: str = WORK_ITEM) -> Path:
    target = root / ".ai" / work_item
    target.mkdir(parents=True)
    (target / "run.json").write_text(
        json.dumps({"schema_version": 1, "status": "prepared", "steps": {"prepare": "pass"}}), encoding="utf-8"
    )
    (target / "fix_report.md").write_text("# Fix Report\n\n## Summary\n\nAttempted.\n", encoding="utf-8")
    return target


def _json(capsys) -> dict:
    return json.loads(capsys.readouterr().out)


def _snapshot(directory: Path) -> dict[str, bytes]:
    return {path.name: path.read_bytes() for path in sorted(directory.iterdir())}


# --- the format --------------------------------------------------------------------


def test_the_report_has_every_heading_in_order_and_the_entered_text(tmp_path, monkeypatch, capsys):
    target = _package(tmp_path)
    monkeypatch.chdir(tmp_path)

    assert main(["record-review", WORK_ITEM, *FULL, "--json"]) == 0

    payload = _json(capsys)
    assert payload["ok"] is True
    assert payload["review_report"] == f".ai/{WORK_ITEM}/review_report.md"
    assert payload["replaced"] is False
    assert (target / "review_report.md").read_text(encoding="utf-8") == (
        "# Review Report: JR-12345\n\n"
        "## Summary\n\nThe change is small and reads correctly.\n\n"
        "## Findings\n\n- The null check duplicates one in the caller.\n\n"
        "## Validation Notes\n\nThe reviewer read the diff; no tests were run.\n\n"
        "## Recommendations\n\n- Drop the duplicate check.\n\n"
        "## Source\n\nRecorded from an external review.\n"
    )


def test_a_section_left_empty_is_written_as_not_recorded():
    text = render_review_report(WORK_ITEM, ReviewInput(findings="One finding."))
    assert text.count(NOT_RECORDED) == 3
    for heading in ("## Summary", "## Findings", "## Validation Notes", "## Recommendations", "## Source"):
        assert heading in text


def test_the_text_is_kept_but_cannot_open_a_section_of_its_own():
    entered = "## Critical\n- the writer path\n# Also\nplain `## not at line start` stays"
    text = render_review_report(WORK_ITEM, ReviewInput(findings=entered))
    assert "### Critical\n- the writer path\n### Also\nplain `## not at line start` stays" in text
    # Still exactly one of each of the report's own sections.
    assert text.count("\n## ") == 5


def test_code_fences_are_left_alone_and_indented_headings_are_demoted_too():
    entered = "First.\n   ## Indented\n```bash\n# a shell comment\n## still code\n```\n#\tTabbed"
    text = render_review_report(WORK_ITEM, ReviewInput(findings=entered))
    assert "First.\n   ### Indented\n```bash\n# a shell comment\n## still code\n```\n###\tTabbed" in text


def test_the_format_carries_no_verdict_and_says_who_it_cannot_know():
    text = render_review_report(WORK_ITEM, ReviewInput(summary="Looks fine."))
    lowered = text.lower()
    for word in ("verdict", "approved", "passed", "verified", "status:"):
        assert word not in lowered
    assert "Recorded from an external review." in text
    assert "AI review" not in text


# --- refusals ----------------------------------------------------------------------


@pytest.mark.parametrize("entered", [[], ["--summary", "   ", "--findings", "\n\t"]])
def test_nothing_entered_is_refused_and_nothing_is_written(tmp_path, monkeypatch, capsys, entered):
    target = _package(tmp_path)
    monkeypatch.chdir(tmp_path)

    assert main(["record-review", WORK_ITEM, *entered, "--json"]) == 1

    assert _json(capsys)["error"]["code"] == errors.INVALID_INPUT
    assert not (target / "review_report.md").exists()


@pytest.mark.parametrize("work_item", ["../JR-1", "JR-1/..", "jr", "JR-12345\n", "C:\\x-1"])
def test_an_id_that_is_not_one_is_refused_before_any_path_is_touched(tmp_path, monkeypatch, capsys, work_item):
    monkeypatch.chdir(tmp_path)

    assert main(["record-review", work_item, "--summary", "x", "--json"]) == 1

    assert _json(capsys)["error"]["code"] == errors.INVALID_INPUT
    assert not (tmp_path / ".ai").exists()


def test_a_work_item_never_prepared_is_refused_and_not_created(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)

    assert main(["record-review", WORK_ITEM, "--summary", "x", "--json"]) == 1

    assert _json(capsys)["error"]["code"] == errors.WORK_ITEM_NOT_FOUND
    assert not (tmp_path / ".ai" / WORK_ITEM).exists()


def test_a_section_past_the_cap_is_refused(tmp_path):
    _package(tmp_path)
    with pytest.raises(ValueError, match="Findings"):
        record_review(tmp_path, WORK_ITEM, ReviewInput(findings="x" * (MAX_SECTION_CHARS + 1)))


# --- an existing report ------------------------------------------------------------


def test_a_recorded_review_is_kept_unless_replace_is_asked_for(tmp_path, monkeypatch, capsys):
    target = _package(tmp_path)
    monkeypatch.chdir(tmp_path)
    assert main(["record-review", WORK_ITEM, "--summary", "First review."]) == 0
    first = (target / "review_report.md").read_bytes()
    capsys.readouterr()

    assert main(["record-review", WORK_ITEM, "--summary", "Second review.", "--json"]) == 1
    assert _json(capsys)["error"]["code"] == errors.ARTIFACT_EXISTS
    assert (target / "review_report.md").read_bytes() == first

    assert main(["record-review", WORK_ITEM, "--summary", "Second review.", "--replace", "--json"]) == 0
    assert _json(capsys)["replaced"] is True
    assert "Second review." in (target / "review_report.md").read_text(encoding="utf-8")


def test_the_exists_error_has_its_own_code():
    assert errors.error_code_for(ReviewReportExistsError("kept")) == errors.ARTIFACT_EXISTS


# --- recording touches nothing else ------------------------------------------------


def test_recording_adds_one_file_and_changes_no_other(tmp_path, monkeypatch, capsys):
    target = _package(tmp_path)
    before = _snapshot(target)
    monkeypatch.chdir(tmp_path)

    assert main(["record-review", WORK_ITEM, *FULL]) == 0
    assert main(["record-review", WORK_ITEM, "--summary", "again", "--replace"]) == 0

    after = _snapshot(target)
    assert set(after) - set(before) == {"review_report.md"}
    # run.json above all: no step mark, no status, no "review" anywhere in it.
    assert {name: data for name, data in after.items() if name != "review_report.md"} == before
    assert not (tmp_path / ".ai_memory").exists()


def test_no_legacy_or_state_artifact_is_created(tmp_path, monkeypatch):
    target = _package(tmp_path)
    monkeypatch.chdir(tmp_path)
    assert main(["record-review", WORK_ITEM, *FULL]) == 0
    for name in ("review_report.json", "review_status.json", "reviewer_state.json", "review_completion.json",
                 "final_review_prompt.md", "workflow_status.json", "review_notes.md", "manual_validation.md"):
        assert not (target / name).exists(), name


def test_the_human_output_claims_nothing_about_the_fix(tmp_path, monkeypatch, capsys):
    _package(tmp_path)
    monkeypatch.chdir(tmp_path)
    assert main(["record-review", WORK_ITEM, "--summary", "ok"]) == 0
    out = capsys.readouterr().out
    assert "Recorded the review result" in out
    assert "does not verify the fix" in out


# --- the JSON file the extension sends ---------------------------------------------


def test_a_json_file_carries_the_sections(tmp_path, monkeypatch, capsys):
    target = _package(tmp_path)
    payload = tmp_path / "review.json"
    payload.write_text(
        json.dumps({"summary": "From a file.", "findings": "Line one\nLine two", "validation_notes": None}),
        encoding="utf-8",
    )
    monkeypatch.chdir(tmp_path)

    assert main(["record-review", WORK_ITEM, "--from-file", str(payload), "--json"]) == 0

    report = read_review_report(tmp_path, WORK_ITEM)
    assert report is not None
    assert report.summary == "From a file."
    assert report.findings == "Line one\nLine two"
    assert report.validation_notes == "" and report.recommendations == ""
    assert (target / "review_report.md").exists()


@pytest.mark.parametrize(
    ("contents", "extra"),
    [
        ('{"summary": "x", "verdict": "pass"}', []),
        ('{"summary": 3}', []),
        ('["summary"]', []),
        ("{not json", []),
        ('{"summary": "x"}', ["--summary", "also"]),
    ],
)
def test_a_json_file_that_is_not_the_contract_is_refused(tmp_path, monkeypatch, capsys, contents, extra):
    target = _package(tmp_path)
    payload = tmp_path / "review.json"
    payload.write_text(contents, encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    assert main(["record-review", WORK_ITEM, "--from-file", str(payload), *extra, "--json"]) == 1

    assert _json(capsys)["error"]["code"] == errors.INVALID_INPUT
    assert not (target / "review_report.md").exists()


# --- the reader --------------------------------------------------------------------


def test_the_reader_returns_sections_and_treats_not_recorded_as_empty(tmp_path):
    _package(tmp_path)
    record_review(tmp_path, WORK_ITEM, ReviewInput(summary="S", recommendations="R"))
    report = read_review_report(tmp_path, WORK_ITEM)
    assert report is not None
    assert (report.summary, report.findings, report.validation_notes, report.recommendations) == ("S", "", "", "R")


def test_the_reader_tolerates_a_hand_edited_report(tmp_path):
    target = _package(tmp_path)
    (target / "review_report.md").write_text(
        "Some preface\n## summary  \nKept.\n### Detail\nStill summary.\n## Unknown\nIgnored\n", encoding="utf-8"
    )
    report = read_review_report(tmp_path, WORK_ITEM)
    assert report is not None
    assert report.summary == "Kept.\n### Detail\nStill summary."
    assert report.findings == ""


def test_the_reader_tolerates_bytes_that_are_not_utf8(tmp_path):
    target = _package(tmp_path)
    (target / "review_report.md").write_bytes(b"## Summary\n\n\xff\xfe broken\n")
    report = read_review_report(tmp_path, WORK_ITEM)
    assert report is not None and "broken" in report.summary


def test_no_report_reads_as_none(tmp_path):
    _package(tmp_path)
    assert read_review_report(tmp_path, WORK_ITEM) is None


# --- Fresh, Resume, Retry ----------------------------------------------------------


def test_fresh_deletes_the_review_with_the_rest_of_the_attempt_and_resume_keeps_it(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    assert main(["bug", WORK_ITEM, "--allow-mock", "--prepare-only"]) == 0
    target = tmp_path / ".ai" / WORK_ITEM
    (target / "fix_report.md").write_text("## Summary\n\nAttempted.\n", encoding="utf-8")
    assert main(["record-review", WORK_ITEM, "--summary", "Reviewed."]) == 0

    assert main(["bug", WORK_ITEM, "--resume", "--allow-mock", "--prepare-only"]) == 0
    assert (target / "review_report.md").exists()
    assert (target / "fix_report.md").exists()

    assert main(["bug", WORK_ITEM, "--fresh", "--allow-mock", "--prepare-only"]) == 0
    assert not (target / "review_report.md").exists()
    assert not (target / "fix_report.md").exists()


def test_retry_neither_creates_nor_changes_the_review(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    main(["bug", "--description", "crash on save", "--prepare-only", "--json"])
    work_item = json.loads(capsys.readouterr().out)["work_item_id"]
    target = tmp_path / ".ai" / work_item

    assert main(["bug", work_item, "--retry", "--prepare-only"]) == 0
    assert not (target / "review_report.md").exists()

    assert main(["record-review", work_item, "--summary", "Reviewed the first attempt."]) == 0
    recorded = (target / "review_report.md").read_bytes()
    assert main(["bug", work_item, "--retry", "--prepare-only"]) == 0
    assert (target / "review_report.md").read_bytes() == recorded
