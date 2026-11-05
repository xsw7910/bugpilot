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

Batch 2B-3a adds a record of its own (CH-1), applied after 2B-2's, and the
sessions label their repository's ID (M-a): another repository's ID in a
record is an error, never normalized away.

Batch 2B-3b adds a third record, and the two approved supersession pairs
(E-3): an earlier entry's evidence is required until a matching successor is
approved, a pending pair keeps the approval gate failing, and anything else
is a problem rather than an exemption.
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
    """The approval gate (plan §14.3, Q-6 and C-4): a value is recorded only after the owner reviewed it.

    A supersession pair whose successor awaits approval is reported here too (E-3), never accepted silently.
    """
    chain = baseline.load_chain()
    assert baseline.unapproved(chain) == []
    assert baseline.pending_supersessions(chain) == []


def test_the_designed_differences_records_are_well_formed_and_made_against_the_frozen_records():
    chain = baseline.load_chain()
    assert baseline.chain_problems(chain) == []
    assert [designed["base_commit"] for designed in chain] == [
        "ea9659cd39ccc16565a95ffce5937eee1bdbbf51",  # Batch 2B-2
        "5b66ffea28ee660599428453391cf32ad20a6818",  # Batch 2B-3a
        "93118926956464e6baa9c5c2631bc74166bf241c",  # Batch 2B-3b
        "8d69f6fc66a1c5e4c76a958e9e692c770ee937d7",  # 0.1.7, Simplified Unified Storage
    ]
    assert [path.parent.name for path in baseline.DESIGNED_CHAIN] == [
        "0.1.6-batch2b2", "0.1.6-batch2b3a", "0.1.6-batch2b3b", "0.1.7"]


def test_each_designed_difference_names_independent_evidence_that_exists():
    """Its `evidence` is a test that asserts the new value from first principles, never from a baseline.

    Only an earlier entry of a pending or active supersession pair (E-3) may have retired its test: an inactive
    pair's evidence is still required, and a pair with any problem exempts nothing.
    """
    chain = baseline.load_chain()
    states, problems = baseline.supersession(chain)
    assert problems == []
    exempt = {earlier for earlier, state in states.items() if state in (baseline.PENDING, baseline.ACTIVE)}
    for entry in (entry for designed in chain for entry in designed["differences"]):
        file, _, name = entry["evidence"].partition("::")
        assert file.startswith("tests/test_") and file != "tests/test_storage_baseline.py", entry["id"]
        if entry["id"] in exempt:
            continue
        assert f"def {name}(" in (baseline.REPO / file).read_text(encoding="utf-8"), entry["id"]


def test_the_supersession_table_is_exactly_the_two_approved_pairs_with_their_historical_evidence():
    assert baseline.SUPERSEDED == {
        "DD-5": {"by": "U7-10", "verified_at": "743f542ad328b1af5eb9f0b494d07491f2b33ed7", "ci_run": "39675645316"},
        "DD-9": {"by": "U7-12", "verified_at": "743f542ad328b1af5eb9f0b494d07491f2b33ed7", "ci_run": "39675645316"},
    }


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


# --- chained per-slice records (CH-1, Batch 2B-3a) ---------------------------------------------------


def _slice(designed: dict, *entries: dict) -> dict:
    """A later slice's record, made against the same frozen records as ``designed``."""
    return {**copy.deepcopy(designed), "describes": "a later synthetic slice", "differences": list(entries)}


def test_a_later_slice_changes_a_value_again_from_the_earlier_slices_to(synthetic):
    expected, actual, designed, change, entry = synthetic
    change("cli_paths.json", lambda value: value["items"].__setitem__(1, "d"))
    first = {**designed, "differences": [entry("/items/1", "b", "c", ident="DD-1")]}
    second = _slice(designed, entry("/items/1", "c", "d", ident="DD-2"))
    assert baseline.differences(expected, actual, [first, second]) == []
    assert baseline.unapproved([first, second]) == ["DD-1", "DD-2"]


