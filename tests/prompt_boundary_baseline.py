"""What becomes of each corpus case in each text source, judged by the two oracles (0.1.5 Batch 0).

Not a test module (no `test_` prefix). A developer command and the evaluation the
tests share:

    python tests/prompt_boundary_baseline.py                 # print the matrix's outcome counts
    python tests/prompt_boundary_baseline.py --update        # rewrite the living expectations, after a deliberate change
    python tests/prompt_boundary_baseline.py --write DIR     # record the matrix, MCP parity facts and timings in DIR
                                                             # (refuses files that are already there)

**How a case is judged.** Each injectable source (`prompt_boundary_sources`)
renders its documents twice: with the corpus case's text, and with a placeholder
(the clean render). The CommonMark oracle compares the two documents' own
headings; the raw-line oracle reads both line by line. The outcome is one of
the expected-baseline markers below:

- **EXPECTED_CURRENT_ESCAPE** — the text changed the document's structure: a
  top-level heading taken from the text appears, a heading of the clean render
  is missing or out of order, or a code fence the text opened never closes.
- **EXPECTED_CURRENT_AMBIGUOUS** — the structure a parser sees is unchanged, but
  a line-by-line reader meets something that reads as structure: a line
  imitating a BugPilot section title at heading level 1–2 (inside a fence, say),
  a heading only a reader honouring U+2028/U+2029/NEL/VT/FF sees, or — for
  evidence and earlier AI output — a sub-heading taken from the text.
- **EXPECTED_CURRENT_SAFE** — neither oracle sees anything.
- **EXPECTED_CURRENT_REFUSED** — the product refused the input (a Fix Mode
  section holding a heading, an instructions file it will not include).

Batch 0 recorded **0.1.4 as released**, vulnerabilities included (N1–N4). They
are not what 0.1.5 promises: Batches 1–3 flip them, case by case, and say so in
their records (:data:`DESCRIBES` says where the living record stands). The
expectations live in `tests/golden/prompt_boundary/expected.json` (rewritten
only with `--update`, after reading the diff); a record written with `--write`
is history and is never rewritten.

The timings in `performance.json` are this machine's, recorded beside the
platform they were measured on and never asserted (plan §44.12's comparators).
"""

from __future__ import annotations

import json
import platform
import statistics
import sys
import tempfile
import time
from collections import Counter
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

import oracle_commonmark as commonmark
import oracle_rawline as rawline
import prompt_boundary_corpus as corpus
import prompt_boundary_sources as sources

TESTS = Path(__file__).resolve().parent
EXPECTED_PATH = TESTS / "golden" / "prompt_boundary" / "expected.json"

#: What the living expectations describe, kept with them. Each batch that changes the boundaries says so here;
#: the frozen records (`tests/baselines/0.1.5-batch*/prompt_boundary.json`) keep what they described.
DESCRIBES = (
    "BugPilot 0.1.5 as of Batch 2: 0.1.4 (a1ce8dd) with the editable layers' containment repaired (N1, the "
    "unclosed HTML comment, N7), attachment names written safely (N3), and context.md's evidence quoted in "
    "fenced blocks with its short fields on one line (F8, N2, N4); the retry prompt and MCP findings are still "
    "those of 0.1.4, for Batch 3"
)

EXPECTED_CURRENT_ESCAPE = "EXPECTED_CURRENT_ESCAPE"
EXPECTED_CURRENT_AMBIGUOUS = "EXPECTED_CURRENT_AMBIGUOUS"
EXPECTED_CURRENT_SAFE = "EXPECTED_CURRENT_SAFE"
EXPECTED_CURRENT_REFUSED = "EXPECTED_CURRENT_REFUSED"
MARKERS = (EXPECTED_CURRENT_ESCAPE, EXPECTED_CURRENT_AMBIGUOUS, EXPECTED_CURRENT_SAFE, EXPECTED_CURRENT_REFUSED)

#: Sources whose text is never an instruction: a sub-heading taken from it is read as structure.
_NOT_INSTRUCTIONS = ("evidence", "ai-output", "metadata")


def _normalized(text: str) -> str:
    return rawline.normalized_title(text)


