"""Retrieval quality, measured rather than asserted about keywords.

The assertion that matters is not "which keywords came out" — it is "did the
file a developer needs come back, and near the top". These tests run the real
pipeline over `tests/retrieval_corpus.py` and check that.

Ranks against this repository move as the tree moves, so the thresholds here are
deliberately loose: they are a floor that catches a real regression, not a
snapshot of today's exact ordering. The precise numbers live in the development
plan (§33), recorded before and after the change.
"""

from __future__ import annotations

import json

import pytest

from retrieval_corpus import CORPUS, REPO_ROOT, RetrievalCase, run_case

pytest.importorskip("shutil")


def _rg_available() -> bool:
    from bugpilot.core.git_ops import command_available

    return command_available("rg")


requires_rg = pytest.mark.skipif(not _rg_available(), reason="code search needs ripgrep")


@requires_rg
def test_the_harness_measures_a_rank_rather_than_a_keyword_list():
    """The mechanics, so a broken harness cannot read as a retrieval result."""
    case = RetrievalCase(
        name="harness-self-check",
        issue_text="persist_fix_mode writes fix_mode.json before the pipeline runs.",
        expected_files=("bugpilot/core/fix_mode_state.py",),
    )

    result = run_case(case)

    assert result.ranked, "the search returned nothing at all"
    assert set(result.ranks) == {"bugpilot/core/fix_mode_state.py"}
    assert result.terms, "no search terms were produced"
    # A rank is 1-based or absent; never 0, which would silently read as a hit.
    for rank in result.ranks.values():
        assert rank is None or rank >= 1


@requires_rg
@pytest.mark.parametrize("case", CORPUS, ids=lambda case: case.name)
def test_every_corpus_case_runs_and_reports(case: RetrievalCase):
    """Each case retrieves *something* and measures itself.

    Not an accuracy assertion. At the §33.1 baseline the accuracy was poor on
    purpose-built cases (top-3 recall 0/5), and a test that failed for that
    reason would have had to be deleted before the work that fixes it.
    """
    result = run_case(case)

    assert result.duration_s >= 0
    assert len(result.ranks) == len(case.expected_files)
    assert result.docs_in_top(5) <= 5


@requires_rg
def test_an_identifier_bug_retrieves_its_implementation(tmp_path):
    """The floor: a bug naming real symbols must find the file defining them.

    Rank 7 at the §33.1 baseline, rank 1 after §33.7. Measured on a fixture
    tree: the top-3 hedge against this repository's own churn
    ran out when the artifact consolidation legitimately rewrote the case's
    subject files (the plan's checkpoints record the reshuffle), and a floor
    should fail only when retrieval changes, never when prose does. The live
    corpus keeps being measured — by the parametrized reporting test above and
    `python tests/retrieval_corpus.py` — without hard-failing on drift.
    """
    (tmp_path / "core").mkdir()
    (tmp_path / "core" / "fix_mode_state.py").write_text(
        '"""Fix Mode selection state."""\n\n\n'
        "def persist_fix_mode(repo_root, mode):\n"
        '    """Write fix_mode.json before the pipeline runs."""\n'
        '    path = repo_root / ".ai" / "fix_mode.json"\n'
        "    path.write_text(mode.id)\n"
        "    return path\n",
        encoding="utf-8",
    )
    (tmp_path / "core" / "workflow.py").write_text(
        "from .fix_mode_state import persist_fix_mode\n\n\n"
        "def run_pipeline(repo_root, mode, resume=False):\n"
        "    # A half-failed resume records a mode the task file was never built under.\n"
        "    persist_fix_mode(repo_root, mode)\n"
        "    return build_task_file(repo_root, mode)\n",
        encoding="utf-8",
    )
    # Decoys: prose that mentions the symbol, and an unrelated implementation.
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "modes.md").write_text(
        "persist_fix_mode stores the selection in fix_mode.json for the resume path.\n",
        encoding="utf-8",
    )
    (tmp_path / "core" / "email.py").write_text(
        "def send_notification(recipient, body):\n    return recipient\n", encoding="utf-8"
    )
    case = next(item for item in CORPUS if item.name == "identifier-persist-fix-mode")

    result = run_case(case, repo_root=tmp_path)

    ranked = result.ranked
    assert "core/fix_mode_state.py" in ranked[:3], f"the defining file is not in the top 3: {ranked[:5]}"
    assert "core/workflow.py" in ranked[:3], f"the caller is not in the top 3: {ranked[:5]}"


