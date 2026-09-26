"""The work item id rule, held to one answer by Python and the extension (§37.70).

`tests/fixtures/work_item_ids.json` is read here and by `extension/test/form.test.ts`,
so the two copies of the rule — `WORK_ITEM_ID_RE` in `bugpilot/core/identity.py`
and in `extension/src/app/form.ts` — cannot quietly disagree. They once did:
Python's `$` also matches before a trailing newline, so `"JR-12345\\n"` passed
here and failed there.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from bugpilot.cli import main
from bugpilot.core.identity import is_jira_issue_key, is_known_work_item_id, is_work_item_id, validate_work_item_id

CASES = json.loads((Path(__file__).parent / "fixtures" / "work_item_ids.json").read_text(encoding="utf-8"))


def test_the_shared_valid_ids_are_work_item_ids():
    assert "JR-12345" in CASES["valid"] and "local_20260926010922" in CASES["valid"]
    for value in CASES["valid"]:
        assert is_work_item_id(value), value
        validate_work_item_id(value)


@pytest.mark.parametrize("value", CASES["invalid"])
def test_the_shared_invalid_names_are_not(value):
    assert not is_work_item_id(value)
    with pytest.raises(ValueError):
        validate_work_item_id(value)


def test_a_trailing_newline_is_part_of_the_string_it_ends():
    # `re.match` with `$` accepted these; `fullmatch` does not.
    assert not is_work_item_id("JR-12345\n")
    assert not is_jira_issue_key("JR-12345\n")
    assert not is_known_work_item_id("local_20260926010922\n")


def test_list_skips_folders_that_are_not_work_items_and_leaves_them_alone(tmp_path, monkeypatch, capsys):
    # Anything under .ai/ that is not named like a work item is not one this tool
    # made; listing it would hand its name to the extension's History and from
    # there to a handoff's command line.
    ai = tmp_path / ".ai"
    for name in ("JR-12345", "local_20260926010922", "x$(calc)", "x`calc`_1", "scratch notes", "JR-1.2"):
        (ai / name).mkdir(parents=True)
    monkeypatch.chdir(tmp_path)

    assert main(["list", "--json"]) == 0
    listed = [entry["work_item_id"] for entry in json.loads(capsys.readouterr().out)["work_items"]]

    assert listed == ["JR-12345", "local_20260926010922"]
    # Skipped, never deleted or renamed.
    for name in ("x$(calc)", "x`calc`_1", "scratch notes", "JR-1.2"):
        assert (ai / name).is_dir(), name
