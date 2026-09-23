"""What a term costs the repository to answer, and what that buys it (§33.4).

The search always knew how broad a term was — ripgrep printed every match and
the collector threw the surplus away. Nothing downstream could tell a term that
matched twenty lines from one that matched nine thousand, so `Mode` (4,150
matches in this repository) scored like a name.

Two separate ideas live here, and conflating them was the bug:

- **how much a term touched** decides what it is worth;
- **what is retained** is the bounded evidence shown downstream.
"""

from __future__ import annotations

import shutil

import pytest

from bugpilot.core import search
from bugpilot.core.search import (
    BROAD_MATCH_THRESHOLD,
    BROAD_TERM_FILE_BUDGET,
    MAX_FILES_PER_TERM,
    MAX_MATCHES_PER_FILE_PER_TERM,
    TermSearchResult,
    _collect,
    _probe_term,
)
from bugpilot.core.search_terms import WEIGHT_IDENTIFIER, WEIGHT_WEAK, SearchTerm

needs_rg = pytest.mark.skipif(shutil.which("rg") is None, reason="ripgrep is not installed")


def _term(value: str, weight: int = WEIGHT_IDENTIFIER) -> SearchTerm:
    return SearchTerm(value=value, source="issue", weight=weight)


# --- counting is not retaining ----------------------------------------------


def test_a_term_that_matches_nothing_is_recorded_and_weighs_nothing():
    result = TermSearchResult(term=_term("nothing"), total_match_count=0)

    assert result.classification == "zero"
    assert result.retained_matches == []


def test_a_narrow_term_keeps_the_weight_it_earned():
    result = TermSearchResult(term=_term("persist_fix_mode"), total_match_count=12)

    assert result.classification == "specific"
    assert result.effective_weight == WEIGHT_IDENTIFIER


def test_a_broad_term_is_demoted_rather_than_dropped():
    # Dropping would trade a precision problem for a recall one: a broad term is
    # sometimes the only thread connecting a file to the report.
    result = TermSearchResult(term=_term("Mode"), total_match_count=4150)

    assert result.classification == "broad"
    assert result.effective_weight == WEIGHT_WEAK


def test_the_threshold_is_one_named_constant():
    """Tuning it should be one edit, not a hunt through the ranker."""
    assert TermSearchResult(term=_term("x"), total_match_count=BROAD_MATCH_THRESHOLD).classification == "specific"
    assert TermSearchResult(term=_term("x"), total_match_count=BROAD_MATCH_THRESHOLD + 1).classification == "broad"


# --- the retained budget is spent on files, not on the first few lines -------


def _rg_output(pairs: list[tuple[str, int]]) -> str:
    return "\n".join(f"{path}:{line}:some matching code" for path, line in pairs)


def test_the_total_counts_every_match_even_past_the_retained_cap():
    stdout = _rg_output([(f"src/f{index}.py", 1) for index in range(200)])

    matches, total = _collect(stdout, "term", "issue")

    assert total == 200, "the count stopped at the retained cap"
    assert len(matches) <= MAX_FILES_PER_TERM * MAX_MATCHES_PER_FILE_PER_TERM


def test_evidence_is_spread_across_files_rather_than_taken_in_order():
    """The defect this replaces.

    ripgrep walks in directory order, so a line-counted budget is spent on
    whatever it reaches first. `bugpilot/core/fix_mode_state.py` contains
    `persisted` nine times and was never retained for it — the budget had gone
    to `bugpilot/cli.py` before the walk arrived.
    """
    noisy = [("src/aaa.py", line) for line in range(1, 60)]
    later = [("src/zzz.py", 1)]

    matches, total = _collect(_rg_output(noisy + later), "term", "issue")

    assert total == 60
    assert any(match.file == "src/zzz.py" for match in matches), "the later file was starved"
    assert sum(1 for match in matches if match.file == "src/aaa.py") == MAX_MATCHES_PER_FILE_PER_TERM


def test_a_smaller_budget_keeps_fewer_files():
    stdout = _rg_output([(f"src/f{index}.py", 1) for index in range(50)])

    matches, _total = _collect(stdout, "term", "issue", max_files=BROAD_TERM_FILE_BUDGET)

    assert len({match.file for match in matches}) == BROAD_TERM_FILE_BUDGET


# --- against the real binary -------------------------------------------------


@needs_rg
def test_a_specific_term_outranks_a_broad_one_on_the_same_file(tmp_path):
    (tmp_path / "src").mkdir()
    # One file names the thing; the rest merely contain the common word.
    (tmp_path / "src" / "target.py").write_text(
        "def mapSampleIndexToSampleValue():\n    return data\n", encoding="utf-8"
    )
    for index in range(30):
        (tmp_path / "src" / f"noise{index}.py").write_text("data = 1\n" * 40, encoding="utf-8")

    specific = _probe_term(tmp_path, _term("mapSampleIndexToSampleValue"), [])
    broad = _probe_term(tmp_path, _term("data"), [])

    assert specific.classification == "specific"
    assert specific.effective_weight > broad.effective_weight
    assert specific.total_match_count < broad.total_match_count


@needs_rg
def test_a_term_with_no_matches_contributes_nothing(tmp_path):
    (tmp_path / "a.py").write_text("print('hello')\n", encoding="utf-8")

    result = _probe_term(tmp_path, _term("zzz_definitely_absent_zzz"), [])

    assert result.total_match_count == 0
    assert result.retained_matches == []
    assert result.classification == "zero"


@needs_rg
def test_the_diagnostics_say_what_each_term_did(tmp_path):
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "a.py").write_text("VolumeDescriptor = 1\n", encoding="utf-8")

    _markdown, _related, quality = search.run_code_search(
        tmp_path,
        "JR-1",
        {"high_value_keywords": ["VolumeDescriptor"], "normal_keywords": [], "phrase_keywords": []},
    )

    terms = quality["terms"]
    assert terms, "no term diagnostics were recorded"
    entry = next(item for item in terms if item["value"] == "VolumeDescriptor")
    assert entry["match_count"] == 1
    assert entry["classification"] == "specific"
    assert entry["effective_weight"] == entry["weight"]


@needs_rg
def test_the_same_search_twice_returns_the_same_ranking(tmp_path):
    """Reproducibility, which the per-file budget nearly cost.

    ripgrep walks directories in parallel and its output order is not stable, so
    once the retained budget was counted in files, *which* files a broad term
    kept depended on that order. Two identical searches of an unchanged tree
    returned different rankings — found by running the §33.1 corpus twice.
    """
    (tmp_path / "src").mkdir()
    for index in range(40):
        (tmp_path / "src" / f"module{index}.py").write_text("shared = 1\n" * 3, encoding="utf-8")

    rankings = [
        [item["file"] for item in search.run_code_search(
            tmp_path, "JR-1", {"high_value_keywords": ["shared"], "normal_keywords": []}
        )[1]]
        for _ in range(3)
    ]

    assert rankings[0] == rankings[1] == rankings[2], "the same search ranked differently"
    assert rankings[0], "the search found nothing to compare"
