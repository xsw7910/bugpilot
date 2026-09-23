"""The developer's hint, as a search signal (§33.5).

Before this, a hint reached the agent's task file and nothing else. The one
sentence in which a developer says where they think the fix lives had no effect
on which files were retrieved for them.

The balance the tests hold: a hint must be able to help, and must not be able to
take over. It is the developer's hypothesis — better than the issue's prose,
because they chose to write it; worse than a name the crash printed or a keyword
they typed deliberately, because it may simply be wrong.
"""

from __future__ import annotations

import shutil

import pytest

from bugpilot.core.keywords import extract_keywords
from bugpilot.core.models import InvestigationOptions
from bugpilot.core.search import run_code_search
from bugpilot.core.search_terms import (
    WEIGHT_HINT,
    WEIGHT_PROSE,
    WEIGHT_STRONG,
    WEIGHT_WEAK,
    terms_from_extraction,
    weigh,
)

needs_rg = pytest.mark.skipif(shutil.which("rg") is None, reason="ripgrep is not installed")

ISSUE = "VDS cannot be selected as process output."
HINT = "Maybe related to output type validation."


def _terms(hint: str = "", user: list[str] | None = None) -> dict[str, int]:
    extracted = extract_keywords(ISSUE)
    terms = terms_from_extraction(extracted, user_keywords=user or [], hint=hint)
    return {term.value.lower(): term.weight for term in terms}


# --- a hint contributes -------------------------------------------------------


def test_a_hint_adds_terms_the_issue_never_mentioned():
    without = _terms()
    with_hint = _terms(hint=HINT)

    assert "validation" not in without, "the issue already contained the hint's term"
    assert "validation" in with_hint


def test_an_empty_hint_changes_nothing():
    assert _terms(hint="") == _terms()
    assert _terms(hint="   \n  ") == _terms()


def test_changing_the_hint_changes_the_terms():
    first = _terms(hint="Maybe related to output type validation.")
    second = _terms(hint="Look at the poststack reader instead.")

    assert first != second
    assert "poststack" in second and "poststack" not in first


# --- but cannot take over ------------------------------------------------------


def test_a_hint_term_is_weaker_than_a_keyword_the_developer_typed():
    """A hint is a hypothesis; `--keywords` is an instruction."""
    assert weigh("validation", "hint").weight < weigh("validation", "user").weight


def test_a_hint_term_is_weaker_than_a_name_the_crash_printed():
    stack = weigh("SamplePoststackReader", "issue", is_priority=True)

    assert weigh("validation", "hint").weight < stack.weight
    assert stack.weight == WEIGHT_STRONG


def test_a_hint_term_still_beats_ordinary_issue_prose():
    # The developer chose to write it, which is more than can be said for the
    # words that happened to be in the report.
    assert weigh("validation", "hint").weight == WEIGHT_HINT
    assert WEIGHT_HINT > WEIGHT_PROSE


def test_a_hedging_hint_word_carries_no_weight():
    """"Maybe" is how a hint starts, not what it says."""
    for hedge in ["maybe", "perhaps", "possibly", "probably", "seems"]:
        assert weigh(hedge, "hint").weight == WEIGHT_WEAK


def test_the_same_term_from_two_sources_keeps_the_stronger_claim():
    merged = _terms(hint="validation output", user=["validation"])

    assert merged["validation"] == WEIGHT_STRONG, "the user's own keyword was downgraded"


# --- through the real search ---------------------------------------------------


@needs_rg
def test_a_hint_moves_a_file_into_the_results(tmp_path):
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "validator.py").write_text(
        "def check_validation():\n    return True\n", encoding="utf-8"
    )
    (tmp_path / "src" / "other.py").write_text("value = 1\n", encoding="utf-8")
    keywords = extract_keywords(ISSUE)

    without = run_code_search(tmp_path, "JR-1", keywords, InvestigationOptions())[1]
    with_hint = run_code_search(tmp_path, "JR-1", keywords, InvestigationOptions(hint=HINT))[1]

    assert not any("validator.py" in item["file"] for item in without)
    assert any("validator.py" in item["file"] for item in with_hint)


@needs_rg
def test_a_wrong_hint_does_not_displace_a_named_identifier(tmp_path):
    """The failure mode this weighting exists to prevent."""
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "VolumeDescriptor.py").write_text(
        "class VolumeDescriptor:\n    pass\n", encoding="utf-8"
    )
    for index in range(6):
        (tmp_path / "src" / f"validation{index}.py").write_text(
            "# validation\n" * 5, encoding="utf-8"
        )

    _markdown, related, _quality = run_code_search(
        tmp_path,
        "JR-1",
        extract_keywords("VolumeDescriptor is empty when the volume loads."),
        InvestigationOptions(hint="Probably the validation code."),
    )

    assert related[0]["file"].endswith("VolumeDescriptor.py")


@needs_rg
def test_hint_provenance_is_recorded_so_a_rank_can_be_explained(tmp_path):
    (tmp_path / "a.py").write_text("validation = 1\n", encoding="utf-8")

    _markdown, _related, quality = run_code_search(
        tmp_path, "JR-1", extract_keywords(ISSUE), InvestigationOptions(hint=HINT)
    )

    sources = {item["value"].lower(): item["source"] for item in quality["terms"]}
    assert sources.get("validation") == "hint"


@needs_rg
def test_retrieval_never_calls_an_ai_provider(tmp_path, monkeypatch):
    """Hint improvement is a separate, opt-in act. Searching is not.

    Enforced by the absence of a seam rather than by a mock: nothing in the
    retrieval path imports a provider. This asserts the property directly.
    """
    import bugpilot.core.search as search_module
    import bugpilot.core.search_terms as terms_module

    for module in (search_module, terms_module):
        source = module.__file__ or ""
        text = open(source, encoding="utf-8").read()
        for forbidden in ("subprocess.Popen", "claude", "codex", "improveHint"):
            assert forbidden not in text, f"{module.__name__} reaches for {forbidden}"
