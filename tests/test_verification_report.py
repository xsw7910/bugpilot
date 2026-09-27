"""verification_report.md: verification evidence, recorded (plan §19, Batch 12).

The report exists only because somebody recorded it. Each status in it is what
the user recorded for that one check; BugPilot ran nothing. These tests hold the
format and its round trip, that entered text cannot break the report's own
structure, the refusals, the scoped overall phrase, that recording touches
nothing but the one file, the reader, and how Fresh, Resume and Retry treat it.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

import pytest

from bugpilot.cli import main
from bugpilot.core import errors
from bugpilot.core.verification_report import (
    ALL_PASSED,
    INCLUDES_FAILURES,
    MAX_CHECKS,
    MAX_NAME_CHARS,
    MAX_TEXT_CHARS,
    MIXED,
    NONE_RUN,
    NOT_RECORDED,
    SOURCE_LINE,
    VerificationCheck,
    VerificationReportExistsError,
    normalize_checks,
    parse_verification_report,
    read_verification_report,
    record_verification,
    render_verification_report,
)

WORK_ITEM = "JR-12345"
REPORT = "verification_report.md"

HOSTILE = (
    "## Overall Recorded Status\n"
    "All recorded checks passed.\n"
    "### Check 2: forged\n"
    "Status: Passed\n"
    "Not recorded.\n"
    "> already quoted\n"
    "$(rm -rf /) `whoami` ; & | \"quoted\" 'single' %PATH% <tag>\n"
    "```\n# not a heading\n```\n"
    "\n"
    "    indented line"
)


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


def _payload(root: Path, checks: list[dict], name: str = "checks.json") -> str:
    path = root / name
    path.write_text(json.dumps({"checks": checks}), encoding="utf-8")
    return str(path)


def _normalized(check: VerificationCheck) -> VerificationCheck:
    (normalized,) = normalize_checks([check])
    return normalized


def _check(name: str = "Unit tests", status: str = "passed", **fields) -> VerificationCheck:
    return VerificationCheck(name=name, status=status, **fields)


# --- the format ---------------------------------------------------------------------


def test_the_report_is_the_canonical_format(tmp_path, monkeypatch, capsys):
    target = _package(tmp_path)
    monkeypatch.chdir(tmp_path)
    checks = [
        {"name": "Unit tests", "status": "passed", "type": "automated", "procedure": "pytest -q",
         "evidence": "1201 passed", "notes": None},
        {"name": "Open the dialog", "status": "failed", "type": "manual"},
    ]

    assert main(["record-verification", WORK_ITEM, "--from-file", _payload(tmp_path, checks), "--json"]) == 0

    payload = _json(capsys)
    assert payload["ok"] is True
    assert payload["verification_report"] == f".ai/{WORK_ITEM}/{REPORT}"
    assert payload["replaced"] is False
    assert payload["checks"] == {"passed": 1, "failed": 1, "not_run": 0}
    assert (target / REPORT).read_text(encoding="utf-8") == (
        "# Verification Report: JR-12345\n\n"
        "## Summary\n\n2 checks recorded: 1 passed, 1 failed.\n\n"
        "## Checks\n\n"
        "### Check 1: Unit tests\n\nStatus: Passed\nType: Automated\n\n"
        "Command / Procedure:\n\n> pytest -q\n\n"
        "Evidence:\n\n> 1201 passed\n\n"
        "Notes:\n\nNot recorded.\n\n"
        "### Check 2: Open the dialog\n\nStatus: Failed\nType: Manual\n\n"
        "Command / Procedure:\n\nNot recorded.\n\n"
        "Evidence:\n\nNot recorded.\n\n"
        "Notes:\n\nNot recorded.\n\n"
        "## Overall Recorded Status\n\nRecorded checks include failures.\n\n"
        "## Source\n\nVerification evidence explicitly recorded by the user.\n"
    )


def test_every_field_round_trips_exactly():
    checks = (
        _check("A", "passed", type="automated", procedure="npm test", evidence="line 1\n\nline 3", notes="n"),
        _check("B", "failed", type="manual", procedure="", evidence="", notes=""),
        _check("C", "not_run", type="other", procedure="  leading spaces kept", evidence="> quoted", notes="x"),
    )
    parsed = parse_verification_report(render_verification_report(WORK_ITEM, checks))
    assert parsed.checks == checks
    assert (parsed.passed, parsed.failed, parsed.not_run, parsed.total) == (1, 1, 1, 3)


def test_hostile_text_stays_inside_its_field_and_round_trips(tmp_path):
    target = _package(tmp_path)
    check = _check("Shell-looking evidence", "failed", procedure=HOSTILE, evidence=HOSTILE, notes=HOSTILE)
    record_verification(tmp_path, WORK_ITEM, [check])
    text = (target / REPORT).read_text(encoding="utf-8")

    # Only the report's own structure is at the start of a line.
    assert re.findall(r"^## .*$", text, flags=re.M) == [
        "## Summary", "## Checks", "## Overall Recorded Status", "## Source"
    ]
    assert re.findall(r"^### .*$", text, flags=re.M) == ["### Check 1: Shell-looking evidence"]
    assert re.findall(r"^Status: .*$", text, flags=re.M) == ["Status: Failed"]
    # The generated conclusion is the counts', not the forged one.
    assert text.count("\n" + INCLUDES_FAILURES + "\n") == 1
    report = read_verification_report(tmp_path, WORK_ITEM)
    assert report is not None and report.checks == (check,)
    assert (report.passed, report.failed, report.not_run) == (0, 1, 0)


def test_a_multi_line_name_is_one_line():
    normalized = _normalized(_check("First\n## Second\r\nThird   words"))
    assert normalized.name == "First ## Second Third words"


def test_line_endings_and_trailing_space_are_normalized():
    normalized = _normalized(_check(evidence="\r\n\r\none  \r\ntwo\rthree\t\n\n"))
    assert normalized.evidence == "one\ntwo\nthree"


def test_text_that_reads_not_recorded_is_still_recorded():
    checks = (_check(evidence=NOT_RECORDED),)
    text = render_verification_report(WORK_ITEM, checks)
    assert "> Not recorded." in text
    assert parse_verification_report(text).checks == checks


@pytest.mark.parametrize(
    ("statuses", "phrase"),
    [
        (["passed"], ALL_PASSED),
        (["passed", "passed"], ALL_PASSED),
        (["passed", "failed"], INCLUDES_FAILURES),
        (["failed"], INCLUDES_FAILURES),
        (["failed", "not_run"], INCLUDES_FAILURES),
        (["not_run"], NONE_RUN),
        (["not_run", "not_run"], NONE_RUN),
        (["passed", "not_run"], MIXED),
    ],
)
def test_the_overall_phrase_comes_from_the_counts(statuses, phrase):
    checks = tuple(_check(f"Check {index}", status) for index, status in enumerate(statuses))
    text = render_verification_report(WORK_ITEM, checks)
    assert f"## Overall Recorded Status\n\n{phrase}\n" in text


def test_the_summary_counts_only_what_is_there():
    text = render_verification_report(WORK_ITEM, (_check(status="not_run"),))
    assert "1 check recorded: 1 not run." in text


def test_no_generated_wording_claims_more_than_the_evidence():
    checks = tuple(_check(f"C{status}", status) for status in ("passed", "passed"))
    text = render_verification_report(WORK_ITEM, checks).lower()
    for claim in ("verified", "approved", "correct", "safe to merge", "fix verified", "ready to merge", "confidence"):
        assert claim not in text, claim
    assert SOURCE_LINE.lower() in text


# --- refusals -------------------------------------------------------------------------


@pytest.mark.parametrize(
    "checks",
    [
        [],
        [{"name": "  ", "status": "passed"}],
        [{"name": "x", "status": "skipped"}],
        [{"name": "x", "status": "Passed"}],
        [{"name": "x", "status": "passed", "type": "automatic"}],
        [{"name": "x" * (MAX_NAME_CHARS + 1), "status": "passed"}],
        [{"name": "x", "status": "passed", "evidence": "e" * (MAX_TEXT_CHARS + 1)}],
        [{"name": f"c{i}", "status": "not_run"} for i in range(MAX_CHECKS + 1)],
    ],
)
def test_invalid_checks_are_refused_and_nothing_is_written(tmp_path, monkeypatch, capsys, checks):
    target = _package(tmp_path)
    monkeypatch.chdir(tmp_path)

    assert main(["record-verification", WORK_ITEM, "--from-file", _payload(tmp_path, checks), "--json"]) == 1

    assert _json(capsys)["error"]["code"] == errors.INVALID_INPUT
    assert not (target / REPORT).exists()


def test_the_caps_themselves_are_accepted(tmp_path):
    _package(tmp_path)
    checks = [_check("n" * MAX_NAME_CHARS, "passed", evidence="e" * MAX_TEXT_CHARS)]
    checks += [_check(f"c{i}", "not_run") for i in range(MAX_CHECKS - 1)]
    record_verification(tmp_path, WORK_ITEM, checks)
    report = read_verification_report(tmp_path, WORK_ITEM)
    assert report is not None and report.checks is not None and len(report.checks) == MAX_CHECKS


@pytest.mark.parametrize(
    "contents",
    [
        '{"checks": [{"name": "x", "status": "passed", "confidence": 0.9}]}',
        '{"checks": [{"name": "x", "status": "passed", "source": "ci"}]}',
        '{"checks": [{"status": "passed"}]}',
        '{"checks": [{"name": "x"}]}',
        '{"checks": [{"name": 3, "status": "passed"}]}',
        '{"checks": [{"name": "x", "status": ["passed"]}]}',
        '{"checks": [{"name": "x", "status": "passed", "notes": 5}]}',
        '{"checks": ["x"]}',
        '{"checks": {}}',
        '{"checks": [], "verdict": "pass"}',
        '[{"name": "x", "status": "passed"}]',
        "{not json",
    ],
)
def test_a_json_file_that_is_not_the_contract_is_refused(tmp_path, monkeypatch, capsys, contents):
    target = _package(tmp_path)
    payload = tmp_path / "checks.json"
    payload.write_text(contents, encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    assert main(["record-verification", WORK_ITEM, "--from-file", str(payload), "--json"]) == 1

    assert _json(capsys)["error"]["code"] == errors.INVALID_INPUT
    assert not (target / REPORT).exists()


def test_from_file_is_required_and_a_missing_file_is_refused(tmp_path, monkeypatch, capsys):
    target = _package(tmp_path)
    monkeypatch.chdir(tmp_path)

    assert main(["record-verification", WORK_ITEM, "--json"]) == 1
    assert _json(capsys)["error"]["code"] == errors.INVALID_INPUT
    assert main(["record-verification", WORK_ITEM, "--from-file", str(tmp_path / "absent.json"), "--json"]) == 1
    assert _json(capsys)["error"]["code"] == errors.INVALID_INPUT
    assert not (target / REPORT).exists()


def test_an_unprepared_work_item_is_refused_and_no_folder_is_created(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    payload = _payload(tmp_path, [{"name": "x", "status": "passed"}])

    assert main(["record-verification", "JR-99999", "--from-file", payload, "--json"]) == 1

    assert _json(capsys)["error"]["code"] == errors.WORK_ITEM_NOT_FOUND
    assert not (tmp_path / ".ai" / "JR-99999").exists()


def test_an_invalid_work_item_id_is_refused(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    payload = _payload(tmp_path, [{"name": "x", "status": "passed"}])
    assert main(["record-verification", "../escape", "--from-file", payload, "--json"]) == 1
    assert _json(capsys)["ok"] is False
    assert not (tmp_path / "escape").exists()


def test_an_existing_report_is_kept_unless_replace(tmp_path, monkeypatch, capsys):
    target = _package(tmp_path)
    monkeypatch.chdir(tmp_path)
    first = _payload(tmp_path, [{"name": "First", "status": "passed"}], "first.json")
    second = _payload(tmp_path, [{"name": "Second", "status": "failed"}], "second.json")

    assert main(["record-verification", WORK_ITEM, "--from-file", first, "--json"]) == 0
    capsys.readouterr()
    recorded = (target / REPORT).read_bytes()

    assert main(["record-verification", WORK_ITEM, "--from-file", second, "--json"]) == 1
    assert _json(capsys)["error"]["code"] == errors.ARTIFACT_EXISTS
    assert (target / REPORT).read_bytes() == recorded

    assert main(["record-verification", WORK_ITEM, "--from-file", second, "--replace", "--json"]) == 0
    assert _json(capsys)["replaced"] is True
    assert "### Check 1: Second" in (target / REPORT).read_text(encoding="utf-8")


def test_the_exists_error_has_its_own_code():
    assert errors.error_code_for(VerificationReportExistsError("kept")) == errors.ARTIFACT_EXISTS


def test_a_write_that_fails_says_so_and_leaves_no_report(tmp_path, monkeypatch, capsys):
    target = _package(tmp_path)
    monkeypatch.chdir(tmp_path)

    def refuse(path, text):
        raise PermissionError("denied")

    monkeypatch.setattr("bugpilot.core.verification_report.atomic_write_text", refuse)
    payload = _payload(tmp_path, [{"name": "x", "status": "passed"}])
    assert main(["record-verification", WORK_ITEM, "--from-file", payload, "--json"]) == 1

    error = _json(capsys)["error"]
    assert "could not be written" in error["message"]
    assert not (target / REPORT).exists()


def test_a_report_that_would_not_read_back_is_not_written(tmp_path, monkeypatch):
    target = _package(tmp_path)
    monkeypatch.setattr(
        "bugpilot.core.verification_report.render_verification_report", lambda work_item, checks: "# broken\n"
    )
    with pytest.raises(ValueError, match="reads back"):
        record_verification(tmp_path, WORK_ITEM, [_check()])
    assert not (target / REPORT).exists()


# --- recording touches nothing else ---------------------------------------------------


def test_recording_adds_one_file_and_changes_no_other(tmp_path, monkeypatch, capsys):
    target = _package(tmp_path)
    before = _snapshot(target)
    monkeypatch.chdir(tmp_path)
    payload = _payload(tmp_path, [{"name": "x", "status": "passed"}])

    assert main(["record-verification", WORK_ITEM, "--from-file", payload]) == 0
    assert main(["record-verification", WORK_ITEM, "--from-file", payload, "--replace"]) == 0

    after = _snapshot(target)
    assert set(after) - set(before) == {REPORT}
    # run.json above all: no step mark, no status, no "verification" anywhere in it.
    assert {name: data for name, data in after.items() if name != REPORT} == before
    assert not (tmp_path / ".ai_memory").exists()
    # The transport file is the caller's; the CLI neither stores nor deletes it.
    assert Path(payload).exists()


def test_no_sidecar_or_state_artifact_is_created(tmp_path, monkeypatch):
    target = _package(tmp_path)
    monkeypatch.chdir(tmp_path)
    assert main(["record-verification", WORK_ITEM, "--from-file", _payload(tmp_path, [
        {"name": "x", "status": "passed"}
    ])]) == 0
    for name in ("verification_report.json", "verification_status.json", "verified.json", "verification.md",
                 "test_results.json", "workflow_status.json", "manual_validation.md"):
        assert not (target / name).exists(), name


def test_the_human_output_says_the_statuses_are_the_users(tmp_path, monkeypatch, capsys):
    _package(tmp_path)
    monkeypatch.chdir(tmp_path)
    payload = _payload(tmp_path, [{"name": "x", "status": "passed"}, {"name": "y", "status": "not_run"}])
    assert main(["record-verification", WORK_ITEM, "--from-file", payload]) == 0
    out = capsys.readouterr().out
    assert "Recorded the verification evidence" in out
    assert "2 checks recorded: 1 passed, 1 not run." in out
    assert "ran none of these checks" in out
    assert "verified" not in out.lower().replace("verification", "")


def test_a_missing_type_is_recorded_as_other_not_automated():
    normalized = _normalized(VerificationCheck(name="x", status="passed"))
    assert normalized.type == "other"


# --- the reader -----------------------------------------------------------------------


def test_no_report_reads_as_none(tmp_path):
    _package(tmp_path)
    assert read_verification_report(tmp_path, WORK_ITEM) is None


def test_a_hand_edited_report_gives_counts_but_no_guessed_checks(tmp_path):
    target = _package(tmp_path)
    (target / REPORT).write_text(
        "# Verification Report\n\n## Checks\n\n### Check 1: tests\nStatus: Passed\n\nsome prose\n"
        "### Check 2: manual\nStatus: Failed\nType: Manual\n\n## Overall Recorded Status\n\nwhatever\n",
        encoding="utf-8",
    )
    report = read_verification_report(tmp_path, WORK_ITEM)
    assert report is not None
    assert report.checks is None
    assert (report.passed, report.failed, report.not_run) == (1, 1, 0)


def test_a_report_with_crlf_line_endings_still_parses(tmp_path):
    target = _package(tmp_path)
    checks = (_check(evidence="a\nb"),)
    (target / REPORT).write_bytes(render_verification_report(WORK_ITEM, checks).replace("\n", "\r\n").encode())
    report = read_verification_report(tmp_path, WORK_ITEM)
    assert report is not None and report.checks == checks


def test_the_reader_tolerates_bytes_that_are_not_utf8(tmp_path):
    target = _package(tmp_path)
    (target / REPORT).write_bytes(b"## Checks\n\n### Check 1: x\n\nStatus: Passed\n\xff\xfe\n")
    report = read_verification_report(tmp_path, WORK_ITEM)
    assert report is not None and report.passed == 1 and report.checks is None


def test_out_of_order_check_numbers_are_not_structured():
    text = render_verification_report(WORK_ITEM, (_check("a"), _check("b"))).replace("### Check 2:", "### Check 3:")
    assert parse_verification_report(text).checks is None


# --- Fresh, Resume, Retry -------------------------------------------------------------


def test_fresh_deletes_the_evidence_with_the_rest_of_the_attempt_and_resume_keeps_it(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    assert main(["bug", WORK_ITEM, "--allow-mock", "--prepare-only"]) == 0
    target = tmp_path / ".ai" / WORK_ITEM
    (target / "fix_report.md").write_text("## Summary\n\nAttempted.\n", encoding="utf-8")
    payload = _payload(tmp_path, [{"name": "x", "status": "passed"}])
    assert main(["record-verification", WORK_ITEM, "--from-file", payload]) == 0
    recorded = (target / REPORT).read_bytes()

    assert main(["bug", WORK_ITEM, "--resume", "--allow-mock", "--prepare-only"]) == 0
    assert (target / REPORT).read_bytes() == recorded

    assert main(["bug", WORK_ITEM, "--fresh", "--allow-mock", "--prepare-only"]) == 0
    assert not (target / REPORT).exists()
    assert not (target / "fix_report.md").exists()


def test_retry_neither_creates_nor_changes_the_evidence(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    main(["bug", "--description", "crash on save", "--prepare-only", "--json"])
    work_item = json.loads(capsys.readouterr().out)["work_item_id"]
    target = tmp_path / ".ai" / work_item

    assert main(["bug", work_item, "--retry", "--prepare-only"]) == 0
    assert not (target / REPORT).exists()

    payload = _payload(tmp_path, [{"name": "First attempt", "status": "failed"}])
    assert main(["record-verification", work_item, "--from-file", payload]) == 0
    recorded = (target / REPORT).read_bytes()
    assert main(["bug", work_item, "--retry", "--prepare-only"]) == 0
    assert (target / REPORT).read_bytes() == recorded


def test_clean_deletes_the_evidence(tmp_path, monkeypatch, capsys):
    target = _package(tmp_path)
    monkeypatch.chdir(tmp_path)
    assert main(["record-verification", WORK_ITEM, "--from-file", _payload(tmp_path, [
        {"name": "x", "status": "passed"}
    ])]) == 0
    assert main(["clean", WORK_ITEM]) == 0
    assert not (target / REPORT).exists()


def test_deeply_nested_json_is_refused_as_input_not_a_traceback(tmp_path, monkeypatch, capsys):
    target = _package(tmp_path)
    payload = tmp_path / "checks.json"
    payload.write_text('{"checks": ' + "[" * 100_000 + "]" * 100_000 + "}", encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    assert main(["record-verification", WORK_ITEM, "--from-file", str(payload), "--json"]) == 1

    assert _json(capsys)["error"]["code"] == errors.INVALID_INPUT
    assert not (target / REPORT).exists()
