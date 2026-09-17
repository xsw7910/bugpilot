"""Tests for the --json envelope contract."""

from __future__ import annotations

import json
import os
import pathlib

import pytest

from bugpilot.cli import main
from bugpilot.cli_json import SCHEMA_VERSION, failure, success
from bugpilot.core import errors


def _json_out(capsys) -> dict:
    """The single JSON object a --json command writes to stdout."""
    return json.loads(capsys.readouterr().out)


def _run_json(capsys, argv: list[str]) -> tuple[int, dict]:
    code = main(argv)
    return code, _json_out(capsys)


# --- envelope shape ---------------------------------------------------------


def test_success_envelope_carries_the_schema_version():
    payload = success("doctor", report={"a": 1})
    assert payload["schema_version"] == SCHEMA_VERSION
    assert payload["ok"] is True
    assert payload["command"] == "doctor"
    assert payload["warnings"] == []


def test_success_envelope_lets_a_caller_supply_warnings():
    payload = success("check-results", warnings=["missing fix_summary.md"])
    assert payload["warnings"] == ["missing fix_summary.md"]


def test_failure_envelope_separates_code_from_message():
    payload = failure("status", errors.WORK_ITEM_NOT_FOUND, "no such thing")
    assert payload["ok"] is False
    assert payload["error"]["code"] == errors.WORK_ITEM_NOT_FOUND
    assert payload["error"]["message"] == "no such thing"


# --- error codes ------------------------------------------------------------


@pytest.mark.parametrize(
    "error_type, expected",
    [
        ("missing_env", errors.JIRA_NOT_CONFIGURED),
        ("auth_or_permission", errors.JIRA_AUTH_FAILED),
        ("not_found", errors.JIRA_ISSUE_NOT_FOUND),
        ("rate_limited", errors.JIRA_RATE_LIMITED),
        ("timeout", errors.JIRA_TIMEOUT),
        ("network_error", errors.JIRA_NETWORK_ERROR),
        ("invalid_response", errors.JIRA_INVALID_RESPONSE),
        ("unknown_error", errors.JIRA_ERROR),
        (None, errors.JIRA_ERROR),
        ("something new", errors.JIRA_ERROR),
    ],
)
def test_every_jira_error_type_maps_to_a_code(error_type, expected):
    assert errors.code_for_jira_error_type(error_type) == expected


def test_jira_error_message_keys_are_all_mapped():
    """A new ERROR_MESSAGES key must not silently fall back to JIRA_ERROR."""
    from bugpilot.core.jira import ERROR_MESSAGES

    unmapped = [
        key for key in ERROR_MESSAGES if errors.code_for_jira_error_type(key) == errors.JIRA_ERROR
    ]
    assert unmapped == ["unknown_error"]


@pytest.mark.parametrize(
    "exc, expected",
    [
        (FileNotFoundError("gone"), errors.ARTIFACT_NOT_FOUND),
        (ValueError("bad key"), errors.INVALID_INPUT),
        (RuntimeError("boom"), errors.INTERNAL_ERROR),
    ],
)
def test_exception_classification(exc, expected):
    assert errors.error_code_for(exc) == expected


# --- doctor -----------------------------------------------------------------


