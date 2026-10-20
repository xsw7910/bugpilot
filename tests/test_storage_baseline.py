"""The synthetic 0.1.5 storage baselines, held to today's behaviour (0.1.6 Batch 0A, plan §14.1.A).

`tests/baselines/0.1.6-batch0/` records what 0.1.5 does with storage
(`tests/storage_baseline.py`). These tests regenerate the compared records in
the test isolation and require them byte-identical, so a change to where
BugPilot writes, what the handoff says or which JSON field names a path shows
up here — expected in Batch 2, which flips them on purpose, and a regression
anywhere else.

The platform path observations (plan §7.3) are written to
`$BUGPILOT_BASELINE_OUT` when that is set, so CI keeps each system's record in
its file-safety artifact. They are never compared: a runner's privileges
(symbolic links on Windows) differ from a developer machine's.

Batch 2B-2 changes three values on purpose. They are listed, exactly, in
`tests/baselines/0.1.6-batch2b2/designed_differences.json`, and the frozen
records stay byte for byte as Batch 0A wrote them. Whether a listed value is
right is one test; whether the owner has approved it is another, so a pending
review never hides a wrong value.
"""

from __future__ import annotations

import copy
import json
import os
import re
import sys
from pathlib import Path, PurePosixPath, PureWindowsPath

import pytest

import storage_baseline as baseline


def test_the_compared_baselines_match_todays_behaviour(tmp_path: Path):
    baseline.generate(tmp_path / "now", timing=False)
    assert baseline.differences(baseline.OUT, tmp_path / "now") == []


def test_every_designed_difference_is_approved_by_the_owner():
    """The approval gate (plan §14.3, Q-6 and C-4): a value is recorded only after the owner reviewed it."""
    assert baseline.unapproved(baseline.load_designed()) == []


def test_the_designed_differences_record_is_well_formed_and_made_against_the_frozen_records():
    designed = baseline.load_designed()
    assert baseline.designed_problems(designed) == []
    assert designed["base_commit"] == "ea9659cd39ccc16565a95ffce5937eee1bdbbf51"


def test_each_designed_difference_names_independent_evidence_that_exists():
    """Its `evidence` is a test that asserts the new value from first principles, never from a baseline."""
    for entry in baseline.load_designed()["differences"]:
        file, _, name = entry["evidence"].partition("::")
        assert file.startswith("tests/test_") and file != "tests/test_storage_baseline.py", entry["id"]
        assert f"def {name}(" in (baseline.REPO / file).read_text(encoding="utf-8"), entry["id"]


# --- the designed-difference mechanism, on synthetic records ----------------------------------------


@pytest.fixture
def synthetic(tmp_path: Path):
    """Four synthetic committed records, today's copies of them, and a designed record made against them."""
    expected, actual = tmp_path / "expected", tmp_path / "actual"
    expected.mkdir()
    actual.mkdir()
    records = {name: {"name": name, "flag": True, "items": ["a", "b"], "odd/key~": "x"} for name in baseline.COMPARED}
    for name, value in records.items():
        (expected / name).write_bytes(baseline._dump(value))
        (actual / name).write_bytes(baseline._dump(value))
    designed = {
        "describes": "synthetic",
        "base_commit": "0" * 40,
        "frozen": {name: baseline.frozen_sha256(expected / name) for name in baseline.COMPARED},
        "differences": [],
    }

    def change(name: str, update) -> None:
        value = copy.deepcopy(records[name])
        update(value)
        (actual / name).write_bytes(baseline._dump(value))

    def entry(pointer: str, before, after, record: str = "cli_paths.json", ident: str = "DD-x") -> dict:
        return {"id": ident, "record": record, "pointer": pointer, "from": before, "to": after,
                "decision": "synthetic", "evidence": "synthetic", "approved": None}

    return expected, actual, designed, change, entry


def test_unchanged_records_and_no_entries_compare_clean(synthetic):
    expected, actual, designed, _change, _entry = synthetic
    assert baseline.differences(expected, actual, designed) == []


def test_a_listed_difference_that_happened_passes(synthetic):
    expected, actual, designed, change, entry = synthetic
    change("cli_paths.json", lambda value: value["items"].__setitem__(1, "c"))
    designed["differences"] = [entry("/items/1", "b", "c")]
    assert baseline.differences(expected, actual, designed) == []


def test_an_unlisted_difference_fails(synthetic):
    expected, actual, designed, change, entry = synthetic
    change("cli_paths.json", lambda value: value["items"].__setitem__(1, "c"))
    assert baseline.differences(expected, actual, designed) == ["cli_paths.json: differs from the committed baseline"]
    change("handoff.json", lambda value: value.__setitem__("flag", False))
    designed["differences"] = [entry("/items/1", "b", "c")]
    assert baseline.differences(expected, actual, designed) == ["handoff.json: differs from the committed baseline"]


