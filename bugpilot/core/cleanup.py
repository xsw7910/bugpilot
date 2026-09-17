"""Safe cleanup helpers for generated bugpilot artifacts."""

from __future__ import annotations

import shutil
from dataclasses import dataclass, field
from pathlib import Path

from .identity import validate_work_item_id


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
    validate_issue_key(issue_key)
    root = repo_root.resolve()
    ai_root = (root / ".ai").resolve()
    memory_root = (root / ".ai_memory" / "bugs").resolve()
    workflow_dir = ai_root / issue_key
    memory_file = memory_root / f"{issue_key}.md"
    result = CleanResult(issue_key=issue_key)

    _ensure_child(workflow_dir, ai_root, ".ai issue directory")
    _ensure_child(memory_file, memory_root, "memory issue file")

    if workflow_dir.exists() or workflow_dir.is_symlink():
        _remove_path(workflow_dir)
        result.deleted_paths.append(f".ai/{issue_key}/")
    else:
        result.missing_paths.append(f".ai/{issue_key}/")

    if include_memory:
        if memory_file.exists() or memory_file.is_symlink():
            _remove_path(memory_file)
            result.deleted_paths.append(f".ai_memory/bugs/{issue_key}.md")
        else:
            result.missing_paths.append(f".ai_memory/bugs/{issue_key}.md")
    else:
        result.preserved_paths.append(f".ai_memory/bugs/{issue_key}.md")

    return result


def _ensure_child(path: Path, parent: Path, label: str) -> None:
    try:
        path.relative_to(parent)
    except ValueError as exc:
        raise ValueError(f"Refusing to clean {label} outside target repo generated paths.") from exc


def _remove_path(path: Path) -> None:
    if path.is_symlink() or path.is_file():
        path.unlink()
        return
    if path.is_dir():
        shutil.rmtree(path)
