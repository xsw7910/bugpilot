"""The Effective AI Task: what BugPilot would tell an agent, shown and never written (0.1.4).

``bugpilot task-preview`` renders the task through the same path a run uses —
:class:`workflow.TaskInputs` and its ``render()``, which is ``generate_task`` —
so the preview is the task, never a description of it. Two kinds:

- **A work item's** (``bugpilot task-preview JR-12345``): exactly what
  regenerating its ``task.md`` would write now — its recorded guidance (hint,
  Fix Mode, attachments, branch policy and branch, the Jira comment opt-in)
  with every layer read again at this moment: the protected rules, the
  Repository Profile, User and Project Instructions, the Verification Policy
  and AI Behavior. A policy edited since the work item was prepared is in the
  preview; whether the prepared ``task.md`` still says the same is reported
  beside it, by comparing the two texts — not by a second staleness model.
- **A template** (no work item): the same task with obvious placeholders for
  what only a work item has — its id, a hint, attached files, its branch name.
  Every other layer is the repository's and the user's own, as a run would
  read them. Nothing about an issue is made up.

Reading only. It writes nothing — no ``.ai/`` folder, no ``issue.json``
(where writing a task records a branch name, a preview does not), no policy
file — talks to no Jira and runs no Git command. Policy texts reach the
preview only as the task carries them; the metadata says where each came from,
never what it says.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from .ai_behavior import DEFAULT_AI_BEHAVIOR_VERSION, resolve_ai_behavior
from .artifacts import CONTEXT_ARTIFACT, TASK_ARTIFACT
from .branch_policy import resolve_branch_policy
from .config import issue_dir
from .fix_mode_state import select_fix_mode
from .identity import validate_work_item_id
from .instructions import InstructionFile, code_fence, load_instructions
from .issue import load_issue
from .project_settings import ResolvedProjectSettings, resolve_project_settings
from .prompts import TASK_SECTION_CLASSES
from .protected_rules import PROTECTED_RULES_VERSION
from .repository_profile import resolve_repository_context
from .safe_paths import is_link_or_junction
from .verification import DEFAULT_POLICY_VERSION
from .workflow import TaskInputs, work_item_task_inputs

KIND_WORK_ITEM = "active-work-item"
KIND_TEMPLATE = "template"

TEMPLATE_LABEL = "Template preview — no work item selected"

#: What stands in for what only a work item has. Angle brackets, so none of
#: them can be read as an id, a path or a fact.
WORK_ITEM_PLACEHOLDER = "<work-item-id>"
TITLE_SLUG_PLACEHOLDER = "<title-slug>"
HINT_PLACEHOLDER = "<developer hint, when the work item has one>"
ATTACHMENT_PLACEHOLDER = "<attached file>"
ATTACHMENT_NOTE_PLACEHOLDER = "<the developer's note on the file, when there is one>"
PLACEHOLDERS: tuple[str, ...] = (
    WORK_ITEM_PLACEHOLDER,
    TITLE_SLUG_PLACEHOLDER,
    HINT_PLACEHOLDER,
    ATTACHMENT_PLACEHOLDER,
    ATTACHMENT_NOTE_PLACEHOLDER,
)

#: The default name a work item's branch gets without a template (`git_ops.branch_name`).
_DEFAULT_BRANCH_TEMPLATE = "feature/{issue}-{slug}"


class TaskPreviewError(ValueError):
    """A preview that cannot be made, in one sentence naming no absolute path."""

    def __init__(self, message: str, code: str = "INVALID_INPUT") -> None:
        super().__init__(message)
        self.code = code


@dataclass(frozen=True)
class PreparedTask:
    """What the work item's prepared files say beside the preview: present, and the same or not."""

    task_exists: bool
    context_exists: bool
    #: The prepared ``task.md`` says exactly what the preview says.
    task_current: bool
    #: The ``## `` sections whose text differs, in the preview's order, then any only the old file has.
    changed_sections: tuple[str, ...] = ()
    #: Why the prepared task was not compared, when it was not.
    problem: str | None = None


@dataclass(frozen=True)
class TaskPreview:
    kind: str
    work_item: str | None
    inputs: TaskInputs
    text: str
    #: Where the Fix Mode came from: explicit, persisted or default (`fix_mode_state.SelectionOrigin`).
    fix_mode_origin: str
    warnings: tuple[str, ...]
    prepared: PreparedTask | None = None

    @property
    def label(self) -> str:
        return TEMPLATE_LABEL if self.kind == KIND_TEMPLATE else f"Effective AI task for {self.work_item}"


# --- the two kinds --------------------------------------------------------------------------


