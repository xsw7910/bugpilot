"""A measurement record for task.md and retrieval, written once per milestone.

Not a test module (no `test_` prefix). A developer command:

    python tests/baseline_report.py                  # print today's numbers, and the change since 0.1.3-batch0
    python tests/baseline_report.py --write DIR      # record them in DIR (refuses an existing record)
    python tests/baseline_report.py --real [PATH]    # also run a local private corpus — printed, never written

A record is `task.json` (the golden matrix, measured: `task_golden.measure`),
`retrieval.json` (the synthetic corpus and this repository's live corpus,
`retrieval_corpus.baseline_record`) and `report.txt`, the same numbers as
tables — text rather than Markdown, so a record never becomes documentation
that code search reads (`code_files.DOC_SUFFIXES`).
Every number is reproducible from the tree: no timings, no machine paths.

A record is history, not an expectation. `tests/baselines/0.1.3-batch0/` is
what task generation and retrieval did before 0.1.3 changed either; later
batches write their own record and compare against it, and never rewrite it.
"""

from __future__ import annotations

import json
import subprocess
import tempfile
from pathlib import Path

import retrieval_corpus as corpus
import task_golden as golden

TESTS = Path(__file__).resolve().parent
#: The record from before 0.1.3 changed task generation or retrieval.
BASELINE = TESTS / "baselines" / "0.1.3-batch0"


def _ripgrep_version() -> str:
    completed = subprocess.run(["rg", "--version"], capture_output=True, text=True, check=False)
    return completed.stdout.splitlines()[0] if completed.returncode == 0 and completed.stdout else "unknown"


def _base_commit() -> str:
    completed = subprocess.run(
        ["git", "rev-parse", "--short", "HEAD"], cwd=corpus.REPO_ROOT, capture_output=True, text=True, check=False
    )
    return completed.stdout.strip() or "unknown"


def collect() -> dict[str, dict[str, object]]:
    """Measure the task matrix and run both retrieval corpora."""
    corpus.require_ripgrep()
    texts = {case.name: golden.render(case) for case in golden.MATRIX}
    with tempfile.TemporaryDirectory() as directory:
        root = corpus.build_synthetic_repository(Path(directory))
        synthetic = [corpus.run_case(case, root) for case in corpus.SYNTHETIC_CORPUS]
    # Git History and Context Quality since 0.1.3 (§42.3): the same cases
    # over the synthetic product's history.
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory)
        hashes = corpus.build_synthetic_history(root)
        history = [corpus.run_history_case(case, root, hashes) for case in corpus.SYNTHETIC_CORPUS]
    live = [corpus.run_case(case) for case in corpus.CORPUS]
    environment = {"base_commit": _base_commit(), "ripgrep": _ripgrep_version()}
    task = {"environment": environment, **golden.matrix_record(texts)}
    record = {
        "task": task,
        "retrieval": {
            "environment": environment,
            "synthetic": {"repository_files": len(corpus.SYNTHETIC_REPOSITORY), **corpus.baseline_record(synthetic)},
            # This repository's own cases move as the tree moves (`retrieval_corpus`):
            # recorded for the trend, never asserted.
            "live_repository": corpus.baseline_record(live),
        },
        "git_history": {
            "environment": environment,
            "history": [subject for subject, _paths in ((corpus.SYNTHETIC_IMPORT_SUBJECT, ()), *corpus.SYNTHETIC_HISTORY)],
            "cases": [
                {
                    "name": result.case.name,
                    "extracted_terms": list(result.extracted_terms),
                    "weak_ranked_files": list(result.weak_ranked_files),
                    "commits": [
                        {"subject": subject, "score": score, "reasons": list(reasons)}
                        for subject, score, reasons in result.commits
                    ],
                }
                for result in history
            ],
        },
        "context_quality": {
            "environment": environment,
            "cases": [_quality_entry(result.case.name, result.context_quality) for result in history],
            "cap_cases": [
                _quality_entry(name, values) for name, values in corpus.context_quality_cap_cases().items()
            ],
        },
    }
    # The task beside the baseline record (0.1.3, §42.4), when there is one to stand beside.
    comparison = task_comparison(task)
    if comparison is not None:
        record["task_comparison"] = comparison
    return record