def _from_text(heading: str, text: str) -> bool:
    """Whether a heading's title came from the injected text (not from BugPilot's own conditional sections).

    Either the title is part of the text, or a line of the text (its heading
    marks stripped) begins the title: a forged heading can run on into what
    BugPilot writes after it on the same line (`## BugPilot Safety Rules, export`).
    """
    title = _normalized(heading)
    if not title:
        return False
    if title in _normalized(text):
        return True
    for line, _end in rawline.split_lines(text):
        candidate = _normalized(line.strip().lstrip("#>-*=~` \t"))
        if len(candidate) >= 4 and candidate in title:
            return True
    return False


@dataclass(frozen=True)
class Observation:
    outcome: str
    added: tuple[tuple[int, str], ...] = ()
    missing: tuple[tuple[int, str], ...] = ()
    unclosed: int = 0
    imitations: tuple[str, ...] = ()
    liberal_only: tuple[str, ...] = ()
    sub_headings: tuple[tuple[int, str], ...] = ()
    refused: str = ""

    def record(self) -> dict[str, object]:
        out: dict[str, object] = {"expected": self.outcome}
        for name in ("added", "missing", "sub_headings"):
            values = getattr(self, name)
            if values:
                out[name] = [list(item) for item in values]
        for name in ("imitations", "liberal_only"):
            values = getattr(self, name)
            if values:
                out[name] = list(values)
        if self.unclosed:
            out["unclosed"] = self.unclosed
        if self.refused:
            out["refused"] = self.refused
        return out


def judge(clean: str, injected: str, text: str, trust_class: str) -> Observation:
    """One document's outcome: the injected render against the clean one."""
    difference = commonmark.compare(clean, injected)
    added = tuple(item for item in difference.added if _from_text(item[1], text))
    clean_lines, injected_lines = rawline.scan(clean), rawline.scan(injected)
    imitations = Counter(_normalized(line.detail) for line in injected_lines.imitations()) - Counter(
        _normalized(line.detail) for line in clean_lines.imitations()
    )
    liberal = Counter(rawline.liberal_only_headings(injected)) - Counter(rawline.liberal_only_headings(clean))
    sub_headings = tuple(item for item in difference.added_sub_headings if _from_text(item[1], text))
    structural = bool(added or difference.missing or not difference.in_order or difference.new_unclosed_fences)
    if structural:
        outcome = EXPECTED_CURRENT_ESCAPE
    elif imitations or liberal or (trust_class in _NOT_INSTRUCTIONS and sub_headings):
        outcome = EXPECTED_CURRENT_AMBIGUOUS
    else:
        outcome = EXPECTED_CURRENT_SAFE
    return Observation(
        outcome=outcome,
        added=added,
        missing=difference.missing,
        unclosed=difference.new_unclosed_fences,
        imitations=tuple(sorted(imitations.elements())),
        liberal_only=tuple(sorted(liberal.elements())),
        sub_headings=sub_headings if trust_class in _NOT_INSTRUCTIONS else (),
    )


class Matrix:
    """Every applicable (source, case) pair, rendered in one workspace, the clean renders cached."""

    def __init__(self, base: Path) -> None:
        self.workspace = sources.Workspace(base)
        self._clean: dict[str, dict[str, str]] = {}

    def clean(self, source: sources.Source) -> dict[str, str]:
        if source.id not in self._clean:
            assert source.inject is not None
            self._clean[source.id] = source.inject(self.workspace, source.placeholder or corpus.PLACEHOLDER)
        return self._clean[source.id]

    def observe(self, source: sources.Source, text: str) -> dict[str, Observation]:
        assert source.inject is not None
        clean = self.clean(source)
        try:
            documents = source.inject(self.workspace, text)
        except Exception as error:  # the product refusing the input is an outcome, not a failure
            return {name: Observation(EXPECTED_CURRENT_REFUSED, refused=type(error).__name__) for name in clean}
        return {name: judge(clean[name], documents[name], text, source.trust_class) for name in documents}

    def run(self, cases: tuple[corpus.Case, ...] | None = None) -> dict[str, dict[str, dict[str, Observation]]]:
        cases = cases if cases is not None else corpus.matrix_cases()
        return {
            source.id: {case.id: self.observe(source, case.text) for case in cases if source.applies(case.text)}
            for source in sources.injectable()
        }


def run_matrix() -> dict[str, dict[str, dict[str, Observation]]]:
    with tempfile.TemporaryDirectory() as directory:
        return Matrix(Path(directory)).run()


