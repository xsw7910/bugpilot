"""Safe cleanup helpers for generated bugpilot artifacts."""

from __future__ import annotations

from dataclasses import dataclass, field
from pathlib import Path

from . import storage
from .config import data_dir, shown
from .identity import validate_work_item_id
from .repository_settings import guarded
from .safe_paths import owned_path


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

    Both live in the repository's folder in BugPilot's data folder (0.1.7):
    ``work/<id>/`` and ``memory/<id>.md``, which the result names relative to
    that folder. Every path is checked before anything is deleted: a link or
    junction at ``work``, ``work/<id>``, ``memory`` or the memory entry raises
    :class:`~bugpilot.core.safe_paths.UnsafePathError` in the deletion's own
    words (``safe_paths.owned_path``, as in 0.1.6), and storage's checks of the
    data folder down to the namespace raise its ``StorageError``; either way
    nothing is removed — not the folder, not the memory entry. Storage then
    deletes each one only inside this repository's
    namespace (``RepositoryStorage.remove_work_item``). Both ``clean`` and
    ``bug --fresh`` come through here. A repository's 0.1.5 ``.ai/`` and
    ``.ai_memory/`` folders are never touched.
    A data folder that cannot be examined or changed right now is
    ``StorageAccessError``, in storage's sentence (C-1, F2-S).
    """
    validate_issue_key(issue_key)
    result = CleanResult(issue_key=issue_key)
    namespace = storage.repository_storage(repo_root)

    # Checked first, both of them, so a refusal of either deletes nothing.
    base = data_dir(repo_root)
    owned_path(base, ("work", issue_key), boundary=storage.DATA_ROOT_BOUNDARY)
    if include_memory:
        owned_path(base, ("memory", f"{issue_key}.md"), boundary=storage.DATA_ROOT_BOUNDARY)
    return guarded("delete", lambda: shown(base), lambda: _remove(namespace, result, include_memory))


def _remove(namespace: storage.RepositoryStorage, result: CleanResult, include_memory: bool) -> CleanResult:
    """Storage's checks of both targets first, then each checked deletion, recorded in ``result``."""
    issue_key = result.issue_key
    folder, memory = f"work/{issue_key}/", f"memory/{issue_key}.md"
    namespace.work_item_dir(issue_key, create=False)
    if include_memory:
        namespace.memory_file(issue_key, create=False)

    if namespace.remove_work_item(issue_key):
        result.deleted_paths.append(folder)
    else:
        result.missing_paths.append(folder)

    if include_memory:
        if namespace.remove_memory_file(issue_key):
            result.deleted_paths.append(memory)
        else:
            result.missing_paths.append(memory)
    else:
        result.preserved_paths.append(memory)

    return result