#: Repetition `task.md` keeps on purpose (0.1.3, §42.4), so a record says why it is there.
#: Written into records as is, so a new record compares with the older ones.
RETAINED_REPETITION = (
    "The Verification Policy's one-sentence reminder that claiming a check ran when it did not is a "
    "BugPilot rule (Batch 1's deliberate cross-reference).",
    "Investigation Handoff's reminder that BugPilot Delivery Safety still applies to a later "
    "implementation pass.",
    "Delivery Safety restates force pushes, merges, pull requests and Jira changes only in the retry "
    "prompt, which has no Safety Rules section; task.md states each once.",
    "Fix Mode text is the mode's own (Standard Fix avoids formatting-only changes); Batch 3 does not "
    "edit modes.",
    "Repository Context's closing sentence and the default AI Behavior overlap on following existing "
    "patterns; both are guidance, not rules.",
)


def task_comparison(task: dict[str, object], before: Path = BASELINE) -> dict[str, object] | None:
    """The task matrix beside the baseline record's — the before every later record is measured against."""
    if not (before / "task.json").is_file():
        return None
    old = json.loads((before / "task.json").read_text(encoding="utf-8"))
    sizes = ("chars", "words", "approx_tokens")

    def reduction(was: float, now: float) -> float:
        return round((was - now) / was, 3) if was else 0.0

    cases: dict[str, object] = {}
    for name, now in task["cases"].items():  # type: ignore[union-attr]
        was = old["cases"].get(name)
        entry: dict[str, object] = {
            "after": {**{key: now[key] for key in sizes}, "sections": len(now["sections"])},
            "rule_counts_after": now["rule_counts"],
        }
        if was is not None:
            entry["before"] = {**{key: was[key] for key in sizes}, "sections": len(was["sections"])}
            entry["rule_counts_before"] = was["rule_counts"]
            entry["token_reduction"] = reduction(was["approx_tokens"], now["approx_tokens"])
        cases[name] = entry
    return {
        "against": before.name,
        "median_before": old["median"],
        "median_after": task["median"],
        "median_reduction": {key: reduction(old["median"][key], task["median"][key]) for key in sizes},  # type: ignore[index]
        "cases": cases,
        "retained_repetition": list(RETAINED_REPETITION),
    }


def _quality_entry(name: str, values: tuple[int, int, int, int, int | None]) -> dict[str, object]:
    overall, issue, retrieval, repository, cap = values
    return {
        "name": name,
        "overall": overall,
        "issue_completeness": issue,
        "retrieval_quality": retrieval,
        "repository_context": repository,
        "cap": cap,
    }


# --- the report -------------------------------------------------------------------------------

_RULES_SHOWN = (
    "force_push", "false_test_claims", "mass_format", "pr_creation",
    "jira_field_mutation", "commit_push_approval", "delete_files",
)


def _percent(value: float) -> str:
    return f"{value * 100:.0f}%"