def test_a_later_slice_whose_from_ignores_the_earlier_slice_fails(synthetic):
    """`from` is the value the earlier records leave, not the frozen one: a chain is never skipped over."""
    expected, actual, designed, change, entry = synthetic
    change("cli_paths.json", lambda value: value["items"].__setitem__(1, "d"))
    first = {**designed, "differences": [entry("/items/1", "b", "c", ident="DD-1")]}
    second = _slice(designed, entry("/items/1", "b", "d", ident="DD-2"))
    assert baseline.differences(expected, actual, [first, second]) == [
        "cli_paths.json DD-2: the value the earlier designed differences leave at /items/1 is not `from`"]


def test_the_earlier_slices_values_still_hold_where_no_later_slice_changes_them(synthetic):
    expected, actual, designed, change, entry = synthetic
    change("cli_paths.json", lambda value: value["items"].__setitem__(1, "c"))
    first = {**designed, "differences": [entry("/items/1", "b", "c", ident="DD-1")]}
    assert baseline.differences(expected, actual, [first, _slice(designed)]) == []
    change("cli_paths.json", lambda value: value["items"].__setitem__(1, "b"))
    assert baseline.differences(expected, actual, [first, _slice(designed)]) == [
        "cli_paths.json DD-1: today's value at /items/1 is not `to`"]


def test_a_value_a_later_slice_changes_is_judged_by_that_slices_to_only(synthetic):
    expected, actual, designed, change, entry = synthetic
    first = {**designed, "differences": [entry("/items/1", "b", "c", ident="DD-1")]}
    second = _slice(designed, entry("/items", ["a", "c"], ["z"], ident="DD-2"))
    assert baseline.differences(expected, actual, [first, second]) == [
        "cli_paths.json DD-2: today's value at /items is not `to`"]


def test_an_id_two_slices_use_is_refused(synthetic):
    expected, actual, designed, _change, entry = synthetic
    first = {**designed, "differences": [entry("/flag", True, False, ident="DD-1")]}
    second = _slice(designed, entry("/name", "cli_paths.json", "x", ident="DD-1"))
    assert "designed differences: the id 'DD-1' is listed by more than one slice's record" in baseline.differences(
        expected, actual, [first, second])


def test_every_slice_must_be_made_against_the_frozen_records(synthetic):
    expected, actual, designed, _change, _entry = synthetic
    second = _slice(designed)
    second["frozen"] = {**second["frozen"], "handoff.json": "0" * 64}
    assert baseline.differences(expected, actual, [designed, second]) == [
        "handoff.json: the committed baseline is not the one the designed differences were made against"]


# --- superseded evidence (E-3, Batch 2B-3b), on synthetic records in memory -------------------------

_OLD = {"DD-5": "tests/test_a.py::old_five", "DD-9": "tests/test_a.py::old_nine"}
_NEW = {"U7-10": "tests/test_b.py::new_thirteen", "U7-12": "tests/test_b.py::new_fifteen"}


def _entry(ident: str, pointer: str, before, after, evidence: str, approved: str | None = "2026-10-21") -> dict:
    return {"id": ident, "record": "pollution.json", "pointer": pointer, "from": before, "to": after,
            "decision": "synthetic", "evidence": evidence, "approved": approved}


def _u7_10(**changes) -> dict:
    return {**_entry("U7-10", "/steps/9/created", ["a", "b"], [], _NEW["U7-10"]), **changes}


def _u7_12(**changes) -> dict:
    return {**_entry("U7-12", "/git_status", ["x"], [], _NEW["U7-12"]), **changes}


def _record(name: str, *entries: dict) -> dict:
    return {"describes": name, "base_commit": "0" * 40, "frozen": {}, "differences": list(entries)}


def _supersession_chain(*later: dict) -> list[dict]:
    """An earlier slice holding DD-5 and DD-9, then a later slice holding ``later``."""
    earlier = _record("earlier", _entry("DD-5", "/steps/9/created", ["a"], ["a", "b"], _OLD["DD-5"]),
                      _entry("DD-9", "/git_status", ["x", "y"], ["x"], _OLD["DD-9"]))
    return [earlier, _record("later", *later)]


def _judge(chain: list[dict], present: set[str], table: dict | None = None):
    def exists(evidence: object) -> bool:
        return evidence in present

    table = baseline.SUPERSEDED if table is None else table
    return (*baseline.supersession(chain, table, exists), baseline.pending_supersessions(chain, table, exists))


