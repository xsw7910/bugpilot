"""The Fix Mode selected for one work item: choosing it, and remembering it.

The selection is persisted at `.ai/<work item>/fix_mode.json`, beside
`workflow_status.json`. That is generated runtime state, not team policy —
`.bugpilot/` is where team-owned mode definitions will live in a later phase,
and mixing the two would make a run's own bookkeeping look like something a
developer should edit and commit.

**Only the id selects a mode.** Everything else in the file is audit metadata:
what the package was generated with, so a `review_notes.md` read months later
still says which workflow the agent was given. A name or an instruction copied
out of a stale file must never become the workflow, so the id is re-resolved
through the registry on every read. That is also what makes a mode which has
since disappeared fail loudly instead of quietly becoming Standard Fix — the
case that matters once modes can come from a project directory.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from .artifact_io import atomic_write_text
from .config import issue_dir
from .fix_mode_store import effective_registry_for
from .fix_modes import (
    FixMode,
    FixModeError,
    FixModeNotFoundError,
    FixModeRegistry,
)

FIX_MODE_FILE = "fix_mode.json"
FIX_MODE_SCHEMA_VERSION = 1
_METADATA_KEYS: tuple[str, ...] = (
    "id",
    "name",
    "version",
    "source",
    "execution_kind",
    "based_on",
    "based_on_version",
)

SelectionOrigin = Literal["explicit", "persisted", "default"]


@dataclass(frozen=True)
class FixModeSelection:
    """A resolved mode, where the choice came from, and what to tell the developer."""

    mode: FixMode
    origin: SelectionOrigin
    warnings: tuple[str, ...] = ()


def fix_mode_registry(repo_root: Path | None = None) -> FixModeRegistry:
    """The registry every entry point resolves ids through.

    Built-ins plus the developer's own modes plus the repository's, with project
    beating user for a custom id and built-ins reserved. One function, so
    nothing downstream learns about scopes or config paths: callers hand an id
    in and get a resolved `FixMode` back.

    `repo_root` is explicit rather than taken from the process's directory,
    because "which repository" is the caller's question — a command run from a
    nested directory, a VS Code workspace and a test in a temporary directory
    all answer it differently. Without a root only built-ins and the
    developer's own modes are available; a project has none to offer.

    Rebuilt on every call: these files are meant to be edited and committed, so
    a cached registry would answer with the content of the last run.
    """
    return effective_registry_for(repo_root)


def fix_mode_metadata(mode: FixMode) -> dict[str, object]:
    """The audit record of which mode produced a package.

    One shape for all three consumers — the persisted file, the status file and
    the `--json` envelope — because a consumer that learns to read it in one
    place should not have to learn a second spelling for the next.
    """
    return {key: getattr(mode, key) for key in _METADATA_KEYS}


def select_fix_mode(
    repo_root: Path,
    work_item_id: str,
    requested_id: str | None = None,
    *,
    use_persisted: bool = True,
    registry: FixModeRegistry | None = None,
) -> FixModeSelection:
    """Explicit selection, else the persisted one, else Standard Fix.

    Reads; never writes. `use_persisted=False` is for a fresh run, which is
    about to delete the previous package: the mode recorded there belongs to the
    run being discarded, and resolving before the deletion means a mistyped
    `--fix-mode` costs nothing.
    """
    registry = registry or fix_mode_registry(repo_root)
    if requested_id is not None:
        return FixModeSelection(registry.resolve(requested_id), "explicit")
    stored = _read_state(repo_root, work_item_id) if use_persisted else None
    if stored is None:
        return FixModeSelection(registry.resolve(None), "default")
    return _selection_from_state(stored, registry, repo_root, work_item_id)


def persist_fix_mode(repo_root: Path, work_item_id: str, mode: FixMode) -> Path:
    """Record the selection for later regeneration, resume, refine and retry."""
    target = issue_dir(repo_root, work_item_id)
    target.mkdir(parents=True, exist_ok=True)
    path = target / FIX_MODE_FILE
    payload = {"schema_version": FIX_MODE_SCHEMA_VERSION, **fix_mode_metadata(mode)}
    atomic_write_text(path, json.dumps(payload, indent=2, sort_keys=True) + "\n")
    return path


def stored_fix_mode_metadata(repo_root: Path, work_item_id: str) -> dict[str, object] | None:
    """What was recorded, for the status file. Never raises.

    Status writing runs on the failure path too, so an unreadable selection file
    must not be the reason a run cannot report what it did.
    """
    try:
        stored = _read_state(repo_root, work_item_id)
    except FixModeError:
        return None
    if not stored:
        return None
    return {key: stored.get(key) for key in _METADATA_KEYS}


def _read_state(repo_root: Path, work_item_id: str) -> dict[str, object] | None:
    """The persisted selection as raw data, or None when there is none."""
    path = issue_dir(repo_root, work_item_id) / FIX_MODE_FILE
    if not path.exists():
        return None
    try:
        stored = json.loads(path.read_text(encoding="utf-8", errors="replace"))
    except (json.JSONDecodeError, OSError) as exc:
        raise FixModeError(
            f"{_display_path(work_item_id)} could not be read ({exc}). "
            "Choose a mode explicitly with --fix-mode, or delete the file to fall "
            "back to Standard Fix."
        ) from exc
    if not isinstance(stored, dict):
        raise FixModeError(
            f"{_display_path(work_item_id)} does not contain a JSON object. "
            "Choose a mode explicitly with --fix-mode, or delete the file to fall "
            "back to Standard Fix."
        )
    return stored


def _selection_from_state(
    stored: dict[str, object],
    registry: FixModeRegistry,
    repo_root: Path,
    work_item_id: str,
) -> FixModeSelection:
    stored_id = stored.get("id")
    if not isinstance(stored_id, str) or not stored_id.strip():
        raise FixModeError(
            f"{_display_path(work_item_id)} does not record a Fix Mode id. "
            "Choose a mode explicitly with --fix-mode, or delete the file to fall "
            "back to Standard Fix."
        )
    try:
        mode = registry.resolve(stored_id)
    except FixModeNotFoundError as exc:
        raise FixModeNotFoundError(
            f"Stored Fix Mode {stored_id!r} cannot be resolved. Choose another mode "
            "explicitly with --fix-mode or restore the mode definition."
        ) from exc
    return FixModeSelection(mode, "persisted", _drift_warnings(stored, mode))


def _drift_warnings(stored: dict[str, object], mode: FixMode) -> tuple[str, ...]:
    """Say so when the definition behind an id is no longer the one that ran.

    Two ways that happens, and the second is the one custom modes introduce: the
    recorded mode was edited (a new version), or another scope started answering
    to the same id — a project mode appearing beside a developer's own, or being
    deleted again. Only the id is authority, so re-resolution is correct; doing
    it *silently* would swap a personal workflow for a team one, or back, with
    nothing on screen to say so.

    BugPilot regenerates from the current definition rather than replaying an old
    one, the same compatibility model as every other artifact here. Pinning a
    mode to a snapshot is a later decision, not this phase's.
    """
    changes: list[str] = []
    stored_source = stored.get("source")
    if isinstance(stored_source, str) and stored_source and stored_source != mode.source:
        changes.append(f"source: {stored_source} -> {mode.source}")
    stored_version = stored.get("version")
    if isinstance(stored_version, int) and not isinstance(stored_version, bool):
        if stored_version != mode.version:
            changes.append(f"version: {stored_version} -> {mode.version}")
    if not changes:
        return ()
    return (
        f"Fix Mode {mode.id!r} changed since this work item was prepared: "
        + "; ".join(changes)
        + ". Regenerating with the current effective definition.",
    )


def _display_path(work_item_id: str) -> str:
    return f".ai/{work_item_id}/{FIX_MODE_FILE}"
