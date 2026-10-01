"""The normalized issue: one typed object, persisted as ``issue.json``.

A Jira issue and a hand-written description end up in the same shape here, so
nothing downstream — keyword extraction, context, prompts, memory — needs to
know where a bug was described. The workflow builds this object once, hands it
to later steps in memory, and writes it to ``issue.json`` as the persistent copy
that resume, refine and standalone commands read back.

Only what BugPilot actually uses is kept. The raw Jira payload is not persisted:
it carried attachment URLs, account ids and dozens of custom fields that no step
ever read. People's names are not kept either — no step decides anything from
an assignee, a reporter or a comment author.

``guidance`` is the effective hint and Fix Mode *this run used*, not what some
earlier run was given: a hint accepted from the hint improver arrives as the
run's hint, and that is what is recorded here and what resume reuses.
"""

from __future__ import annotations

import json
from collections.abc import Mapping
from dataclasses import dataclass, field, replace
from pathlib import Path

from .artifact_io import atomic_write_text
from .artifacts import ARTIFACT_SCHEMA_VERSION, ISSUE_ARTIFACT
from .config import issue_dir
from .input_adapters import manual_issue_payload
from .jira import parse_issue
from .models import SOURCE_JIRA, SOURCE_MANUAL, BugSpec


class IssueArtifactError(ValueError):
    """``issue.json`` exists but is not a readable version-1 issue."""


@dataclass(frozen=True)
class IssueComment:
    created: str
    body: str


@dataclass(frozen=True)
class IssueAttachment:
    """Metadata only: BugPilot never downloads attachment content."""

    filename: str
    kind: str
    mime_type: str = ""
    size: int = 0
    created: str = ""


@dataclass(frozen=True)
class IssueSignals:
    """Evidence mined from the report. Keyword extraction ranks these first."""

    stack_traces: tuple[str, ...] = ()
    error_messages: tuple[str, ...] = ()
    log_signals: tuple[str, ...] = ()


@dataclass(frozen=True)
class IssueDetails:
    """What the report says beyond its title and description.

    The Jira fields are empty for a hand-written bug; the extracted fields are
    filled for both sources, by the same parser.
    """

    issue_type: str = ""
    status: str = ""
    resolution: str = ""
    priority: str = ""
    labels: tuple[str, ...] = ()
    components: tuple[str, ...] = ()
    affected_versions: tuple[str, ...] = ()
    fix_versions: tuple[str, ...] = ()
    mock: bool = False
    reproduction_steps: tuple[str, ...] = ()
    actual_result: str = ""
    expected_result: str = ""
    environment: str = ""
    regression_signals: tuple[str, ...] = ()
    missing_information: tuple[str, ...] = ()
    attachments: tuple[IssueAttachment, ...] = ()


@dataclass(frozen=True)
class IssueGuidance:
    """The effective hint and Fix Mode for this work item.

    ``fix_mode`` is the audit record from ``fix_mode_state.fix_mode_metadata``.
    Only its ``id`` selects a mode; the rest lets a later run say when the
    definition behind that id has changed.
    """

    hint: str | None = None
    fix_mode: Mapping[str, object] | None = None
    # The developer's description of an attached file, by its name in
    # `attachments/`: why the file matters. Guidance like the hint, so it is
    # recorded here and survives --resume with the files it describes.
    attachment_notes: Mapping[str, str] = field(default_factory=dict)
    # The files this work item currently has in `attachments/`, by name: the
    # last selection a run copied (§37.99). The record is what a task file
    # names and what a later run may delete — never whatever else is in the
    # folder. ``None``: never recorded (a work item from before, or only ever
    # prepared additively), and the folder is read as it always was.
    attachment_files: tuple[str, ...] | None = None


