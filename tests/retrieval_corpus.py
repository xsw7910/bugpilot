"""A retrieval harness: does the search actually find the right file?

Not a test module (no `test_` prefix, so pytest does not collect it). It exists
because the question that matters about keyword extraction cannot be asked of
keyword extraction. "Did we produce sensible-looking keywords" is easy to assert
and nearly worthless; "does `bugpilot/core/fix_mode_state.py` come back in the
top three for a bug about Fix Mode persistence" is the thing a developer feels.

So every case here names an *issue* and the *files* that would help fix it, runs
the real pipeline — extract, merge, search, rank — and measures where those files
landed. What the keywords were is diagnostic output, not the assertion.

Two kinds of corpus:

- **fixture repositories**, written to a tmp_path, for anything that has to be
  deterministic (a term's breadth, an extension being searchable at all);
- **this repository**, for the cases worth having real code behind. Those move
  as the tree moves, which is why the baseline records ranks rather than
  asserting exact ones.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from pathlib import Path

from bugpilot.core.code_files import is_documentation
from bugpilot.core.keywords import extract_keywords
from bugpilot.core.search import run_code_search
from bugpilot.core.models import InvestigationOptions

REPO_ROOT = Path(__file__).resolve().parents[1]


@dataclass(frozen=True)
class RetrievalCase:
    """One bug, and the files that would actually help fix it.

    For a real historical case the expected files are the ones the fixing commit
    changed — minus anything that was along for the ride. A formatting sweep, a
    regenerated file or a changelog edit appears in the diff without being what
    the bug was about, and counting those as ground truth would reward a search
    for finding the wrong thing.
    """

    name: str
    issue_text: str
    expected_files: tuple[str, ...]
    hint: str = ""
    user_keywords: tuple[str, ...] = ()
    #: What this case is here to exercise, for the baseline table.
    kind: str = "general"


@dataclass
class RetrievalResult:
    case: RetrievalCase
    #: Ranked file paths, best first, as the searcher returned them.
    ranked: list[str] = field(default_factory=list)
    #: expected file -> 1-based rank, or None when it did not appear at all.
    ranks: dict[str, int | None] = field(default_factory=dict)
    terms: list[str] = field(default_factory=list)
    duration_s: float = 0.0

    @property
    def best_rank(self) -> int | None:
        """The best rank any expected file reached; None if none appeared."""
        found = [rank for rank in self.ranks.values() if rank is not None]
        return min(found) if found else None

    @property
    def reciprocal_rank(self) -> float:
        """1/rank, or 0 when nothing was found.

        The metric recall thresholds cannot express: 15 -> 6 is a real
        improvement and both are outside the top 5, so top-5 recall records it
        as nothing happening.
        """
        rank = self.best_rank
        return 1.0 / rank if rank else 0.0

    def hit_at(self, n: int) -> bool:
        rank = self.best_rank
        return rank is not None and rank <= n

    def docs_in_top(self, n: int) -> int:
        """Prose in the slots that reach the context.

        Uses the production classifier rather than a second suffix list of its
        own. The harness previously kept one, and it counted `CMakeLists.txt` as
        documentation — which would have inflated this metric on exactly the
        CMake-heavy repositories the corpus exists to measure.
        """
        return sum(1 for path in self.ranked[:n] if is_documentation(path))


def _normalize(path: str) -> str:
    return path.replace("\\", "/").lstrip("./").lower()


def run_case(case: RetrievalCase, repo_root: Path = REPO_ROOT) -> RetrievalResult:
    """Run the real retrieval pipeline for one case and measure where files land.

    Mirrors `workflow.extract_issue_keywords` rather than calling it, because
    that takes a normalized issue and a case is a sentence: the harness wants the
    retrieval, not a work item. The merge below is the same one it performs.
    """
    started = time.perf_counter()
    keywords = extract_keywords(case.issue_text)
    supplied = [word.strip() for word in case.user_keywords if word.strip()]
    if supplied:
        existing = [word for word in keywords.get("high_value_keywords", []) if word not in supplied]
        keywords["high_value_keywords"] = supplied + existing

    options = InvestigationOptions(hint=case.hint) if case.hint else InvestigationOptions()
    retrieval = run_code_search(repo_root, keywords, options)
    duration = time.perf_counter() - started

    ranked = [item.file for item in retrieval.related_files]
    lookup = {_normalize(path): index + 1 for index, path in enumerate(ranked)}
    ranks = {expected: lookup.get(_normalize(expected)) for expected in case.expected_files}

    terms: list[str] = []
    for key in ("high_value_keywords", "normal_keywords", "phrase_keywords", "expanded_keywords"):
        value = keywords.get(key, [])
        if isinstance(value, list):
            terms.extend(str(item) for item in value)

    return RetrievalResult(
        case=case, ranked=ranked, ranks=ranks, terms=terms, duration_s=duration
    )


# --- the corpus --------------------------------------------------------------
#
# Cases against this repository. Chosen because the answer is knowable: each
# expected file is the one a developer would open for that bug.

CORPUS: tuple[RetrievalCase, ...] = (
    RetrievalCase(
        name="fix-mode-persistence",
        kind="natural language, known implementation file",
        issue_text="Fix Mode selection is not persisted when the run fails halfway.",
        expected_files=("bugpilot/core/fix_mode_state.py",),
    ),
    RetrievalCase(
        name="identifier-persist-fix-mode",
        kind="strong identifier",
        issue_text=(
            "persist_fix_mode writes fix_mode.json before the pipeline runs, so a "
            "half-failed resume records a mode the task file was never built under."
        ),
        expected_files=("bugpilot/core/fix_mode_state.py", "bugpilot/core/workflow.py"),
    ),
    RetrievalCase(
        name="prose-heavy-keyword-extraction",
        kind="prose heavy",
        issue_text=(
            "The keywords that come out of a bug report are not very good. Generic "
            "words are treated as important and the useful ones are ranked below them, "
            "so the files that come back are not the ones you need."
        ),
        expected_files=("bugpilot/core/keywords.py",),
    ),
    RetrievalCase(
        name="generic-terms-only",
        kind="generic terms",
        issue_text="The data process output is wrong and the volume is not updated correctly.",
        # Nothing in this repository genuinely implements that sentence. The case
        # exists to measure noise: what a bug made only of generic words retrieves.
        expected_files=(),
    ),
    RetrievalCase(
        name="atomic-write-crash",
        kind="natural language",
        issue_text=(
            "Writing the workflow status file sometimes fails on Windows when another "
            "process has it open, and the artifact is left truncated."
        ),
        expected_files=("bugpilot/core/artifact_io.py",),
    ),
    RetrievalCase(
        name="hint-points-at-the-fix",
        kind="hint carries the technical direction",
        issue_text="Improving a hint does not use the issue text.",
        hint="Look at how the issue details are loaded before the prompt is built.",
        expected_files=("extension/src/app/hintImprovement.ts",),
    ),
)


# --- a real historical corpus ------------------------------------------------
#
# Six hand-written cases against this repository found three real defects and
# cannot calibrate anything: six sentences will not resolve a threshold, and all
# of them are Python or TypeScript while BugPilot was built for a C++/Qt tree.
#
# So the harness also evaluates real solved issues, where the ground truth is
# what the fixing commit actually changed. That text is internal, so none of it
# lives here: the committed part is the loader and the format, and the cases
# themselves come from a local file a developer populates and git ignores.

#: Where a developer's own corpus is looked for by default.
REAL_CORPUS_PATH = REPO_ROOT / "tests" / "retrieval_corpus" / "real_cases.json"

#: What a corpus file looks like. Kept flat on purpose — it is written by hand
#: or by a short script, and a schema nobody can type from memory will not be
#: populated.
CORPUS_FORMAT = """
{
  "repo_root": "C:/path/to/the/product/checkout",
  "cases": [
    {
      "id": "JR-12345",
      "issue_text": "CSV cannot be selected as the export format.",
      "hint": "maybe format validation",
      "expected_files": ["src/export/FormatSelector.cpp"],
      "notes": "fixed in MR !456; the header change was incidental"
    }
  ]
}
"""


class CorpusError(Exception):
    """A corpus file that cannot be trusted to measure anything."""


def load_real_corpus(path: Path | None = None) -> tuple[list[RetrievalCase], Path | None]:
    """A developer's historical cases, and the repository to run them against.

    Returns an empty corpus rather than raising when the file is absent: the
    standard suite must never depend on a private repository, and never fail for
    not having one.
    """
    import json

    source = path or REAL_CORPUS_PATH
    if not source.is_file():
        return [], None
    try:
        payload = json.loads(source.read_text(encoding="utf-8"))
    except json.JSONDecodeError as error:
        raise CorpusError(f"{source} is not valid JSON: {error}") from error

    repo_root = payload.get("repo_root")
    seen: set[str] = set()
    for entry in payload.get("cases", []):
        name = str(entry.get("id") or entry.get("name") or "").strip()
        if not name:
            raise CorpusError(f"{source}: a case has no id.")
        if not str(entry.get("issue_text", "")).strip():
            # Silently becoming an empty search would score as "not found" and
            # pull the corpus average down for a reason nobody could see.
            raise CorpusError(f"{source}: case {name} has no issue_text.")
        if name in seen:
            raise CorpusError(f"{source}: case id {name} appears more than once.")
        seen.add(name)

    cases = [
        RetrievalCase(
            name=str(entry.get("id") or entry.get("name") or "unnamed"),
            issue_text=str(entry.get("issue_text", "")),
            expected_files=tuple(str(item) for item in entry.get("expected_files", [])),
            hint=str(entry.get("hint", "")),
            user_keywords=tuple(str(item) for item in entry.get("user_keywords", [])),
            kind=str(entry.get("category", "real")),
        )
        for entry in payload.get("cases", [])
    ]
    return cases, Path(repo_root) if repo_root else None


# --- reporting ----------------------------------------------------------------


def summarise(results: list[RetrievalResult]) -> dict[str, float | int]:
    """The aggregate numbers, over the cases that have an answer to find.

    Cases with no expected file are excluded from recall and MRR — they exist to
    measure noise, and scoring them would be scoring a question with no answer.
    """
    scored = [result for result in results if result.case.expected_files]
    count = len(scored) or 1
    return {
        "cases": len(results),
        "scored": len(scored),
        "top_3": sum(result.hit_at(3) for result in scored),
        "top_5": sum(result.hit_at(5) for result in scored),
        "top_10": sum(result.hit_at(10) for result in scored),
        "mrr": round(sum(result.reciprocal_rank for result in scored) / count, 3),
        "docs_in_top_5": sum(result.docs_in_top(5) for result in results),
        "terms": sum(len(result.terms) for result in results),
        "duration_s": round(sum(result.duration_s for result in results), 2),
    }


def report(results: list[RetrievalResult]) -> str:
    """A report to read while working on retrieval, not only to assert on."""
    lines: list[str] = []
    for result in results:
        lines.append(f"{result.case.name}  [{result.case.kind}]")
        if result.case.expected_files:
            lines.append("  expected:")
            for expected, rank in result.ranks.items():
                lines.append(f"    {expected}  ->  rank {rank if rank else 'not found'}")
        else:
            lines.append("  expected: (none; this case measures noise)")
        lines.append("  retrieved:")
        for index, path in enumerate(result.ranked[:10], start=1):
            marker = " <-- expected" if _normalize(path) in {
                _normalize(item) for item in result.case.expected_files
            } else ""
            lines.append(f"    {index:>2}. {path}{marker}")
        if result.case.expected_files:
            lines.append(
                f"  best rank {result.best_rank or '-'} | "
                f"top-3 {'yes' if result.hit_at(3) else 'no'} | "
                f"top-5 {'yes' if result.hit_at(5) else 'no'} | "
                f"top-10 {'yes' if result.hit_at(10) else 'no'} | "
                f"RR {result.reciprocal_rank:.3f}"
            )
        lines.append("")

    totals = summarise(results)
    lines.append(
        f"cases {totals['cases']} ({totals['scored']} scored)   "
        f"top-3 {totals['top_3']}/{totals['scored']}   "
        f"top-5 {totals['top_5']}/{totals['scored']}   "
        f"top-10 {totals['top_10']}/{totals['scored']}   "
        f"MRR {totals['mrr']}"
    )
    lines.append(
        f"docs in top 5 {totals['docs_in_top_5']}   terms {totals['terms']}   "
        f"{totals['duration_s']}s"
    )
    return "\n".join(lines)


def main(argv: list[str] | None = None) -> int:
    """`python tests/retrieval_corpus.py [--real [PATH]] [--repo PATH]`.

    A developer command rather than a test: retrieval work needs to see where
    every file landed, which an assertion cannot show.
    """
    import argparse

    parser = argparse.ArgumentParser(description="Evaluate BugPilot retrieval against a corpus.")
    parser.add_argument("--real", nargs="?", const=str(REAL_CORPUS_PATH), default=None,
                        help="Evaluate a local historical corpus instead of the fixture cases.")
    parser.add_argument("--repo", default=None,
                        help="The checkout to search. Defaults to the corpus file's repo_root.")
    parser.add_argument("--format", action="store_true", help="Print the corpus file format and exit.")
    args = parser.parse_args(argv)

    if args.format:
        print(CORPUS_FORMAT.strip())
        return 0

    if args.real:
        try:
            cases, corpus_root = load_real_corpus(Path(args.real))
        except CorpusError as error:
            print(f"error: {error}")
            return 1
        if not cases:
            print(f"No corpus at {args.real}.")
            print("Populate it with cases in this format:")
            print(CORPUS_FORMAT.strip())
            return 1
        repo_root = Path(args.repo) if args.repo else corpus_root
        if repo_root is None or not repo_root.is_dir():
            print(f"The corpus names no usable repo_root (got {repo_root}). Pass --repo.")
            return 1
    else:
        cases, repo_root = list(CORPUS), REPO_ROOT

    print(f"repository: {repo_root}")
    print(f"cases: {len(cases)}\n")
    print(report([run_case(case, repo_root) for case in cases]))
    return 0


if __name__ == "__main__":  # pragma: no cover - a developer command
    raise SystemExit(main())
