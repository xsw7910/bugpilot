"""A golden matrix for `task.md`: what the task says today, case by case.

Not a test module (no `test_` prefix, so pytest does not collect it); the
assertions over it are in `test_task_golden.py`. Regenerate the golden files
after a deliberate change with `python tests/task_golden.py --update`, and read
the diff: every line of it is something an agent will now be told differently.

Each case is one combination of the inputs that change the task — Fix Mode
(fix-capable or investigation-only), branch policy (`current`, `per-issue`,
`ask`), the work item's source (Jira or hand-written), Jira comment permission,
attached files, a hint, configured instructions and project settings, and the
repository's Verification Policy and AI Behavior files — not
the full Cartesian product, which would be mostly repetition. The rest of the
inputs are resolved the way `workflow.prompt_step` resolves them: the Repository
Profile, the User and Project Instructions and the project settings are read
from a synthetic repository and an empty user configuration directory, never
from the machine running the suite.

`measure` is the yardstick the task's later deduplication is judged by:
characters, words, `characters / 4` as an approximate token count (no
tokenizer: the package has no dependencies, and the suite gains none), the
section list, and how often each safety rule is said.
"""

from __future__ import annotations

import hashlib
import json
import os
import re
import statistics
import tempfile
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path

import _isolation
from bugpilot.core.ai_behavior import resolve_ai_behavior
from bugpilot.core.branch_policy import BRANCH_POLICIES
from bugpilot.core.fix_modes import INVESTIGATE_FIRST_FIX, STANDARD_FIX, FixMode
from bugpilot.core.instructions import load_instructions
from bugpilot.core.project_settings import resolve_project_settings
from bugpilot.core.prompts import generate_task
from bugpilot.core.repository_profile import resolve_repository_context
from bugpilot.core.user_config import CONFIG_DIR_ENV

#: One `<case>.txt` per case. Text, not Markdown: code search reads `.md` as
#: documentation (`code_files.DOC_SUFFIXES`), and twelve copies of the task would
#: change what a search of this repository finds — its live corpus included.
GOLDEN_DIR = Path(__file__).resolve().parent / "golden" / "task"

FIX_MODES: dict[str, FixMode] = {"fix": STANDARD_FIX, "investigation": INVESTIGATE_FIRST_FIX}

#: Where a golden task says the work item's folder is: a representative Linux path, so the text is what an
#: agent reads (0.1.7: the work folder is in BugPilot's data folder, named absolutely, plan §9.8.1).
GOLDEN_DATA_FOLDER = "/home/user/.bugpilot/repositories/repo-0123456789abcdef"

JIRA_ID = "JR-12345"
LOCAL_ID = "local_20260101090000"


@dataclass(frozen=True)
class TaskCase:
    """One combination of the inputs that change `task.md`."""

    name: str
    work_item_id: str
    title: str
    #: `fix` (Standard Fix) or `investigation` (Investigate First).
    fix_mode: str = "fix"
    branch_policy: str = "current"
    jira_comment: bool = False
    #: Files the developer attached, by name, and the description of each.
    attachments: tuple[tuple[str, str], ...] = ()
    hint: str = ""
    #: User and Project Instructions, and saved project settings, in place.
    configured: bool = False
    #: A repository `.bugpilot/verification.md`, which replaces the switches (0.1.3).
    verification_file: bool = False
    #: A repository `.bugpilot/ai_behavior.md`, added to BugPilot's defaults (0.1.4).
    ai_behavior: bool = False

    def __post_init__(self) -> None:
        if self.fix_mode not in FIX_MODES:
            raise ValueError(f"{self.name}: unknown fix mode {self.fix_mode!r}")
        if self.branch_policy not in BRANCH_POLICIES:
            raise ValueError(f"{self.name}: unknown branch policy {self.branch_policy!r}")
        if self.jira_comment and self.source != "jira":
            raise ValueError(f"{self.name}: only a Jira work item can post a comment")

    @property
    def source(self) -> str:
        return "jira" if self.work_item_id == JIRA_ID else "manual"


JIRA_TITLE = "Export dialog forgets the chosen output format"
MANUAL_TITLE = "Chosen output format is lost after reopening the export dialog"