def test_a_difference_beside_a_listed_one_fails(synthetic):
    expected, actual, designed, change, entry = synthetic
    change("cli_paths.json", lambda value: (value["items"].__setitem__(1, "c"), value.__setitem__("flag", False)))
    designed["differences"] = [entry("/items/1", "b", "c")]
    assert baseline.differences(expected, actual, designed) == [
        "cli_paths.json: differs from the committed baseline beyond its designed differences"]


def test_a_listed_difference_that_did_not_happen_fails(synthetic):
    expected, actual, designed, _change, entry = synthetic
    designed["differences"] = [entry("/items/1", "b", "c")]
    assert baseline.differences(expected, actual, designed) == ["cli_paths.json DD-x: today's value at /items/1 is not `to`"]


def test_a_stale_from_fails(synthetic):
    expected, actual, designed, change, entry = synthetic
    change("cli_paths.json", lambda value: value["items"].__setitem__(1, "c"))
    designed["differences"] = [entry("/items/1", "z", "c")]
    assert baseline.differences(expected, actual, designed) == [
        "cli_paths.json DD-x: the committed value at /items/1 is not `from`"]


def test_values_are_compared_with_their_type(synthetic):
    """``true`` is not ``1``: a pair that only matches by Python's ``==`` is stale."""
    expected, actual, designed, change, entry = synthetic
    change("cli_paths.json", lambda value: value.__setitem__("flag", 0))
    designed["differences"] = [entry("/flag", 1, 0)]
    assert baseline.differences(expected, actual, designed) == [
        "cli_paths.json DD-x: the committed value at /flag is not `from`"]


def test_pointer_escapes_follow_rfc_6901(synthetic):
    expected, actual, designed, change, entry = synthetic
    change("cli_paths.json", lambda value: value.__setitem__("odd/key~", "y"))
    designed["differences"] = [entry("/odd~1key~0", "x", "y")]
    assert baseline.differences(expected, actual, designed) == []
    assert baseline.pointer_parts("/a~1b/c~0d/0") == ["a/b", "c~d", "0"]
    for bad in ("", "a/b", "/a~2b", "/a~"):
        with pytest.raises(ValueError):
            baseline.pointer_parts(bad)


def test_a_changed_frozen_record_is_refused(synthetic):
    expected, actual, designed, _change, _entry = synthetic
    (expected / "task_size.json").write_bytes(baseline._dump({"name": "edited"}))
    problems = baseline.differences(expected, actual, designed)
    assert problems == ["task_size.json: the committed baseline is not the one the designed differences were made against"]


@pytest.mark.parametrize("mutate, message", [
    (lambda d, e: d["differences"].extend([e("/items", ["a", "b"], []), e("/items/1", "b", "c", ident="DD-y")]),
     "DD-y: /items/1 is listed twice, or lies inside another listed pointer"),
    (lambda d, e: d["differences"].extend([e("/flag", True, False), e("/flag", True, False, ident="DD-y")]),
     "DD-y: /flag is listed twice, or lies inside another listed pointer"),
    (lambda d, e: d["differences"].append(e("/flag", True, False, record="prepare_timing.json")),
     "DD-x: 'prepare_timing.json' is not a compared record"),
    (lambda d, e: d["differences"].append(e("/flag", True, True)),
     "DD-x: `from` and `to` are the same value, so nothing would differ"),
    (lambda d, e: d["differences"].extend([e("/flag", True, False), e("/name", "x", "y")]),
     "designed differences: a missing or repeated id 'DD-x'"),
])
def test_a_malformed_designed_record_is_refused(synthetic, mutate, message):
    expected, actual, designed, _change, entry = synthetic
    mutate(designed, entry)
    assert message in baseline.differences(expected, actual, designed)


def test_approval_is_judged_apart_from_the_values(synthetic):
    expected, actual, designed, change, entry = synthetic
    change("cli_paths.json", lambda value: value["items"].__setitem__(1, "c"))
    designed["differences"] = [entry("/items/1", "b", "c")]
    assert baseline.differences(expected, actual, designed) == []
    assert baseline.unapproved(designed) == ["DD-x"]
    designed["differences"][0]["approved"] = "2026-10-19, the owner"
    assert baseline.unapproved(designed) == []


def test_pointer_differences_name_each_changed_value():
    before = {"a": {"b": 1, "c": [1, 2]}, "d": ["x"], "e": "same"}
    after = {"a": {"b": 2, "c": [1, 3]}, "d": [], "e": "same", "f": True}
    assert baseline.pointer_differences(before, after) == [
        ("/a/b", 1, 2), ("/a/c/1", 2, 3), ("/d", ["x"], []), ("/f", None, True)]


