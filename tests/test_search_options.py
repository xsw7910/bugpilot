"""Tests for InvestigationOptions reaching the code search."""

from __future__ import annotations

import pytest

from bugpilot.core.models import InvestigationOptions
from bugpilot.core.search import (
    FOCUS_FILE_BONUS,
    FileScore,
    Match,
    _apply_focus_bonus,
    _matches_any_path,
    _rank_related_files,
    _render_markdown,
)


# --- path matching ----------------------------------------------------------


@pytest.mark.parametrize(
    "path, patterns, expected",
    [
        ("src/reader/VdsReader.cpp", ["src/reader"], True),
        ("src/reader/VdsReader.cpp", ["src/reader/"], True),
        ("src/reader/VdsReader.cpp", ["./src/reader"], True),
        # A Windows-style pattern must still match rg's forward-slash output.
        ("src/reader/VdsReader.cpp", [r"src\reader"], True),
        (r"src\reader\VdsReader.cpp", ["src/reader"], True),
        ("src/reader/VdsReader.cpp", ["VDSREADER.CPP"], True),  # case-insensitive
        # A prefix must stop at a path boundary, not mid-segment.
        ("src/readerx/A.cpp", ["src/reader"], False),
        ("src/reader/VdsReader.cpp", [], False),
        ("src/reader/VdsReader.cpp", ["", "   "], False),
    ],
)
def test_path_pattern_matching(path, patterns, expected):
    assert _matches_any_path(path, patterns) is expected


# --- focus files ------------------------------------------------------------


def test_focus_bonus_lifts_a_marked_file():
    item = FileScore(file="src/reader/VdsReader.cpp", score=4)
    _apply_focus_bonus(item, ["src/reader"])
    assert item.score == 4 + FOCUS_FILE_BONUS
    assert any("focus area" in reason for reason in item.reasons)


def test_focus_bonus_leaves_other_files_alone():
    item = FileScore(file="src/writer/VdsWriter.cpp", score=4)
    _apply_focus_bonus(item, ["src/reader"])
    assert item.score == 4
    assert item.reasons == []


def test_focus_is_a_boost_not_a_filter():
    """A wrong guess must not empty the results, only reorder them."""
    matches = [
        _match("src/writer/W.cpp", "alpha"),
        _match("src/writer/W.cpp", "beta"),
        _match("src/reader/R.cpp", "alpha"),
    ]
    ranked = _rank_related_files(matches, ["alpha", "beta"], [], focus_files=["src/reader"])
    files = [item.file for item in ranked]

    assert files[0] == "src/reader/R.cpp"  # boosted above the better keyword match
    assert "src/writer/W.cpp" in files  # but still present


# --- caps -------------------------------------------------------------------


def test_max_files_caps_the_ranked_result():
    matches = [_match(f"src/f{index}.cpp", "alpha") for index in range(8)]
    assert len(_rank_related_files(matches, ["alpha"], [], max_files=3)) == 3


def test_max_files_defaults_to_the_module_constant():
    matches = [_match(f"src/f{index}.cpp", "alpha") for index in range(25)]
    assert len(_rank_related_files(matches, ["alpha"], [])) == 10


def test_max_search_lines_bounds_the_matched_lines_section():
    ranked = [
        FileScore(
            file=f"src/f{index}.cpp",
            score=5,
            confidence="high",
            snippets=[
                Match(keyword="alpha", tier="high_value", file=f"src/f{index}.cpp", line_number=line, line="code")
                for line in range(20)
            ],
        )
        for index in range(5)
    ]
    small = _render_markdown("JR-1", ["alpha"], [], [], [], ranked, [], {}, max_search_lines=5)
    large = _render_markdown("JR-1", ["alpha"], [], [], [], ranked, [], {}, max_search_lines=200)
    assert len(small.splitlines()) < len(large.splitlines())


# --- helpers ----------------------------------------------------------------


def _match(file: str, keyword: str) -> Match:
    return Match(keyword=keyword, tier="high_value", file=file, line_number=1, line=f"// {keyword}")