MATRIX: tuple[TaskCase, ...] = (
    TaskCase("jira-fix-current", JIRA_ID, JIRA_TITLE),
    TaskCase("jira-fix-current-jira-comment", JIRA_ID, JIRA_TITLE, jira_comment=True),
    TaskCase("jira-fix-per-issue", JIRA_ID, JIRA_TITLE, branch_policy="per-issue"),
    TaskCase("jira-fix-ask", JIRA_ID, JIRA_TITLE, branch_policy="ask"),
    TaskCase(
        "jira-fix-current-attachments-hint", JIRA_ID, JIRA_TITLE,
        attachments=(("crash.log", "The log from the failed export."), ("dialog.png", "")),
        hint="Start with the export dialog's format selector.",
    ),
    TaskCase("jira-fix-current-configured", JIRA_ID, JIRA_TITLE, configured=True),
    # Added in 0.1.3 (§42.2): the repository's own Verification Policy
    # text, over saved switches that no longer decide anything.
    TaskCase("jira-fix-current-verification-file", JIRA_ID, JIRA_TITLE, configured=True, verification_file=True),
    TaskCase("jira-investigation-current", JIRA_ID, JIRA_TITLE, fix_mode="investigation"),
    TaskCase(
        "jira-investigation-current-jira-comment", JIRA_ID, JIRA_TITLE,
        fix_mode="investigation", jira_comment=True,
    ),
    TaskCase("jira-investigation-per-issue", JIRA_ID, JIRA_TITLE, fix_mode="investigation", branch_policy="per-issue"),
    TaskCase("manual-fix-current", LOCAL_ID, MANUAL_TITLE),
    TaskCase(
        "manual-fix-ask-attachments", LOCAL_ID, MANUAL_TITLE, branch_policy="ask",
        attachments=(("export.log", "Written while reproducing the bug."),),
    ),
    TaskCase("manual-investigation-current", LOCAL_ID, MANUAL_TITLE, fix_mode="investigation"),
    # Added in 0.1.4: the repository's AI Behavior additions, alone, beside
    # User and Project Instructions, beside a Verification Policy file, and in
    # an investigation. Without the file, every case above has the defaults.
    TaskCase("jira-fix-current-ai-behavior", JIRA_ID, JIRA_TITLE, ai_behavior=True),
    TaskCase("jira-fix-current-configured-ai-behavior", JIRA_ID, JIRA_TITLE, configured=True, ai_behavior=True),
    TaskCase(
        "jira-fix-current-verification-file-ai-behavior", JIRA_ID, JIRA_TITLE, verification_file=True, ai_behavior=True
    ),
    TaskCase("jira-investigation-current-ai-behavior", JIRA_ID, JIRA_TITLE, fix_mode="investigation", ai_behavior=True),
)


# --- inputs, resolved as a run resolves them -----------------------------------------------

#: The synthetic repository the Repository Profile is detected from.
_REPOSITORY_FILES = {
    "pyproject.toml": '[project]\nname = "sample-export"\nversion = "0.1.0"\n',
    "src/export/format_selector.py": '"""The export dialog\'s output format selector."""\n',
}
_USER_INSTRUCTIONS = "Explain the root cause in two sentences before listing changes.\n"
_PROJECT_INSTRUCTIONS = "Run the unit tests with `python -m pytest tests/unit`.\n"
_PROJECT_SETTINGS = {
    "schema_version": 1,
    # Not the defaults on purpose: the project relaxes the relevant tests and asks
    # for the full suite, so the task's wording for both is in the baseline.
    "verification": {"relevant_tests": False, "static_checks": True, "full_suite": True, "report_not_run": True},
    "branch_naming": {"template": "bugfix/{issue}-{slug}"},
}
#: A repository's own Verification Policy. The heading is there on purpose: it
#: must land below the task's own sections, never pose as one of them.
_VERIFICATION_FILE = (
    "---\nschema_version: 1\nbased_on_version: 1\nmode: replace\n---\n\n"
    "## Checks for this repository\n\n"
    "- Run the unit tests for the module you changed.\n"
    "- Run the type checker on the files you changed.\n"
    "- The integration suite is not required.\n"
)
#: A repository's own AI Behavior additions, one line under each section. The
#: headings must land below the task's own sections, as the policy's do.
_AI_BEHAVIOR_FILE = (
    "---\nschema_version: 1\nbased_on_version: 1\nmode: append\n---\n\n"
    "## Code Change Conventions\n\n"
    "- Keep the export module's public functions backward compatible.\n\n"
    "## Evidence Standards\n\n"
    "- Quote the log line or stack frame that shows the failure.\n\n"
    "## Reporting Standards\n\n"
    "- Name the export formats the change affects in the report's Summary.\n"
)