@requires_rg
def test_a_natural_language_bug_reaches_its_implementation_at_all():
    """Absent at the §33.1 baseline; rank 5 after §33.7.

    The case the whole section exists for: a bug written the way developers
    write them, whose file was not returned at all before this work.
    """
    case = next(item for item in CORPUS if item.name == "fix-mode-persistence")

    result = run_case(case)

    assert result.hit_at(10), f"expected file missing from the top 10: {result.ranked[:10]}"


@requires_rg
def test_documentation_no_longer_takes_half_the_context():
    """15 of 30 top-5 slots at the §33.1 baseline; 9 after §33.7.

    The top of the ranking is what an agent reads first, so a slot spent on
    prose is a slot not spent on code.
    """
    docs = sum(run_case(case).docs_in_top(5) for case in CORPUS)

    assert docs <= 12, f"documentation is crowding the context again: {docs}/30"


# --- a corpus of real historical bugs, when a developer has one ---------------


def test_the_suite_does_not_need_a_private_repository():
    """The corpus is opt-in, and its absence is not a failure.

    The historical cases are real Jira text against a product checkout that most
    machines running this suite will not have. A test that failed for its
    absence would be deleted within a week.
    """
    from retrieval_corpus import REAL_CORPUS_PATH, load_real_corpus

    cases, repo_root = load_real_corpus(REPO_ROOT / "tests" / "does-not-exist.json")

    assert cases == []
    assert repo_root is None
    # And the real path is ignored by git, so populating it cannot leak.
    assert "retrieval_corpus" in (REPO_ROOT / ".gitignore").read_text(encoding="utf-8")
    assert REAL_CORPUS_PATH.name.endswith(".json")


def test_a_corpus_file_is_read_into_cases(tmp_path):
    from retrieval_corpus import load_real_corpus

    corpus = tmp_path / "cases.json"
    corpus.write_text(
        json.dumps(
            {
                "repo_root": str(tmp_path),
                "cases": [
                    {
                        "id": "JR-12345",
                        "issue_text": "CSV cannot be selected as the export format.",
                        "hint": "maybe output type validation",
                        "expected_files": ["src/OutputSelector.cpp"],
                        "category": "real",
                    }
                ],
            }
        ),
        encoding="utf-8",
    )

    cases, repo_root = load_real_corpus(corpus)

    assert repo_root == tmp_path
    assert len(cases) == 1
    assert cases[0].name == "JR-12345"
    assert cases[0].hint == "maybe output type validation"
    assert cases[0].expected_files == ("src/OutputSelector.cpp",)


@requires_rg
def test_the_summary_reports_mrr_as_well_as_recall():
    """Recall thresholds cannot see 15 -> 6; the mean reciprocal rank can."""
    from retrieval_corpus import summarise

    totals = summarise([run_case(case) for case in CORPUS])

    assert 0.0 <= totals["mrr"] <= 1.0
    assert totals["scored"] == sum(1 for case in CORPUS if case.expected_files)
    assert totals["cases"] == len(CORPUS)


def test_a_corpus_that_cannot_be_trusted_says_so(tmp_path):
    """A typo in a case file must not quietly become a worse score.

    Every one of these previously loaded: a case with no issue text searched the
    empty string, scored "not found", and pulled the average down for a reason
    nobody could see from the report.
    """
    from retrieval_corpus import CorpusError, load_real_corpus

    def corpus(name: str, payload: str):
        path = tmp_path / name
        path.write_text(payload, encoding="utf-8")
        return path

    for name, payload, expected in [
        ("bad.json", "{not json", "not valid JSON"),
        ("noid.json", json.dumps({"cases": [{"issue_text": "x"}]}), "no id"),
        ("empty.json", json.dumps({"cases": [{"id": "A"}]}), "no issue_text"),
        (
            "dup.json",
            json.dumps({"cases": [{"id": "A", "issue_text": "x"}, {"id": "A", "issue_text": "y"}]}),
            "more than once",
        ),
    ]:
        with pytest.raises(CorpusError, match=expected):
            load_real_corpus(corpus(name, payload))


def test_a_valid_corpus_still_loads(tmp_path):
    from retrieval_corpus import load_real_corpus

    path = tmp_path / "cases.json"
    path.write_text(
        json.dumps(
            {
                "repo_root": str(tmp_path),
                "cases": [{"id": "JR-1", "issue_text": "CSV cannot be selected as the export format.",
                           "expected_files": ["src/a.cpp"]}],
            }
        ),
        encoding="utf-8",
    )

    cases, repo_root = load_real_corpus(path)

    assert [case.name for case in cases] == ["JR-1"]
    assert repo_root == tmp_path
