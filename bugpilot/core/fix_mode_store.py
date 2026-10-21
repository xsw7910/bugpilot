"""Custom Fix Modes on disk: where they live, and what may be done to them.

Two scopes, and the difference between them is who the mode belongs to:

    ~/.bugpilot/config/fix_modes/<id>.json                                one developer's own workflows
    ~/.bugpilot/repositories/<repository id>/settings/fix_modes/<id>.json this developer's for one repository

The user folder is in ``config/`` of BugPilot's data folder (``BUGPILOT_HOME``
when set; 0.1.6, plan §14.3, Batch 2B-2), reached only through storage's checked
accessor: a data folder in a Git working tree, or a link on the way, is refused
(owner decision C-2). The 0.1.5 folder at the top of the data folder is never read.

The project folder is in the repository's namespace (Batch 2B-3a), reached only
through :mod:`repository_settings`, with the same refusals (G-6). It is not
shared through the repository (US-D9); the 0.1.5 ``<repo>/.bugpilot/fix_modes/``
is never read, copied or deleted.

Built-ins stay packaged and read-only. A custom file may not claim one of their
ids, and may not claim to *be* one: `source` is never stored in the file, it is
derived from the directory the file was found in. A JSON file that could say
`"source": "builtin"` would be a file that could dress itself up as something
BugPilot ships.

Two views of the same modes, deliberately kept apart:

  - the **effective registry** answers "which definition does this id run?",
    one mode per id, project over user, built-ins reserved;
  - the **catalog** answers "what exists on disk?", and keeps both
    `user/my-safe` and `project/my-safe` visible so that management can address
    either. Resolving through the effective registry to decide what to edit
    would make the shadowed one unreachable.

Nothing here is cached. A store is built per command, so a file edited by hand
between two runs is seen by the second one — these files are meant to be edited.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path
from typing import Callable, Iterable, Literal

from . import repository_settings, storage
from .artifact_io import atomic_write_text
from .errors import StorageAccessError
from .fix_modes import (
    BUILTIN_FIX_MODES,
    FixMode,
    FixModeError,
    FixModeNotFoundError,
    FixModeRegistry,
    builtin_fix_mode_registry,
    is_valid_fix_mode_id,
)
from .safe_paths import is_link_or_junction

CUSTOM_SCHEMA_VERSION = 1
FIX_MODE_SUBDIR = "fix_modes"

CustomScope = Literal["user", "project"]
CUSTOM_SCOPES: tuple[str, ...] = ("user", "project")

BUILTIN_FIX_MODE_IDS: frozenset[str] = frozenset(mode.id for mode in BUILTIN_FIX_MODES)

# The content of a mode, as a file carries it. `source` is absent on purpose and
# `version` is managed by this module, never by whoever wrote the file.
_CONTENT_FIELDS: tuple[str, ...] = (
    "name",
    "description",
    "objective",
    "investigation",
    "implementation",
    "verification",
    "constraints",
    "completion",
    "execution_kind",
)
_ORIGIN_FIELDS: tuple[str, ...] = ("based_on", "based_on_version")
_ALLOWED_KEYS: frozenset[str] = frozenset(
    ("schema_version", "id", "version", *_CONTENT_FIELDS, *_ORIGIN_FIELDS)
)


@dataclass(frozen=True)
class FixModeIssue:
    """A custom file that could not be loaded, and why.

    Carried rather than raised: one unreadable file must not take the other
    modes down with it, and must not be silently skipped either. The developer
    needs the path and the reason, in the listing where they would look.
    """

    scope: str
    path: str
    message: str


@dataclass(frozen=True)
class FixModeCatalog:
    """Every mode that physically exists, by scope, plus what could not be read."""

    builtin: tuple[FixMode, ...]
    user: tuple[FixMode, ...]
    project: tuple[FixMode, ...]
    issues: tuple[FixModeIssue, ...] = ()

    def scoped(self, scope: str) -> tuple[FixMode, ...]:
        if scope == "builtin":
            return self.builtin
        if scope == "user":
            return self.user
        if scope == "project":
            return self.project
        raise FixModeError(f"Unknown Fix Mode scope: {scope!r}.")

    def effective_modes(self) -> tuple[FixMode, ...]:
        """One mode per id: project over user, built-ins never overridden.

        Order is deterministic and does not depend on directory enumeration:
        built-ins in their packaged order, then custom ids alphabetically.
        """
        effective: dict[str, FixMode] = {mode.id: mode for mode in self.builtin}
        custom: dict[str, FixMode] = {}
        for mode in self.user:
            custom[mode.id] = mode
        for mode in self.project:
            # Project beats user for a custom id. Stated here rather than left to
            # the order two directories happen to be walked in.
            custom[mode.id] = mode
        for mode_id in sorted(custom):
            if mode_id in effective:
                # Unreachable through `load_catalog`, which refuses a reserved id
                # at load time. Kept so that a hand-built catalog cannot shadow a
                # built-in either.
                continue
            effective[mode_id] = custom[mode_id]
        return tuple(effective.values())

    def effective_registry(self) -> FixModeRegistry:
        return FixModeRegistry(self.effective_modes())

    def is_effective(self, mode: FixMode) -> bool:
        """Whether this physical definition is the one its id resolves to."""
        for candidate in self.effective_modes():
            if candidate.id == mode.id:
                return candidate is mode or candidate == mode
        return False


def custom_mode_payload(mode: FixMode) -> dict[str, object]:
    """A mode as its file spells it: content, origin, version — never source."""
    payload: dict[str, object] = {"schema_version": CUSTOM_SCHEMA_VERSION, "id": mode.id}
    for field in _CONTENT_FIELDS:
        payload[field] = getattr(mode, field)
    payload["version"] = mode.version
    payload["based_on"] = mode.based_on
    payload["based_on_version"] = mode.based_on_version
    return payload


def _require_scope(scope: str) -> CustomScope:
    if scope not in CUSTOM_SCOPES:
        raise FixModeError(
            f"Unknown Fix Mode scope {scope!r}. Custom modes live in "
            f"{' or '.join(CUSTOM_SCOPES)} scope; built-in modes cannot be modified."
        )
    return scope  # type: ignore[return-value]


def _require_not_reserved(mode_id: str) -> str:
    if mode_id in BUILTIN_FIX_MODE_IDS:
        raise FixModeError(
            f"Built-in Fix Mode {mode_id!r} is reserved and cannot be overridden. "
            "Duplicate it under a different custom id."
        )
    return mode_id


def _require_managed_version(value: object, field: str) -> int:
    """A version a caller sends back to us, checked before it decides anything.

    `True` is not 1 here: a JSON `true` that slipped into an expected-version
    field must not pass for the first version of a mode and silently authorize
    an overwrite.
    """
    if isinstance(value, bool) or not isinstance(value, int):
        raise FixModeError(
            f"{field} must be an integer, got {type(value).__name__}."
        )
    if value < 1:
        raise FixModeError(f"{field} must be >= 1.")
    return value


def fix_mode_from_payload(
    payload: object,
    *,
    scope: CustomScope,
    mode_id: str | None = None,
    require_version: bool = True,
    where: str = "Fix Mode definition",
) -> FixMode:
    """Build a validated `FixMode` from a custom definition.

    Strict on purpose. An unknown key is an error rather than something ignored,
    because the realistic way to lose a section is to misspell it: a tolerant
    reader would take `"verfication"` as "no verification given" and the mode
    would quietly run without it. `source` is refused outright — the directory
    decides that, not the file.
    """
    if not isinstance(payload, dict):
        raise FixModeError(f"{where} must be a JSON object.")
    if "source" in payload:
        raise FixModeError(
            f"{where} must not set 'source'. A Fix Mode's scope comes from where it "
            "is stored, so a file cannot claim to be built-in."
        )
    unknown = sorted(set(payload) - _ALLOWED_KEYS)
    if unknown:
        raise FixModeError(
            f"{where} has unsupported field(s): {', '.join(unknown)}. Allowed: "
            f"{', '.join(sorted(_ALLOWED_KEYS))}."
        )
    declared = payload.get("schema_version", CUSTOM_SCHEMA_VERSION)
    if declared != CUSTOM_SCHEMA_VERSION:
        raise FixModeError(
            f"{where} has schema_version {declared!r}; this BugPilot understands "
            f"{CUSTOM_SCHEMA_VERSION}."
        )
    missing = [field for field in ("id", *_CONTENT_FIELDS) if field not in payload]
    if require_version and "version" not in payload:
        missing.append("version")
    if missing:
        raise FixModeError(f"{where} is missing required field(s): {', '.join(missing)}.")

    declared_id = payload["id"]
    if mode_id is not None and declared_id != mode_id:
        raise FixModeError(
            f"{where} declares id {declared_id!r} but belongs to {mode_id!r}. "
            "A custom Fix Mode's id and its file name must match."
        )
    version = (
        _require_managed_version(payload["version"], "Fix Mode version")
        if "version" in payload
        else 1
    )
    mode = FixMode(
        id=declared_id if isinstance(declared_id, str) else "",
        name=payload["name"],  # type: ignore[arg-type]
        description=payload["description"],  # type: ignore[arg-type]
        objective=payload["objective"],  # type: ignore[arg-type]
        investigation=payload["investigation"],  # type: ignore[arg-type]
        implementation=payload["implementation"],  # type: ignore[arg-type]
        verification=payload["verification"],  # type: ignore[arg-type]
        constraints=payload["constraints"],  # type: ignore[arg-type]
        completion=payload["completion"],  # type: ignore[arg-type]
        execution_kind=payload["execution_kind"],  # type: ignore[arg-type]
        source=scope,
        based_on=payload.get("based_on"),  # type: ignore[arg-type]
        based_on_version=payload.get("based_on_version"),  # type: ignore[arg-type]
        version=version,
    )
    mode.validate()
    _require_not_reserved(mode.id)
    return mode


class FixModeStore:
    """The two custom-mode directories, and everything done to them.

    Built per command rather than kept: these files are ordinary repository and
    home-directory config, and a long-lived copy in memory would answer with
    yesterday's content after a developer edited one in an editor.
    """

    def __init__(self, repo_root: Path | None = None, home_dir: Path | None = None) -> None:
        self._repo_root = Path(repo_root) if repo_root is not None else None
        # The user scope is `config/fix_modes` in BugPilot's data folder, from storage's checked accessor
        # (0.1.6 Batch 2B-2). An explicit `home_dir` is a folder of the caller's own, holding `fix_modes/`,
        # for tests of this store on its own; no product caller passes one.
        self._home_dir = Path(home_dir) if home_dir is not None else None

    # --- locations ---------------------------------------------------------

    def scope_dir(self, scope: str, *, create: bool = False) -> Path:
        """Where a scope's modes live. Not created by reading; ``create=True`` makes the user's folder ready."""
        _require_scope(scope)
        if scope == "user":
            if self._home_dir is not None:
                return self._home_dir / FIX_MODE_SUBDIR
            return storage.global_storage().user_fix_modes_dir(create=create)
        if self._repo_root is None:
            raise FixModeError(
                "Project Fix Modes need a repository. Run this from inside the "
                "repository you are working on, or use --scope user."
            )
        return repository_settings.fix_modes_dir(self._repo_root, create=create)

    def _shown(self, scope: str, path: Path) -> str:
        """A path in a scope's folder as messages name it: display form where storage owns the folder (US-D22)."""
        return storage.display_path(path) if self._through_storage(scope) else str(path)

    def mode_path(self, scope: str, mode_id: str) -> Path:
        """The one file a mode may occupy, checked to be inside its directory.

        The id is already restricted to lowercase letters, digits and hyphens,
        which leaves no room for a separator or a `..`. This checks the resolved
        path anyway: the id validator is a different function with a different
        job, and a containment rule that depends on another function's invariant
        is a containment rule that breaks when that function changes.
        """
        if not is_valid_fix_mode_id(mode_id):
            raise FixModeError(
                f"Invalid Fix Mode id {mode_id!r}. Use lowercase letters, digits and "
                "hyphens, starting with a letter."
            )
        directory = self.scope_dir(scope)
        # Before anything is built from it: one guard here covers read, create,
        # duplicate, update and delete, which all address a file through this.
        unsafe = _unsafe_directory_reason(directory, scope, lambda path: self._shown(scope, path))
        if unsafe:
            raise FixModeError(unsafe)
        candidate = directory / f"{mode_id}.json"
        base = _resolved(directory)
        resolved = _resolved(candidate)
        if resolved.parent != base:
            raise FixModeError(
                f"Refusing to work on {self._shown(scope, candidate)}: it resolves outside the "
                f"{scope} Fix Mode directory."
            )
        return candidate

    # --- reading -----------------------------------------------------------

    def load_catalog(self) -> FixModeCatalog:
        """Everything on disk, by scope, with unreadable files reported."""
        issues: list[FixModeIssue] = []
        user = self._load_scope("user", issues)
        project = self._load_scope("project", issues) if self._repo_root is not None else ()
        return FixModeCatalog(
            # Through the factory rather than the raw tuple: it is the packaged
            # set already validated, and one source for "what BugPilot ships"
            # keeps the reserved ids and the catalog from ever disagreeing.
            builtin=builtin_fix_mode_registry().list_modes(),
            user=user,
            project=project,
            issues=tuple(issues),
        )

    def effective_registry(self) -> FixModeRegistry:
        return self.load_catalog().effective_registry()

    def _load_scope(self, scope: str, issues: list[FixModeIssue]) -> tuple[FixMode, ...]:
        try:
            directory = self.scope_dir(scope)
        except FixModeError:
            return ()
        unsafe = _unsafe_directory_reason(directory, scope, lambda path: self._shown(scope, path))
        if unsafe:
            # Reported rather than raised: one unusable scope must not cost the
            # developer the built-ins and the other scope's modes. (Storage refuses
            # a link on the way first, for the scopes it owns: that fails the command.)
            issues.append(FixModeIssue(scope=scope, path=self._shown(scope, directory), message=unsafe))
            return ()
        if not directory.is_dir():
            return ()
        modes: list[FixMode] = []
        # Sorted, so two machines listing the same directory agree.
        for path in sorted(directory.glob("*.json")):
            try:
                modes.append(self._load_file(path, scope))
            except FixModeError as exc:
                # In display form where storage owns the folder (row 22, US-D22): never the user's folder name.
                issues.append(FixModeIssue(scope=scope, path=self._shown(scope, path), message=str(exc)))
        return tuple(modes)

    def _load_file(self, path: Path, scope: str) -> FixMode:
        if not path.is_file():
            raise FixModeError(f"{path.name} is not a file.")
        if path.is_symlink():
            # A link is a definition that lives somewhere else, under rules this
            # store does not set. Reading one would make the scope a lie.
            raise FixModeError(
                f"{path.name} is a symbolic link. Custom Fix Modes must be real "
                "files inside their scope directory."
            )
        try:
            raw = json.loads(path.read_text(encoding="utf-8"))
        except json.JSONDecodeError as exc:
            raise FixModeError(f"{path.name} is not valid JSON: {exc}.") from exc
        except OSError as exc:
            # The system error's class, never its text, which holds the absolute path (US-D22).
            raise FixModeError(f"{path.name} could not be read: {exc.strerror or type(exc).__name__}.") from exc
        return fix_mode_from_payload(
            raw,
            scope=scope,  # type: ignore[arg-type]
            mode_id=path.stem,
            require_version=True,
            where=path.name,
        )

    def read(self, scope: str, mode_id: str) -> FixMode:
        """One scope's definition of an id, for management rather than execution."""
        path = self.mode_path(scope, mode_id)
        if not path.exists():
            raise FixModeNotFoundError(
                f"No {scope} Fix Mode {mode_id!r}. Run: bugpilot fix-mode list --all-scopes"
            )
        return self._load_file(path, scope)

    # --- writing -----------------------------------------------------------

    def create(self, scope: str, mode_id: str, payload: object) -> FixMode:
        """A new custom mode, complete, at version 1.

        Deliberately does not fill missing sections from Standard Fix: a mode
        assembled half from a payload and half from a built-in is a mode nobody
        wrote. Starting from a built-in is what `duplicate` is for.
        """
        _require_scope(scope)
        _require_not_reserved(mode_id)
        path = self.mode_path(scope, mode_id)
        if path.exists():
            raise FixModeError(
                f"A {scope} Fix Mode {mode_id!r} already exists. Choose another id, "
                "or update the existing one."
            )
        mode = fix_mode_from_payload(
            payload,
            scope=scope,  # type: ignore[arg-type]
            mode_id=mode_id,
            require_version=False,
            where=f"{mode_id}.json",
        )
        # Version is managed here, not by whoever wrote the payload.
        mode = _with(mode, version=1)
        self._write(scope, path, mode)
        return mode

    def duplicate(
        self,
        source_id: str,
        new_id: str,
        scope: str,
        *,
        name: str | None = None,
        registry: FixModeRegistry | None = None,
    ) -> FixMode:
        """A complete, independent copy that remembers where it came from.

        `based_on` and `based_on_version` are audit metadata and nothing else:
        the copy carries every section itself, so the original can change or be
        deleted afterwards without touching it. There is no inheritance to break.
        """
        _require_scope(scope)
        _require_not_reserved(new_id)
        source = (registry or self.effective_registry()).resolve(source_id)
        copy = FixMode(
            id=new_id,
            name=name if name and name.strip() else f"{source.name} (copy)",
            description=source.description,
            objective=source.objective,
            investigation=source.investigation,
            implementation=source.implementation,
            verification=source.verification,
            constraints=source.constraints,
            completion=source.completion,
            execution_kind=source.execution_kind,
            source=scope,  # type: ignore[arg-type]
            based_on=source.id,
            based_on_version=source.version,
            version=1,
        )
        copy.validate()
        path = self.mode_path(scope, new_id)
        if path.exists():
            raise FixModeError(
                f"A {scope} Fix Mode {new_id!r} already exists. Choose another id."
            )
        self._write(scope, path, copy)
        return copy

    def update(self, scope: str, mode_id: str, payload: object, expected_version: object) -> FixMode:
        """Replace a custom mode's content, one version at a time.

        The version is BugPilot's to increment and the caller's to state: a
        client that could choose the next number could also skip past someone
        else's save. Everything — the payload, the expected version, the new
        definition — is checked before the file on disk is touched, so a refused
        update leaves exactly what was there.
        """
        _require_scope(scope)
        # Before the lookup: a built-in id is reserved, not merely absent from a
        # custom directory, and "No user Fix Mode 'standard'" would send the
        # developer looking for a file rather than telling them why.
        _require_not_reserved(mode_id)
        current = self.read(scope, mode_id)
        expected = _require_managed_version(expected_version, "expected_version")
        if expected != current.version:
            raise FixModeError(
                f"Fix Mode {mode_id!r} changed since this editor was opened "
                f"(expected version {expected}, found {current.version}). "
                "Reload it before saving."
            )
        updated = fix_mode_from_payload(
            payload,
            scope=scope,  # type: ignore[arg-type]
            mode_id=mode_id,
            require_version=False,
            where=f"{mode_id}.json",
        )
        # Identity, origin and version are not the payload's to change: an id
        # rename would orphan every work item that recorded it, and `based_on`
        # records where this mode came from rather than what it says today.
        updated = _with(
            updated,
            version=current.version + 1,
            based_on=current.based_on,
            based_on_version=current.based_on_version,
        )
        self._write(scope, self.mode_path(scope, mode_id), updated)
        return updated

    def delete(self, scope: str, mode_id: str, expected_version: object) -> FixMode:
        """Remove one custom mode, if it is still the version the caller saw."""
        _require_scope(scope)
        _require_not_reserved(mode_id)
        current = self.read(scope, mode_id)
        expected = _require_managed_version(expected_version, "expected_version")
        if expected != current.version:
            raise FixModeError(
                f"Fix Mode {mode_id!r} changed since it was listed "
                f"(expected version {expected}, found {current.version}). "
                "Reload it before deleting."
            )
        path = self.mode_path(scope, mode_id)
        if path.is_symlink():
            raise FixModeError(
                f"{path.name} is a symbolic link and will not be deleted through BugPilot."
            )
        if not self._through_storage(scope):
            path.unlink()
            return current
        try:
            (self.scope_dir(scope, create=True) / path.name).unlink()
        except StorageAccessError:
            raise  # already one sentence: the folder could not be made ready
        except OSError as error:
            raise StorageAccessError.during("delete", storage.display_path(path), error) from None
        return current

    def _write(self, scope: str, path: Path, mode: FixMode) -> None:
        if path.is_symlink():
            raise FixModeError(
                f"{path.name} is a symbolic link. BugPilot will not write through it."
            )
        text = json.dumps(custom_mode_payload(mode), indent=2, sort_keys=True) + "\n"
        if not self._through_storage(scope):
            path.parent.mkdir(parents=True, exist_ok=True)
            atomic_write_text(path, text)
            return
        try:
            # The folder made ready by storage (0700, link-checked); the file written inside it.
            atomic_write_text(self.scope_dir(scope, create=True) / path.name, text)
        except StorageAccessError:
            raise  # already one sentence: the folder could not be made ready
        except OSError as error:
            # Storage unavailable (C-1, F2-S): one sentence in the display form, never the system error's text.
            raise StorageAccessError.during("write", storage.display_path(path), error) from None

    def _through_storage(self, scope: str) -> bool:
        """Whether this scope's folder is BugPilot's own, in its data folder: the project's always (Batch 2B-3a),
        the user's unless a test gave a ``home_dir``."""
        return scope == "project" or self._home_dir is None


