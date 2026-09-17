"""What the context package says about itself, from a real run.

Both defects here were found by the first real MCP session — a live Jira issue,
a real repository, a real agent reading the result. Nothing in the test suite
had noticed either, because both are about what the *headline* says, and the
data underneath it was correct all along.

The fixture is JR-12345 as Jira actually returned it: a 2020 feature request,
typed Task, closed as "Won't Do", whose keywords matched only bugpilot's own
source on generic English.
"""

from __future__ import annotations

import json

from bugpilot.core.context import _caution_markdown, _quality_score

# The parsed shape of the real issue, trimmed to the fields these two functions
# read.
HR_12345 = {
    "summary": "[Client] Feature to Calculate Quality (Q) Factor …",
    "issue_type": "Task",
    "status": "Closed",
    "resolution": "Won't Do",
    "description": "Suggested by user in PETRONAS Reservoir Geophysics Group …",
}

# related_files.json from that run: ten files, none of them high confidence.
TEN_LOW_VALUE_FILES = json.loads(
    """[
      {"file": "bugpilot/core/workflow.py", "confidence": "medium", "score": 11},
      {"file": "docs/architecture.md", "confidence": "low", "score": 11},
      {"file": "bugpilot/core/keywords.py", "confidence": "medium", "score": 8},
      {"file": "bugpilot/core/search.py", "confidence": "medium", "score": 6},
      {"file": "docs/plan.md", "confidence": "low", "score": 6},
      {"file": "tests/test_workflow.py", "confidence": "medium", "score": 6},
      {"file": "README.md", "confidence": "medium", "score": 4},
      {"file": "tests/test_unwired.py", "confidence": "medium", "score": 3},
      {"file": "bugpilot/core/context.py", "confidence": "medium", "score": 2},
      {"file": "bugpilot/mcp_server.py", "confidence": "medium", "score": 2}
    ]"""
)

LOW_QUALITY = {"confidence": "low", "high_confidence_files": []}
HIGH_QUALITY = {"confidence": "high", "high_confidence_files": ["src/thing.cpp"]}
GIT = "## Recent Commits\n\n- abc123 something"
NO_MEMORY = "No similar memory entries found."


def _score(search_quality, related=TEN_LOW_VALUE_FILES):
    return _quality_score(HR_12345, {"high_value_keywords": ["a"]}, related, search_quality, NO_MEMORY, GIT)


# --- the headline must not contradict the section beneath it ----------------


def test_a_low_confidence_search_does_not_score_like_a_good_one():
    """The real run announced 90/100 while its own search said "low".

    Ten files counted for a flat +25 regardless of what the search thought of
    them. The number is the first thing an agent reads, and it disagreed with
    the confidence printed directly below.
    """
    low, _ = _score(LOW_QUALITY)
    high, _ = _score(HIGH_QUALITY)

    assert low < high, "confidence has to change the score, or it is decoration"
    assert low < 80, f"{low}/100 for a search that found nothing it believes in"


def test_the_signal_line_carries_the_confidence_with_the_count():
    """"Related files found: 10" reads as good news on its own."""
    _, signals = _score(LOW_QUALITY)
    related = next(line for line in signals if line.startswith("Related files found"))
    assert related == "Related files found: 10 (search confidence: low)"


def test_finding_nothing_still_beats_finding_ten_wrong_things_by_a_little():
    """Not a trick: an empty list scores lower than a low-confidence one.

    A low-confidence match is weak evidence, not negative evidence — the point
    is that it must not be worth the same as a confident one.
    """
    empty, _ = _score(LOW_QUALITY, related=[])
    low, _ = _score(LOW_QUALITY)
    assert empty < low < 90


# --- the facts that decide whether to work the issue at all ----------------


def test_a_closed_issue_says_so_before_the_reader_starts():
    """bugpilot prepared a branch name and a fix workflow for a Won't Do."""
    caution = _caution_markdown(HR_12345)
    assert "## Caution" in caution
    assert "Closed" in caution and "Won't Do" in caution
    assert "did not reopen" in caution


def test_a_non_bug_says_what_to_expect_instead():
    caution = _caution_markdown(HR_12345)
    assert "types this as Task, not a Bug" in caution
    assert "no reproduction steps" in caution


def test_an_open_bug_gets_no_caution_section():
    """Silence when there is nothing to say; a caution on every issue is noise."""
    assert _caution_markdown({"status": "In Progress", "issue_type": "Bug"}) == ""
    assert _caution_markdown({}) == ""


def test_an_unfamiliar_workflow_state_says_nothing():
    """Better than labelling a live issue as settled on a guess."""
    assert "Caution" not in _caution_markdown(
        {"status": "Awaiting Triage", "issue_type": "Bug"}
    )


def test_a_closed_issue_with_no_resolution_still_warns():
    caution = _caution_markdown({"status": "Done", "issue_type": "Bug"})
    assert "already Done" in caution
    assert "resolution:" not in caution, "do not print an empty resolution"
