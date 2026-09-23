"""Bridging prose to identifier shape (§33.7B).

The gap everything before this could measure and not close: a report says
"issue details are loaded" and the code says `loadIssueDetails`. Every word is
present and no weighting reaches across, because what differs is the shape.

The line this file defends is the one between shape and meaning. Turning
"output type" into `outputType` rearranges characters the reporter wrote.
Turning it into `validateOutputType` invents a verb they did not. The first is
checkable; the second is §33.8.
"""

from __future__ import annotations

import shutil

import pytest

from bugpilot.core.keywords import (
    MAX_EXPANDED_PHRASES,
    candidate_phrases,
    extract_keywords,
    identifier_shapes,
    shape_expansions,
)
from bugpilot.core.models import InvestigationOptions
from bugpilot.core.search import run_code_search
from bugpilot.core.search_terms import (
    MAX_EXPANSION_PROBES,
    WEIGHT_HINT,
    WEIGHT_PROSE,
    WEIGHT_SHAPE,
    WEIGHT_STRONG,
    shape_candidates,
    terms_from_extraction,
)

needs_rg = pytest.mark.skipif(shutil.which("rg") is None, reason="ripgrep is not installed")


# --- phrase into shape ---------------------------------------------------------


def test_the_examples_this_phase_exists_for():
    assert "issueDetails" in shape_expansions("Issue details are loaded incorrectly.")
    assert "issue_details" in shape_expansions("Issue details are loaded incorrectly.")

    shapes = shape_expansions("Output type selection is not restored.")
    for expected in ["outputType", "output_type", "typeSelection", "outputTypeSelection"]:
        assert expected in shapes, shapes


def test_grammar_does_not_become_an_identifier():
    """"does not work when using" is a sentence, not a name."""
    assert shape_expansions("This does not work when using the thing. Please fix.") == []
    assert shape_expansions("It is not correct.") == []


def test_only_case_insensitively_distinct_shapes_are_produced():
    """The search is case-insensitive, so PascalCase is not a second search.

    `outputType` and `OutputType` match exactly the same lines. Generating both
    would spend two ripgrep invocations to score one piece of evidence twice —
    which is how a file quietly gets double credit.
    """
    shapes = identifier_shapes(["output", "type"])

    assert shapes == ["outputType", "output_type"]
    lowered = [shape.lower() for shape in shapes]
    assert len(lowered) == len(set(lowered))


def test_a_compound_word_is_not_used_to_build_another():
    """`VolumeDescriptor` is already a shape, not a word to assemble one from."""
    assert candidate_phrases("VolumeDescriptor is empty") == []


def test_phrases_are_two_or_three_words_longest_first():
    phrases = candidate_phrases("Output type selection is broken")

    assert [" ".join(phrase) for phrase in phrases][0] == "Output type selection"
    assert all(2 <= len(phrase) <= 3 for phrase in phrases)


def test_the_phrase_budget_is_bounded():
    text = " ".join(f"alpha{index} beta{index}" for index in range(40))

    assert len(candidate_phrases(text)) <= MAX_EXPANDED_PHRASES


# --- nothing is evidence until the repository says so --------------------------


def test_candidates_carry_their_provenance_and_the_shape_weight():
    extracted = extract_keywords("Output type selection is not restored.")

    candidates = shape_candidates(extracted)

    assert candidates, "no shapes were offered for probing"
    for term in candidates:
        assert term.source == "shape_expansion"
        assert term.weight == WEIGHT_SHAPE
        assert term.derived_from, f"{term.value} cannot say where it came from"
    assert len(candidates) <= MAX_EXPANSION_PROBES


def test_a_shape_the_text_already_contains_is_not_generated_twice():
    extracted = extract_keywords("outputType and output type are both here.")
    already = {term.value.lower() for term in terms_from_extraction(extracted)}

    candidates = shape_candidates(extracted, already=already)

    assert "outputtype" not in {term.value.lower() for term in candidates}


def test_a_confirmed_shape_sits_between_a_hint_and_a_written_identifier():
    """It was assembled by a rule, and the codebase agreed with it."""
    assert WEIGHT_HINT < WEIGHT_SHAPE < WEIGHT_STRONG
    assert WEIGHT_PROSE < WEIGHT_SHAPE


@needs_rg
def test_a_shape_with_no_repository_evidence_never_reaches_the_ranking(tmp_path):
    """The rule that makes generating strings safe."""
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "reader.py").write_text("value = 1\n", encoding="utf-8")

    _markdown, related, quality = run_code_search(
        tmp_path,
        "JR-1",
        extract_keywords("Output type selection is not restored."),
        InvestigationOptions(),
    )

    shapes = [term for term in quality["terms"] if term["source"] == "shape_expansion"]
    assert shapes, "no shape was even tried"
    assert all(term["match_count"] == 0 for term in shapes)
    assert all(term["status"] == "dropped" for term in shapes)
    assert related == [], "a made-up identifier ranked a file"


@needs_rg
def test_a_confirmed_shape_is_retained_and_says_where_it_came_from(tmp_path):
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "selector.py").write_text(
        "def outputType():\n    return 1\n", encoding="utf-8"
    )

    _markdown, related, quality = run_code_search(
        tmp_path,
        "JR-1",
        extract_keywords("Output type is not restored."),
        InvestigationOptions(),
    )

    confirmed = next(term for term in quality["terms"] if term["value"] == "outputType")
    assert confirmed["match_count"] == 1
    assert confirmed["status"] == "retained"
    assert confirmed["derived_from"] == "output type"
    assert any("selector.py" in item["file"] for item in related)


@needs_rg
def test_the_bridge_moves_a_file_that_prose_alone_could_not_reach(tmp_path):
    """The regression this phase exists to produce.

    The repository names the concept in camelCase and the report names it in
    words. Before expansion nothing connects them.
    """
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "Selector.cpp").write_text(
        "void outputType() {}\nvoid outputTypeSelection() {}\n", encoding="utf-8"
    )
    # Files that merely contain the separate words, which is what the prose terms
    # would otherwise retrieve.
    for index in range(8):
        (tmp_path / "src" / f"other{index}.cpp").write_text(
            "// output\n// type\n// selection\n" * 4, encoding="utf-8"
        )
    keywords = extract_keywords("Output type selection is not restored after reload.")

    without = keywords | {"shape_candidates": []}
    before = run_code_search(tmp_path, "JR-1", without, InvestigationOptions())[1]
    after = run_code_search(tmp_path, "JR-1", keywords, InvestigationOptions())[1]

    before_rank = next(
        (index for index, item in enumerate(before, 1) if "Selector.cpp" in item["file"]), None
    )
    after_rank = next(
        (index for index, item in enumerate(after, 1) if "Selector.cpp" in item["file"]), None
    )
    assert after_rank == 1, [item["file"] for item in after]
    assert before_rank is None or before_rank > after_rank, (before_rank, after_rank)


@needs_rg
def test_expansion_stays_deterministic(tmp_path):
    (tmp_path / "src").mkdir()
    for index in range(12):
        (tmp_path / "src" / f"f{index}.py").write_text(
            "outputType = 1\noutput = 2\ntype = 3\n", encoding="utf-8"
        )
    keywords = extract_keywords("Output type selection is not restored.")

    rankings = [
        [item["file"] for item in run_code_search(tmp_path, "JR-1", keywords, InvestigationOptions())[1]]
        for _ in range(3)
    ]

    assert rankings[0] == rankings[1] == rankings[2]
