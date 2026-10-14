"""`context.md` and the retry prompt match their golden files (0.1.5 Batch 0, plan §44.7).

The first goldens either document has had. Batches 2 and 3 change them on
purpose; after such a change, `python tests/boundary_golden.py --update` and read
the diff — every line of it is something an agent will now be shown differently.
"""

from __future__ import annotations

import boundary_golden as golden
import oracle_commonmark as commonmark
import pytest

RENDERED = golden.render_all()


@pytest.mark.parametrize("path", sorted(RENDERED), ids=lambda path: f"{path.parent.name}/{path.stem}")
def test_the_document_matches_its_golden_file(path):
    assert path.is_file(), f"missing golden file {path.name}: python tests/boundary_golden.py --update"
    assert RENDERED[path] == golden.read_golden(path), "changed: python tests/boundary_golden.py --update, and read the diff"


def test_no_golden_file_is_left_over():
    on_disk = set(golden.CONTEXT_DIR.glob("*.txt")) | set(golden.RETRY_DIR.glob("*.txt"))
    assert on_disk == set(RENDERED)


def test_the_goldens_show_todays_exposure_as_plainly_as_todays_normal_output():
    """The forged cases are in the goldens on purpose, visible as a diff when fixed.

    `context.md` was fixed in Batch 2 (Batch 0 recorded two `## Context Quality` sections in the forged-title
    golden, and the description's and the comment's forged sections): each forged case now has exactly the
    sections of the typical one. The retry prompt was fixed in Batch 3 (Batch 0 recorded the feedback's forged
    `## BugPilot Delivery Safety`, the report's `## BugPilot Safety Rules` and the feedback's fence left open
    over the rest of the prompt): the forged retry now has exactly the top-level sections of the typical one,
    and no golden leaves a fence open.
    """
    typical = commonmark.top_level_headings(RENDERED[golden.CONTEXT_DIR / "manual-typical.txt"])
    forged_title = RENDERED[golden.CONTEXT_DIR / "manual-forged-title.txt"]
    assert commonmark.top_level_headings(forged_title) == typical
    assert commonmark.top_level_headings(forged_title).count((2, "Context Quality")) == 1
    forged_evidence = RENDERED[golden.CONTEXT_DIR / "jira-forged-description-and-comment.txt"]
    assert commonmark.top_level_headings(forged_evidence) == commonmark.top_level_headings(
        RENDERED[golden.CONTEXT_DIR / "jira-typical.txt"]
    )
    for path in sorted(RENDERED):
        assert not commonmark.structure(RENDERED[path]).unclosed_fences(), path.name
    forged_retry = RENDERED[golden.RETRY_DIR / "fix-forged-feedback-and-report.txt"]
    assert commonmark.top_level_headings(forged_retry) == commonmark.top_level_headings(
        RENDERED[golden.RETRY_DIR / "fix-typical.txt"]
    )
    assert (2, "BugPilot Safety Rules") not in commonmark.top_level_headings(forged_retry)