@contextmanager
def _resolved_inputs(
    configured: bool, verification_file: bool = False, ai_behavior: bool = False
) -> Iterator[dict[str, object]]:
    """The Repository Profile, instructions and settings, read from a fresh synthetic repository.

    BugPilot's data folder is a fresh one for the duration (``BUGPILOT_HOME``;
    the user configuration is its ``config/`` since 0.1.6 Batch 2B-2, and the
    repository's own settings its namespace's ``settings/`` since Batch 2B-3a),
    so the developer's own `~/.bugpilot` never reaches a golden file. Since 0.1.6
    Batch 0A it also refuses to run outside the test isolation (plan §11.1).
    """
    from bugpilot.core import storage

    _isolation.require_isolated()
    with tempfile.TemporaryDirectory() as directory:
        root = Path(directory) / "repo"
        data = Path(directory) / "data"
        config = data / "config"
        config.mkdir(parents=True)
        for relative, text in _REPOSITORY_FILES.items():
            path = root / relative
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(text, encoding="utf-8", newline="\n")
        if configured:
            (config / "instructions.md").write_text(_USER_INSTRUCTIONS, encoding="utf-8", newline="\n")
        previous = os.environ.get("BUGPILOT_HOME")
        os.environ["BUGPILOT_HOME"] = str(data)
        try:
            # The repository's Verification Policy and AI Behavior, in its namespace's settings (0.1.7).
            settings = {
                "verification.md": _VERIFICATION_FILE if verification_file else None,
                "ai_behavior.md": _AI_BEHAVIOR_FILE if ai_behavior else None,
            }
            for name, text in settings.items():
                if text is not None:
                    storage.repository_storage(root).settings_file(name, create=True).write_text(  # type: ignore[arg-type]
                        text, encoding="utf-8", newline="\n"
                    )
            if configured:
                # The repository's own settings, where 0.1.6 keeps them: written through storage's accessor.
                namespace = storage.repository_storage(root)
                namespace.settings_file("instructions.md", create=True).write_text(
                    _PROJECT_INSTRUCTIONS, encoding="utf-8", newline="\n"
                )
                namespace.settings_file("project_settings.json", create=True).write_text(
                    json.dumps(_PROJECT_SETTINGS, indent=2) + "\n", encoding="utf-8", newline="\n"
                )
            yield {
                "repository": resolve_repository_context(root),
                "instructions": load_instructions(root),
                "project_settings": resolve_project_settings(root),
                "ai_behavior": resolve_ai_behavior(root),
            }
        finally:
            if previous is None:
                os.environ.pop("BUGPILOT_HOME", None)
            else:
                os.environ["BUGPILOT_HOME"] = previous


def render(case: TaskCase) -> str:
    """`task.md` for one case, through `generate_task` with the inputs a run resolves."""
    with _resolved_inputs(case.configured, case.verification_file, case.ai_behavior) as inputs:
        return generate_task(
            case.work_item_id,
            case.title,
            hint=case.hint or None,
            jira_comment=case.jira_comment,
            attachments=[name for name, _note in case.attachments],
            fix_mode=FIX_MODES[case.fix_mode],
            attachment_notes={name: note for name, note in case.attachments if note},
            branch_policy=case.branch_policy,
            branch=None,
            work_folder=f"{GOLDEN_DATA_FOLDER}/work/{case.work_item_id}",
            **inputs,  # type: ignore[arg-type]
        )


def golden_path(case: TaskCase) -> Path:
    return GOLDEN_DIR / f"{case.name}.txt"


def normalized(text: str, case: TaskCase) -> str:
    """The golden with its work folder replaced by ``<WORK>``: the measure the size gate uses (US-D30, plan §9.8.2).

    0.1.7 tasks name their work folder absolutely; how long a path is depends on the machine, so the gate
    measures the text around it.
    """
    return text.replace(f"{GOLDEN_DATA_FOLDER}/work/{case.work_item_id}", "<WORK>")