def expectations(results: dict[str, dict[str, dict[str, Observation]]]) -> dict[str, object]:
    return {
        "schema_version": 1,
        "describes": DESCRIBES,
        "markers": list(MARKERS),
        "outcomes": {
            source: {case: {name: item.record() for name, item in sorted(documents.items())}
                     for case, documents in sorted(cases.items())}
            for source, cases in sorted(results.items())
        },
    }


def summary(results: dict[str, dict[str, dict[str, Observation]]]) -> dict[str, object]:
    """Outcome counts: overall, per document, per source, per trust class; and every escape, by case."""
    overall: Counter[str] = Counter()
    by_document: dict[str, Counter[str]] = {}
    by_source: dict[str, Counter[str]] = {}
    by_class: dict[str, Counter[str]] = {}
    escapes: dict[str, list[str]] = {}
    for source_id, cases in results.items():
        trust = sources.BY_ID[source_id].trust_class
        for case_id, documents in cases.items():
            for name, item in documents.items():
                overall[item.outcome] += 1
                by_document.setdefault(name, Counter())[item.outcome] += 1
                by_source.setdefault(source_id, Counter())[item.outcome] += 1
                by_class.setdefault(trust, Counter())[item.outcome] += 1
                if item.outcome == EXPECTED_CURRENT_ESCAPE:
                    escapes.setdefault(case_id, []).append(f"{source_id}:{name}")

    def plain(counter: Counter[str]) -> dict[str, int]:
        return {marker: counter.get(marker, 0) for marker in MARKERS}

    return {
        "observations": sum(overall.values()),
        "overall": plain(overall),
        "by_document": {name: plain(counter) for name, counter in sorted(by_document.items())},
        "by_trust_class": {name: plain(counter) for name, counter in sorted(by_class.items())},
        "by_source": {name: plain(counter) for name, counter in sorted(by_source.items())},
        "escapes_by_case": {case: sorted(found) for case, found in sorted(escapes.items())},
    }


def read_expected(path: Path = EXPECTED_PATH) -> dict[str, object]:
    return json.loads(path.read_text(encoding="utf-8"))


def _dump(value: object) -> bytes:
    # ASCII only: the expectations quote heading titles, and a title can hold a zero-width or CJK character.
    return (json.dumps(value, indent=1, ensure_ascii=True, sort_keys=False) + "\n").encode("ascii")


def _dump_outcomes(value: dict[str, object]) -> bytes:
    """The expectations with one line per (source, case), so a flip in a later batch is a one-line diff."""
    def compact(item: object) -> str:
        return json.dumps(item, ensure_ascii=True, separators=(", ", ": "))

    lines = ["{"]
    lines += [f" {compact(key)}: {compact(item)}," for key, item in value.items() if key != "outcomes"]
    lines.append(' "outcomes": {')
    outcomes = list(value["outcomes"].items())  # type: ignore[union-attr]
    for source_index, (source, cases) in enumerate(outcomes):
        lines.append(f"  {compact(source)}: {{")
        entries = list(cases.items())
        for case_index, (case, documents) in enumerate(entries):
            lines.append(f"   {compact(case)}: {compact(documents)}" + ("," if case_index < len(entries) - 1 else ""))
        lines.append("  }" + ("," if source_index < len(outcomes) - 1 else ""))
    lines += [" }", "}"]
    return ("\n".join(lines) + "\n").encode("ascii")


# --- performance (plan §44.12's comparators; this machine's, never asserted) -------------------


def _median_seconds(action: Callable[[], object], runs: int) -> float:
    times = []
    for _ in range(runs):
        start = time.perf_counter()
        action()
        times.append(time.perf_counter() - start)
    return statistics.median(times)


