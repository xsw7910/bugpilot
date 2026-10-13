"""The Effective Context: the context BugPilot last generated, and whether it is still current (0.1.4).

``bugpilot context-preview WORK_ITEM_ID`` shows the ``context.md`` the work
item was prepared with — the file an agent was handed beside its task — and
never runs retrieval to make a new one: a context is only "effective" when
retrieval produced it (plan §27). Stale, it is still shown, marked as needing
a rebuild, with the reasons.

What it can tell, and how:

- **Task inputs changed since preparing** — the instructions, the Verification
  Policy, AI Behavior, the Repository Profile, the Fix Mode, branch naming, the
  work item's guidance, BugPilot's own wording. Read from the Effective AI
  Task's comparison of the prepared ``task.md`` with the task BugPilot would
  write now (``task_preview``), each changed section named by its class: one
  comparison, not a second staleness model.
- **The prepared package itself** — ``context.md``, ``retrieval.json``,
  ``task.md`` and ``run.json`` present and readable, and the last run's
  context step passed.

What it cannot, and says so: the retrieval inputs as the panel holds them
now (keywords, the hint as typed, Code Search, Git History and Similar Fixes
settings), which the panel compares itself; and the issue in Jira since it was
fetched, which would take a fetch. Context Quality and Search Confidence are
the stored ones, read back, never recomputed.

Reading only: no search, no Git, no Jira, no process, no file written.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from .artifacts import (
    ARTIFACT_SCHEMA_VERSION,
    CONTEXT_ARTIFACT,
    ISSUE_ARTIFACT,
    RETRIEVAL_ARTIFACT,
    RUN_ARTIFACT,
    TASK_ARTIFACT,
)
from .config import issue_dir
from .context import CONTEXT_FORMAT, ContextQuality, read_context_quality
from .fix_modes import FixModeError
from .identity import validate_work_item_id
from .issue import IssueArtifact, IssueArtifactError, load_issue
from .prompts import TASK_SECTION_CLASSES
from .retrieval import CONFIDENCE_DETAILS_VERSION, RetrievalArtifact, RetrievalArtifactError, load_retrieval
from .run import RunArtifact, RunArtifactError, load_run
from .safe_paths import is_link_or_junction
from .task_preview import PreparedTask, TaskPreviewError, preview_work_item, read_work_item_text

STATE_UNAVAILABLE = "unavailable"
STATE_NOT_GENERATED = "not-generated"
STATE_MISSING = "missing"
STATE_UNREADABLE = "unreadable"
STATE_CURRENT = "current"
STATE_STALE = "stale"
STATE_UNKNOWN = "unknown"

NO_CONTEXT = "No generated context available. Build context first."

#: Said of a context whose run record has no format marker, or an older one (S7). A note, not a reason: it asks
#: for no rebuild, and the context is shown as stored.
EARLIER_FORMAT_WARNING = (
    "This context was prepared before BugPilot quoted evidence in fenced blocks (0.1.5): text from the issue "
    "and the repository is not set apart in it. Rebuilding the context writes it the new way; nothing else "
    "requires a rebuild."
)

#: What a reader is told for each state.
_LABELS = {
    STATE_UNAVAILABLE: NO_CONTEXT,
    STATE_NOT_GENERATED: NO_CONTEXT,
    STATE_MISSING: "Context status: Missing — the generated context is gone. Build context again.",
    STATE_UNREADABLE: "Context status: Unreadable — the generated context could not be read.",
    STATE_CURRENT: "Context status: Current",
    STATE_STALE: "Context status: Needs rebuild",
    STATE_UNKNOWN: "Context status: Unknown — whether it is current could not be checked.",
}

#: The task section classes (`prompts.TASK_SECTION_CLASSES`), as what changed.
_CLASS_REASONS = {
    "project-instructions": ("project_instructions_changed", "Project Instructions"),
    "user-instructions": ("user_instructions_changed", "User Instructions"),
    "verification-policy": ("verification_changed", "Verification Policy"),
    "ai-behavior": ("ai_behavior_changed", "AI Behavior"),
    "generated-evidence": ("repository_profile_changed", "Repository Profile"),
    "fix-mode": ("fix_mode_changed", "Fix Mode"),
    "developer-hint": ("work_item_changed", "Work item guidance"),
}
#: Protected sections whose text follows a setting rather than BugPilot's wording.
_SECTION_REASONS = {
    "Branch Instructions": ("branch_changed", "Branch policy or naming"),
    "Report Status to Jira": ("work_item_changed", "Work item guidance"),
    "Report Status to Jira (before commit)": ("work_item_changed", "Work item guidance"),
}
_BUGPILOT_WORDING = ("bugpilot_task_changed", "BugPilot's own task sections (for example, after a BugPilot update)")
_OUTSIDE_SECTIONS = ("task_changed_outside_sections", f"{TASK_ARTIFACT} outside its sections (its title, or their order)")

#: What this command does not check, and who does.
UNCHECKED: tuple[tuple[str, str], ...] = (
    (
        "retrieval_inputs",
        "Retrieval inputs as the panel holds them (keywords, the hint as typed, Code Search, Git History and "
        "Similar Fixes settings): the panel compares those itself.",
    ),
    ("issue_source", "The issue in Jira since it was fetched: not fetched again."),
)


class ContextPreviewError(ValueError):
    """A request that cannot be answered, in one sentence naming no absolute path."""

    def __init__(self, message: str, code: str = "INVALID_INPUT") -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class Reason:
    code: str
    label: str


@dataclass(frozen=True)
class ContextPreview:
    state: str
    work_item: str | None
    text: str | None = None
    reasons: tuple[Reason, ...] = ()
    #: What could not be read or checked, in a sentence each. Problems, not reasons: a reason is a change.
    problems: tuple[str, ...] = ()
    warnings: tuple[str, ...] = ()
    issue: IssueArtifact | None = None
    retrieval: RetrievalArtifact | None = None
    run: RunArtifact | None = None
    quality: ContextQuality | None = None
    task: PreparedTask | None = None
    artifacts: dict[str, bool] = field(default_factory=dict)

    @property
    def label(self) -> str:
        return _LABELS[self.state]

    @property
    def current(self) -> bool | None:
        """True, False, or None when the context is not there to judge or could not be checked."""
        if self.state == STATE_CURRENT:
            return True
        if self.state == STATE_STALE:
            return False
        return None


def preview_context(repo_root: Path, work_item_id: str | None) -> ContextPreview:
    """The last generated context of a work item, and its status. Reads; never writes, searches or fetches."""
    if not work_item_id:
        return ContextPreview(state=STATE_UNAVAILABLE, work_item=None)
    try:
        validate_work_item_id(work_item_id)
    except ValueError as exc:
        raise ContextPreviewError(str(exc)) from exc

    folder = issue_dir(repo_root, work_item_id)
    if is_link_or_junction(repo_root / ".ai") or is_link_or_junction(folder):
        return ContextPreview(
            state=STATE_UNREADABLE,
            work_item=work_item_id,
            problems=(f".ai/{work_item_id} is behind a link or junction, so nothing in it was read.",),
        )
    if not folder.is_dir():
        return ContextPreview(state=STATE_NOT_GENERATED, work_item=work_item_id)

    problems: list[str] = []
    warnings: list[str] = []
    issue = _quietly(lambda: load_issue(repo_root, work_item_id), IssueArtifactError, problems)
    run = _quietly(lambda: load_run(repo_root, work_item_id), RunArtifactError, problems)
    retrieval = _quietly(lambda: load_retrieval(repo_root, work_item_id), RetrievalArtifactError, problems)
    artifacts = {
        "issue": (folder / ISSUE_ARTIFACT).is_file(),
        "context": (folder / CONTEXT_ARTIFACT).is_file(),
        "retrieval": (folder / RETRIEVAL_ARTIFACT).is_file(),
        "task": (folder / TASK_ARTIFACT).is_file(),
        "run": (folder / RUN_ARTIFACT).is_file(),
    }
    context_step = run.steps.get("context") if run is not None else None

    exists, text, problem = read_work_item_text(repo_root, work_item_id, CONTEXT_ARTIFACT)
    common = {"work_item": work_item_id, "issue": issue, "run": run, "retrieval": retrieval, "artifacts": artifacts}
    if not exists:
        # Generated once — by the run's record or the task beside it — and gone since; or never.
        prepared_before = context_step == "pass" or artifacts["task"]
        state = STATE_MISSING if prepared_before else STATE_NOT_GENERATED
        return ContextPreview(state=state, problems=tuple(problems), **common)
    if text is None:
        return ContextPreview(state=STATE_UNREADABLE, problems=(*problems, problem or ""), **common)

    quality = read_context_quality(text)
    if quality is None:
        warnings.append(f"The Context Quality section of .ai/{work_item_id}/{CONTEXT_ARTIFACT} could not be read.")
    # Only from a run record that says: without one there is nothing to go on, and nothing is guessed.
    if run is not None and (run.context_format or 0) < CONTEXT_FORMAT:
        warnings.append(EARLIER_FORMAT_WARNING)
    reasons: list[Reason] = []

    # The prepared package, as the run left it.
    if run is not None and context_step != "pass":
        reasons.append(Reason("context_step_not_passed", f"The last run's context step: {context_step or 'not run'}"))
    if retrieval is None and artifacts["retrieval"]:
        reasons.append(Reason("retrieval_unreadable", f"{RETRIEVAL_ARTIFACT} cannot be read"))
    elif not artifacts["retrieval"] and run is not None and run.steps.get("code_search") == "pass":
        reasons.append(Reason("retrieval_missing", f"{RETRIEVAL_ARTIFACT} is missing"))

    # The task inputs, compared through the Effective AI Task.
    task: PreparedTask | None = None
    try:
        task = preview_work_item(repo_root, work_item_id).prepared
    except (TaskPreviewError, FixModeError, IssueArtifactError) as exc:
        problems.append(f"Whether the task inputs changed could not be checked: {exc}")
    if task is not None:
        if not task.task_exists:
            reasons.append(Reason("task_missing", f"{TASK_ARTIFACT} is missing"))
        elif task.problem:
            problems.append(task.problem)
        elif task.changed_sections:
            reasons.extend(_section_reasons(task.changed_sections))
        elif not task.task_current:
            # Not the same text, yet no section's body differs: the title, or the sections' order.
            reasons.append(Reason(*_OUTSIDE_SECTIONS))

    unique = tuple(dict.fromkeys(reasons))
    if unique:
        state = STATE_STALE
    elif problems or task is None or task.problem:
        state = STATE_UNKNOWN
    else:
        state = STATE_CURRENT
    return ContextPreview(
        state=state,
        text=text,
        reasons=unique,
        problems=tuple(dict.fromkeys(problems)),
        warnings=tuple(warnings),
        quality=quality,
        task=task,
        **common,
    )


def _quietly(load, error: type[Exception], problems: list[str]):
    try:
        return load()
    except error as exc:
        problems.append(str(exc))
        return None


def _section_reasons(sections: tuple[str, ...]) -> list[Reason]:
    """What changed, for each task section that differs: its class, or a setting, or BugPilot's wording."""
    reasons = []
    for heading in sections:
        kind = TASK_SECTION_CLASSES.get(heading)
        code, label = _CLASS_REASONS.get(kind or "") or _SECTION_REASONS.get(heading) or _BUGPILOT_WORDING
        reasons.append(Reason(code, label))
    return reasons


