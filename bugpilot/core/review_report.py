"""review_report.md: the recorded result of a review (plan §19).

Review with AI opens a terminal and stops there. Nothing comes back from the
reviewer, so BugPilot never knows that a review finished, let alone what it
concluded. This file is how it learns: somebody who read the review records its
result, and ``bugpilot record-review`` writes it here.

Its existence means exactly that a review result was recorded — not that the
review passed, that the fix is right, that tests ran, or that anything the
review recommended was done. The format has no verdict field, and the reader
does not look for one.

One writer, this module, reached through ``record-review``; one reader, for the
bounded previews. The report is otherwise the developer's: they may edit it by
hand, and nothing here rewrites it except an explicit ``--replace``.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from .artifact_io import atomic_write_text
from .artifacts import REVIEW_REPORT_ARTIFACT, WorkItemNotFoundError
from .config import issue_dir, writable_issue_dir
from .fix_report import section_of
from .identity import validate_work_item_id

# The recorded sections, in the order they are written. `## Source` follows them
# and is BugPilot's own line, not something the developer enters.
REVIEW_SECTIONS: tuple[tuple[str, str], ...] = (
    ("summary", "## Summary"),
    ("findings", "## Findings"),
    ("validation_notes", "## Validation Notes"),
    ("recommendations", "## Recommendations"),
)
SOURCE_HEADING = "## Source"
# "External review", not "AI review": the reviewer may be a person, another
# tool, or a session outside BugPilot, and BugPilot cannot tell which.
SOURCE_LINE = "Recorded from an external review."
# What an empty section says, so every heading is always written.
NOT_RECORDED = "Not recorded."
# Far above a real review, low enough that a runaway paste is refused rather
# than written.
MAX_SECTION_CHARS = 50_000

# A line that would open a new top-level or report-level section — up to three
# spaces in, as Markdown and the tolerant reader both allow. Demoted so the
# report's own sections stay the only ones: a reviewer's "## Critical" belongs
# inside Findings, not beside it. Code fences are left as they are: a `# comment`
# in a shell snippet is code, not a heading.
_SECTION_BREAKING = re.compile(r"^( {0,3})#{1,2}([ \t])")
_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")


class ReviewReportExistsError(FileExistsError):
    """A review result is already recorded and ``replace`` was not asked for."""


@dataclass(frozen=True)
class ReviewInput:
    """What the developer entered. A blank section is one not recorded."""

    summary: str = ""
    findings: str = ""
    validation_notes: str = ""
    recommendations: str = ""

    def sections(self) -> dict[str, str]:
        return {key: getattr(self, key) for key, _heading in REVIEW_SECTIONS}


@dataclass(frozen=True)
class ReviewReport:
    """The report as it is on disk, and its sections. Empty for one not recorded."""

    text: str
    summary: str
    findings: str
    validation_notes: str
    recommendations: str


@dataclass(frozen=True)
class RecordedReview:
    path: Path
    replaced: bool


def review_report_path(repo_root: Path, work_item_id: str) -> Path:
    return issue_dir(repo_root, work_item_id) / REVIEW_REPORT_ARTIFACT


def render_review_report(work_item_id: str, review: ReviewInput) -> str:
    """The report text: every heading, the entered text as entered, nothing inferred."""
    parts = [f"# Review Report: {work_item_id}", ""]
    for key, heading in REVIEW_SECTIONS:
        body = _normalized(review.sections()[key])
        parts += [heading, "", body or NOT_RECORDED, ""]
    parts += [SOURCE_HEADING, "", SOURCE_LINE, ""]
    return "\n".join(parts)


def record_review(
    repo_root: Path,
    work_item_id: str,
    review: ReviewInput,
    *,
    replace: bool = False,
) -> RecordedReview:
    """Write ``review_report.md`` for a prepared work item.

    Refuses rather than guesses: an id that is not one, a work item that was
    never prepared (the folder is not created here), nothing entered, a section
    past the size cap, and — unless ``replace`` — a report already recorded.
    Touches nothing else: no ``run.json`` mark, no Jira, no email, no memory.
    """
    validate_work_item_id(work_item_id)
    # Checked for links before the report is written.
    target = writable_issue_dir(repo_root, work_item_id, create=False)
    if not target.is_dir():
        raise WorkItemNotFoundError(f"Work item not found: .ai/{work_item_id}/")
    sections = review.sections()
    for key, heading in REVIEW_SECTIONS:
        if len(sections[key]) > MAX_SECTION_CHARS:
            raise ValueError(f"{heading[3:]} is longer than {MAX_SECTION_CHARS} characters.")
    if not any(_normalized(text) for text in sections.values()):
        raise ValueError("Nothing to record: enter at least one of Summary, Findings, Validation Notes or Recommendations.")
    path = target / REVIEW_REPORT_ARTIFACT
    existed = path.exists()
    if existed and not replace:
        raise ReviewReportExistsError(
            f"A review result is already recorded in .ai/{work_item_id}/{REVIEW_REPORT_ARTIFACT}. "
            "It was kept; pass --replace to overwrite it."
        )
    atomic_write_text(path, render_review_report(work_item_id, review))
    return RecordedReview(path=path, replaced=existed)


def read_review_report(repo_root: Path, work_item_id: str) -> ReviewReport | None:
    """The recorded review, or ``None`` when none has been recorded.

    Read tolerantly, the way ``fix_report.md`` is: the developer may have edited
    it, so a missing heading is an empty section and ``Not recorded.`` is one
    too. Never a verdict — the sections are returned as text.
    """
    path = review_report_path(repo_root, work_item_id)
    if not path.exists():
        return None
    text = path.read_text(encoding="utf-8", errors="replace")
    body = {key: _recorded(section_of(text, heading)) for key, heading in REVIEW_SECTIONS}
    return ReviewReport(text=text, **body)


def _normalized(text: str) -> str:
    """Entered text with its line endings unified and its section breaks demoted."""
    unified = text.replace("\r\n", "\n").replace("\r", "\n").strip()
    lines: list[str] = []
    in_fence = False
    for line in unified.split("\n"):
        if _FENCE.match(line):
            in_fence = not in_fence
        elif not in_fence:
            line = _SECTION_BREAKING.sub(lambda match: match.group(1) + "###" + match.group(2), line)
        lines.append(line)
    return "\n".join(lines)


def _recorded(section: str) -> str:
    return "" if section.strip() == NOT_RECORDED else section