def test_both_pairs_are_inactive_while_the_successor_record_is_empty():
    states, problems, pending = _judge(_supersession_chain(), set(_OLD.values()))
    assert states == {"DD-5": baseline.INACTIVE, "DD-9": baseline.INACTIVE}
    assert problems == [] and pending == []


def test_an_inactive_pair_still_requires_its_historical_evidence():
    """No successor yet: a retired earlier test is a problem, not an exemption."""
    states, problems, _pending = _judge(_supersession_chain(), {_OLD["DD-9"]})
    assert states["DD-5"] == baseline.INACTIVE
    assert problems == ["supersession DD-5 -> U7-10: inactive, so DD-5's evidence is still required, and it is missing"]


def test_a_missing_successor_never_excuses_retired_evidence_for_either_pair():
    _states, problems, pending = _judge(_supersession_chain(), set())
    assert len(problems) == 2 and all("still required" in problem for problem in problems) and pending == []


def test_a_pair_whose_earlier_entry_is_not_in_the_chain_is_a_problem():
    chain = [_record("earlier", _entry("DD-9", "/git_status", ["x", "y"], ["x"], _OLD["DD-9"])), _record("later")]
    states, problems, _pending = _judge(chain, set(_OLD.values()))
    assert "DD-5" not in states
    assert problems == ["supersession DD-5 -> U7-10: DD-5 is not listed exactly once in the chain"]


def test_a_duplicated_successor_is_a_problem():
    chain = [*_supersession_chain(_u7_10()), _record("third", _u7_10())]
    states, problems, _pending = _judge(chain, {*_OLD.values(), *_NEW.values()})
    assert "DD-5" not in states
    assert "supersession DD-5 -> U7-10: U7-10 is listed more than once in the chain" in problems


def test_an_unapproved_successor_is_pending_and_reported_never_treated_as_approved():
    chain = _supersession_chain(_u7_10(approved=None), _u7_12())
    states, problems, pending = _judge(chain, set(_NEW.values()))
    assert states == {"DD-5": baseline.PENDING, "DD-9": baseline.ACTIVE}
    assert problems == [] and pending == ["DD-5 -> U7-10"]
    # The approval gate reports both the unapproved value and the pending pair until the owner approves.
    assert baseline.unapproved(chain) == ["U7-10"]


@pytest.mark.parametrize("successor, message", [
    (_u7_10(record="cli_paths.json"), "U7-10 names another record than DD-5"),
    (_u7_10(pointer="/steps/10/created"), "U7-10 names another pointer than DD-5"),
    (_u7_10(**{"from": ["a"]}), "U7-10's `from` is not DD-5's `to`"),
    (_u7_10(evidence="tests/test_b.py::nowhere"), "U7-10's evidence does not exist"),
    (_u7_10(evidence=_OLD["DD-5"]), "U7-10 names DD-5's evidence, not its own"),
])
def test_a_successor_that_does_not_match_is_a_problem_and_exempts_nothing(successor, message):
    states, problems, pending = _judge(_supersession_chain(successor), {*_OLD.values(), *_NEW.values()})
    assert "DD-5" not in states and pending == []
    assert problems == [f"supersession DD-5 -> U7-10: {message}"]


@pytest.mark.parametrize("placement", ["same record", "earlier record"])
def test_a_successor_out_of_chronological_order_is_a_problem(placement):
    chain = _supersession_chain()
    if placement == "same record":
        chain[0]["differences"].append(_u7_10())
    else:
        chain.insert(0, _record("before", _u7_10()))
    states, problems, _pending = _judge(chain, {*_OLD.values(), *_NEW.values()})
    assert "DD-5" not in states
    assert "supersession DD-5 -> U7-10: U7-10 is not in a later slice's record than DD-5" in problems


def test_an_active_pair_requires_its_old_test_retired_and_then_exempts_it():
    chain = _supersession_chain(_u7_10(), _u7_12())
    _states, problems, _pending = _judge(chain, {*_OLD.values(), *_NEW.values()})
    assert problems == [
        "supersession DD-5 -> U7-10: active, so DD-5's retired evidence must be removed",
        "supersession DD-9 -> U7-12: active, so DD-9's retired evidence must be removed",
    ]
    states, problems, pending = _judge(chain, set(_NEW.values()))
    assert states == {"DD-5": baseline.ACTIVE, "DD-9": baseline.ACTIVE} and problems == [] and pending == []


