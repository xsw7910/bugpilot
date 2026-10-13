"""The CI reporter turns test output into annotations faithfully, and escapes them (0.1.5 Batch 0)."""

from __future__ import annotations

import json

import ci_report


def test_an_annotation_escapes_what_the_runner_would_read_as_a_command():
    line = ci_report.annotation("notice", "a: b, c", "50% done\nnext line\r")
    assert line == "::notice title=a%3A b%2C c::50%25 done%0Anext line%0D"
    assert "\n" not in line


def test_a_long_message_is_cut_and_says_so():
    line = ci_report.annotation("notice", "t", "x" * 10_000)
    assert len(line) < ci_report.MESSAGE_LIMIT + 50 and line.endswith("(cut; see the log)")


def test_the_pytest_report_carries_the_summary_failures_skips_and_observations(tmp_path):
    log = (
        "..F.s\n"
        "FAILED tests/test_x.py::test_y - AssertionError: assert 1 == 2\n"
        "SKIPPED [1] tests/test_z.py:3: permission bits are POSIX's\n"
        "3 passed, 1 failed, 1 skipped in 2.50s\n"
    )
    (tmp_path / "file_safety_linux_py313.json").write_text(json.dumps({"new_file_mode": {"0o22": "0o600"}}),
                                                           encoding="utf-8")
    lines = ci_report.pytest_report(log, tmp_path)
    assert lines[0] == "::notice title=pytest summary::3 passed, 1 failed, 1 skipped in 2.50s"
    assert lines[1].startswith("::error title=pytest failures (1)::FAILED tests/test_x.py::test_y")
    assert lines[2].startswith("::notice title=pytest skips (1 lines)::SKIPPED [1]")
    assert lines[3] == '::notice title=observed%3A file_safety_linux_py313::{"new_file_mode":{"0o22":"0o600"}}'


def test_a_clean_pytest_run_reports_only_its_summary():
    assert ci_report.pytest_report("....\n4 passed in 0.10s\n") == ["::notice title=pytest summary::4 passed in 0.10s"]


def test_the_node_report_carries_the_totals_and_failures():
    log = "✔ ok (1ms)\n✖ breaks (2ms)\nℹ tests 2\nℹ pass 1\nℹ fail 1\n✖ breaks (2ms)\n"
    lines = ci_report.node_report(log)
    assert lines[0] == "::notice title=node --test summary::ℹ tests 2%0Aℹ pass 1%0Aℹ fail 1"
    assert lines[1] == "::error title=node --test failures (1)::✖ breaks (2ms)"


def test_the_node_report_reads_the_tap_reporter_too():
    log = "TAP version 13\nok 1 - fine\nnot ok 2 - breaks\n# tests 2\n# pass 1\n# fail 1\n"
    lines = ci_report.node_report(log)
    assert lines[0] == "::notice title=node --test summary::# tests 2%0A# pass 1%0A# fail 1"
    assert lines[1] == "::error title=node --test failures (1)::not ok 2 - breaks"


def test_the_reporter_never_fails_a_job(tmp_path, capsys):
    assert ci_report.main(["pytest", str(tmp_path / "missing.log")]) == 0
    assert "no pytest summary line found" in capsys.readouterr().out
    assert ci_report.main([]) == 0
