"""Safe cleanup helpers for generated bugpilot artifacts."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from .identity import validate_work_item_id
from .safe_paths import owned_path, remove_owned_path


@dataclass
class CleanResult:
    issue_key: str
    deleted_paths: list[str] = field(default_factory=list)
    preserved_paths: list[str] = field(default_factory=list)
    missing_paths: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def validate_issue_key(issue_key: str) -> None:
    """Deprecated alias for :func:`identity.validate_work_item_id`.

    Kept so existing callers keep working; new code should call
    ``validate_work_item_id`` directly.
    """
    validate_work_item_id(issue_key)


def clean_issue_artifacts(repo_root: Path, issue_key: str, include_memory: bool = False) -> CleanResult:
    """Delete one work item's generated artifacts, and its memory entry if asked.

    Every path is checked before anything is deleted (``safe_paths.owned_path``):
    a link or junction at ``.ai``, ``.ai/<id>``, ``.ai_memory`` or below raises
    :class:`~bugpilot.core.safe_paths.UnsafePathError` and nothing is removed —
    not the folder, not the memory entry. Both ``clean`` and ``bug --fresh``
    come through here.
    """
    validate_issue_key(issue_key)
    result = CleanResult(issue_key=issue_key)

    workflow_dir = owned_path(repo_root, (".ai", issue_key))
    memory_file = owned_path(repo_root, (".ai_memory", "bugs", f"{issue_key}.md")) if include_memory else None

    if remove_owned_path(workflow_dir):
        result.deleted_paths.append(f".ai/{issue_key}/")
    else:
        result.missing_paths.append(f".ai/{issue_key}/")

    if memory_file is not None:
        if remove_owned_path(memory_file):
            result.deleted_paths.append(f".ai_memory/bugs/{issue_key}.md")
        else:
            result.missing_paths.append(f".ai_memory/bugs/{issue_key}.md")
    else:
        result.preserved_paths.append(f".ai_memory/bugs/{issue_key}.md")

    return result
