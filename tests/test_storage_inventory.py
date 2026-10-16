"""The storage path-literal ratchet (0.1.6 Batch 0A, plan §11.2).

BugPilot 0.1.6 moves every BugPilot-owned file out of the repository. Before
any code moves, this records where the production sources name the 0.1.5
locations — `.ai`, `.ai_memory`, `.bugpilot`, `~/.bugpilot`,
`BUGPILOT_CONFIG_DIR`, the agent-facing sentences that name `.ai/` — and the
helpers, constants and home lookups through which paths are built
indirectly. The record is `tests/storage_inventory.json`: a count per source
file and per pattern family, never a line number (lines move on every edit).

The rules:

- a **new** reference — a file, or a family in a file, the record does not
  list — fails;
- **more** references than recorded fail;
- **fewer** pass: Batches 2 and 3 remove references, then lock the reduction
  with `python tests/test_storage_inventory.py --update` in the same commit;
- `approved_residue` names what may stay at the end (plan §11.2: the F22
  legacy guards, the protected rule if US-D14 keeps it, the default data-root
  name, historical comments), each with its reason. It is empty until a batch
  approves an entry.

Text matching cannot see every constructed path; the record's `known_gaps`
says which ones it misses, and the `path-helper`, `path-constant` and
`home-lookup` families are there to keep those visible.

    python tests/test_storage_inventory.py            # report counts, increases and reductions
    python tests/test_storage_inventory.py --update   # rewrite the record from today's sources
"""

from __future__ import annotations

import json
import os
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[1]
RECORD = Path(__file__).resolve().parent / "storage_inventory.json"

#: What is scanned (plan §11.2): the production sources, the skill and the scripts.
ROOTS: tuple[str, ...] = ("bugpilot", "skills", "scripts", "extension/src", "extension/media/panel.js")
TEXT_SUFFIXES = frozenset({".py", ".ts", ".js", ".mjs", ".md", ".ps1", ".sh", ".cmd", ".json", ".toml", ".txt"})
SKIPPED_DIRS = frozenset({"__pycache__", "node_modules", "out", ".review", "codicons"})

#: Pattern families, each with the plan's path families (§5.2) it watches.
FAMILIES: dict[str, dict[str, object]] = {
    "ai-dir": {
        "pattern": r"(?<![\w])\.ai(?![\w-])",
        "watches": ["F01", "F02", "F03", "F04", "F05", "F06", "F21", "F22", "F23", "F24", "F25"],
        "what": "the work-item folder `.ai` (`.ai/`, `\".ai\"`)",
    },
    "ai-memory": {
        "pattern": r"\.ai_memory\b",
        "watches": ["F07", "F21", "F22", "F23", "F24", "F25"],
        "what": "the memory folder `.ai_memory`",
    },
    "bugpilot-dir": {
        "pattern": r"(?<![\w~])(?<!~/)(?<!~\\)\.bugpilot(?![\w-])",
        "watches": ["F08", "F09", "F10", "F11", "F12", "F13", "F14", "F15", "F16"],
        "what": "a `.bugpilot` folder name, the repository's or the home's (`Path.home() / \".bugpilot\"`)",
    },
    "home-bugpilot": {
        "pattern": r"~[/\\]\.bugpilot",
        "watches": ["F14", "F15", "F16", "F23"],
        "what": "`~/.bugpilot` as written in text and messages",
    },
    "config-dir-env": {
        "pattern": r"\bBUGPILOT_CONFIG_DIR\b",
        "watches": ["F17"],
        "what": "the 0.1.5 configuration-folder variable",
    },
    "agent-instruction": {
        "pattern": r"\b(?:[Rr]ead|[Ww]rite|[Uu]pdate|[Ii]nspect)\b[^\n]{0,25}?\.ai/",
        "watches": ["F23"],
        "what": "a sentence telling the agent to read, write, update or inspect a `.ai/` path (heuristic)",
    },
    "path-helper": {
        "pattern": (
            r"(?:\b(?:issue_dir|writable_issue_dir|memory_dir|writable_memory_file|user_config_dir|"
            r"user_config_path|user_instructions_path|project_instructions_path|instructions_path|"
            r"verification_path|ai_behavior_path|settings_path|profile_path|run_path|issue_path|"
            r"retrieval_path|writable_dir|owned_path)|#itemFile)\s*\("
        ),
        "watches": ["F01", "F07", "F08", "F09", "F10", "F11", "F12", "F14", "F15"],
        "what": "a call to a function that builds a storage path (indirect)",
    },
    "path-constant": {
        "pattern": (
            r"\b(?:PROJECT_CONFIG_DIR|FIX_MODE_DIR_NAME|FIX_MODE_SUBDIR|ARTIFACT_ROOT|ARTIFACT_DIRECTORIES|"
            r"CONFIG_DIR_ENV|ATTACHMENTS_DIR|VERIFICATION_FILE|AI_BEHAVIOR_FILE|EXCLUDE_DIRS|_PATHSPEC)\b"
        ),
        "watches": ["F06", "F08", "F09", "F10", "F11", "F12", "F13", "F17", "F21", "F22"],
        "what": "a constant from which a storage path is built (indirect)",
    },
    "home-lookup": {
        "pattern": r"Path\.home\(\)|\bexpanduser\(|\bhomedir\(\)",
        "watches": ["F14", "F15", "F16", "F17", "F20"],
        "what": "a lookup of the user's home folder (indirect)",
    },
}