def preview_work_item(repo_root: Path, work_item_id: str) -> TaskPreview:
    """The task a prepared work item would be handed now. Reads; never writes."""
    try:
        validate_work_item_id(work_item_id)
    except ValueError as exc:
        raise TaskPreviewError(str(exc)) from exc
    issue = load_issue(repo_root, work_item_id)
    if issue is None:
        raise TaskPreviewError(
            f"There is no prepared work item {work_item_id} here (.ai/{work_item_id}/issue.json). "
            "Prepare it first, or run `bugpilot task-preview` without an id for the template.",
            code="WORK_ITEM_NOT_FOUND",
        )
    selection = select_fix_mode(repo_root, work_item_id)
    layers = _layers(repo_root)
    inputs = work_item_task_inputs(repo_root, work_item_id, issue, fix_mode=selection.mode, **layers)
    text = inputs.render()
    return TaskPreview(
        kind=KIND_WORK_ITEM,
        work_item=work_item_id,
        inputs=inputs,
        text=text,
        fix_mode_origin=selection.origin,
        warnings=tuple(selection.warnings) + _layer_warnings(inputs),
        prepared=_prepared(repo_root, work_item_id, text),
    )


def preview_template(
    repo_root: Path,
    fix_mode_id: str | None = None,
    branch_policy: str | None = None,
    jira_comment: bool = False,
) -> TaskPreview:
    """The task before any work item: placeholders for what only one has. Reads; never writes.

    The Fix Mode, branch policy and Jira comment are the run's settings, taken
    as `bug` takes them and defaulted the same way.
    """
    # Nothing persisted is read for a template: an explicit id, else the default.
    selection = select_fix_mode(repo_root, WORK_ITEM_PLACEHOLDER, fix_mode_id, use_persisted=False)
    layers = _layers(repo_root)
    settings: ResolvedProjectSettings = layers["project_settings"]  # type: ignore[assignment]
    template = settings.settings.branch_template or _DEFAULT_BRANCH_TEMPLATE
    inputs = TaskInputs(
        issue_key=WORK_ITEM_PLACEHOLDER,
        summary=None,
        hint=HINT_PLACEHOLDER,
        jira_comment=jira_comment,
        attachments=(ATTACHMENT_PLACEHOLDER,),
        attachment_notes={ATTACHMENT_PLACEHOLDER: ATTACHMENT_NOTE_PLACEHOLDER},
        fix_mode=selection.mode,
        branch_policy=resolve_branch_policy(branch_policy, None),
        branch=template.replace("{issue}", WORK_ITEM_PLACEHOLDER).replace("{slug}", TITLE_SLUG_PLACEHOLDER),
        **layers,  # type: ignore[arg-type]
    )
    return TaskPreview(
        kind=KIND_TEMPLATE,
        work_item=None,
        inputs=inputs,
        text=inputs.render(),
        fix_mode_origin=selection.origin,
        warnings=_layer_warnings(inputs),
    )


def _layers(repo_root: Path) -> dict[str, object]:
    """Every layer read now, exactly as a run reads it — and logged nowhere."""
    return {
        "repository": resolve_repository_context(repo_root),
        "instructions": load_instructions(repo_root),
        "project_settings": resolve_project_settings(repo_root),
        "ai_behavior": resolve_ai_behavior(repo_root),
    }


def _layer_warnings(inputs: TaskInputs) -> tuple[str, ...]:
    """What a run would warn about these layers, in the run's order."""
    return (
        tuple(inputs.repository.warnings)
        + tuple(inputs.instructions.warnings)
        + tuple(inputs.project_settings.warnings)
        + tuple(inputs.project_settings.effective_verification.warnings)
        + tuple(inputs.ai_behavior.warnings)
    )


# --- the prepared files, beside it ----------------------------------------------------------


def read_work_item_text(repo_root: Path, work_item_id: str, name: str) -> tuple[bool, str | None, str | None]:
    """``(exists, text, problem)`` for a generated text file in ``.ai/<id>/``, read for showing only.

    Never through a link or junction — at ``.ai``, the work item's folder or
    the file — and only as UTF-8; CRLF reads as LF. Writes nothing.
    """
    folder = issue_dir(repo_root, work_item_id)
    path = folder / name
    if not path.exists() and not is_link_or_junction(path):
        return False, None, None
    if any(is_link_or_junction(item) for item in (repo_root / ".ai", folder, path)):
        return True, None, f".ai/{work_item_id}/{name} is behind a link or junction, so it was not read."
    try:
        return True, path.read_bytes().decode("utf-8").replace("\r\n", "\n"), None
    except (OSError, UnicodeDecodeError):
        return True, None, f".ai/{work_item_id}/{name} could not be read as UTF-8 text."


def _prepared(repo_root: Path, work_item_id: str, text: str) -> PreparedTask:
    folder = issue_dir(repo_root, work_item_id)
    context_exists = (folder / CONTEXT_ARTIFACT).is_file()
    task_exists, prepared, problem = read_work_item_text(repo_root, work_item_id, TASK_ARTIFACT)
    if not task_exists:
        return PreparedTask(task_exists=False, context_exists=context_exists, task_current=False)
    if prepared is None:
        return PreparedTask(task_exists=True, context_exists=context_exists, task_current=False, problem=problem)
    if prepared == text:
        return PreparedTask(task_exists=True, context_exists=context_exists, task_current=True)
    return PreparedTask(
        task_exists=True,
        context_exists=context_exists,
        task_current=False,
        changed_sections=_changed_sections(prepared, text),
    )