def _with(mode: FixMode, **changes: object) -> FixMode:
    from dataclasses import replace

    updated = replace(mode, **changes)  # type: ignore[arg-type]
    updated.validate()
    return updated


def _redirects_elsewhere(path: Path) -> bool:
    """Whether this path is a link that sends writes somewhere else.

    `resolve()` cannot answer this, and that is exactly how a symlinked store
    escaped containment: resolving *both* the base directory and the candidate
    file follows the same link, so the two agree and the check passes while the
    file lands outside the repository.

    The one link test BugPilot has (`safe_paths.is_link_or_junction`), shared
    with `clean` and `--fresh`: symbolic links everywhere, and on Windows every
    name-surrogate reparse point, junctions included.
    """
    return is_link_or_junction(path)


def _unsafe_directory_reason(directory: Path, scope: str, shown: Callable[[Path], str] = str) -> str | None:
    """Why this scope's directory may not be used, if it may not be.

    The store is `<config dir>/fix_modes` and `<namespace>/settings/fix_modes`,
    so both the directory and the folder holding it have to be real: a link at
    either level redirects the whole store. Storage refuses such a link first
    for the folders it owns; this guard is the store's own, kept as defence in
    depth. ``shown`` names the folder in the message (display form, US-D22).
    """
    for candidate in (directory, directory.parent):
        if _redirects_elsewhere(candidate):
            return (
                f"{shown(candidate)} is a symbolic link or junction. {scope.capitalize()} Fix "
                "Mode directories must be real directories, so that modes cannot be "
                "read from or written to somewhere else."
            )
    return None


def _resolved(path: Path) -> Path:
    """`resolve()` that also works for a path that does not exist yet."""
    try:
        return path.resolve()
    except OSError:  # pragma: no cover - only on an unreadable parent
        return path.absolute()


def catalog_for(repo_root: Path | None, home_dir: Path | None = None) -> FixModeCatalog:
    """Read every mode available to one repository. The common entry point."""
    return FixModeStore(repo_root, home_dir).load_catalog()


def effective_registry_for(
    repo_root: Path | None, home_dir: Path | None = None
) -> FixModeRegistry:
    """The registry an id resolves through for this repository."""
    return catalog_for(repo_root, home_dir).effective_registry()


def scoped_modes(catalog: FixModeCatalog) -> Iterable[tuple[str, FixMode]]:
    """Every physical definition with its scope, in listing order."""
    for scope in ("builtin", "user", "project"):
        for mode in catalog.scoped(scope):
            yield scope, mode
