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
    """The forged cases are in the goldens on purpose: EXPECTED_CURRENT_ESCAPE, visible as a diff when fixed."""
    forged_title = RENDERED[golden.CONTEXT_DIR / "manual-forged-title.txt"]
    assert commonmark.top_level_headings(forged_title).count((2, "Context Quality")) == 2
    forged_retry = RENDERED[golden.RETRY_DIR / "fix-forged-feedback-and-report.txt"]
    assert commonmark.structure(forged_retry).unclosed_fences()
    typical = RENDERED[golden.CONTEXT_DIR / "jira-typical.txt"]
    assert not commonmark.structure(typical).unclosed_fences()