def _heading_lines(lines: list[str]) -> list[int]:
    """Where the task's own ``## `` sections start: never a line inside a code fence.

    An editable layer's headings are demoted, but a fenced line is left as
    written — so a ``## BugPilot Safety Rules`` inside a fence in AI Behavior
    reaches ``task.md`` at column 0 and is not a section of the task. Only a
    closed fence hides its lines: every layer's text has its fences closed, and
    one that never closes must not hide BugPilot's sections after it.
    """
    fenced: set[int] = set()
    fence: str | None = None
    opened = 0
    for index, line in enumerate(lines):
        mark = code_fence(line)
        if fence is None:
            if mark:
                fence, opened = mark, index
        elif mark and mark[0] == fence[0] and len(mark) >= len(fence) and line.strip() == mark:
            fenced.update(range(opened, index + 1))
            fence = None
    return [index for index, line in enumerate(lines) if line.startswith("## ") and index not in fenced]


def _section_map(text: str) -> dict[str, str]:
    lines = text.split("\n")
    starts = _heading_lines(lines)
    ends = [*starts[1:], len(lines)]
    return {lines[start][3:]: "\n".join(lines[start + 1 : end]) for start, end in zip(starts, ends)}


def _changed_sections(prepared: str, now: str) -> tuple[str, ...]:
    before, after = _section_map(prepared), _section_map(now)
    changed = [heading for heading, body in after.items() if before.get(heading) != body]
    changed += [heading for heading in before if heading not in after]
    return tuple(changed)


# --- the JSON -------------------------------------------------------------------------------


def _sections(text: str) -> list[dict[str, object]]:
    """Each ``## `` section: where it starts (1-based line), how long, and whose it is."""
    lines = text.split("\n")
    starts = _heading_lines(lines)
    sections = []
    for position, start in enumerate(starts):
        end = starts[position + 1] if position + 1 < len(starts) else len(lines)
        heading = lines[start][3:]
        body = "\n".join(lines[start:end])
        kind = TASK_SECTION_CLASSES.get(heading, "unclassified")
        sections.append(
            {
                "heading": heading,
                "class": kind,
                "protected": kind == "protected",
                "line": start + 1,
                "lines": end - start,
                "placeholder": any(placeholder in body for placeholder in PLACEHOLDERS),
            }
        )
    return sections


def _instruction_source(file: InstructionFile) -> dict[str, object]:
    return {
        "configured": file.configured,
        "characters": file.characters,
        "problem": file.problem,
        "sha256": file.sha256,
    }


def task_preview_payload(preview: TaskPreview) -> dict[str, object]:
    """``bugpilot task-preview --json``: the text, its sections, where each layer came from, and the prepared files' state."""
    inputs = preview.inputs
    verification = inputs.project_settings.effective_verification
    ai_behavior = inputs.ai_behavior
    template = preview.kind == KIND_TEMPLATE
    prepared = preview.prepared
    return {
        "preview_kind": preview.kind,
        "label": preview.label,
        "work_item": preview.work_item,
        "text": preview.text,
        "sections": _sections(preview.text),
        "placeholders": [placeholder for placeholder in PLACEHOLDERS if placeholder in preview.text],
        "sources": {
            "protected_rules": {"rules_version": PROTECTED_RULES_VERSION},
            "repository_profile": {"mode": inputs.repository.mode},
            "project_instructions": _instruction_source(inputs.instructions.project),
            "verification": {
                "source": verification.source,
                "problem": verification.problem,
                "lint": len(verification.lint),
                "based_on_version": verification.based_on_version,
                "default_version": DEFAULT_POLICY_VERSION,
                "default_changed": verification.default_changed,
                "sha256": verification.sha256,
            },
            "ai_behavior": {
                "source": ai_behavior.source,
                "problem": ai_behavior.problem,
                "lint": len(ai_behavior.lint),
                "has_project_additions": ai_behavior.has_project_additions,
                "based_on_version": ai_behavior.based_on_version,
                "default_version": DEFAULT_AI_BEHAVIOR_VERSION,
                "default_changed": ai_behavior.default_changed,
                "sha256": ai_behavior.sha256,
            },
            "user_instructions": _instruction_source(inputs.instructions.user),
            "fix_mode": {
                "id": inputs.fix_mode.id,
                "name": inputs.fix_mode.name,
                "source": inputs.fix_mode.source,
                "execution_kind": inputs.fix_mode.execution_kind,
                "origin": preview.fix_mode_origin,
            },
            "branch_policy": {
                "policy": inputs.branch_policy,
                # A template's name is the repository's naming with placeholders in it.
                "branch": inputs.branch,
            },
            "jira_comment": inputs.jira_comment,
            "hint": None if template else inputs.hint is not None and inputs.hint.strip() != "",
            "attachments": None if template else len(inputs.attachments),
        },
        "prepared": None
        if prepared is None
        else {
            "task_exists": prepared.task_exists,
            "context_exists": prepared.context_exists,
            "task_current": prepared.task_current,
            "changed_sections": list(prepared.changed_sections),
            "problem": prepared.problem,
        },
    }