@pytest.mark.parametrize("table", [
    {**baseline.SUPERSEDED, "DD-4": {"by": "DD-14"}},
    {"DD-5": {"by": "DD-14"}, "DD-9": baseline.SUPERSEDED["DD-9"]},
])
def test_any_pair_beyond_the_two_approved_ones_is_a_problem(table):
    chain = _supersession_chain(_u7_10(), _u7_12())
    _states, problems, _pending = _judge(chain, set(_NEW.values()), table)
    assert any("not an approved pair (only DD-5 -> U7-10 and DD-9 -> U7-12 are)" in problem for problem in problems)


# --- the repository-ID label (M-a, Batch 2B-3a) ----------------------------------------------------


def test_a_session_labels_its_own_repository_id_computed_by_bugpilots_identity(tmp_path: Path):
    from bugpilot.core import storage

    session = baseline.Session(tmp_path / "s")
    own = storage.repository_identity(session.repo).repository_id
    assert session.repository_id == own and storage.REPOSITORY_ID_RE.fullmatch(own)
    shown = f"BUGPILOT_HOME/repositories/{own}/settings/instructions.md"
    assert session.normalize(shown) == "BUGPILOT_HOME/repositories/<repository-id>/settings/instructions.md"
    assert session.normalize({"a": [shown, own]}) == {"a": ["<repository-id>", shown.replace(own, "<repository-id>")]}


def test_a_canonical_spelling_that_contains_the_plain_one_is_labelled_whole(tmp_path: Path, monkeypatch):
    # macOS: a temporary folder `/var/folders/...` is canonically `/private/var/folders/...`, and storage prints the
    # canonical one (its data root is a realpath). Replacing the plain spelling first left `/private<data>/...`, and
    # the order of the spellings changed with the hash seed (0.1.7, CI run 40936578232). Windows' `\\?\` form nests
    # the same way, so this runs everywhere. The order also changed with the folder's name, so many names are tried:
    # the old normalizer got each one right about half the time, and all sixteen almost never.
    session = baseline.Session(tmp_path / "s")
    prefix = "\\\\?\\" if os.name == "nt" else "/private"
    real_resolve = type(session.data).resolve

    def resolve(self, strict=False):
        return type(self)(prefix + str(self)) if str(self).startswith(str(tmp_path)) else real_resolve(self, strict=strict)

    monkeypatch.setattr(type(session.data), "resolve", resolve)
    for index in range(16):
        session.data = tmp_path / "s" / f"data-{index}"
        canonical = f"{prefix}{session.data}"
        assert str(session.data) in canonical and canonical != str(session.data)
        task = f"Read {canonical}/repositories/{session.repository_id}/work/JR-12345/task.md and complete the workflow."
        assert session.normalize(task) == (
            "Read <data>/repositories/<repository-id>/work/JR-12345/task.md and complete the workflow.")
        assert session.normalize(f"{session.data}/memory/JR-12345.md") == "<data>/memory/JR-12345.md"


@pytest.mark.parametrize("folder", ["subfolder", "elsewhere"])
def test_another_folders_repository_id_in_a_record_is_an_error_never_normalized_away(tmp_path: Path, folder):
    """The identity-collision guard: a namespace computed from the wrong folder fails the generator."""
    from bugpilot.core import storage

    session = baseline.Session(tmp_path / "s")
    other = (session.repo / "src") if folder == "subfolder" else (tmp_path / "repo")
    other.mkdir(exist_ok=True)
    foreign = storage.repository_identity(other).repository_id
    assert foreign != session.repository_id
    with pytest.raises(RuntimeError, match=re.escape(foreign)):
        session.normalize(f"BUGPILOT_HOME/repositories/{foreign}/settings/project_settings.json")


def test_a_name_that_only_contains_the_sessions_id_is_not_relabelled(tmp_path: Path):
    session = baseline.Session(tmp_path / "s")
    longer = f"x{session.repository_id}"
    with pytest.raises(RuntimeError, match="not this session's"):
        session.normalize(f"repositories/{longer}/settings")
    assert session.normalize("JR-12345 and local_20261020101010 and 0123456789abcdef") == (
        "JR-12345 and local_<timestamp> and 0123456789abcdef")


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