def measure_performance(preparation_runs: int = 5) -> dict[str, object]:
    """Render and preparation timings of 0.1.4 today, with the sizes the 5% growth goal is measured on."""
    import shutil

    from bugpilot.core import workflow
    from bugpilot.core.input_adapters import bug_spec_from_description
    from bugpilot.core.models import InvestigationOptions, InvestigationRequest

    results: dict[str, object] = {}
    with tempfile.TemporaryDirectory() as directory:
        workspace = sources.Workspace(Path(directory))
        typical = sources.jira_issue()
        typical_text = workspace.context(typical)
        megabyte = corpus.one_megabyte_description()
        big_issue = sources.jira_issue(description=megabyte.text)
        comments = sources.jira_issue(comment={"comments": [
            {"created": f"2026-05-{1 + index % 28:02d}T09:00:00.000+0000", "body": body}
            for index, body in enumerate(corpus.five_hundred_comments())
        ]})
        from bugpilot.core.context import build_context
        from bugpilot.core.workflow import extract_issue_keywords

        def render_only(issue):  # what the 0.1.5 containment changes: build_context, keywords already extracted
            keywords = extract_issue_keywords(issue, None)
            return lambda: build_context(issue, keywords, sources.TYPICAL_RETRIEVAL)

        timings = {
            # The whole step a run takes for context.md: keyword extraction, then rendering.
            "context_typical_ms": _median_seconds(lambda: workspace.context(typical), 30) * 1000,
            "context_1mb_description_ms": _median_seconds(lambda: workspace.context(big_issue), 5) * 1000,
            "context_500_comments_ms": _median_seconds(lambda: workspace.context(comments), 5) * 1000,
            # Rendering alone (`build_context`): the comparator for §44.12's render goals.
            "render_typical_ms": _median_seconds(render_only(typical), 30) * 1000,
            "render_1mb_description_ms": _median_seconds(render_only(big_issue), 5) * 1000,
            "render_500_comments_ms": _median_seconds(render_only(comments), 5) * 1000,
            "task_typical_ms": _median_seconds(lambda: workspace.task(hint="Start with the selector."), 30) * 1000,
            "retry_typical_ms": _median_seconds(workspace.retry, 30) * 1000,
        }
        results["render"] = {key: round(value, 3) for key, value in timings.items()}
        big_text = workspace.context(big_issue)
        results["sizes"] = {
            "context_typical_chars": len(typical_text),
            "context_typical_approx_tokens": round(len(typical_text) / 4),
            "context_1mb_input_chars": len(megabyte.text),
            "context_1mb_output_chars": len(big_text),
            "task_typical_chars": len(workspace.task(hint="Start with the selector.")),
            "retry_typical_chars": len(workspace.retry()),
        }

    if shutil.which("rg") is None:
        results["preparation"] = {"skipped": "ripgrep is not installed"}
    else:
        durations = []
        for run in range(preparation_runs):
            with tempfile.TemporaryDirectory() as directory:
                root = Path(directory)
                (root / "src" / "export").mkdir(parents=True)
                (root / "src" / "export" / "format_selector.py").write_text(
                    "def remember_format(dialog, fmt):\n    dialog.format = fmt\n", encoding="utf-8"
                )
                spec = bug_spec_from_description(
                    "The export dialog forgets the chosen output format after reopening.\n\n"
                    "Error: FormatSelector reset in remember_format",
                    title="Chosen format is lost on reopen",
                )
                request = InvestigationRequest(spec=spec, options=InvestigationOptions(keywords=["remember_format"]))
                start = time.perf_counter()
                workflow.run_investigation(root, request)
                durations.append(time.perf_counter() - start)
        results["preparation"] = {
            "runs": preparation_runs,
            "median_ms": round(statistics.median(durations) * 1000, 1),
            "all_ms": [round(value * 1000, 1) for value in durations],
            "what": "workflow.run_investigation of a hand-written bug in a two-file repository, "
                    "no git, ripgrep search; a fresh repository each run",
        }
    from importlib.metadata import version

    results["environment"] = {
        "platform": platform.system(),
        "machine": platform.machine(),
        "python": platform.python_version(),
        "markdown_it_py": version("markdown-it-py"),
    }
    return results


# --- the record -------------------------------------------------------------------------------