def render_report(record: dict[str, dict[str, object]], title: str) -> str:
    task = record["task"]
    retrieval = record["retrieval"]
    environment = task["environment"]  # type: ignore[index]
    lines = [
        f"# {title}",
        "",
        "Generated by `python tests/baseline_report.py --write`; do not edit by hand.",
        f"Base commit `{environment['base_commit']}`, {environment['ripgrep']}.",  # type: ignore[index]
        "",
        "## task.md — golden matrix (`tests/task_golden.py`)",
        "",
        "Approximate tokens are characters / 4. Rule counts are occurrences by meaning",
        "(`task_golden.RULE_PATTERNS`); related patterns can count the same sentence.",
        "",
        "| case | chars | words | ~tokens | sections | " + " | ".join(_RULES_SHOWN) + " |",
        "| --- | ---: | ---: | ---: | ---: | " + " | ".join("---:" for _ in _RULES_SHOWN) + " |",
    ]
    for name, values in task["cases"].items():  # type: ignore[union-attr]
        counts = values["rule_counts"]
        lines.append(
            f"| {name} | {values['chars']} | {values['words']} | {values['approx_tokens']} | {len(values['sections'])} | "
            + " | ".join(str(counts[rule]) for rule in _RULES_SHOWN)
            + " |"
        )
    median = task["median"]  # type: ignore[index]
    lines += [
        "",
        f"Median over {len(task['cases'])} cases: {median['chars']} characters, {median['words']} words, "  # type: ignore[arg-type]
        f"{median['approx_tokens']} approximate tokens.",
        "",
    ]
    for label, key in (("synthetic corpus (`retrieval_corpus.SYNTHETIC_CORPUS`)", "synthetic"),
                       ("this repository's live corpus (`retrieval_corpus.CORPUS`; drifts with the tree)", "live_repository")):
        section = retrieval[key]  # type: ignore[index]
        summary = section["summary"]
        lines += [
            f"## Retrieval — {label}",
            "",
            f"{summary['cases']} cases, {summary['scored']} with an expected file: Recall@5 {_percent(summary['recall_at_5'])} "
            f"({summary['top_5']}/{summary['scored']}), MRR {summary['mrr']}, confidence high {summary['confidence']['high']} / "
            f"medium {summary['confidence']['medium']} / low {summary['confidence']['low']}, "
            f"noise-only files in the top 5: {summary['noise_only_in_top_5']}.",
            "",
            "| kind | cases | Recall@5 | MRR | high / medium / low |",
            "| --- | ---: | ---: | ---: | --- |",
        ]
        for kind, totals in section["by_kind"].items():
            distribution = totals["confidence"]
            recall = f"{_percent(totals['recall_at_5'])}" if totals["scored"] else "—"
            mrr = totals["mrr"] if totals["scored"] else "—"
            lines.append(
                f"| {kind} | {totals['cases']} | {recall} | {mrr} | "
                f"{distribution['high']} / {distribution['medium']} / {distribution['low']} |"
            )
        lines += [
            "",
            "| case | best rank | confidence | expected confidence | noise-only in top 5 |",
            "| --- | ---: | --- | --- | --- |",
        ]
        for case in section["cases"]:
            lines.append(
                f"| {case['name']} | {case['best_rank'] if case['best_rank'] is not None else 'not found'} | "
                f"{case['confidence']} | {case['expected_confidence'] or '—'} | "
                f"{', '.join(case['noise_only_in_top_5']) or '—'} |"
            )
        lines.append("")
    if "task_comparison" in record:
        comparison = record["task_comparison"]
        before, after, cut = (comparison[key] for key in ("median_before", "median_after", "median_reduction"))  # type: ignore[index]
        lines += [
            f"## task.md — compared with {comparison['against']}",  # type: ignore[index]
            "",
            f"Median characters {before['chars']} -> {after['chars']} (-{cut['chars']:.1%}), "
            f"words {before['words']} -> {after['words']} (-{cut['words']:.1%}), "
            f"approximate tokens {before['approx_tokens']} -> {after['approx_tokens']} (-{cut['approx_tokens']:.1%}).",
            "",
            "| case | tokens before | tokens after | reduction | sections before | sections after |",
            "| --- | ---: | ---: | ---: | ---: | ---: |",
        ]
        for name, entry in comparison["cases"].items():  # type: ignore[index]
            if "before" in entry:
                lines.append(
                    f"| {name} | {entry['before']['approx_tokens']} | {entry['after']['approx_tokens']} | "
                    f"-{entry['token_reduction']:.1%} | {entry['before']['sections']} | {entry['after']['sections']} |"
                )
            else:
                lines.append(f"| {name} | — | {entry['after']['approx_tokens']} | — | — | {entry['after']['sections']} |")
        lines += ["", "Rule counts (Batch 0 patterns) before -> after, in each case that Batch 0 measured:", ""]
        rules = sorted({rule for entry in comparison["cases"].values() for rule in entry["rule_counts_after"]})  # type: ignore[index]
        for rule in rules:
            pairs = sorted({
                (entry["rule_counts_before"][rule], entry["rule_counts_after"][rule])
                for entry in comparison["cases"].values()  # type: ignore[index]
                if "rule_counts_before" in entry
            })
            lines.append(f"- {rule}: " + ", ".join(f"{was} -> {now}" for was, now in pairs))
        lines += ["", "Repetition kept on purpose:", ""]
        lines += [f"- {reason}" for reason in comparison["retained_repetition"]]  # type: ignore[index]
        lines.append("")
    if "git_history" in record:
        history = record["git_history"]
        lines += [
            "## Git History — the synthetic corpus over the synthetic history",
            "",
            "History, oldest first: " + "; ".join(history["history"]) + ".",  # type: ignore[index, arg-type]
            "",
            "| case | commit-message terms | ranked files given no credit | commits (score) |",
            "| --- | --- | --- | --- |",
        ]
        for case in history["cases"]:  # type: ignore[index]
            commits = "; ".join(f"{commit['subject']} ({commit['score']})" for commit in case["commits"]) or "—"
            lines.append(
                f"| {case['name']} | {', '.join(case['extracted_terms']) or '—'} | "
                f"{', '.join(case['weak_ranked_files']) or '—'} | {commits} |"
            )
        lines.append("")
    if "context_quality" in record:
        quality = record["context_quality"]
        lines += [
            "## Context Quality",
            "",
            "| case | overall | issue completeness | retrieval quality | repository context | cap |",
            "| --- | ---: | ---: | ---: | ---: | ---: |",
        ]
        for case in [*quality["cases"], *quality["cap_cases"]]:  # type: ignore[index]
            lines.append(
                f"| {case['name']} | {case['overall']} | {case['issue_completeness']} | {case['retrieval_quality']} | "
                f"{case['repository_context']} | {case['cap'] if case['cap'] is not None else '—'} |"
            )
        lines.append("")
    return "\n".join(lines)