KNOWN_GAPS: tuple[str, ...] = (
    "Uses of a path constant or helper are counted where the name appears, not where the path is used; a value "
    "passed on (a variable holding `.ai`, an f-string built from `ATTACHMENTS_DIR`) is seen only at its source.",
    "Paths assembled from fragments (`'.' + 'ai'`, `path.join(root, dir)` with `dir` computed elsewhere) are not "
    "matched at all; the path-helper and path-constant families are the hooks for reviewing those by hand.",
    "The extension's `.bugpilot` file names (`VERIFICATION_FILE`, `AI_BEHAVIOR_FILE`) are constants; their "
    "joins in controller.ts are counted through the constants, not as `.bugpilot` literals.",
    "Comments and docstrings are counted with code: a historical comment is a reference until a batch rewords it or "
    "approves it as residue.",
    "Documentation (docs/, README, CHANGELOG) and tests are not scanned; the plan's §5.5 audits them.",
)

_COMPILED = {name: re.compile(str(spec["pattern"])) for name, spec in FAMILIES.items()}


def scanned_files() -> list[Path]:
    files: list[Path] = []
    for root in ROOTS:
        path = REPO / root
        if path.is_file():
            files.append(path)
            continue
        for current, folders, names in os.walk(path):
            folders[:] = sorted(folder for folder in folders if folder not in SKIPPED_DIRS)
            files.extend(Path(current) / name for name in sorted(names) if Path(name).suffix in TEXT_SUFFIXES)
    return sorted(files, key=lambda item: item.relative_to(REPO).as_posix())


def count_references() -> dict[str, dict[str, int]]:
    """``{file: {family: occurrences}}`` for every scanned file with at least one."""
    counts: dict[str, dict[str, int]] = {}
    for path in scanned_files():
        text = path.read_text(encoding="utf-8", errors="replace")
        found = {name: len(pattern.findall(text)) for name, pattern in _COMPILED.items()}
        found = {name: count for name, count in found.items() if count}
        if found:
            counts[path.relative_to(REPO).as_posix()] = found
    return counts


def load_record() -> dict[str, object]:
    return json.loads(RECORD.read_text(encoding="utf-8"))


def compare(recorded: dict[str, dict[str, int]], actual: dict[str, dict[str, int]]) -> tuple[list[str], list[str]]:
    """``(problems, reductions)``: a new or larger reference is a problem; a smaller one is a reduction."""
    problems: list[str] = []
    reductions: list[str] = []
    for file, families in sorted(actual.items()):
        for family, count in sorted(families.items()):
            before = recorded.get(file, {}).get(family)
            if before is None:
                problems.append(f"{file}: {count} new {family} reference(s), not in the record")
            elif count > before:
                problems.append(f"{file}: {family} {before} -> {count}")
    for file, families in sorted(recorded.items()):
        for family, before in sorted(families.items()):
            count = actual.get(file, {}).get(family, 0)
            if count < before:
                reductions.append(f"{file}: {family} {before} -> {count}")
    return problems, reductions


def totals(counts: dict[str, dict[str, int]]) -> dict[str, dict[str, int]]:
    """Per family: occurrences, and files holding at least one."""
    summary: dict[str, dict[str, int]] = {}
    for families in counts.values():
        for family, count in families.items():
            entry = summary.setdefault(family, {"occurrences": 0, "files": 0})
            entry["occurrences"] += count
            entry["files"] += 1
    return {family: summary[family] for family in FAMILIES if family in summary}