# --- the JSON -------------------------------------------------------------------------------


def _quality(quality: ContextQuality | None) -> dict[str, object] | None:
    if quality is None:
        return None
    return {
        "overall": quality.overall,
        "issue_completeness": quality.issue_completeness,
        "retrieval_quality": quality.retrieval_quality,
        "repository_context": quality.repository_context,
        "cap": quality.cap,
    }


def _retrieval(retrieval: RetrievalArtifact | None) -> dict[str, object] | None:
    if retrieval is None:
        return None
    history = retrieval.git_history
    return {
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "confidence": retrieval.confidence,
        # Search Confidence v2's own record, when the file has one (written by 0.1.3 or later).
        "confidence_version": CONFIDENCE_DETAILS_VERSION if retrieval.confidence_details else None,
        "reason_codes": list(retrieval.confidence_details.reasons) if retrieval.confidence_details else [],
        "reasons": list(retrieval.reasons),
        "related_files": len(retrieval.related_files),
        "terms": len(retrieval.terms),
        "git_history": None if history is None else {"status": history.status, "commits": len(history.commits)},
    }


def _sources(preview: ContextPreview) -> dict[str, object] | None:
    """Where the context's evidence came from, in counts and states — the text says the rest."""
    if preview.text is None:
        return None
    issue = preview.issue
    signals = preview.quality.signals if preview.quality is not None else ()
    guidance = issue.guidance if issue is not None else None
    return {
        "issue": None if issue is None else {"source": issue.source, "mock": issue.details.mock},
        "hint": None if guidance is None else bool(guidance.hint and guidance.hint.strip()),
        "attachments": None if guidance is None else len(guidance.attachment_files or ()),
        "fix_mode": None if guidance is None or guidance.fix_mode is None else {
            "id": guidance.fix_mode.get("id"), "name": guidance.fix_mode.get("name"),
        },
        "code_search": preview.retrieval is not None,
        "git_history": preview.retrieval.git_history.status
        if preview.retrieval is not None and preview.retrieval.git_history is not None
        else None,
        "similar_fixes": None if not signals else "Memory search results found: yes" in signals,
    }