def write_record(record: dict[str, dict[str, object]], directory: Path, title: str) -> None:
    if directory.exists():
        raise FileExistsError(f"{directory} already holds a record; a record is history and is never rewritten.")
    directory.mkdir(parents=True)
    for name in ("task", "task_comparison", "retrieval", "git_history", "context_quality"):
        if name in record:
            (directory / f"{name}.json").write_bytes((json.dumps(record[name], indent=2) + "\n").encode("utf-8"))
    (directory / "report.txt").write_bytes(render_report(record, title).encode("utf-8"))


# --- comparing with the baseline record -------------------------------------------------------


def compare(record: dict[str, dict[str, object]], before: Path = BASELINE) -> str:
    """Today's numbers beside a written record's, for the plan's before/after."""
    if not (before / "task.json").is_file():
        return f"(no record at {before} to compare with)"
    old_task = json.loads((before / "task.json").read_text(encoding="utf-8"))
    old_retrieval = json.loads((before / "retrieval.json").read_text(encoding="utf-8"))
    lines = [f"compared with {before.name}:"]
    for key in ("chars", "words", "approx_tokens"):
        was, now = old_task["median"][key], record["task"]["median"][key]  # type: ignore[index]
        change = (now - was) / was if was else 0.0
        lines.append(f"  task median {key}: {was} -> {now} ({change:+.1%})")
    for key in ("synthetic", "live_repository"):
        was = old_retrieval[key]["summary"]
        now = record["retrieval"][key]["summary"]  # type: ignore[index]
        lines.append(
            f"  {key}: Recall@5 {was['recall_at_5']} -> {now['recall_at_5']}, MRR {was['mrr']} -> {now['mrr']}, "
            f"confidence {was['confidence']} -> {now['confidence']}, "
            f"on target {_on_target(old_retrieval[key])} -> {_on_target(record['retrieval'][key])}, "  # type: ignore[index]
            f"noise-only in top 5 {was['noise_only_in_top_5']} -> {now['noise_only_in_top_5']}"
        )
    old_cases = {case["name"]: case for case in old_retrieval["synthetic"]["cases"]}
    for case in record["retrieval"]["synthetic"]["cases"]:  # type: ignore[index]
        was = old_cases.get(case["name"])
        if was and (was["best_rank"], was["confidence"]) != (case["best_rank"], case["confidence"]):
            lines.append(
                f"  {case['name']}: rank {was['best_rank']} -> {case['best_rank']}, "
                f"confidence {was['confidence']} -> {case['confidence']} (expected {case['expected_confidence'] or '—'})"
            )
    return "\n".join(lines)


def _on_target(section: dict) -> str:
    """Cases whose confidence is their target, of those with one; read from the cases, so older records answer too."""
    targeted = [case for case in section["cases"] if case.get("expected_confidence")]
    return f"{sum(case['confidence'] == case['expected_confidence'] for case in targeted)}/{len(targeted)}"


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="Measure task.md and retrieval, and record or compare the numbers.")
    parser.add_argument("--write", metavar="DIR", default=None, help="Write a new record to DIR (never over an existing one).")
    parser.add_argument("--title", default="Measurement record", help="The report's title, with --write.")
    parser.add_argument("--real", nargs="?", const=str(corpus.REAL_CORPUS_PATH), default=None,
                        help="Also run a local private corpus. LOCAL-ONLY: printed, never written to a record.")
    args = parser.parse_args(argv)

    try:
        record = collect()
    except corpus.RipgrepUnavailable as error:
        print(f"error: {error}")
        return 1
    if args.write:
        try:
            write_record(record, Path(args.write), args.title)
        except FileExistsError as error:
            print(f"error: {error}")
            return 1
        print(f"wrote {args.write}")
    print(render_report(record, args.title))
    print(compare(record))
    if args.real:
        cases, root = corpus.load_real_corpus(Path(args.real))
        if not cases or root is None or not root.is_dir():
            print(f"LOCAL-ONLY: no usable private corpus at {args.real}.")
        else:
            totals = corpus.summarise([corpus.run_case(case, root) for case in cases])
            # Totals only: a private case's text, id or files never leave this terminal.
            print(f"LOCAL-ONLY private corpus: {totals['cases']} cases, Recall@5 {totals['recall_at_5']}, "
                  f"MRR {totals['mrr']}, confidence {totals['confidence']}")
    return 0


if __name__ == "__main__":  # pragma: no cover - a developer command
    raise SystemExit(main())