def build_record(counts: dict[str, dict[str, int]], approved: dict[str, dict[str, str]]) -> dict[str, object]:
    return {
        "schema_version": 1,
        "description": (
            "Where BugPilot's production sources name its 0.1.5 storage locations, per file and pattern family "
            "(plan §11.2). Generated by `python tests/test_storage_inventory.py --update`; review the diff."
        ),
        "scanned": list(ROOTS),
        "families": {
            name: {"pattern": spec["pattern"], "watches": spec["watches"], "what": spec["what"]}
            for name, spec in FAMILIES.items()
        },
        "known_gaps": list(KNOWN_GAPS),
        "approved_residue": approved,
        "totals": totals(counts),
        "counts": counts,
    }


def _dump(record: dict[str, object]) -> bytes:
    return (json.dumps(record, indent=1, ensure_ascii=False) + "\n").encode("utf-8")


# --- the tests -------------------------------------------------------------------------------------


def test_no_new_or_larger_storage_path_reference():
    record = load_record()
    problems, _reductions = compare(record["counts"], count_references())  # type: ignore[arg-type]
    assert problems == [], (
        "New or more references to BugPilot's 0.1.5 storage locations. Remove them, or, if a batch approves "
        "them, update the record (python tests/test_storage_inventory.py --update) in the same commit:\n  "
        + "\n  ".join(problems)
    )


def test_the_record_describes_the_families_it_counts():
    record = load_record()
    assert record["schema_version"] == 1
    assert record["scanned"] == list(ROOTS)
    assert set(record["families"]) == set(FAMILIES)  # type: ignore[arg-type]
    for name, spec in record["families"].items():  # type: ignore[union-attr]
        assert spec["pattern"] == FAMILIES[name]["pattern"]
    counted = {family for families in record["counts"].values() for family in families}  # type: ignore[union-attr]
    assert counted <= set(FAMILIES)
    assert record["totals"] == totals(record["counts"])  # type: ignore[arg-type]


def test_approved_residue_names_only_recorded_references_with_a_reason():
    record = load_record()
    for file, families in record["approved_residue"].items():  # type: ignore[union-attr]
        for family, reason in families.items():
            assert family in record["counts"].get(file, {}), f"{file}: approved {family} is not recorded"  # type: ignore[union-attr]
            assert isinstance(reason, str) and reason.strip(), f"{file}: approved {family} needs a reason"


def test_every_family_matches_what_it_is_meant_to_match():
    """The patterns themselves, on fixed samples: what counts, and what does not."""
    def hits(family: str, text: str) -> int:
        return len(_COMPILED[family].findall(text))

    assert hits("ai-dir", 'Read .ai/JR-12345/task.md; path.join(root, ".ai", id); `.ai`') == 3
    assert hits("ai-dir", "openai.ai .ai_memory .aiohttp email.ai") == 0
    assert hits("ai-memory", ".ai_memory/bugs/JR-1.md and '.ai_memory'") == 2
    assert hits("bugpilot-dir", '<repo>/.bugpilot/x Path.home() / ".bugpilot" `.bugpilot/`') == 3
    assert hits("bugpilot-dir", "~/.bugpilot ShiweiX.bugpilot .bugpilot-panel") == 0
    assert hits("home-bugpilot", "~/.bugpilot/config.toml and ~\\.bugpilot") == 2
    assert hits("agent-instruction", "Read .ai/x/task.md. Write one report: `.ai/x/fix_report.md`") == 2
    assert hits("path-helper", "issue_dir(root, id) writable_dir(root, parts) this.#itemFile(id, name)") == 3
    assert hits("home-lookup", "Path.home() / x; os.path.expanduser('~'); os.homedir()") == 3


def main(argv: list[str] | None = None) -> int:
    import argparse

    parser = argparse.ArgumentParser(description="The storage path-literal ratchet.")
    parser.add_argument("--update", action="store_true", help="Rewrite the record from today's sources.")
    args = parser.parse_args(argv)
    counts = count_references()
    approved: dict[str, dict[str, str]] = {}
    if RECORD.exists():
        record = load_record()
        approved = record.get("approved_residue", {})  # type: ignore[assignment]
        problems, reductions = compare(record["counts"], counts)  # type: ignore[arg-type]
        for line in problems:
            print(f"increase: {line}")
        for line in reductions:
            print(f"reduction: {line}")
    if args.update:
        RECORD.write_bytes(_dump(build_record(counts, approved)))
        print(f"wrote {RECORD.relative_to(REPO).as_posix()}")
    for family, entry in totals(counts).items():
        print(f"{family:18} {entry['occurrences']:5} occurrences in {entry['files']:3} files")
    return 0


if __name__ == "__main__":  # pragma: no cover - a developer command
    raise SystemExit(main(sys.argv[1:]))
