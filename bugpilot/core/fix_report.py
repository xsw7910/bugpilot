"""fix_report.md: the one post-agent workflow report (plan §37).

Five agent-written files used to carry the outcome — analysis, fix summary,
test result, diff summary, review notes — and BugPilot then derived four more
from them. One report remains, and the derivations (the Jira comment draft,
the notification email, the memory entry's Final Result, the validation
checklist, the retry prompt's previous-attempt summary) are rendered from it
in memory.

The report is **agent-owned**: the coding agent writes and updates it per
``task.md``'s Required Output contract, and BugPilot never rewrites it. The
one BugPilot writer is the ``manual-result`` template, for a developer who
fixed by hand, and it refuses to overwrite an existing report unless asked.

The name means "post-agent workflow report", not "confirmed fix". An
investigation-only mode fills the same sections with investigation state, and
``## Summary`` says honestly what happened: fixed, investigation only, no-op,
or an attempt that did not finish.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .artifacts import FIX_REPORT_ARTIFACT
from .config import issue_dir

# The section contract task.md asks the agent for, in this order.
FIX_REPORT_SECTIONS: tuple[str, ...] = (
    "## Summary",
    "## Analysis",
    "## Changes",
    "## Tests",
    "## Review Notes",
)


@dataclass(frozen=True)
class FixReport:
    """The report as written, plus its sections. Empty string for a missing one."""

    text: str
    summary: str
    analysis: str
    changes: str
    tests: str
    review_notes: str

    @property
    def missing_sections(self) -> tuple[str, ...]:
        by_heading = {
            "## Summary": self.summary,
            "## Analysis": self.analysis,
            "## Changes": self.changes,
            "## Tests": self.tests,
            "## Review Notes": self.review_notes,
        }
        return tuple(heading for heading in FIX_REPORT_SECTIONS if not by_heading[heading])


def fix_report_path(repo_root: Path, work_item_id: str) -> Path:
    return issue_dir(repo_root, work_item_id) / FIX_REPORT_ARTIFACT


def read_fix_report(repo_root: Path, work_item_id: str) -> FixReport | None:
    """The agent's report, or ``None`` when nothing has written one yet.

    Markdown a model wrote, read tolerantly: a missing heading is an empty
    section, never an error — the readers all render "not available" for it.
    """
    path = fix_report_path(repo_root, work_item_id)
    if not path.exists():
        return None
    text = path.read_text(encoding="utf-8", errors="replace")
    return FixReport(
        text=text,
        summary=section_of(text, "## Summary"),
        analysis=section_of(text, "## Analysis"),
        changes=section_of(text, "## Changes"),
        tests=section_of(text, "## Tests"),
        review_notes=section_of(text, "## Review Notes"),
    )


def section_of(markdown: str, heading: str) -> str:
    """The body under a ``##`` heading, up to the next one. ``###`` stays inside.

    Matched with trailing whitespace and case forgiven: the report is written by
    a model, and ``## summary `` failing to parse would read as a missing
    section everywhere downstream — safe, but a sharp edge for no gain.
    """
    wanted = heading.strip().lower()
    lines = markdown.splitlines()
    start = next(
        (index + 1 for index, line in enumerate(lines) if line.strip().lower() == wanted),
        None,
    )
    if start is None:
        return ""
    collected: list[str] = []
    for line in lines[start:]:
        if line.startswith("## "):
            break
        collected.append(line)
    return "\n".join(collected).strip()


def manual_fix_report_template(work_item_id: str) -> str:
    """The report skeleton for a developer who fixed the bug by hand."""
    return (
        f"# Fix Report: {work_item_id}\n\n"
        "## Summary\n\n"
        "Developer manual fix. TODO: one line on what was done and the outcome.\n\n"
        "## Analysis\n\n"
        "TODO: the root cause and the evidence for it.\n\n"
        "## Changes\n\n"
        "TODO: what changed, the files touched, and a short diff summary.\n\n"
        "## Tests\n\n"
        "TODO: the commands run and their outcomes — or state that tests were "
        "not run, and why.\n\n"
        "## Review Notes\n\n"
        "TODO: risks, open questions, and the recommended next step.\n"
    )