@dataclass(frozen=True)
class IssueArtifact:
    id: str
    source: str
    title: str = ""
    description: str = ""
    comments: tuple[IssueComment, ...] = ()
    signals: IssueSignals = field(default_factory=IssueSignals)
    details: IssueDetails = field(default_factory=IssueDetails)
    guidance: IssueGuidance = field(default_factory=IssueGuidance)

    @property
    def is_jira(self) -> bool:
        return self.source == SOURCE_JIRA

    @property
    def source_ref(self) -> str | None:
        """The external issue a Jira write is addressed to; ``None`` for manual."""
        return self.id if self.is_jira else None

    @property
    def can_write_back(self) -> bool:
        return self.source_ref is not None

    @property
    def combined_text(self) -> str:
        """Title, description and comments: the text keywords are mined from."""
        return "\n".join(
            [self.title, self.description, "\n".join(c.body for c in self.comments)]
        ).strip()

    @property
    def priority_text(self) -> str:
        """Stack traces, error messages and log signals, in that order."""
        return "\n".join(
            [*self.signals.stack_traces, *self.signals.error_messages, *self.signals.log_signals]
        )

    def with_guidance(self, guidance: IssueGuidance) -> IssueArtifact:
        return replace(self, guidance=guidance)


# --- building ----------------------------------------------------------------


def jira_stub(work_item_id: str, guidance: IssueGuidance) -> IssueArtifact:
    """A Jira work item whose content is not fetched yet.

    Written before the pipeline runs so that the guidance is on disk even if
    the fetch fails: resume, refine and retry must regenerate under the same
    mode, and a half-finished run is exactly when someone reaches for them.
    """
    return IssueArtifact(id=work_item_id, source=SOURCE_JIRA, guidance=guidance)


def issue_from_jira(
    payload: dict, work_item_id: str, guidance: IssueGuidance
) -> IssueArtifact:
    """Normalize a fetched Jira payload.

    Identity comes from the request, not the payload: the id is what names the
    directory, and a payload is not allowed to rename it.
    """
    issue = _from_parsed(parse_issue(payload), work_item_id, SOURCE_JIRA, guidance)
    # The version fields are not in the parsed dict: parse_issue folds them into
    # `environment`, and only the normalized block (added by parse_issue's own
    # enrich step) keeps them as lists.
    normalized = payload.get("bugpilot_normalized")
    normalized = normalized if isinstance(normalized, dict) else {}
    return replace(
        issue,
        details=replace(
            issue.details,
            affected_versions=_strings(normalized.get("affected_versions")),
            fix_versions=_strings(normalized.get("fix_versions")),
        ),
    )


def issue_from_spec(spec: BugSpec, guidance: IssueGuidance) -> IssueArtifact:
    """Normalize a hand-written bug through the same parser a Jira issue uses."""
    return _from_parsed(
        parse_issue(manual_issue_payload(spec)), spec.work_item_id, spec.source, guidance
    )


def _from_parsed(
    parsed: dict[str, object], work_item_id: str, source: str, guidance: IssueGuidance
) -> IssueArtifact:
    raw_comments = parsed.get("comment_details")
    comments = tuple(
        IssueComment(
            created=str(item.get("created") or ""),
            body=str(item.get("body_markdown") or ""),
        )
        for item in (raw_comments if isinstance(raw_comments, list) else [])
        if isinstance(item, dict)
    )
    raw_attachments = parsed.get("attachments")
    attachments = tuple(
        IssueAttachment(
            filename=str(item.get("filename") or ""),
            kind=str(item.get("kind") or "unknown"),
            mime_type=str(item.get("mime_type") or ""),
            size=_int(item.get("size")),
            created=str(item.get("created") or ""),
        )
        for item in (raw_attachments if isinstance(raw_attachments, list) else [])
        if isinstance(item, dict)
    )
    return IssueArtifact(
        id=work_item_id,
        source=source,
        title=str(parsed.get("summary") or "").strip(),
        description=str(parsed.get("description") or "").strip(),
        comments=comments,
        signals=IssueSignals(
            stack_traces=_strings(parsed.get("stack_traces")),
            error_messages=_strings(parsed.get("error_messages")),
            log_signals=_strings(parsed.get("log_signals")),
        ),
        details=IssueDetails(
            issue_type=str(parsed.get("issue_type") or ""),
            status=str(parsed.get("status") or ""),
            resolution=str(parsed.get("resolution") or ""),
            priority=str(parsed.get("priority") or ""),
            labels=_strings(parsed.get("labels")),
            components=_strings(parsed.get("components")),
            affected_versions=_strings(parsed.get("affected_versions")),
            fix_versions=_strings(parsed.get("fix_versions")),
            mock=bool(parsed.get("is_mock")),
            reproduction_steps=_strings(parsed.get("reproduction_steps")),
            actual_result=str(parsed.get("actual_result") or ""),
            expected_result=str(parsed.get("expected_result") or ""),
            environment=str(parsed.get("environment") or ""),
            regression_signals=_strings(parsed.get("regression_signals")),
            missing_information=_strings(parsed.get("missing_information")),
            attachments=attachments,
        ),
        guidance=guidance,
    )


