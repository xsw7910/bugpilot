"""How the bounded search budget is shared out.

Every term is one ripgrep invocation with its own 20-second timeout, so the
budget is a latency bound before it is anything else. The question this file
answers is who gets to spend it.

The bug it exists for: user keywords weigh more than anything mined from the
text and therefore sort first, so a straight truncation handed them the whole
budget. Twenty `--keywords` left room for nothing else, and a `SampleFoo::bar` out
of the stack trace was dropped in favour of the twentieth word the developer
typed. Advanced Settings -> Keywords is meant to be an expert *boost*, not a
replacement for the automatic search.
"""

from __future__ import annotations

from bugpilot.core.keywords import extract_keywords
from bugpilot.core.search_terms import (
    AUTOMATIC_TERM_RESERVE,
    MAX_EXPANSION_PROBES,
    MAX_SEARCHED_TERMS,
    shape_candidates,
    terms_from_extraction,
)

#: A report carrying names only the software could have produced.
IDENTIFIER_ISSUE = (
    "Crash in SampleFoo::bar at widget.cpp when VolumeDescriptor is empty; "
    "see mapSampleIndexToSampleValue and sample_volume_cache.cpp"
)


def _split(terms):
    user = [term for term in terms if term.source == "user"]
    automatic = [term for term in terms if term.source != "user"]
    return user, automatic


def test_many_user_keywords_cannot_erase_automatic_retrieval():
    extracted = extract_keywords(IDENTIFIER_ISSUE)

    terms = terms_from_extraction(extracted, user_keywords=[f"user{i}" for i in range(20)])
    user, automatic = _split(terms)

    assert user, "the developer's own keywords were dropped"
    assert automatic, "twenty keywords erased every automatically found term"
    assert len(terms) <= MAX_SEARCHED_TERMS - MAX_EXPANSION_PROBES


def test_the_names_the_crash_printed_survive_a_wall_of_user_keywords():
    """The specific loss that motivated the reserve."""
    extracted = extract_keywords(IDENTIFIER_ISSUE)

    terms = terms_from_extraction(extracted, user_keywords=[f"user{i}" for i in range(20)])

    values = {term.value for term in terms}
    for identifier in ["SampleFoo::bar", "widget.cpp", "VolumeDescriptor"]:
        assert identifier in values, f"{identifier} was displaced by user keywords"


def test_a_few_user_keywords_do_not_waste_the_reserve():
    """It is a reserve, not a quota: unclaimed space goes back."""
    extracted = extract_keywords(IDENTIFIER_ISSUE)

    without = terms_from_extraction(extracted)
    with_two = terms_from_extraction(extracted, user_keywords=["alpha", "beta"])

    user, automatic = _split(with_two)
    assert len(user) == 2
    # Every automatic term that fitted before still fits.
    assert len(automatic) == len(without)


def test_the_reserve_shrinks_to_what_there_is_to_reserve():
    """No automatic terms to hold the space means the user may have it."""
    extracted = extract_keywords("x")  # nothing worth searching

    terms = terms_from_extraction(extracted, user_keywords=[f"user{i}" for i in range(20)])
    user, automatic = _split(terms)

    assert automatic == []
    assert len(user) > MAX_SEARCHED_TERMS - MAX_EXPANSION_PROBES - AUTOMATIC_TERM_RESERVE


def test_the_total_stays_within_the_configured_maximum():
    """Worst case is a latency promise: terms times the per-term timeout."""
    noisy = " ".join(f"alpha{i} beta{i} gamma{i}" for i in range(40))
    extracted = extract_keywords(noisy + " SampleFoo::bar widget.cpp")

    base = terms_from_extraction(
        extracted, user_keywords=[f"user{i}" for i in range(30)], hint=noisy
    )
    shapes = shape_candidates(extracted, hint=noisy, already={term.key for term in base})

    assert len(base) <= MAX_SEARCHED_TERMS - MAX_EXPANSION_PROBES
    assert len(shapes) <= MAX_EXPANSION_PROBES
    assert len(base) + len(shapes) <= MAX_SEARCHED_TERMS


def test_terms_are_still_searched_strongest_first():
    """Allocation must not reorder the search away from weight order."""
    extracted = extract_keywords(IDENTIFIER_ISSUE)

    terms = terms_from_extraction(extracted, user_keywords=["alpha", "beta"])

    weights = [term.weight for term in terms]
    assert weights == sorted(weights, reverse=True)


def test_allocation_is_deterministic_under_budget_pressure():
    extracted = extract_keywords(IDENTIFIER_ISSUE)
    keywords = [f"user{i}" for i in range(20)]

    runs = [
        [(term.value, term.weight) for term in terms_from_extraction(extracted, user_keywords=keywords)]
        for _ in range(3)
    ]

    assert runs[0] == runs[1] == runs[2]