def read_golden(case: TaskCase) -> str:
    """The golden text, with the line endings `generate_task` writes."""
    return golden_path(case).read_bytes().decode("utf-8").replace("\r\n", "\n")


# --- the yardstick ------------------------------------------------------------------------

#: How often each safety rule is said, by meaning rather than by one exact
#: sentence: the same rule is phrased several ways across the task's sections.
RULE_PATTERNS: dict[str, str] = {
    "force_push": r"\bforce[ -]push",
    "force_flags": r"--force(?:-with-lease)?\b",
    "push_main_master": r"\bpush\b[^.\n]{0,12}\bmain/master\b",
    "work_on_main_master": r"\bdirectly on main/master\b",
    "false_test_claims": r"\bclaim(?:s|ing)?\b[^.\n]{0,40}\b(?:pass(?:ed)?|ran)\b",
    "mass_format": r"\bmass-format",
    "pr_creation": r"\bcreate (?:PRs|pull requests)\b",
    "jira_field_mutation": r"\b(?:change|edit|update)\b[^.\n]{0,20}\bJira fields?\b|\bchange any Jira field\b",
    "jira_transition_assign": r"\b(?:transition|assign)\b[^.\n]{0,12}\bJira\b|\btransition the issue\b",
    "commit_push_approval": r"\b(?:commit|push)\b[^.\n]{0,80}\bapprov|\bapprov[^.\n]{0,60}\b(?:commit|push)\b",
    "delete_files": r"\bdelete (?:source )?files\b",
    "stage_ai_artifacts": r"\.ai/`?[^.\n]{0,30}\.ai_memory/",
    "destructive_git": r"git reset --hard|git clean -fd",
    "low_confidence": r"\bconfidence is Low\b",
}


def rule_counts(text: str) -> dict[str, int]:
    return {name: len(re.findall(pattern, text, re.IGNORECASE)) for name, pattern in RULE_PATTERNS.items()}


#: Where each protected rule is defined — once (0.1.3, §42.4): the
#: section that owns it, a pattern for its full statement by meaning, and the
#: sections where a deliberate short reference may match the pattern too. A
#: reference that does not restate the rule ("the one Jira write the BugPilot
#: Safety Rules allow", "apply every rule in BugPilot Delivery Safety above")
#: does not match at all.
CANONICAL_RULES: dict[str, tuple[str, str, tuple[str, ...]]] = {
    "destructive_git": ("BugPilot Safety Rules", r"git reset --hard[^\n]*git clean -fd", ()),
    "merge": ("BugPilot Safety Rules", r"\bnever merge\b", ()),
    "pr_creation": ("BugPilot Safety Rules", RULE_PATTERNS["pr_creation"], ()),
    "force_push": ("BugPilot Safety Rules", RULE_PATTERNS["force_push"], ()),
    "force_flags": ("BugPilot Safety Rules", r"--force` or `--force-with-lease", ()),
    "jira_field_mutation": ("BugPilot Safety Rules", RULE_PATTERNS["jira_field_mutation"], ()),
    "jira_transition_assign": ("BugPilot Safety Rules", RULE_PATTERNS["jira_transition_assign"], ()),
    "credentials": ("BugPilot Safety Rules", r"\breveal credentials\b", ()),
    "delete_files": ("BugPilot Safety Rules", RULE_PATTERNS["delete_files"], ()),
    "mass_format": ("BugPilot Safety Rules", RULE_PATTERNS["mass_format"], ()),
    # The Verification Policy's reminder (§42.2) is the one reference kept.
    "false_test_claims": ("BugPilot Safety Rules", RULE_PATTERNS["false_test_claims"], ("Verification Policy",)),
    "work_on_main_master": ("Branch Instructions", RULE_PATTERNS["work_on_main_master"], ()),
    "commit_push_approval": ("BugPilot Delivery Safety", RULE_PATTERNS["commit_push_approval"], ()),
    "push_main_master": ("BugPilot Delivery Safety", RULE_PATTERNS["push_main_master"], ()),
    "stage_ai_artifacts": ("BugPilot Delivery Safety", RULE_PATTERNS["stage_ai_artifacts"], ()),
    "secret_files": ("BugPilot Delivery Safety", r"`JIRA_TOKEN`", ()),
    "invented_evidence": ("BugPilot Evidence Rules", r"\binvent reproduction steps\b", ()),
    "low_confidence": ("BugPilot Evidence Rules", RULE_PATTERNS["low_confidence"], ()),
    "no_op": ("BugPilot Evidence Rules", r"\bno-op analysis that explains\b", ()),
    "report_contract": ("Required Output Files", r"Write one report: `", ()),
    "conflict_review_notes": ("BugPilot Rule Precedence", r"\brecord the conflict in the Review Notes\b", ()),
}