def context_preview_payload(preview: ContextPreview) -> dict[str, object]:
    """``bugpilot context-preview --json``: the stored context, its status, and what it was built from."""
    task = preview.task
    run = preview.run
    return {
        "work_item": preview.work_item,
        "state": preview.state,
        "label": preview.label,
        "text": preview.text,
        "generated": {
            "artifacts": dict(preview.artifacts),
            "run_status": run.status if run is not None else None,
            "context_step": run.steps.get("context") if run is not None else None,
            # S7: the format the stored context was written in, by its run record; null when the record does
            # not say (before 0.1.5) or there is no record. `context_format_current` is what this CLI writes.
            "context_format": run.context_format if run is not None else None,
            "context_format_current": CONTEXT_FORMAT,
        },
        "freshness": {
            "current": preview.current,
            "reasons": [{"code": reason.code, "label": reason.label} for reason in preview.reasons],
            "checked": ["task_inputs", "artifacts"] if preview.text is not None else [],
            "unchecked": [{"code": code, "label": label} for code, label in UNCHECKED],
        },
        "task": None if task is None else {
            "exists": task.task_exists,
            "current": task.task_current,
            "changed_sections": list(task.changed_sections),
        },
        "quality": _quality(preview.quality),
        "retrieval": _retrieval(preview.retrieval),
        "sources": _sources(preview),
        "problems": list(preview.problems),
    }