def _strings(value: object) -> list[str]:
    if isinstance(value, str):
        return [value]
    if isinstance(value, list):
        return [text for item in value for text in _strings(item)]
    if isinstance(value, dict):
        return [text for item in value.values() for text in _strings(item)]
    return []


def test_a_path_argument_is_recorded_the_same_from_either_platform():
    """The same argument, spelled by Windows or by POSIX, is recorded as the same text."""
    for root, path in (
        (PureWindowsPath("D:/work/bugpilot-x"), PureWindowsPath(r"D:\work\bugpilot-x\inputs\review.json")),
        (PurePosixPath("/srv/work/bugpilot-x"), PurePosixPath("/srv/work/bugpilot-x/inputs/review.json")),
    ):
        labels = [(root / "repo", "<repo>"), (root / "inputs", "<input>")]
        assert baseline.portable_path(path, labels) == "<input>/review.json"
        assert baseline.portable_path(path.parent / "nested" / "a.md", labels) == "<input>/nested/a.md"
        assert baseline.portable_path(root / "inputs", labels) == "<input>"
    # Outside every root: spelled in full with `/`, which the private-path test below would catch.
    windows_labels = [(PureWindowsPath(r"D:\work\bugpilot-x\inputs"), "<input>")]
    assert baseline.portable_path(PureWindowsPath(r"D:\elsewhere\x.json"), windows_labels) == "D:/elsewhere/x.json"


def test_only_path_arguments_are_rewritten(tmp_path: Path):
    """Text that is not a path keeps a backslash it holds on purpose."""
    session = baseline.Session(tmp_path / "s")
    command = session.command(["bug", r"--description=Crash in src\record.py", "--from-file", session.inputs / "review.json"])
    assert command == r"bugpilot bug --description=Crash in src\record.py --from-file <input>/review.json"


def test_no_compared_record_spells_a_temporary_path_with_a_backslash():
    """`<input>\\review.json` is a Windows spelling, which Linux and macOS would not reproduce."""
    for name in baseline.COMPARED:
        for text in _strings(json.loads((baseline.OUT / name).read_text(encoding="utf-8"))):
            assert not re.search(r"<(?:repo|config|data|input|home)>\\", text), (name, text)


def test_the_0_1_5_pollution_baseline_records_repository_local_folders():
    """0.1.5 writes into the repository; Batch 2 deliberately changes this expectation."""
    record = json.loads((baseline.OUT / "pollution.json").read_text(encoding="utf-8"))
    assert record["bugpilot_folders_in_repository"] == [".ai", ".ai_memory", ".bugpilot"]
    assert all(step["exit"] == 0 for step in record["steps"]), [s["step"] for s in record["steps"] if s["exit"]]
    read_only = [step for step in record["steps"] if "(read-only)" in step["step"]]
    assert len(read_only) == 7
    assert all(step["created"] == [] and step["removed"] == [] for step in read_only)
    user = next(step for step in record["steps"] if step["step"].startswith("user instructions"))
    assert user["created"] == [] and record["user_configuration_written"] == ["instructions.md"]


def test_the_committed_baselines_name_no_private_path():
    private = re.compile(
        r"[A-Za-z]:[\\/]|(?<![\w.])/(?:home|Users|tmp|private|var)/|AppData|bugpilot-test-|pytest-of-",
        re.IGNORECASE,
    )
    for path in sorted(baseline.OUT.glob("*.json")):
        found = private.findall(path.read_text(encoding="utf-8"))
        assert found == [], (path.name, found)


def test_the_compared_records_hold_nothing_machine_specific():
    for name in baseline.COMPARED:
        text = (baseline.OUT / name).read_text(encoding="utf-8")
        assert "median_ms" not in text and "python_version" not in text, name


def test_platform_path_observations(tmp_path: Path):
    """How this system canonicalizes one folder's spellings; recorded for CI, asserted where §7.3 relies on it."""
    seen = baseline.observe_realpath(tmp_path)
    out = os.environ.get("BUGPILOT_BASELINE_OUT")
    if out:
        directory = Path(out)
        directory.mkdir(parents=True, exist_ok=True)
        name = f"storage_realpath_{sys.platform}_py{sys.version_info.major}{sys.version_info.minor}.json"
        (directory / name).write_text(json.dumps(seen, indent=1, sort_keys=True) + "\n", encoding="utf-8")
    assert seen["separators_and_dots"] is True
    assert seen["trailing_separator"] is True
    assert seen["forward_slashes"] is True
    assert seen["strict_missing_raises"] is True
    link = seen["symlink_resolves_to_target"]
    assert link is True or str(link).startswith("unavailable")
    if sys.platform == "win32":
        assert seen["case_variant_resolves_to_stored_case"] is True
        assert seen["junction_resolves_to_target"] is True
    elif sys.platform.startswith("linux"):
        assert seen["case_variant_resolves_to_stored_case"] == "error: FileNotFoundError"