# --- on-disk form ------------------------------------------------------------


def issue_path(repo_root: Path, work_item_id: str) -> Path:
    return issue_dir(repo_root, work_item_id) / ISSUE_ARTIFACT


def save_issue(repo_root: Path, issue: IssueArtifact) -> Path:
    """Write ``issue.json`` atomically.

    Atomically because other processes read it while a run is writing: the
    extension, an MCP ``get_status``, a ``bugpilot list`` in another terminal.
    """
    path = issue_path(repo_root, issue.id)
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_text(path, json.dumps(issue_to_dict(issue), indent=2, ensure_ascii=False) + "\n")
    return path


def load_issue(repo_root: Path, work_item_id: str) -> IssueArtifact | None:
    """The persisted issue, or ``None`` when the work item has none.

    Raises :class:`IssueArtifactError` when the file exists but cannot be used,
    including a file from before this schema. Callers that only label a listing
    use :func:`read_issue_quietly` instead.
    """
    path = issue_path(repo_root, work_item_id)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError, UnicodeDecodeError) as exc:
        raise IssueArtifactError(f".ai/{work_item_id}/{ISSUE_ARTIFACT} could not be read ({exc}).") from exc
    return issue_from_dict(data, work_item_id)


def read_issue_quietly(repo_root: Path, work_item_id: str) -> IssueArtifact | None:
    """:func:`load_issue` for a caller that degrades rather than fails.

    A listing or a status line shows the ids it found instead of failing on one
    unreadable directory.
    """
    try:
        return load_issue(repo_root, work_item_id)
    except IssueArtifactError:
        return None


def issue_to_dict(issue: IssueArtifact) -> dict[str, object]:
    details = issue.details
    return {
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "id": issue.id,
        "source": issue.source,
        "title": issue.title,
        "description": issue.description,
        "comments": [{"created": c.created, "body": c.body} for c in issue.comments],
        "signals": {
            "stack_traces": list(issue.signals.stack_traces),
            "error_messages": list(issue.signals.error_messages),
            "log_signals": list(issue.signals.log_signals),
        },
        "details": {
            "issue_type": details.issue_type,
            "status": details.status,
            "resolution": details.resolution,
            "priority": details.priority,
            "labels": list(details.labels),
            "components": list(details.components),
            "affected_versions": list(details.affected_versions),
            "fix_versions": list(details.fix_versions),
            "mock": details.mock,
            "reproduction_steps": list(details.reproduction_steps),
            "actual_result": details.actual_result,
            "expected_result": details.expected_result,
            "environment": details.environment,
            "regression_signals": list(details.regression_signals),
            "missing_information": list(details.missing_information),
            "attachments": [
                {
                    "filename": a.filename,
                    "kind": a.kind,
                    "mime_type": a.mime_type,
                    "size": a.size,
                    "created": a.created,
                }
                for a in details.attachments
            ],
        },
        "guidance": {
            "hint": issue.guidance.hint,
            "fix_mode": dict(issue.guidance.fix_mode) if issue.guidance.fix_mode is not None else None,
            # Only when there is one: a work item without described attachments
            # writes the issue.json it always has.
            **(
                {"attachment_notes": dict(issue.guidance.attachment_notes)}
                if issue.guidance.attachment_notes
                else {}
            ),
            **(
                {"attachment_files": list(issue.guidance.attachment_files)}
                if issue.guidance.attachment_files is not None
                else {}
            ),
        },
    }


