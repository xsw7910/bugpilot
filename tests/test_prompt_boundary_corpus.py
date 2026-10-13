"""The adversarial corpus itself: stable, complete, synthetic and plain (0.1.5 Batch 0, plan §44.8)."""

from __future__ import annotations

import re
import unicodedata
from pathlib import Path

import oracle_commonmark as commonmark
import prompt_boundary_corpus as corpus
import pytest

CORPUS_FILE = Path(corpus.__file__)


def test_ids_are_unique_stable_shaped_and_categorised():
    ids = [case.id for case in corpus.CASES]
    assert len(ids) == len(set(ids))
    for case in corpus.CASES:
        assert re.fullmatch(r"[A-J]\d{2}-[a-z0-9-]+", case.id), case.id
        assert case.category in corpus.CATEGORIES
        assert case.title and case.text
    assert corpus.one_megabyte_description().id not in ids


def test_every_category_has_cases_and_both_kinds_are_present():
    present = {case.category for case in corpus.CASES} | {corpus.one_megabyte_description().category}
    assert present == set(corpus.CATEGORIES)
    assert any(case.hostile for case in corpus.CASES) and any(not case.hostile for case in corpus.CASES)
    assert all(not case.hostile for case in corpus.CASES if case.category == "J")


#: What the plan and the Batch 0 brief require, and the case that carries each.
REQUIRED = {
    "LF": "A01-lf-heading", "CRLF": "A02-crlf-heading", "lone CR": "A03-lone-cr-heading",
    "ATX headings": "B02-atx-h2-protected", "setext headings": "B07-setext-dashes",
    "nested headings": "B09-heading-in-blockquote", "backtick fences": "C01-backtick-fence-closed",
    "tilde fences": "C02-tilde-fence-closed", "long backtick runs": "C05-long-run-fence",
    "nested fences": "C07-nested-fences", "fences inside list items": "C08-fence-in-list-item",
    "fences after HTML block lines": "C09-fence-after-html-div", "<div>": "D01-div-block",
    "<details>": "D02-details", "HTML comments": "D03-comment-unclosed", "tags around fences": "D05-tags-around-fence",
    "U+2028": "E01-u2028-heading", "U+2029": "E02-u2029-heading", "tabs": "E05-tab-indented",
    "zero-width": "E06-zero-width-in-name", "BugPilot Safety Rules": "F01-fake-safety-rules",
    "Evidence Rules": "F02-fake-evidence-rules", "Verification Policy": "F03-fake-verification-policy",
    "AI Behavior": "F04-fake-ai-behavior", "Rule Precedence": "F05-fake-rule-precedence",
    "Branch Instructions": "F06-fake-branch-instructions", "Delivery Safety": "F07-fake-delivery-safety",
    "Required Output Files": "F08-fake-required-output", "provenance labels": "F10-fake-provenance-labels",
    "attachment names with line breaks": "G01-name-lf", "titles with line breaks": "G04-title-forges-quality",
    "keywords with Markdown syntax": "G06-keyword-markdown", "very long fence runs": "H03-backtick-run-1000",
    "Chinese": "I01-chinese-fake-section", "mixed Unicode": "I02-mixed-scripts",
    "normal Jira description": "J01-plain-description", "normal comment": "J02-plain-comment",
    "normal code snippet": "J03-code-snippet", "ordinary Markdown": "J04-list-table-link",
}


@pytest.mark.parametrize("feature, case_id", sorted(REQUIRED.items()))
def test_every_required_shape_has_a_case(feature, case_id):
    assert case_id in corpus.BY_ID, feature


def test_the_scale_cases_are_the_size_they_claim():
    megabyte = corpus.one_megabyte_description()
    assert megabyte.scale and len(megabyte.text) >= 1_000_000
    assert "\n## BugPilot Safety Rules\n" in megabyte.text and megabyte.text.rstrip().endswith("unclosed at the end")
    comments = corpus.five_hundred_comments()
    assert len(comments) == 500 and sum("## BugPilot Delivery Safety" in body for body in comments) == 10
    assert len(corpus.BY_ID["H06-line-10000"].text) == 10_000 and "\n" not in corpus.BY_ID["H06-line-10000"].text


@pytest.mark.parametrize("inside", [True, False], ids=["inside", "before-close"])
def test_a_fence_straddling_cut_lands_where_it_says(inside):
    prefix = "x" * 1234
    document = prefix + corpus.fence_straddling_cut(len(prefix), cut=4000, inside=inside)
    cut = document[:4000]
    opened = cut.count("\n```\n")
    assert opened == 1, "the fence opens before the cut"
    assert document[4000:].count("\n```\n") == 1, "and closes after it"
    assert commonmark.structure(cut).unclosed_fences(), "so the excerpt ends inside it"


def test_the_corpus_is_synthetic():
    keys = set(re.findall(r"\b[A-Z][A-Z0-9_]+-\d+\b", "\n".join(case.text for case in corpus.CASES)))
    assert keys <= {"JR-12345"}, keys
    hosts = set(re.findall(r"https?://([^/\s)]+)", "\n".join(case.text for case in corpus.CASES)))
    assert all(host.endswith(".example.invalid") for host in hosts), hosts
    # A drive path or a home directory (written so that this line does not read as one itself).
    assert not re.search(r"(?<![A-Za-z])[A-Za-z]:\\|/(?:home|Users)(?=/)", "\n".join(case.text for case in corpus.CASES))


def test_the_corpus_source_file_is_plain():
    """Invisible and line-separator characters are written as escapes, never literally, in the file itself."""
    # A checkout may give the file CRLF line endings (core.autocrlf on Windows); only a lone CR is a problem.
    text = CORPUS_FILE.read_bytes().decode("utf-8").replace("\r\n", "\n")
    offenders = sorted({
        f"U+{ord(character):04X}" for character in text
        if (unicodedata.category(character) in ("Cc", "Cf", "Zl", "Zp") and character != "\n")
        or unicodedata.bidirectional(character) in ("R", "AL")
    })
    assert offenders == []


def test_the_matrix_runs_every_case_but_the_generated_scale_ones():
    assert corpus.matrix_cases() == tuple(case for case in corpus.CASES if not case.scale)
    assert all(not case.scale for case in corpus.CASES)