def test_doctor_json_reports_the_collected_dict(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    code, payload = _run_json(capsys, ["doctor", "--json"])

    assert code == 0
    assert payload["ok"] is True
    assert "python_version" in payload["report"]


def test_doctor_reports_which_bugpilot_this_is(tmp_path, monkeypatch, capsys):
    """A machine can carry a pipx copy, an editable install and an exe at once.

    The extension shows this next to the path it resolved, which is the only way
    a developer can tell which of them just ran.
    """
    from bugpilot import __version__

    monkeypatch.chdir(tmp_path)
    _, payload = _run_json(capsys, ["doctor", "--json"])

    assert payload["report"]["version"] == __version__


def test_module_entry_points_both_work(tmp_path):
    """`python -m bugpilot.cli` used to print nothing and exit 0.

    That reads as "it worked", and it is the form people try when they are
    debugging an import problem in the first place.
    """
    import subprocess
    import sys

    root = pathlib.Path(__file__).resolve().parents[1]
    for module in ("bugpilot", "bugpilot.cli"):
        completed = subprocess.run(
            [sys.executable, "-m", module, "doctor", "--json"],
            cwd=tmp_path,
            capture_output=True,
            text=True,
            env={**os.environ, "PYTHONPATH": str(root)},
        )
        assert completed.returncode == 0, completed.stderr
        assert json.loads(completed.stdout)["command"] == "doctor", module


def test_doctor_without_json_is_unchanged(tmp_path, monkeypatch, capsys):
    """R1: existing human output must survive byte-for-byte."""
    monkeypatch.chdir(tmp_path)
    assert main(["doctor"]) == 0
    out = capsys.readouterr().out
    assert out.startswith("bugpilot doctor\n")
    assert "python_version: " in out


# --- status -----------------------------------------------------------------


def test_status_json_after_a_run(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    main(["bug", "JR-12345", "--allow-mock", "--prepare-only"])
    capsys.readouterr()

    code, payload = _run_json(capsys, ["status", "JR-12345", "--json"])
    assert code == 0
    assert payload["work_item_id"] == "JR-12345"
    assert payload["source"] == "jira"
    assert payload["steps"]["parse"] == "pass"
    assert payload["title"]


def test_status_json_reports_a_missing_work_item_as_a_failure(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    code = main(["status", "JR-99999", "--json"])
    captured = capsys.readouterr()
    payload = json.loads(captured.out)

    assert code == 1
    assert payload["ok"] is False
    assert payload["error"]["code"] == errors.WORK_ITEM_NOT_FOUND
    # The human channel stays populated alongside the machine one.
    assert "ERROR:" in captured.err


# --- check-results ----------------------------------------------------------


def test_check_results_json_lists_what_is_missing(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    main(["bug", "JR-12345", "--allow-mock", "--prepare-only"])
    capsys.readouterr()

    code, payload = _run_json(capsys, ["check-results", "JR-12345", "--json"])
    assert code == 0
    assert payload["ok"] is True
    # Entries are repo-relative paths, not bare file names.
    assert ".ai/JR-12345/fix_summary.md" in payload["missing"]
    assert payload["warnings"]


def test_check_results_strict_json_is_a_failure(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    main(["bug", "JR-12345", "--allow-mock", "--prepare-only"])
    capsys.readouterr()

    code = main(["check-results", "JR-12345", "--strict", "--json"])
    payload = json.loads(capsys.readouterr().out)
    assert code == 1
    assert payload["error"]["code"] == errors.MISSING_RESULTS
    assert payload["missing"]


# --- delivery-check ---------------------------------------------------------


def test_delivery_check_json_reports_readiness(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    main(["bug", "JR-12345", "--allow-mock", "--prepare-only"])
    capsys.readouterr()

    code, payload = _run_json(capsys, ["delivery-check", "JR-12345", "--json"])
    assert code == 0
    assert payload["ready"] is False  # no agent results yet
    assert payload["warnings"]


# --- contract-wide ----------------------------------------------------------


@pytest.mark.parametrize(
    "argv",
    [
        ["doctor", "--json"],
        ["status", "JR-12345", "--json"],
        ["check-results", "JR-12345", "--json"],
        ["delivery-check", "JR-12345", "--json"],
    ],
)
def test_json_mode_writes_exactly_one_object_to_stdout(tmp_path, monkeypatch, capsys, argv):
    """Anything else on stdout would break a consumer parsing the stream."""
    monkeypatch.chdir(tmp_path)
    main(["bug", "JR-12345", "--allow-mock", "--prepare-only"])
    capsys.readouterr()

    main(argv)
    out = capsys.readouterr().out
    payload = json.loads(out)  # raises if anything else was printed
    assert payload["schema_version"] == SCHEMA_VERSION
    assert payload["command"] == argv[0]


def test_non_ascii_survives_the_envelope(capsys):
    from bugpilot.cli_json import emit

    emit(success("status", title="三维视图切换层位后崩溃"))
    out = capsys.readouterr().out
    assert "三维视图切换层位后崩溃" in out  # not \uXXXX escaped
    assert json.loads(out)["title"] == "三维视图切换层位后崩溃"


# --- bug: manual input, options, plan ---------------------------------------


def test_bug_json_for_a_jira_work_item(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    code, payload = _run_json(capsys, ["bug", "JR-12345", "--allow-mock", "--prepare-only", "--json"])

    assert code == 0
    assert payload["work_item_id"] == "JR-12345"
    assert payload["source"] == "jira"
    assert payload["source_ref"] == "JR-12345"
    assert payload["issue_dir"] == ".ai/JR-12345"
    assert payload["agent_task"] == ".ai/JR-12345/agent_task.md"
    assert payload["skipped_steps"] == []


def test_bug_json_for_a_hand_written_description(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    code, payload = _run_json(
        capsys, ["bug", "--description", "3D view crashes after changing horizon", "--prepare-only", "--json"]
    )

    assert code == 0
    assert payload["source"] == "manual"
    assert payload["source_ref"] is None
    assert payload["work_item_id"].startswith("local_")
    assert payload["title"] == "3D view crashes after changing horizon"


def test_bug_reads_a_description_file(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    report = tmp_path / "bug.txt"
    report.write_text("三维视图切换层位后崩溃\n\n复现步骤...", encoding="utf-8")

    code, payload = _run_json(
        capsys, ["bug", "--description-file", str(report), "--prepare-only", "--json"]
    )
    assert code == 0
    assert payload["title"] == "三维视图切换层位后崩溃"


def test_bug_rejects_an_unreadable_description_file(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    code = main(["bug", "--description-file", str(tmp_path / "nope.txt"), "--json"])
    payload = json.loads(capsys.readouterr().out)
    assert code == 1
    assert payload["error"]["code"] == errors.INVALID_INPUT


def test_bug_requires_some_input(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    code = main(["bug", "--json"])
    payload = json.loads(capsys.readouterr().out)
    assert code == 1
    assert payload["error"]["code"] == errors.INVALID_INPUT
    assert "issue key" in payload["error"]["message"]


def test_bug_rejects_both_inputs_at_once(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    code = main(["bug", "JR-12345", "--description", "also this", "--json"])
    payload = json.loads(capsys.readouterr().out)
    assert code == 1
    assert payload["error"]["code"] == errors.INVALID_INPUT


def test_plan_flags_report_what_was_skipped(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    code, payload = _run_json(
        capsys,
        ["bug", "--description", "crash on save", "--skip-git-history", "--prepare-only", "--json"],
    )
    assert code == 0
    assert "git_context" in payload["skipped_steps"]
    assert not (tmp_path / ".ai" / payload["work_item_id"] / "git_context.md").exists()


def test_only_issue_details_skips_everything_else(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    code, payload = _run_json(
        capsys, ["bug", "--description", "crash on save", "--only-issue-details", "--prepare-only", "--json"]
    )
    assert code == 0
    for step in ("code_search", "git_context", "memory_search", "context"):
        assert step in payload["skipped_steps"], step


def test_ignore_path_reaches_the_code_search(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "src").mkdir()
    (tmp_path / "vendor").mkdir()
    (tmp_path / "src" / "W.cpp").write_text("void OpenVdsStatistics() {}\n", encoding="utf-8")
    (tmp_path / "vendor" / "W.cpp").write_text("void OpenVdsStatistics() {}\n", encoding="utf-8")

    code, payload = _run_json(
        capsys,
        ["bug", "--description", "OpenVdsStatistics crashes", "--ignore-path", "vendor",
         "--prepare-only", "--json"],
    )
    assert code == 0
    related = (tmp_path / ".ai" / payload["work_item_id"] / "related_files.json").read_text(encoding="utf-8")
    assert "vendor/W.cpp" not in related


def test_hint_flag_still_reaches_the_artifacts(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    code, payload = _run_json(
        capsys,
        ["bug", "--description", "crash on save", "--hint", "look in VdsWriter", "--prepare-only", "--json"],
    )
    assert code == 0
    hint_file = tmp_path / ".ai" / payload["work_item_id"] / "developer_hint.md"
    assert hint_file.read_text(encoding="utf-8").strip() == "look in VdsWriter"


def test_manual_progress_numbering_excludes_the_jira_fetch(tmp_path, monkeypatch, capsys):
    """Counting to a total that never arrives reads like a stalled run."""
    monkeypatch.chdir(tmp_path)
    main(["bug", "--description", "crash on save", "--prepare-only"])
    out = capsys.readouterr().out
    assert "[1/8] Checking environment..." in out
    assert "Fetching Jira issue" not in out
    assert "Parsing bug details" in out


def test_jira_progress_numbering_is_unchanged(tmp_path, monkeypatch, capsys):
    """R1: the existing nine-step Jira output must not drift."""
    monkeypatch.chdir(tmp_path)
    main(["bug", "JR-12345", "--allow-mock", "--prepare-only"])
    out = capsys.readouterr().out
    assert "[1/9] Checking environment..." in out
    assert "[2/9] Fetching Jira issue JR-12345..." in out
    assert "[3/9] Parsing Jira details..." in out
    assert "[9/9] Generating agent task package..." in out
