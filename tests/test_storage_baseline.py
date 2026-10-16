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
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path, PurePosixPath, PureWindowsPath

import storage_baseline as baseline


def test_the_compared_baselines_match_todays_behaviour(tmp_path: Path):
    baseline.generate(tmp_path / "now", timing=False)
    assert baseline.differences(baseline.OUT, tmp_path / "now") == []


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
            assert not re.search(r"<(?:repo|config|input|home)>\\", text), (name, text)


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
