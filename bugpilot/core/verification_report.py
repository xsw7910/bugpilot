"""verification_report.md: recorded verification evidence (plan §19).

BugPilot cannot prove a fix correct. What it can keep is the evidence the
developer gathered: which checks, what each was recorded as — Passed, Failed or
Not Run — and how it was checked. A status is scoped to its one check and is
what the user recorded; BugPilot neither ran nor observed it, and all recorded
checks passing is not proof that no defect remains. The generated wording says
exactly that much and no more: never "verified", "correct" or "safe to merge".

The format is BugPilot's own and round-trips. Entered field text is stored as a
Markdown quote — every line prefixed ``> `` — so nothing typed can open a
heading, a check or a field of the report; a check name is one line. The writer
parses what it rendered before writing it, so a report it could not read back is
never written. The reader is tolerant for previews and strict for structure: a
report that is not in the canonical shape still gives its counts, but is not
turned into checks by guesswork.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from .artifact_io import atomic_write_text
from .artifacts import VERIFICATION_REPORT_ARTIFACT, WorkItemNotFoundError
from .config import issue_dir, writable_issue_dir
from .identity import validate_work_item_id

#: Recorded statuses, as stored in JSON and as written in the report.
STATUSES: dict[str, str] = {"passed": "Passed", "failed": "Failed", "not_run": "Not Run"}
#: Check types, the same way.
TYPES: dict[str, str] = {"automated": "Automated", "manual": "Manual", "other": "Other"}

MAX_CHECKS = 25
MAX_NAME_CHARS = 200
MAX_TEXT_CHARS = 20_000

NOT_RECORDED = "Not recorded."
SOURCE_LINE = "Verification evidence explicitly recorded by the user."

#: The one generated conclusion, from the counts alone — scoped to recorded checks.
ALL_PASSED = "All recorded checks passed."
INCLUDES_FAILURES = "Recorded checks include failures."
NONE_RUN = "No recorded check has been run."
MIXED = "Recorded checks have mixed or incomplete status."

_FIELDS: tuple[tuple[str, str], ...] = (
    ("procedure", "Command / Procedure:"),
    ("evidence", "Evidence:"),
    ("notes", "Notes:"),
)
_CHECK_HEADING = re.compile(r"^### Check (\d+): (.*)$")
_STATUS_LINE = re.compile(r"^Status: (.+)$")
_TYPE_LINE = re.compile(r"^Type: (.+)$")


class VerificationReportExistsError(FileExistsError):
    """Evidence is already recorded and ``replace`` was not asked for."""


@dataclass(frozen=True)
class VerificationCheck:
    name: str
    status: str
    type: str = "other"
    procedure: str = ""
    evidence: str = ""
    notes: str = ""


@dataclass(frozen=True)
class VerificationReport:
    """The report as it is on disk.

    ``checks`` is the structured list only when the file is in the canonical
    shape; ``None`` otherwise. The counts are read either way, from the status
    lines of the checks the file holds.
    """

    text: str
    checks: tuple[VerificationCheck, ...] | None
    passed: int
    failed: int
    not_run: int

    @property
    def total(self) -> int:
        return self.passed + self.failed + self.not_run


@dataclass(frozen=True)
class RecordedVerification:
    path: Path
    replaced: bool


def verification_report_path(repo_root: Path, work_item_id: str) -> Path:
    return issue_dir(repo_root, work_item_id) / VERIFICATION_REPORT_ARTIFACT


# --- validation and normalization ---------------------------------------------


def normalize_check(check: VerificationCheck, number: int) -> VerificationCheck:
    """A check as it will be stored, or ``ValueError`` saying which one and why."""
    name = " ".join(check.name.split())
    if not name:
        raise ValueError(f"Check {number}: a name is required.")
    if len(name) > MAX_NAME_CHARS:
        raise ValueError(f"Check {number}: the name is longer than {MAX_NAME_CHARS} characters.")
    if check.status not in STATUSES:
        raise ValueError(f"Check {number}: invalid recorded status {check.status!r} (passed, failed or not_run).")
    if check.type not in TYPES:
        raise ValueError(f"Check {number}: invalid type {check.type!r} (automated, manual or other).")
    fields = {}
    for key, label in _FIELDS:
        text = getattr(check, key)
        if len(text) > MAX_TEXT_CHARS:
            raise ValueError(f"Check {number}: {label[:-1]} is longer than {MAX_TEXT_CHARS} characters.")
        fields[key] = _normalized_text(text)
    return VerificationCheck(name=name, status=check.status, type=check.type, **fields)


def normalize_checks(checks: list[VerificationCheck] | tuple[VerificationCheck, ...]) -> tuple[VerificationCheck, ...]:
    if not checks:
        raise ValueError("At least one check is required.")
    if len(checks) > MAX_CHECKS:
        raise ValueError(f"At most {MAX_CHECKS} checks can be recorded in one report.")
    return tuple(normalize_check(check, number) for number, check in enumerate(checks, start=1))


def _normalized_text(text: str) -> str:
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    return "\n".join(line.rstrip() for line in lines).strip("\n")


# --- the generated wording ------------------------------------------------------


def _counts(checks) -> tuple[int, int, int]:
    return (
        sum(check.status == "passed" for check in checks),
        sum(check.status == "failed" for check in checks),
        sum(check.status == "not_run" for check in checks),
    )


def _overall(passed: int, failed: int, not_run: int) -> str:
    if failed:
        return INCLUDES_FAILURES
    if passed and not not_run:
        return ALL_PASSED
    if not_run and not passed:
        return NONE_RUN
    return MIXED


def summary_line(passed: int, failed: int, not_run: int) -> str:
    total = passed + failed + not_run
    parts = [f"{count} {word}" for count, word in ((passed, "passed"), (failed, "failed"), (not_run, "not run")) if count]
    return f"{total} check{'' if total == 1 else 's'} recorded: {', '.join(parts)}."


# --- rendering and parsing ------------------------------------------------------


def render_verification_report(work_item_id: str, checks: tuple[VerificationCheck, ...]) -> str:
    """The report text for already normalized checks."""
    passed, failed, not_run = _counts(checks)
    parts = [f"# Verification Report: {work_item_id}", "", "## Summary", "", summary_line(passed, failed, not_run), "",
             "## Checks", ""]
    for number, check in enumerate(checks, start=1):
        parts += [f"### Check {number}: {check.name}", "",
                  f"Status: {STATUSES[check.status]}", f"Type: {TYPES[check.type]}", ""]
        for key, label in _FIELDS:
            parts += [label, "", _quoted(getattr(check, key)), ""]
    parts += ["## Overall Recorded Status", "", _overall(passed, failed, not_run), "",
              "## Source", "", SOURCE_LINE, ""]
    return "\n".join(parts)


def _quoted(text: str) -> str:
    if not text:
        return NOT_RECORDED
    return "\n".join(f"> {line}" if line else ">" for line in text.split("\n"))


def parse_verification_report(text: str) -> VerificationReport:
    """Counts always; the structured checks only when the shape is canonical."""
    lines = text.replace("\r\n", "\n").replace("\r", "\n").split("\n")
    checks_block = _section_lines(lines, "## Checks")
    passed = failed = not_run = 0
    for line in checks_block:
        match = _STATUS_LINE.match(line)
        if match:
            status = {label: key for key, label in STATUSES.items()}.get(match.group(1).strip())
            passed += status == "passed"
            failed += status == "failed"
            not_run += status == "not_run"
    return VerificationReport(
        text=text,
        checks=_strict_checks(checks_block),
        passed=passed,
        failed=failed,
        not_run=not_run,
    )


def _section_lines(lines: list[str], heading: str) -> list[str]:
    start = next((index + 1 for index, line in enumerate(lines) if line.strip() == heading), None)
    if start is None:
        return []
    block: list[str] = []
    for line in lines[start:]:
        if line.startswith("## "):
            break
        block.append(line)
    return block


def _strict_checks(block: list[str]) -> tuple[VerificationCheck, ...] | None:
    """The checks, if the block is exactly what the writer produces; else ``None``."""
    status_of = {label: key for key, label in STATUSES.items()}
    type_of = {label: key for key, label in TYPES.items()}
    position = 0

    def skip_blank() -> None:
        nonlocal position
        while position < len(block) and block[position] == "":
            position += 1

    checks: list[VerificationCheck] = []
    skip_blank()
    while position < len(block):
        heading = _CHECK_HEADING.match(block[position])
        if not heading or int(heading.group(1)) != len(checks) + 1:
            return None
        position += 1
        skip_blank()
        status = _STATUS_LINE.match(block[position]) if position < len(block) else None
        if not status or status.group(1) not in status_of:
            return None
        position += 1
        kind = _TYPE_LINE.match(block[position]) if position < len(block) else None
        if not kind or kind.group(1) not in type_of:
            return None
        position += 1
        fields: dict[str, str] = {}
        for key, label in _FIELDS:
            skip_blank()
            if position >= len(block) or block[position] != label:
                return None
            position += 1
            skip_blank()
            if position < len(block) and block[position] == NOT_RECORDED:
                fields[key] = ""
                position += 1
                continue
            quoted: list[str] = []
            while position < len(block) and block[position].startswith(">"):
                line = block[position]
                quoted.append(line[2:] if line.startswith("> ") else line[1:])
                position += 1
            if not quoted:
                return None
            fields[key] = "\n".join(quoted)
        checks.append(VerificationCheck(heading.group(2), status_of[status.group(1)], type_of[kind.group(1)], **fields))
        skip_blank()
    return tuple(checks) if checks else None


# --- writing and reading --------------------------------------------------------


def record_verification(
    repo_root: Path,
    work_item_id: str,
    checks: list[VerificationCheck] | tuple[VerificationCheck, ...],
    *,
    replace: bool = False,
) -> RecordedVerification:
    """Write ``verification_report.md`` for a prepared work item.

    Refuses rather than guesses; touches nothing else — no ``run.json`` mark, no
    Jira, no email, no memory. Runs nothing: every status is the user's.
    """
    validate_work_item_id(work_item_id)
    # Checked for links before the report is written.
    target = writable_issue_dir(repo_root, work_item_id, create=False)
    if not target.is_dir():
        raise WorkItemNotFoundError(f"Work item not found: .ai/{work_item_id}/")
    normalized = normalize_checks(checks)
    text = render_verification_report(work_item_id, normalized)
    # The format must read back as exactly what was entered, or it is not written.
    if parse_verification_report(text).checks != normalized:
        raise ValueError("The verification report could not be rendered in a form that reads back unchanged.")
    path = target / VERIFICATION_REPORT_ARTIFACT
    existed = path.exists()
    if existed and not replace:
        raise VerificationReportExistsError(
            f"Verification evidence is already recorded in .ai/{work_item_id}/{VERIFICATION_REPORT_ARTIFACT}. "
            "It was kept; pass --replace to overwrite it."
        )
    atomic_write_text(path, text)
    return RecordedVerification(path=path, replaced=existed)


def read_verification_report(repo_root: Path, work_item_id: str) -> VerificationReport | None:
    path = verification_report_path(repo_root, work_item_id)
    if not path.exists():
        return None
    return parse_verification_report(path.read_text(encoding="utf-8", errors="replace"))