def section_bodies(text: str) -> list[tuple[str, str]]:
    """Each `## ` section as (heading, body); what precedes the first one is ("", …)."""
    parts = re.split(r"^## (.+)$", text, flags=re.MULTILINE)
    return [("", parts[0])] + list(zip(parts[1::2], parts[2::2]))


def rule_homes(text: str) -> dict[str, list[str]]:
    """For every canonical rule, the section of each match — one entry per match."""
    sections = section_bodies(text)
    return {
        name: [
            heading
            for heading, body in sections
            for _match in re.finditer(pattern, body, re.IGNORECASE)
        ]
        for name, (_home, pattern, _references) in CANONICAL_RULES.items()
    }


def sections(text: str) -> list[str]:
    return re.findall(r"^## (.+)$", text, re.MULTILINE)


def precedence_layers(text: str) -> list[str]:
    """The numbered layers of `## BugPilot Rule Precedence`, in order."""
    match = re.search(r"^## BugPilot Rule Precedence\n(.*?)(?=^## )", text, re.MULTILINE | re.DOTALL)
    return re.findall(r"^\d+\. (.+)$", match.group(1), re.MULTILINE) if match else []


def measure(text: str) -> dict[str, object]:
    """The numbers a task is compared by. `approx_tokens` is `characters / 4`, rounded."""
    return {
        "chars": len(text),
        "words": len(re.findall(r"\S+", text)),
        "approx_tokens": round(len(text) / 4),
        "sha256": hashlib.sha256(text.encode("utf-8")).hexdigest(),
        "sections": sections(text),
        "precedence_layers": precedence_layers(text),
        "rule_counts": rule_counts(text),
    }


def matrix_record(texts: dict[str, str]) -> dict[str, object]:
    """Per-case measurements and the medians over the matrix."""
    cases = {
        case.name: {
            "work_item_source": case.source,
            "fix_mode": case.fix_mode,
            "branch_policy": case.branch_policy,
            "jira_comment": case.jira_comment,
            "attachments": len(case.attachments),
            "hint": bool(case.hint),
            "configured": case.configured,
            "verification_file": case.verification_file,
            "ai_behavior": case.ai_behavior,
            **measure(texts[case.name]),
            # Since 0.1.3: where each protected rule's full statement is.
            "canonical_rules": rule_homes(texts[case.name]),
        }
        for case in MATRIX
    }
    return {
        "median": {
            key: statistics.median(int(record[key]) for record in cases.values())
            for key in ("chars", "words", "approx_tokens")
        },
        "cases": cases,
    }


def main(argv: list[str] | None = None) -> int:
    """`python tests/task_golden.py [--update]`: show the matrix's numbers, or rewrite the golden files."""
    import argparse

    _isolation.isolate_session()
    parser = argparse.ArgumentParser(description="The task.md golden matrix.")
    parser.add_argument("--update", action="store_true", help="Rewrite every golden file from today's generate_task.")
    args = parser.parse_args(argv)

    texts = {case.name: render(case) for case in MATRIX}
    if args.update:
        GOLDEN_DIR.mkdir(parents=True, exist_ok=True)
        for case in MATRIX:
            golden_path(case).write_bytes(texts[case.name].encode("utf-8"))
        stale = sorted(path.name for path in GOLDEN_DIR.glob("*") if path.stem not in texts)
        for name in stale:
            (GOLDEN_DIR / name).unlink()
        print(f"wrote {len(MATRIX)} golden files to {GOLDEN_DIR}" + (f"; removed {', '.join(stale)}" if stale else ""))
    record = matrix_record(texts)
    for name, values in record["cases"].items():  # type: ignore[union-attr]
        print(f"{name:42} {values['chars']:6} chars {values['words']:5} words {values['approx_tokens']:5} ~tokens")
    print(f"median: {record['median']}")
    return 0


if __name__ == "__main__":  # pragma: no cover - a developer command
    raise SystemExit(main())