def render_report(record: dict[str, object]) -> str:
    """The record as plain text tables (text, not Markdown, so code search never reads it as documentation)."""
    totals = record["summary"]
    lines = [
        # What the record describes (until Batch 2 this line said "0.1.4 as released" in every record).
        f"Prompt-boundary record, judged by two independent oracles: {DESCRIBES}",
        "Generated by `python tests/prompt_boundary_baseline.py --write`; do not edit by hand.",
        "",
        f"Corpus: {record['corpus']['cases']} cases ({record['corpus']['matrix_cases']} in the matrix), "
        f"{record['corpus']['hostile']} hostile, {record['corpus']['benign']} benign.",
        f"Sources: {record['sources']['injectable']} injectable of {record['sources']['total']}.",
        f"Observations: {totals['observations']}.",
        "",
        "Outcome counts (escape / ambiguous / safe / refused):",
    ]

    def row(name: str, counts: dict[str, int]) -> str:
        return f"  {name:28} " + " / ".join(str(counts[marker]) for marker in MARKERS)

    lines.append(row("all", totals["overall"]))
    lines += ["", "By document:"] + [row(name, counts) for name, counts in totals["by_document"].items()]
    lines += ["", "By trust class:"] + [row(name, counts) for name, counts in totals["by_trust_class"].items()]
    lines += ["", "By source:"] + [row(name, counts) for name, counts in totals["by_source"].items()]
    lines += ["", "Escapes by case (source:document):"]
    for case, found in totals["escapes_by_case"].items():
        lines.append(f"  {case}: {', '.join(found)}")
    performance = record.get("performance")
    if performance:
        lines += ["", "Performance (this machine; never asserted):"]
        for key, value in performance["render"].items():
            lines.append(f"  {key}: {value}")
        for key, value in performance["sizes"].items():
            lines.append(f"  {key}: {value}")
        lines.append(f"  preparation: {json.dumps(performance['preparation'])}")
        lines.append(f"  environment: {json.dumps(performance['environment'])}")
    return "\n".join(lines) + "\n"


def build_record(results: dict[str, dict[str, dict[str, Observation]]], performance: dict[str, object] | None) -> dict[str, object]:
    cases = corpus.CASES
    return {
        "corpus": {
            "cases": len(cases) + 1,  # the generated 1 MB case is counted with the written ones
            "matrix_cases": len(corpus.matrix_cases()),
            "hostile": sum(case.hostile for case in cases) + 1,
            "benign": sum(not case.hostile for case in cases),
            "categories": corpus.CATEGORIES,
        },
        "sources": {
            "total": len(sources.SOURCES),
            "injectable": len(sources.injectable()),
            "matrix": [
                {"id": source.id, "label": source.label, "trust_class": source.trust_class,
                 "enters": list(source.enters), "product_path": source.product_path,
                 "treatment": source.treatment, "findings": list(source.findings),
                 "injectable": source.inject is not None, "covered_by": source.covered_by}
                for source in sources.SOURCES
            ],
        },
        "summary": summary(results),
        **({"performance": performance} if performance else {}),
    }


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="The prompt-boundary matrix: every corpus case in every source.")
    parser.add_argument("--update", action="store_true", help="Rewrite the living expectations from today's behaviour.")
    parser.add_argument("--write", metavar="DIR", default=None, help="Record the matrix and timings in DIR.")
    args = parser.parse_args(argv)

    started = time.perf_counter()
    results = run_matrix()
    elapsed = time.perf_counter() - started
    if args.update:
        EXPECTED_PATH.parent.mkdir(parents=True, exist_ok=True)
        EXPECTED_PATH.write_bytes(_dump_outcomes(expectations(results)))
        print(f"wrote {EXPECTED_PATH.relative_to(TESTS.parent).as_posix()}")
    if args.write:
        directory = Path(args.write)
        directory.mkdir(parents=True, exist_ok=True)
        targets = {name: directory / name for name in ("prompt_boundary.json", "prompt_boundary_summary.json",
                                                       "performance.json", "prompt_boundary_report.txt")}
        existing = [path.name for path in targets.values() if path.exists()]
        if existing:
            print(f"error: {directory} already holds {', '.join(existing)}; a record is history and is never rewritten.")
            return 1
        performance = measure_performance()
        record = build_record(results, performance)
        targets["prompt_boundary.json"].write_bytes(_dump_outcomes(expectations(results)))
        targets["prompt_boundary_summary.json"].write_bytes(_dump({key: record[key] for key in ("corpus", "sources", "summary")}))
        targets["performance.json"].write_bytes(_dump(performance))
        targets["prompt_boundary_report.txt"].write_bytes(render_report(record).encode("utf-8"))
        print(f"wrote {directory}")
    record = build_record(results, None)
    print(render_report(record))
    print(f"matrix: {record['summary']['observations']} observations in {elapsed:.1f} s "
          f"(Python {sys.version.split()[0]})")
    return 0


if __name__ == "__main__":  # pragma: no cover - a developer command
    raise SystemExit(main())