def issue_from_dict(data: object, work_item_id: str) -> IssueArtifact:
    """Rebuild an issue from ``issue.json``. Version 1 only, by design."""
    where = f".ai/{work_item_id}/{ISSUE_ARTIFACT}"
    if not isinstance(data, dict):
        raise IssueArtifactError(f"{where} does not contain a JSON object.")
    if data.get("schema_version") != ARTIFACT_SCHEMA_VERSION:
        raise IssueArtifactError(
            f"{where} has schema_version {data.get('schema_version')!r}; expected "
            f"{ARTIFACT_SCHEMA_VERSION}. Re-prepare the work item."
        )
    issue_id = str(data.get("id") or "").strip()
    if issue_id != work_item_id:
        raise IssueArtifactError(f"{where} records id {issue_id!r}, not {work_item_id!r}.")
    source = str(data.get("source") or "")
    if source not in {SOURCE_JIRA, SOURCE_MANUAL}:
        raise IssueArtifactError(f"{where} records an unknown source {source!r}.")
    signals = _dict(data.get("signals"))
    details = _dict(data.get("details"))
    guidance = _dict(data.get("guidance"))
    hint = guidance.get("hint")
    fix_mode = guidance.get("fix_mode")
    notes = _dict(guidance.get("attachment_notes"))
    files = guidance.get("attachment_files")
    return IssueArtifact(
        id=issue_id,
        source=source,
        title=str(data.get("title") or ""),
        description=str(data.get("description") or ""),
        comments=tuple(
            IssueComment(created=str(item.get("created") or ""), body=str(item.get("body") or ""))
            for item in _list(data.get("comments"))
            if isinstance(item, dict)
        ),
        signals=IssueSignals(
            stack_traces=_strings(signals.get("stack_traces")),
            error_messages=_strings(signals.get("error_messages")),
            log_signals=_strings(signals.get("log_signals")),
        ),
        details=IssueDetails(
            issue_type=str(details.get("issue_type") or ""),
            status=str(details.get("status") or ""),
            resolution=str(details.get("resolution") or ""),
            priority=str(details.get("priority") or ""),
            labels=_strings(details.get("labels")),
            components=_strings(details.get("components")),
            affected_versions=_strings(details.get("affected_versions")),
            fix_versions=_strings(details.get("fix_versions")),
            mock=bool(details.get("mock")),
            reproduction_steps=_strings(details.get("reproduction_steps")),
            actual_result=str(details.get("actual_result") or ""),
            expected_result=str(details.get("expected_result") or ""),
            environment=str(details.get("environment") or ""),
            regression_signals=_strings(details.get("regression_signals")),
            missing_information=_strings(details.get("missing_information")),
            attachments=tuple(
                IssueAttachment(
                    filename=str(item.get("filename") or ""),
                    kind=str(item.get("kind") or "unknown"),
                    mime_type=str(item.get("mime_type") or ""),
                    size=_int(item.get("size")),
                    created=str(item.get("created") or ""),
                )
                for item in _list(details.get("attachments"))
                if isinstance(item, dict)
            ),
        ),
        guidance=IssueGuidance(
            hint=hint.strip() or None if isinstance(hint, str) else None,
            fix_mode=dict(fix_mode) if isinstance(fix_mode, dict) else None,
            attachment_notes={
                str(name): note.strip()
                for name, note in notes.items()
                if isinstance(note, str) and note.strip()
            },
            attachment_files=(
                tuple(name for name in files if isinstance(name, str) and name)
                if isinstance(files, list)
                else None
            ),
        ),
    )


def _dict(value: object) -> dict:
    return value if isinstance(value, dict) else {}


def _list(value: object) -> list:
    return value if isinstance(value, list) else []


def _strings(value: object) -> tuple[str, ...]:
    return tuple(str(item) for item in _list(value) if item is not None)


def _int(value: object) -> int:
    try:
        return int(value)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        return 0
