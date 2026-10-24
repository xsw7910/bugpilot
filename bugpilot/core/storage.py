"""BugPilot's data folder: where every file BugPilot owns lives (0.1.6, plan §6–§8).

One folder, outside every repository::

    <data root>                 ~/.bugpilot, or $BUGPILOT_HOME
    ├── config/                 config.toml, instructions.md, fix_modes/
    └── repositories/
        └── <repository id>/    repository.json, settings/, work/, memory/

This module is the only code that knows the data root, a repository's ID or
the layout. In 0.1.6 Batch 1 nothing calls it yet: it is the foundation the
later batches move each reader and writer onto.

Its contracts (plan §8.1, §8.3):

- **Resolution never creates.** Computing a path reads at most the identity
  record and the links on the way; only :meth:`RepositoryStorage.ensure`,
  :meth:`GlobalStorage.ensure_config_dir` and an accessor called with
  ``create=True`` create anything.
- **The identity is computed, never accepted.** A repository's ID comes from
  its canonical path (:func:`repository_identity`); no function takes an ID
  as input, so one repository cannot be pointed at another's folder.
- **Folders are created one component at a time,** ``0700`` (never wider than
  the umask allows), each checked to be a real directory, not a link or
  junction, before and after it is created, and the result is compared with
  the canonical data root (``safe_paths.writable_dir``). The data root itself
  may be a link — the user's choice — and an existing data root's mode is
  never changed.
- **The identity record is never repaired or overwritten.** A record that
  names another repository, or cannot be read as one, is refused with one
  sentence; the developer may delete it. A new record is published by hard
  link, so a reader never sees half of one and an existing one is never
  replaced.
- **Messages never hold an absolute path:** they use :func:`display_path`.
  A failure of the system itself (an ``OSError``) is mostly not translated;
  where it is (an unreadable record, a deletion that cannot finish) it is a
  :class:`StorageUnavailable`, never a policy refusal. Which error code either
  maps to is the owner's choice (US-D26, ``STORAGE_UNAVAILABLE``).
- **No legacy reads.** Nothing here reads, copies or migrates the folders
  BugPilot 0.1.5 kept inside a repository, or the 0.1.5 files at the top of
  the data root.

Batch 2A added three guarantees, still before any caller uses this module:

- **Never inside a Git working tree** (findings G-1, G-2). A data root that is,
  or is below, a folder holding a ``.git`` entry (a folder, or the file of a
  linked worktree, a submodule or ``--separate-git-dir``), or that lies inside
  the working tree ``GIT_WORK_TREE`` names, is refused for reads and writes,
  global and repository alike. The repository's own scope stays the folder
  BugPilot runs in (US-D4); only the data root is judged.
- **Credentials only where they are private** (G-3). ``config/config.toml`` is
  written only after the data root, ``config/`` and any existing file are
  proven private (:mod:`private_folder`); nothing ever changes a permission.
- **No stale verdict** (cache freshness). A cached repository identity is
  re-checked against the folder on every use; containment, Git working-tree
  and record verdicts live only as long as one :func:`request_scope`.

Batch 2B-1 prepared the switch of callers, still before any caller uses it:

- **Thread-safe identities** (finding C-1): the identity cache is used under
  one lock, so the MCP server's worker threads can share it.
- **Scopes that are never shared** (C-2): a request scope belongs to the
  thread that opened it, so requests that copy one context never share one.
- **Checked deletion:** :meth:`RepositoryStorage.remove_work_item` and
  :meth:`RepositoryStorage.remove_memory_file`, for ``clean``.
- **Checks that never raise:** ``check()`` on both storages, for ``doctor``
  (:class:`StorageCheck`).

Option C added reads that follow no link, still before any caller uses them:
:meth:`RepositoryStorage.read_settings`, :meth:`~RepositoryStorage.read_fix_mode`,
:meth:`GlobalStorage.read_user_instructions`, :meth:`~GlobalStorage.read_user_fix_mode`
and :meth:`~GlobalStorage.read_config` return a file's bytes
(:class:`SettingsContent`), not a path for the caller to open, and the two
``fix_mode_names`` methods list a Fix Mode folder. Every folder from the data
root down stays held open while the file is opened and read
(:mod:`._held_folders`); the checks and their words are the path accessors'.

Standard library only; Python 3.10 and later.
"""

from __future__ import annotations

import contextlib
import errno
import hashlib
import json
import ntpath
import os
import posixpath
import re
import stat
import tempfile
import threading
import time
import unicodedata
from collections import OrderedDict
from contextvars import ContextVar
from dataclasses import dataclass
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Any, Callable, Iterator, Literal, TypeVar

from . import _held_folders, private_folder
from .artifact_io import _check_temp, atomic_write_text
from .identity import is_work_item_id, validate_work_item_id
from .safe_paths import (
    UnsafePathError,
    _check_parts,
    _write_refusal,
    is_link_or_junction,
    is_link_stat,
    refuse_link,
    remove_owned_path,
    writable_dir,
)

__all__ = [
    "CREDENTIALS_NAME",
    "DATA_ROOT_ENV",
    "DATA_ROOT_BOUNDARY",
    "DIRECTORY_MODE",
    "GIT_WORK_TREE_ENV",
    "GlobalStorage",
    "RECORD_NAME",
    "REPOSITORY_ID_RE",
    "RecordState",
    "RepositoryIdentity",
    "RepositoryStorage",
    "SETTINGS_NAMES",
    "STORAGE_LAYOUT_VERSION",
    "SettingsContent",
    "SettingsName",
    "StorageCheck",
    "StorageError",
    "StorageFileReadError",
    "StorageIdentityError",
    "StorageUnavailable",
    "WorkItemEntry",
    "data_root",
    "data_root_source",
    "display_path",
    "global_storage",
    "repository_id_for",
    "repository_identity",
    "repository_storage",
    "request_scope",
]

#: Names the whole data root when set (US-D3). Blank counts as unset.
DATA_ROOT_ENV = "BUGPILOT_HOME"
#: The default data root's name, in the home folder.
DEFAULT_DATA_DIR_NAME = ".bugpilot"
#: The identity record's ``schema_version``.
STORAGE_LAYOUT_VERSION = 1
RECORD_NAME = "repository.json"
#: How a refusal names the folder BugPilot writes into.
DATA_ROOT_BOUNDARY = "BugPilot's data folder"
#: Every folder BugPilot creates under the data root (US-D23).
DIRECTORY_MODE = 0o700
#: A repository ID (§7.2): a display slug, then 64 bits of SHA-256.
REPOSITORY_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,23}-[0-9a-f]{16}$")
#: The one file under ``config/`` that holds a credential (the CLI's Jira token, plan §6.1). Only it is privacy-gated.
CREDENTIALS_NAME = "config.toml"
#: Names a Git working tree explicitly; a data root inside it is refused like one inside a checkout (G-1).
GIT_WORK_TREE_ENV = "GIT_WORK_TREE"
#: What marks a Git working tree's top: a folder, or a file (a linked worktree, a submodule, ``--separate-git-dir``).
GIT_MARKER = ".git"
#: The closed set of files under ``settings/``; nothing else can be addressed there.
SETTINGS_NAMES = frozenset(
    {"instructions.md", "verification.md", "ai_behavior.md", "project_settings.json", "repository_profile.json"}
)

SettingsName = Literal[
    "instructions.md", "verification.md", "ai_behavior.md", "project_settings.json", "repository_profile.json"
]
RecordState = Literal["absent", "ok", "missing-record", "mismatch", "corrupt"]

#: The versioned domain of the identity hash: a new algorithm gives new IDs deliberately.
_IDENTITY_DOMAIN = b"bugpilot-repository-v1\0"
_SLUG_LIMIT = 24
_SLUG_EDGES = "._-"
#: C0 and C1 controls, DEL, and the Unicode line and paragraph separators.
_FORBIDDEN_IN_ROOT = re.compile("[\x00-\x1f\x7f-\x9f\u2028\u2029]")
#: A record is three short fields; anything larger is not one.
_RECORD_LIMIT = 64 * 1024
_RECORD_KEYS = frozenset({"schema_version", "repository_id", "root"})
#: Windows renames without replacing (``os.rename`` raises when the name exists); POSIX renames replace.
_RENAME_NEVER_REPLACES = os.name == "nt"
#: A file another process holds open on Windows cannot be read or removed for a moment: bounded retries.
_TRANSIENT_ATTEMPTS = 5
_TRANSIENT_DELAY = 0.02
#: ``os.link`` errors that mean "this file system has no hard links", not a refusal of this one link.
_NO_HARD_LINKS = frozenset(
    code
    for code in (getattr(errno, name, None) for name in ("EPERM", "EOPNOTSUPP", "ENOTSUP", "ENOSYS", "EXDEV", "EMLINK"))
    if code is not None
)
#: Repository identities remembered per process, each with the file identity it was computed for.
_IDENTITY_CACHE_LIMIT = 128
#: The user Instructions file under ``config/``.
_USER_INSTRUCTIONS_NAME = "instructions.md"

_T = TypeVar("_T")


class StorageError(UnsafePathError):
    """BugPilot's data folder cannot be used as asked. One sentence; never an absolute path.

    An :class:`~bugpilot.core.safe_paths.UnsafePathError`, so every entry point
    already reports it as one sentence (``ERROR: …``, or ``INVALID_INPUT`` in
    JSON), never as a traceback.
    """


class StorageIdentityError(StorageError):
    """A repository's identity record names another repository, or is not a readable record (§7.5)."""


class StorageUnavailable(StorageError):
    """The data folder cannot be read or written right now: a file in use, no permission, a failed deletion.

    Not a policy refusal: the same request may succeed later. Still a
    :class:`StorageError`, so every entry point reports it as one sentence;
    which error code it maps to is still open (``STORAGE_UNAVAILABLE``, US-D26).
    """


class StorageFileReadError(OSError):
    """The file a held read reached could not be opened or read: the file itself, never a folder on the way (M2).

    Raised only by the readers that return :class:`SettingsContent`, and only for the final file, so a
    consumer can keep its own handling of a file it cannot read (a warning, the defaults) while a folder that
    cannot be read, and every refusal, still fails the command. An ``OSError``, with the original's number;
    ``strerror`` is that number's standard text (``os.strerror``), as an error from Python's own ``open``
    carries, never a path. ``error`` is the original, without its path.
    """

    def __init__(self, error: OSError) -> None:
        if error.errno is None:
            super().__init__(error.strerror or type(error).__name__)
        else:
            super().__init__(error.errno, os.strerror(error.errno))
        self.error = error


# --- the data root ----------------------------------------------------------------------------


def _configured_root() -> Path | None:
    raw = os.environ.get(DATA_ROOT_ENV)
    if raw is None or not raw.strip():
        return None
    if _FORBIDDEN_IN_ROOT.search(raw):
        raise StorageError(
            f"{DATA_ROOT_ENV} holds a control or line-separator character; set it to a plain absolute path."
        )
    path = Path(raw.strip())
    if not path.is_absolute():
        raise StorageError(
            f"{DATA_ROOT_ENV} must be an absolute path. A leading ~ is not expanded; write the full path."
        )
    return path


def _configured_or_default_root() -> Path:
    """The data root as configured: ``$BUGPILOT_HOME``, or the default under the home folder. Not yet canonical."""
    configured = _configured_root()
    if configured is not None:
        return configured
    try:
        home = Path.home()
    except (RuntimeError, KeyError, OSError):
        home = None
    if home is None or not home.is_absolute():
        raise StorageError(
            f"BugPilot cannot find your home folder, so it cannot locate its data folder. "
            f"Set {DATA_ROOT_ENV} to an absolute path."
        )
    return home / DEFAULT_DATA_DIR_NAME


def data_root() -> Path:
    """The data root, canonical: ``$BUGPILOT_HOME`` when set, else ``~/.bugpilot`` (plan §8.2, US-D34). Never creates.

    ``BUGPILOT_HOME`` must be absolute and free of control characters; a blank
    value counts as unset. A home folder that cannot be found, or is not
    absolute, is refused rather than guessed.

    The result is canonical (``realpath``, non-strict): links and ``..`` in the
    part that exists are resolved, as §8.10's ``abs`` values require. The data
    root may still be a link the user chose (B4-2): every path is then
    computed in its target, where the writes land anyway.
    """
    return Path(os.path.realpath(_configured_or_default_root()))


def data_root_source() -> Literal["default", "BUGPILOT_HOME"]:
    """Where :func:`data_root` came from."""
    return "BUGPILOT_HOME" if _configured_root() is not None else "default"


def display_path(path: str | os.PathLike[str]) -> str:
    """A path inside the data root as messages show it: ``~/.bugpilot/…`` or ``BUGPILOT_HOME/…`` (US-D22).

    Never the user's own folder name. A path outside the data root is a
    programming error (``ValueError``): BugPilot only names its own files.
    The path may be given in the canonical form or as configured.
    """
    configured = _configured_or_default_root()
    prefix = DATA_ROOT_ENV if data_root_source() == "BUGPILOT_HOME" else f"~/{DEFAULT_DATA_DIR_NAME}"
    target = os.path.abspath(os.fspath(path))
    for base in (os.path.realpath(configured), os.path.abspath(configured)):
        parts = _parts_below(target, base)
        if parts is not None:
            return "/".join((prefix, *parts))
    raise ValueError("display_path() names only paths inside BugPilot's data folder")


def _parts_below(target: str, base: str) -> list[str] | None:
    """``target``'s own components below ``base``, compared component by component (never by text prefix).

    Each component is compared folded (``normcase``) but returned as written,
    so a fold that changes a component's length cannot shift what is shown.
    """
    target_parts, base_parts = Path(target).parts, Path(base).parts
    if len(target_parts) < len(base_parts):
        return None
    for mine, theirs in zip(target_parts, base_parts):
        if os.path.normcase(mine) != os.path.normcase(theirs):
            return None
    return list(target_parts[len(base_parts) :])


# --- repository identity -----------------------------------------------------------------------


@dataclass(frozen=True)
class RepositoryIdentity:
    """Who a repository is, computed from the folder BugPilot runs in (§7.2)."""

    repository_id: str  # "<slug>-<16 hex>"
    root: Path  # canonical (realpath) form: the record and diagnostics hold it
    key: str  # what is hashed: normcase(root) on Windows, root elsewhere


def _slug(basename: str) -> str:
    """Display only, never uniqueness: NFKD, ASCII, lower case, a fixed character class, at most 24.

    The ends are stripped of ``.``, ``-`` and ``_`` so that every ID starts
    with a letter or digit, as §7.2's pattern requires.
    """
    text = unicodedata.normalize("NFKD", basename).encode("ascii", "ignore").decode("ascii").lower()
    text = re.sub(r"[^a-z0-9._-]+", "-", text).strip(_SLUG_EDGES)
    text = text[:_SLUG_LIMIT].strip(_SLUG_EDGES)
    return text or "repository"


def _is_profile_folder(canonical: str, windows: bool) -> bool:
    """A user's own profile folder: ``C:\\Users\\<name>``, ``/home/<name>``, ``/Users/<name>``, ``/root``.

    A pure function of the path (never of ``HOME``), so the same folder always
    gets the same ID. Its name is the account name, which a repository ID, and
    so a display path, must not carry (US-D22). Profiles kept elsewhere are not
    recognized: a stated limit.
    """
    if windows:
        parts = PureWindowsPath(canonical).parts
        return len(parts) == 3 and parts[1].lower() == "users"
    parts = PurePosixPath(canonical).parts
    return (len(parts) == 3 and parts[1] in ("home", "Users")) or parts == ("/", "root")


def _slug_for(canonical: str, windows: bool) -> str:
    if _is_profile_folder(canonical, windows):
        return "home"
    return _slug((ntpath if windows else posixpath).basename(canonical))


def _encode_key(key: str) -> bytes:
    try:
        return key.encode("utf-8", "surrogateescape")  # POSIX: undecodable bytes hash as themselves
    except UnicodeEncodeError:
        return key.encode("utf-8", "surrogatepass")  # Windows: a lone surrogate in a file name


def _id_of(key: str, slug: str) -> str:
    digest = hashlib.sha256(_IDENTITY_DOMAIN + _encode_key(key)).hexdigest()
    repository_id = f"{slug}-{digest[:16]}"
    if not REPOSITORY_ID_RE.fullmatch(repository_id):  # pragma: no cover - the construction guarantees it
        raise StorageError("BugPilot computed an invalid repository ID; nothing was written.")
    return repository_id


def repository_id_for(canonical: str, *, windows: bool | None = None) -> str:
    """The repository ID of a canonical root path (§7.2): pure, no file-system access.

    ``windows`` chooses Windows' rules (``normcase`` folds case and separators)
    or POSIX's (none); it defaults to this platform's. Used for the golden
    vectors that pin the algorithm on every operating system.
    """
    if windows is None:
        windows = os.name == "nt"
    key = ntpath.normcase(canonical) if windows else canonical
    return _id_of(key, _slug_for(canonical, windows))


def repository_identity(repo_root: str | os.PathLike[str]) -> RepositoryIdentity:
    """The identity of the repository at ``repo_root``: the folder BugPilot runs in (§7.1, §7.2).

    ``realpath(strict=True)`` resolves links, junctions, ``.``/``..`` and
    separators, and refuses a folder that does not exist. No git discovery,
    no remote URL, no inode in the ID.

    Remembered per process and spelling, but never trusted blindly (Batch 2A):
    every use first looks at the spelling again (one ``stat``, following links)
    and compares the folder's device and file index with the canonical folder's
    at the time. A link or junction retargeted since, or a spelling that now
    names another folder, is resolved afresh, so a long-running process (the
    MCP server binds its root once) never keeps writing to the namespace of a
    folder it no longer runs in. A file index of 0 proves nothing: such an
    identity is resolved every time and never cached.

    Thread-safe (Batch 2B-1, finding C-1): the MCP server runs tools in worker
    threads, and its read-only tools take no lock of their own. Every look at,
    or change of, the remembered identities happens under ``_identities_lock``:
    a lookup and its reordering are one step, so another thread's removal can
    never fall between them. ``realpath`` runs outside the lock; an identity is
    published only if, at that moment and under the lock, the spelling still
    names the folder it was computed for.
    """
    try:
        given = os.fspath(repo_root)
        if not isinstance(given, str):
            raise TypeError("a text path is required")
        absolute = os.path.abspath(given)
    except (TypeError, ValueError):
        raise StorageError("BugPilot cannot use that repository folder: its path is not valid.") from None
    try:
        now = os.stat(absolute)
    except (OSError, ValueError):
        _forget_identity(absolute)
        return _identity(absolute)  # raises the one-sentence refusal for a missing or unresolvable folder
    file_id = (now.st_dev, now.st_ino)
    with _identities_lock:
        remembered = _identities.get(absolute)
        if remembered is not None and now.st_ino != 0 and file_id == remembered[1]:
            _identities.move_to_end(absolute)
            return remembered[0]
    identity = _identity(absolute)  # the slow part, outside the lock
    try:
        resolved = os.stat(identity.root)
    except OSError:
        _forget_identity(absolute)
        return identity
    if resolved.st_ino == 0 or (resolved.st_dev, resolved.st_ino) != file_id:
        _forget_identity(absolute)  # no stable file identity, or it changed meanwhile: do not remember
        return identity
    with _identities_lock:
        try:
            current = os.stat(absolute)
        except (OSError, ValueError):
            current = None
        if current is None or current.st_ino == 0 or (current.st_dev, current.st_ino) != file_id:
            _identities.pop(absolute, None)  # retargeted while it was resolved: publish nothing stale
            return identity
        _identities[absolute] = (identity, file_id)
        _identities.move_to_end(absolute)
        while len(_identities) > _IDENTITY_CACHE_LIMIT:
            _identities.popitem(last=False)
    return identity


def _forget_identity(absolute: str) -> None:
    with _identities_lock:
        _identities.pop(absolute, None)


#: spelling (absolute) -> (identity, (st_dev, st_ino) of its canonical folder when it was computed)
_identities: OrderedDict[str, tuple[RepositoryIdentity, tuple[int, int]]] = OrderedDict()
#: Guards every access to ``_identities``; never held across ``realpath`` or another lock.
_identities_lock = threading.Lock()


def _identity(absolute: str) -> RepositoryIdentity:
    try:
        canonical = os.path.realpath(absolute, strict=True)
    except (OSError, ValueError):
        raise StorageError(
            "BugPilot cannot use this repository folder: it does not exist or cannot be resolved."
        ) from None
    if not os.path.isdir(canonical):
        raise StorageError("BugPilot cannot use this repository folder: it is not a folder.")
    windows = os.name == "nt"
    key = os.path.normcase(canonical) if windows else canonical
    return RepositoryIdentity(_id_of(key, _slug_for(canonical, windows)), Path(canonical), key)


# --- folders and files under the data root -----------------------------------------------------


def _ensure_root(root: Path) -> None:
    """The data root is a folder. Created ``0700`` when missing; an existing one is never changed.

    It may be a link or junction (the user's choice, owner decision B4-2), so
    this follows it. Its parent is never created: a missing home, or a missing
    folder above ``BUGPILOT_HOME``, is refused.
    """
    if os.path.isdir(root):
        return
    # What is at the name is judged only after the attempt: another process may create the folder between two
    # looks, and a missing root must not be reported as "not a folder" (CI run 39194849242). A file or a link
    # there makes mkdir fail with FileExistsError, and the look after it refuses anything that is not a folder.
    try:
        root.mkdir(mode=DIRECTORY_MODE)
    except FileExistsError:
        if not os.path.isdir(root):
            raise StorageError(
                f"BugPilot cannot use {display_path(root)} as its data folder: it is not a folder."
            ) from None
    except FileNotFoundError:
        raise StorageError(
            f"BugPilot cannot create its data folder {display_path(root)}: "
            "the folder that should contain it does not exist."
        ) from None


def _directory(root: Path, parts: tuple[str, ...], *, create: bool) -> Path:
    """``root / parts`` for a write: every component a real directory, created ``0700`` (``safe_paths.writable_dir``).

    Missing components are created one at a time, each checked before and
    after, and the result is compared with the canonical data root (§8.3).
    """
    try:
        return writable_dir(root, parts, create=create, mode=DIRECTORY_MODE, boundary=DATA_ROOT_BOUNDARY)
    except StorageError:
        raise
    except UnsafePathError as error:
        raise StorageError(str(error)) from None


def _existing(
    root: Path, parts: tuple[str, ...], *, refusal: Callable[[tuple[str, ...], str], str] | None = None
) -> Path:
    """``root / parts`` for a read: every component that exists is a real directory, never a link. Creates nothing.

    The read contract of §8.3: the path is returned whether or not it exists
    (the caller reports "not prepared"), and a link or junction on the way is
    refused, checked component by component as it stands, never followed.
    Unlike a write, nothing is created that could land elsewhere, so the
    canonical comparison a write makes (``_directory``) is not repeated here.
    Every component is first checked to be a plain name (no separator, ``.``,
    ``..`` or empty part), as a write's are: defence in depth, since every
    caller builds them from validated ids and fixed names. ``refusal`` words
    the refusal (a deletion says what it did not delete); a read's by default.
    """
    refuse = refusal or _read_refusal
    try:
        _check_parts(parts)
    except UnsafePathError as error:
        raise StorageError(str(error)) from None
    current = root
    for index, part in enumerate(parts):
        current = current / part
        try:
            info = os.lstat(current)  # one look per component, never followed
        except (FileNotFoundError, NotADirectoryError):
            return root.joinpath(*parts)
        shown = "/".join(parts[: index + 1])
        if is_link_stat(info):
            raise StorageError(refuse(parts, f"{shown} is a symbolic link or junction"))
        if not stat.S_ISDIR(info.st_mode):
            raise StorageError(refuse(parts, f"{shown} is not a directory"))
    return current


def _read_refusal(parts: tuple[str, ...], reason: str) -> str:
    return (
        f"BugPilot cannot read {'/'.join(parts)}: {reason}. BugPilot reads its files only from real "
        f"directories inside {DATA_ROOT_BOUNDARY}, and never through a link. Nothing was read."
    )


def _file(path: Path) -> Path:
    """``path`` itself, unless it is a link or junction (refused for reads too, §8.3)."""
    try:
        return refuse_link(path, boundary=DATA_ROOT_BOUNDARY)
    except UnsafePathError as error:
        raise StorageError(str(error)) from None


def _validated(work_item_id: str) -> str:
    try:
        validate_work_item_id(work_item_id)
    except ValueError as error:
        raise StorageError(str(error)) from None
    return work_item_id


# --- request scopes: how long a verdict may be trusted -------------------------------------------

class _Scope(dict):
    """The verdicts of one request scope, and the thread that opened it."""

    __slots__ = ("owner",)

    def __init__(self) -> None:
        super().__init__()
        self.owner = threading.current_thread()  # held, so it cannot be reused by a later thread


#: The current request scope, or None outside one. Read it through :func:`_active_scope`.
_scope: ContextVar[_Scope | None] = ContextVar("bugpilot_storage_scope", default=None)


def _active_scope() -> _Scope | None:
    """The request scope this thread opened, or None.

    A context copied into another thread (``contextvars.copy_context().run``,
    as ``anyio.to_thread.run_sync`` does for every MCP tool call) carries the
    same scope object with it. That scope belongs to the thread that opened it:
    anywhere else it counts as no scope at all, so two requests can never share
    verdicts through a context they both copied (Batch 2B-1, finding C-2).
    """
    scope = _scope.get()
    if scope is None or scope.owner is not threading.current_thread():
        return None
    return scope


@contextlib.contextmanager
def request_scope() -> Iterator[None]:
    """One bounded operation: within it, each containment, Git working-tree and record verdict is computed once.

    Outside any scope nothing is remembered, so every check looks at the disk
    again. Each public operation of this module opens one, so one operation
    never checks the same thing twice; a caller that makes several calls opens
    one around them, so that a ``.git`` created, or a link changed, between two
    operations is seen by the next one.

    The invariants (Batch 2B-1, C-2):

    - every outermost scope gets a new, empty set of verdicts, never reused,
      and drops it when it ends, by an exception or a cancellation too;
    - a scope opened inside another one, in the same thread, joins it: the
      outermost scope decides how long verdicts live;
    - a scope belongs to the thread that opened it (:func:`_active_scope`).
      A worker thread, even one that inherited or copied the context, starts
      without one, and its own scope is separate. Two asyncio tasks in one
      thread are separate only if neither inherits a context in which a scope
      is already open, so a server must never open one in a context its
      requests are copied from;
    - a long-running loop must never be wrapped in a single scope.

    Not wired yet: the CLI opening one per command is Batch 2B consumer work,
    and the MCP server opening one per tool call, inside the worker thread, is
    a mandatory Batch 2B-5 gate.
    """
    if _active_scope() is not None:
        yield
        return
    token = _scope.set(_Scope())
    try:
        yield
    finally:
        _scope.reset(token)


def _scoped(key: tuple[Any, ...], compute: Callable[[], _T]) -> _T:
    """``compute()``, remembered for the current request scope only; computed every time outside one."""
    verdicts = _active_scope()
    if verdicts is None:
        return compute()
    if key not in verdicts:
        verdicts[key] = compute()
    return verdicts[key]


# --- the identity record -----------------------------------------------------------------------


def _record_signature(info: os.stat_result, identity: RepositoryIdentity) -> tuple[Any, ...]:
    """What must be unchanged for a record verified earlier in this scope to count as verified now.

    ``st_ctime_ns`` is the last change of the file's metadata on POSIX, which a
    rewrite cannot set back; on Windows it is the creation time, which adds
    nothing, so it is left out there.
    """
    changed = info.st_ctime_ns if os.name != "nt" else 0
    return (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, changed, str(identity.root))


def _record_text(identity: RepositoryIdentity) -> str:
    """Deterministic: no timestamp, no host. Two processes write identical bytes (§7.5, §8.7)."""
    record = {
        "schema_version": STORAGE_LAYOUT_VERSION,
        "repository_id": identity.repository_id,
        "root": str(identity.root),
    }
    return json.dumps(record, indent=2, ensure_ascii=True) + "\n"


def _read_regular(path: Path, expected: os.stat_result) -> bytes:
    """The bytes of the regular file at ``path``, provided it is still the file ``expected`` describes."""
    flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_BINARY", 0)
    handle = os.open(path, flags)
    try:
        opened = os.fstat(handle)
        if (opened.st_dev, opened.st_ino) != (expected.st_dev, expected.st_ino) or not stat.S_ISREG(opened.st_mode):
            raise OSError("the record changed while it was read")
        chunks = []
        remaining = _RECORD_LIMIT + 1
        while remaining > 0:
            chunk = os.read(handle, remaining)
            if not chunk:
                break
            chunks.append(chunk)
            remaining -= len(chunk)
        return b"".join(chunks)
    finally:
        os.close(handle)


def _transient(action):
    """Run ``action``, retrying a bounded number of times while it raises ``PermissionError``.

    On Windows a file another process has open (a reader, an antivirus scan)
    can refuse to be opened or removed for a moment. The last
    ``PermissionError`` is raised when the retries are used up.
    """
    for attempt in range(_TRANSIENT_ATTEMPTS):
        try:
            return action()
        except PermissionError:
            if attempt == _TRANSIENT_ATTEMPTS - 1:
                raise
            time.sleep(_TRANSIENT_DELAY)
    raise AssertionError("not reached")  # pragma: no cover


def _unreadable(path: Path) -> StorageUnavailable:
    """A record that cannot be read now (in use, or no permission): not a corrupt one, and never "delete it"."""
    return StorageUnavailable(
        f"BugPilot cannot read {display_path(path)} right now: it is in use or not readable. "
        "Nothing was read or written; try again, and check the folder's permissions if it persists."
    )


def _same_folder(first: str | os.PathLike[str], second: str | os.PathLike[str]) -> bool:
    """Whether two paths name one folder on disk (device and file index), when that can be established.

    A file index of 0 (some file systems report none) establishes nothing, and
    a path that cannot be examined is not the same folder: both fail closed.
    """
    try:
        one, other = os.stat(first), os.stat(second)
    except (OSError, ValueError):
        return False
    return one.st_ino != 0 and (one.st_dev, one.st_ino) == (other.st_dev, other.st_ino)


def _renamed_by_case_only(recorded_root: str, identity: RepositoryIdentity) -> bool:
    """The record names this repository's folder as it was spelled before a case-only rename (Windows).

    Accepted only when the folded keys are equal **and** the recorded spelling
    still resolves to this very folder. Two different folders whose keys
    collide (case-sensitive Windows folders) are not the same folder, and a
    recorded spelling that no longer resolves cannot be proven to be: both are
    refused. The record itself is never rewritten.
    """
    if os.name != "nt" or os.path.normcase(recorded_root) != identity.key:
        return False
    return _same_folder(recorded_root, identity.root)


def _record_state(path: Path, identity: RepositoryIdentity) -> RecordState:
    """What the record at ``path`` says about ``identity``: ok, missing, mismatch or corrupt (§7.5).

    A record that cannot be read at the moment (a sharing violation that
    outlasts the retries, or no permission) is not reported as corrupt: it
    raises :class:`StorageError` saying so, and nothing is written.

    A record verified earlier in the same request scope, and unchanged since
    (:func:`_record_signature`), is not read again; outside a scope it always is.
    """
    try:
        info = _transient(lambda: os.lstat(path))
    except FileNotFoundError:
        return "missing-record"
    except PermissionError:
        raise _unreadable(path) from None
    except OSError:
        return "corrupt"
    signature = _record_signature(info, identity)
    verdicts = _active_scope()
    key = ("record", str(path))
    if verdicts is not None and verdicts.get(key) == signature:
        return "ok"
    if not stat.S_ISREG(info.st_mode) or is_link_or_junction(path) or info.st_size > _RECORD_LIMIT:
        return "corrupt"
    try:
        data = _transient(lambda: _read_regular(path, info))
    except FileNotFoundError:
        return "missing-record"  # removed between the look and the read
    except PermissionError:
        raise _unreadable(path) from None
    except OSError:
        return "corrupt"  # a link swapped in, or the record changed while it was read
    state = _record_verdict(data, identity)
    if state == "ok" and verdicts is not None:
        verdicts[key] = signature
    return state


def _held_record_state(
    namespace: _held_folders.Folder, path: Path, identity: RepositoryIdentity, parts: tuple[str, ...]
) -> RecordState:
    """:func:`_record_state` for a namespace held open: the record opened in it as itself, never by its path (Option C).

    The same verdicts, words and request-scope memory (the same key and
    :func:`_record_signature`, here from the opened record itself), so a record
    verified by either one counts for the other.
    """
    try:
        opened = _transient(lambda: namespace.open_file(RECORD_NAME))
    except _held_folders.FolderFailed as failed:
        raise failed.error from None  # the namespace's own failure, as any folder's: fatal, never the record's state
    except PermissionError:
        raise _unreadable(path) from None
    except _held_folders.Refused as refused:
        raise StorageError(
            _read_refusal((*parts, RECORD_NAME), _HELD_REASONS[refused.reason].format(RECORD_NAME))
        ) from None
    except OSError:
        return "corrupt"
    if opened.kind == "absent":
        return "missing-record"
    if opened.kind != "file" or opened.info is None:
        return "corrupt"  # a link, a folder or anything else at the name is not a record
    signature = _record_signature(opened.info, identity)
    verdicts = _active_scope()
    key = ("record", str(path))
    if verdicts is not None and verdicts.get(key) == signature:
        return "ok"
    if opened.info.st_size > _RECORD_LIMIT:
        return "corrupt"
    try:
        data = opened.read(_RECORD_LIMIT)
    except PermissionError:
        raise _unreadable(path) from None
    except OSError:
        return "corrupt"
    if data is None:
        return "corrupt"
    state = _record_verdict(data, identity)
    if state == "ok" and verdicts is not None:
        verdicts[key] = signature
    return state


def _record_verdict(data: bytes, identity: RepositoryIdentity) -> RecordState:
    """What a record's bytes say about ``identity``: ok, mismatch or corrupt (§7.5)."""
    try:
        record = json.loads(data.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        return "corrupt"
    if not isinstance(record, dict) or set(record) != _RECORD_KEYS:
        return "corrupt"
    version, recorded_id, recorded_root = record["schema_version"], record["repository_id"], record["root"]
    if type(version) is not int or version != STORAGE_LAYOUT_VERSION:
        return "corrupt"
    if not isinstance(recorded_id, str) or not isinstance(recorded_root, str) or recorded_id != identity.repository_id:
        return "corrupt"
    # The canonical root must match exactly: two folders whose keys collide (case-sensitive Windows
    # folders, a hash collision) are refused, never merged (§7.3, §7.5). The one exception is this
    # same folder after a case-only rename, proven by its file identity, not by its folded spelling.
    if recorded_root != str(identity.root) and not _renamed_by_case_only(recorded_root, identity):
        return "mismatch"
    return "ok"


def _publish_record(path: Path, text: str) -> None:
    """Publish the record without ever replacing one (§7.5; review finding M1).

    The text goes into a private temp file (``mkstemp``: exclusive create,
    ``0600``, checked by ``_check_temp``) in the record's own folder, so on
    the same file system, and is complete and closed before it gets the
    record's name. It gets that name only by an operation that fails when the
    name exists:

    - ``os.link``, everywhere it is supported: atomic, and it never replaces
      or follows what is at the name;
    - where the file system has no hard links, ``os.rename`` on Windows, which
      raises rather than replace;
    - otherwise (POSIX without hard links) nothing: BugPilot refuses with one
      sentence rather than risk replacing a record. There is no
      check-then-replace step anywhere.

    A concurrent publisher's record, identical or the evidence of a collision,
    is therefore kept; the caller verifies whatever is at the name. The temp
    file is then removed best-effort (:func:`_remove_temp`).
    """
    handle, name = tempfile.mkstemp(dir=path.parent, prefix=f".{RECORD_NAME}.", suffix=".tmp")
    temp = Path(name)
    try:
        try:
            _check_temp(handle, temp, path)
            stream = os.fdopen(handle, "w", encoding="utf-8", newline="\n")
        except BaseException:
            os.close(handle)
            raise
        with stream:
            stream.write(text)
        _name_without_replacing(temp, path)
    except UnsafePathError as error:
        raise StorageError(str(error)) from None
    finally:
        _remove_temp(temp)


def _name_without_replacing(temp: Path, path: Path) -> None:
    """Give ``temp``'s file the name ``path`` only if no file has it: never a replacement."""
    try:
        os.link(temp, path)
        return
    except FileExistsError:
        return  # another publisher won; the caller verifies what is there
    except OSError as error:
        link_error = error
    if _RENAME_NEVER_REPLACES:
        try:
            os.rename(temp, path)  # Windows: raises FileExistsError instead of replacing
        except FileExistsError:
            pass
        return
    if link_error.errno in _NO_HARD_LINKS:
        raise StorageError(
            "BugPilot cannot create its repository record: the file system holding its data folder has no "
            "hard links, which BugPilot needs to publish the record without ever replacing one. Nothing was "
            f"written. Set {DATA_ROOT_ENV} to a folder on a local disk."
        ) from None
    raise link_error


def _remove_temp(temp: Path) -> None:
    """Remove a temp record name, best-effort: bounded retries, and it never raises.

    It runs in a ``finally``: an error here must not replace the outcome of the
    publish, whether that was a published record or an exception on its way
    out. If the name still cannot be removed (a reader or a scan holding the
    file on Windows), it stays as a stray ``.repository.json.<random>.tmp``:
    never read (the record's name is fixed), never published again, and safe
    to delete by hand. A later clean-up could remove such names when they are
    old regular files; none is attempted here.
    """
    for attempt in range(_TRANSIENT_ATTEMPTS):
        try:
            os.unlink(temp)
            return
        except FileNotFoundError:
            return  # renamed into place, or never there
        except PermissionError:
            if attempt < _TRANSIENT_ATTEMPTS - 1:
                time.sleep(_TRANSIENT_DELAY)
        except OSError:
            return


# --- keeping the data root and the repository apart (R5; review finding H1) --------------------


def _components(path: str) -> tuple[str, ...]:
    """A path's components, each folded (``normcase``), for comparison component by component."""
    return tuple(os.path.normcase(part) for part in Path(path).parts)


def _physically_within(inner: str, outer: str) -> bool:
    """Whether ``inner`` or one of its existing ancestors is the folder ``outer``, by file identity."""
    try:
        target = os.stat(outer)
    except (OSError, ValueError):
        return False
    if target.st_ino == 0:
        return False  # no file identity on this file system: the canonical comparison stands alone
    for candidate in (Path(inner), *Path(inner).parents):
        try:
            info = os.stat(candidate)
        except (OSError, ValueError):
            continue
        if (info.st_dev, info.st_ino) == (target.st_dev, target.st_ino):
            return True
    return False


def _containment_problem(root: Path, identity: RepositoryIdentity) -> Literal["inside", "contains"] | None:
    """Whether the data root and the repository are kept apart (R5): ``None``, or which way they are not.

    - ``"inside"``: the data root is the repository's folder or inside it, so
      every BugPilot write would land in the repository (a ``BUGPILOT_HOME``
      inside a checkout; a repository that is the home folder, which holds
      the default data root).
    - ``"contains"``: the repository is inside the data root, where BugPilot's
      own namespaces live.

    Compared twice, never by text prefix: by the canonical paths' components
    (``realpath`` resolves links, junctions and ``..``; ``normcase`` folds case
    on Windows), and by file identity along each one's existing ancestors,
    which also catches spellings ``realpath`` leaves apart (a case variant on a
    case-insensitive volume, another drive letter or mount for the same
    folder). The verdict lives as long as the current request scope.
    """
    repo = str(identity.root)

    def judge() -> Literal["inside", "contains"] | None:
        data = os.path.realpath(root)
        data_parts, repo_parts = _components(data), _components(repo)
        if data_parts[: len(repo_parts)] == repo_parts or _physically_within(data, repo):
            return "inside"
        if repo_parts[: len(data_parts)] == data_parts or _physically_within(repo, data):
            return "contains"
        return None

    return _scoped(("containment", str(root), repo), judge)


# --- never inside a Git working tree (findings G-1, G-2) ---------------------------------------


def _git_tree_problem(root: Path) -> str | None:
    """Why the data root may not be used because of Git, as one sentence; ``None`` when it may.

    Two rules, both about the **data root** only (the repository's scope stays
    the folder BugPilot runs in, US-D4; no git command is run):

    1. **A ``.git`` entry** — a folder, or the file of a linked worktree, a
       submodule or ``--separate-git-dir`` — in the canonical data root or in any
       folder above it, up to the top of the volume. Checked component by
       component with one ``lstat`` each, never by text prefix. ``realpath`` has
       already resolved links and junctions, so an alias into a checkout is
       judged where it lands. An empty or broken ``.git`` folder counts: Git
       would ignore it, this check does not.
    2. **``GIT_WORK_TREE``**, when set and not blank: the working tree it names
       must not hold the data root. A relative value is resolved against the
       working directory, as Git resolves it.

    Fail closed: a folder above the data root that cannot be examined, or a
    ``GIT_WORK_TREE`` that cannot be resolved or holds a control character,
    refuses the data root too.

    Known gaps, stated: a working tree that no ``.git`` entry marks and no
    ``GIT_WORK_TREE`` names (dotfiles kept in a bare repository used with
    ``--work-tree``, a ``core.worktree`` setting) is not recognized; neither are
    other version-control systems.
    """
    configured = os.environ.get(GIT_WORK_TREE_ENV)
    configured = configured.strip() if configured else ""
    here = _working_directory() if configured and not os.path.isabs(configured) else ""
    return _scoped(("git-tree", str(root), configured, here), lambda: _judge_git_tree(root, configured, here))


def _working_directory() -> str | None:
    """Where a relative ``GIT_WORK_TREE`` is resolved from; ``None`` when the working directory is gone."""
    try:
        return os.getcwd()
    except OSError:
        return None


def _judge_git_tree(root: Path, configured: str, here: str | None) -> str | None:
    shown = display_path(root)
    refusal = (
        f"BugPilot will not keep its data inside a Git working tree: its data folder ({shown}) is inside "
        f"{{where}}, so BugPilot's files could be committed with it. Set {DATA_ROOT_ENV} to a folder outside "
        "every Git working tree. Nothing was read or written."
    )
    canonical = Path(os.path.realpath(root))
    for folder in (canonical, *canonical.parents):
        try:
            os.lstat(folder / GIT_MARKER)
        except (FileNotFoundError, NotADirectoryError):
            continue
        except (OSError, ValueError):
            return (
                f"BugPilot cannot tell whether its data folder ({shown}) is inside a Git working tree: a folder "
                f"above it cannot be examined. Nothing was read or written; check that folder's permissions, or "
                f"set {DATA_ROOT_ENV} to another folder."
            )
        return refusal.format(where=f"a folder that holds a {GIT_MARKER} entry")
    if not configured:
        return None
    unresolvable = (
        f"BugPilot cannot tell whether its data folder ({shown}) is inside the Git working tree that "
        f"{GIT_WORK_TREE_ENV} names: {{why}}. Nothing was read or written."
    )
    if _FORBIDDEN_IN_ROOT.search(configured):
        return unresolvable.format(why=f"{GIT_WORK_TREE_ENV} holds a control or line-separator character")
    if here is None:
        return unresolvable.format(why="it is relative and the working directory is gone")
    try:
        tree = os.path.realpath(configured if os.path.isabs(configured) else os.path.join(here, configured))
    except (OSError, ValueError):
        return unresolvable.format(why="it cannot be resolved")
    tree_parts = _components(tree)
    if _components(str(canonical))[: len(tree_parts)] == tree_parts:
        return refusal.format(where=f"the working tree {GIT_WORK_TREE_ENV} names")
    return None


def _check_data_root(root: Path) -> None:
    """Refuse a data root inside a Git working tree, before anything there is read or created."""
    problem = _git_tree_problem(root)
    if problem is not None:
        raise StorageError(problem)


# --- reads that follow no link (Option C) ---------------------------------------------------------


@dataclass(frozen=True)
class SettingsContent:
    """A settings or configuration file, read without following a link (Option C).

    - ``present``: ``data`` is the whole file, at most the limit asked for;
    - ``absent``: nothing is at the name, or a folder on the way does not exist; nothing was created;
    - ``too_large``: the file holds more than the limit; no bytes are returned;
    - ``not_a_file``: a folder, or another entry that is not a regular file, is at the name;
    - ``link``: a link or junction is at the name. Only a Fix Mode file is reported this way (that one
      file is left out, as before); a link at any other file, and every link on the way to one, is
      refused with :class:`StorageError`.

    A failure of the system itself (no permission, a file in use) is an ``OSError`` that names no path: a
    :class:`StorageFileReadError` at the file itself, a plain ``OSError`` in a folder on the way.
    """

    state: Literal["present", "absent", "too_large", "not_a_file", "link"]
    data: bytes = b""


#: Why a component was not gone through, in :func:`_existing`'s words where it has them.
_HELD_REASONS = {
    "link": "{} is a symbolic link or junction",
    "not-a-folder": "{} is not a directory",
    "reparse": "{} is a reparse point BugPilot does not support",
    "moved": "{} changed while it was being read",
}
#: What a Fix Mode file's name ends with, compared as the system compares names, as a ``*.json`` glob did.
_FIX_MODE_SUFFIX = ".json"


def _is_fix_mode_name(name: str) -> bool:
    return os.path.normcase(name).endswith(_FIX_MODE_SUFFIX)


def _fix_mode_file(file_name: str) -> str:
    """``file_name``, when it names one entry and ends in ``.json``. A refusal never repeats it."""
    if not _held_folders.plain_name(file_name) or not _is_fix_mode_name(file_name):
        raise StorageError(
            "BugPilot reads a Fix Mode only by its plain file name, ending in .json, inside a Fix Mode folder. "
            "Nothing was read."
        )
    return file_name


def _descend(
    folder: _held_folders.Folder, parts: tuple[str, ...], *, walked: tuple[str, ...], wanted: tuple[str, ...]
) -> _held_folders.Folder | None:
    """``parts`` below ``folder``, each held in turn; ``None`` at the first that does not exist.

    :func:`_existing`'s read contract, kept with handles instead of looks: a
    link, a non-folder or an unsupported reparse point on the way is refused,
    never taken as missing, in the same words (``wanted`` is what was asked
    for, ``walked`` what lies above ``folder``).
    """
    for part in parts:
        walked = (*walked, part)
        try:
            found = folder.child(part)
        except _held_folders.Refused as refused:
            raise StorageError(_read_refusal(wanted, _HELD_REASONS[refused.reason].format("/".join(walked)))) from None
        if found is None:
            return None
        folder = found
    return folder


def _content(
    folder: _held_folders.Folder, name: str, parts: tuple[str, ...], limit: int | None, *, entry: bool
) -> SettingsContent:
    """The file ``name`` in the held ``folder`` (``parts`` below the data root), read from its own handle.

    ``entry`` marks a Fix Mode file, the one kind for which a link is a state
    rather than a refusal. A link at any other file is refused in
    :func:`_file`'s words. An ``OSError`` while opening or reading the file
    itself is a :class:`StorageFileReadError`; one in a folder on the way stays
    a plain ``OSError``, and so does a held folder that denies even a look at
    the file (``FolderDenied``: read permission without search, on POSIX) or
    whose own handle cannot be queried (``FolderFailed``, on Windows).
    """
    try:
        opened = folder.open_file(name)
    except _held_folders.Refused as refused:
        raise StorageError(_read_refusal((*parts, name), _HELD_REASONS[refused.reason].format(name))) from None
    except (_held_folders.FolderDenied, _held_folders.FolderFailed) as failed:
        raise failed.error from None  # the folder's failure, as any other folder's: fatal, never a file's warning
    except OSError as error:
        raise StorageFileReadError(error) from None
    if opened.kind == "absent":
        return SettingsContent("absent")
    if opened.kind in ("folder", "other"):
        return SettingsContent("not_a_file")
    if opened.kind == "link":
        if entry:
            return SettingsContent("link")
        raise StorageError(_write_refusal(name, f"{name} is a symbolic link or junction", DATA_ROOT_BOUNDARY))
    if opened.kind != "file" or opened.info is None:  # a reparse point that is no link
        raise StorageError(_read_refusal((*parts, name), _HELD_REASONS["reparse"].format(name)))
    if limit is not None and opened.info.st_size > limit:
        return SettingsContent("too_large")
    try:
        data = opened.read(limit)
    except OSError as error:
        raise StorageFileReadError(error) from None
    return SettingsContent("too_large") if data is None else SettingsContent("present", data)


def _held(read: Callable[[], _T], root: Path) -> _T:
    """``read()``, retried while the system says a file is in use; a system that cannot hold folders is refused.

    Never a path-based read instead: what this system cannot do safely, it does not do. A file in use is
    retried as a folder in use is (:func:`_transient`'s attempts), whichever error carries it.
    """
    try:
        for attempt in range(_TRANSIENT_ATTEMPTS):
            try:
                return read()
            except (PermissionError, StorageFileReadError) as error:
                busy = isinstance(getattr(error, "error", error), PermissionError)
                if not busy or attempt == _TRANSIENT_ATTEMPTS - 1:
                    raise
                time.sleep(_TRANSIENT_DELAY)
        raise AssertionError("not reached")  # pragma: no cover
    except _held_folders.Unsupported:
        raise StorageError(
            "BugPilot cannot read its data folder safely on this system: it cannot open files there without "
            "following links. Nothing was read."
        ) from None
    except _held_folders.Refused:  # the data root's own; every other refusal is worded where it is met
        raise StorageError(
            f"BugPilot cannot use {display_path(root)} as its data folder: it is not a folder."
        ) from None


def _read_held(
    root: Path,
    reach: Callable[[_held_folders.Folder | None], _held_folders.Folder | None],
    parts: tuple[str, ...],
    name: str,
    limit: int | None,
    *,
    entry: bool,
) -> SettingsContent:
    """``name`` in the folder ``parts`` that ``reach`` holds from the data root, read from its own handle."""

    def read() -> SettingsContent:
        with _held_folders.held(root) as anchor:
            folder = reach(anchor)
            return SettingsContent("absent") if folder is None else _content(folder, name, parts, limit, entry=entry)

    return _held(read, root)


def _fix_mode_names(
    root: Path, reach: Callable[[_held_folders.Folder | None], _held_folders.Folder | None]
) -> list[str]:
    """The ``.json`` names in the folder ``reach`` holds, sorted as a glob's paths were; none when it is absent."""

    def names() -> list[str]:
        with _held_folders.held(root) as anchor:
            folder = reach(anchor)
            if folder is None:
                return []
            return sorted((name for name in folder.names() if _is_fix_mode_name(name)), key=os.path.normcase)

    return _held(names, root)


def _checked_parts(parts: tuple[str, ...]) -> tuple[str, ...]:
    """``parts``, each a plain name, as :func:`_existing` checks them first."""
    try:
        _check_parts(parts)
    except UnsafePathError as error:
        raise StorageError(str(error)) from None
    return parts


# --- diagnostics that never raise (Batch 2B-1) --------------------------------------------------

CheckState = Literal["usable", "uninitialized", "refused", "unavailable", "unverifiable"]


@dataclass(frozen=True)
class StorageCheck:
    """What a read-only check found, for a future ``doctor``. Never raises; creates, writes and changes nothing.

    - ``usable``: it exists and passed every check;
    - ``uninitialized``: nothing is wrong, but it was never created (the first write would create it);
    - ``refused``: a policy refusal (the data root in the repository or in a Git working tree, a link on
      the way, a record naming another repository or unreadable as one, a place that is not private);
    - ``unavailable``: the file system did not answer (a file in use, no permission, an I/O error);
    - ``unverifiable``: privacy could not be proven, so credentials would not be written.

    ``problem`` is one sentence in display form, ``None`` when usable or uninitialized. Mapping these
    states onto ``doctor``'s JSON (``state``, ``problem``) is still to be decided (Batch 2B-5).
    """

    state: CheckState
    problem: str | None = None


def _checked(examine: Callable[[], StorageCheck]) -> StorageCheck:
    """``examine()`` in one request scope, with every refusal or failure turned into a :class:`StorageCheck`."""
    try:
        with request_scope():
            return examine()
    except StorageUnavailable as error:
        return StorageCheck("unavailable", str(error))
    except StorageError as error:
        return StorageCheck("refused", str(error))
    except OSError as error:
        return StorageCheck(
            "unavailable",
            f"BugPilot cannot examine its data folder right now ({type(error).__name__}). Nothing was read or written.",
        )


# --- the two storages --------------------------------------------------------------------------


@dataclass(frozen=True)
class GlobalStorage:
    """The data root's global part: ``config/`` (plan §6.1).

    Its folders are private fields: every path to read or write comes from a
    checked method, which refuses a data root inside a Git working tree and a
    link on the way, and, for ``config.toml``, a place that is not private.
    :meth:`diagnostics` gives the paths as text for ``doctor``, checking and
    creating nothing.
    """

    _data_root: Path
    _config_dir: Path

    def ensure_config_dir(self) -> Path:
        """Create ``config/`` (``0700``, link-checked) and the data root if missing; never touch the root's mode."""
        with request_scope():
            _check_data_root(self._data_root)
            _ensure_root(self._data_root)
            return _directory(self._data_root, ("config",), create=True)

    def _config_location(self, rest: tuple[str, ...], *, create: bool) -> Path:
        with request_scope():
            if create:
                self.ensure_config_dir()
                return _directory(self._data_root, ("config", *rest), create=True)
            _check_data_root(self._data_root)
            return _existing(self._data_root, ("config", *rest))

    def config_file(self, *, create: bool) -> Path:
        """``config/config.toml``, the credentials file. A link there is refused, for reads too.

        With ``create=True`` it is the path to *write*: ``config/`` is made
        ready, and then the data root, ``config/`` and the file, if it exists,
        must each be proven private (:func:`private_folder.verify_private`);
        otherwise :class:`StorageError`, and nothing is written. A read
        (``create=False``) checks no privacy: refusing to read a file that is
        already exposed would protect nothing.
        """
        with request_scope():
            path = _file(self._config_location((), create=create) / CREDENTIALS_NAME)
            if create:
                self._check_private_for_credentials(path)
            return path

    def write_config_file(self, text: str) -> Path:
        """Write ``config.toml`` privately (``atomic_write_text(private=True)``) where it is proven private.

        The checks of :meth:`config_file` come first; after the write the file
        itself is checked again. If it then cannot be shown to be private, a
        :class:`StorageError` says so; the file is left as written, never
        loosened or tightened. ``text`` is never part of any message.
        """
        with request_scope():
            path = self.config_file(create=True)
            atomic_write_text(path, text, private=True)
            verdict = private_folder.verify_private(path, "credential-file")
            if not verdict.private:
                raise StorageError(
                    f"BugPilot wrote {display_path(path)} but cannot confirm that only your account can read it "
                    f"({'; '.join(verdict.reasons)}). Check its permissions."
                )
            return path

    def user_instructions_file(self, *, create: bool) -> Path:
        """``config/instructions.md``. Not a credential: no privacy gate, every other check."""
        with request_scope():
            return _file(self._config_location((), create=create) / _USER_INSTRUCTIONS_NAME)

    def user_fix_modes_dir(self, *, create: bool) -> Path:
        """``config/fix_modes``: the user-scope Fix Modes. Not a credential: no privacy gate."""
        return self._config_location(("fix_modes",), create=create)

    def read_config(self, *, limit: int | None = None) -> SettingsContent:
        """``config/config.toml``, read without following a link (Option C). Creates nothing.

        As :meth:`config_file` with ``create=False``: no privacy check, since
        refusing to read a file that is already exposed would protect nothing.
        A link there is refused.
        """
        return self._read((), CREDENTIALS_NAME, limit, entry=False)

    def read_user_instructions(self, *, limit: int) -> SettingsContent:
        """``config/instructions.md``, read without following a link (Option C); a link there is refused."""
        return self._read((), _USER_INSTRUCTIONS_NAME, limit, entry=False)

    def user_fix_mode_names(self) -> list[str]:
        """The ``.json`` names in ``config/fix_modes``, sorted; a link among them is listed, never followed."""
        with request_scope():
            _check_data_root(self._data_root)
            return _fix_mode_names(self._data_root, self._reach(("fix_modes",)))

    def read_user_fix_mode(self, file_name: str, *, limit: int | None) -> SettingsContent:
        """One file of ``config/fix_modes``, read without following a link; a link there is ``link``, left out."""
        return self._read(("fix_modes",), _fix_mode_file(file_name), limit, entry=True)

    def _reach(self, rest: tuple[str, ...]) -> Callable[[_held_folders.Folder | None], _held_folders.Folder | None]:
        """How ``config/<rest>`` is held from the data root: :meth:`_config_location`'s checks, by handle."""
        parts = _checked_parts(("config", *rest))

        def reach(anchor: _held_folders.Folder | None) -> _held_folders.Folder | None:
            return None if anchor is None else _descend(anchor, parts, walked=(), wanted=parts)

        return reach

    def _read(self, rest: tuple[str, ...], name: str, limit: int | None, *, entry: bool) -> SettingsContent:
        with request_scope():
            _check_data_root(self._data_root)
            return _read_held(self._data_root, self._reach(rest), ("config", *rest), name, limit, entry=entry)

    def diagnostics(self) -> dict[str, str]:
        """The global paths ``doctor`` reports (§8.10), as text. Pure: no check, nothing read or created."""
        return {
            "data_root": str(self._data_root),
            "data_root_display": display_path(self._data_root),
            "data_root_source": data_root_source(),
            "config_dir": str(self._config_dir),
        }

    def check(self) -> StorageCheck:
        """Whether ``config/`` could be used and credentials written, without raising or creating anything.

        The data root is judged as every accessor judges it (Git working tree,
        a link at ``config/`` or at ``config.toml``); then the data root,
        ``config/`` and ``config.toml``, as far as they exist, as the
        credentials gate judges them (:func:`private_folder.verify_private`).
        """

        def examine() -> StorageCheck:
            _check_data_root(self._data_root)
            config = _existing(self._data_root, ("config",))
            places: list[tuple[Path, private_folder.Role]] = []
            if os.path.lexists(self._data_root):
                places.append((self._data_root, "data-root"))
            if os.path.lexists(config):
                places.append((config, "config-folder"))
                credentials = _file(config / CREDENTIALS_NAME)
                if os.path.lexists(credentials):
                    places.append((credentials, "credential-file"))
            unproven = []
            for place, role in places:
                verdict = private_folder.verify_private(place, role)
                if verdict.state == "not-private":
                    return StorageCheck(
                        "refused",
                        f"Credentials would not be written: {display_path(place)} is not private "
                        f"({'; '.join(verdict.reasons)}).",
                    )
                if verdict.state == "unverifiable":
                    unproven.append(f"{display_path(place)} ({'; '.join(verdict.reasons)})")
            if unproven:
                return StorageCheck(
                    "unverifiable",
                    "Credentials would not be written: BugPilot cannot confirm that these are private: "
                    + ", ".join(unproven) + ".",
                )
            return StorageCheck("usable" if os.path.lexists(config) else "uninitialized")

        return _checked(examine)

    def _check_private_for_credentials(self, path: Path) -> None:
        places: list[tuple[Path, private_folder.Role]] = [
            (self._data_root, "data-root"),
            (self._config_dir, "config-folder"),
        ]
        if os.path.lexists(path):
            places.append((path, "credential-file"))
        for place, role in places:
            verdict = private_folder.verify_private(place, role)
            if verdict.private:
                continue
            shown, why = display_path(place), "; ".join(verdict.reasons)
            if verdict.state == "unverifiable":
                raise StorageError(
                    f"BugPilot cannot confirm that {shown} is private ({why}), so it does not write credentials "
                    "there. Nothing was written."
                )
            raise StorageError(
                f"BugPilot will not write credentials: {shown} is not private ({why}). Nothing was written; "
                f"restrict it to your account, or set {DATA_ROOT_ENV} to a private folder."
            )


def global_storage() -> GlobalStorage:
    """The global locations, resolved. Creates nothing."""
    root = data_root()
    return GlobalStorage(root, root / "config")


@dataclass(frozen=True)
class WorkItemEntry:
    """One work item folder, for ``list``."""

    work_item_id: str
    path: Path
    mtime: float | None  # the folder's own modification time; None when it cannot be read


@dataclass(frozen=True)
class RepositoryStorage:
    """One repository's namespace: ``<data root>/repositories/<repository id>/`` (plan §6.1, §8.2).

    It exists only for the root it was computed from (:func:`repository_storage`).
    Every accessor checks, in one request scope, that the data root and the
    repository are kept apart, that the data root is outside every Git working
    tree, and then the identity record: a namespace whose record names another
    repository, or is not a readable record, is refused for reads and writes
    alike (§7.5). The folders are private fields; :meth:`diagnostics` gives the
    paths as text, checking and creating nothing.
    """

    _data_root: Path
    identity: RepositoryIdentity
    _directory: Path

    @property
    def _record_file(self) -> Path:
        return self._directory / RECORD_NAME

    def _parts(self, *rest: str) -> tuple[str, ...]:
        return ("repositories", self.identity.repository_id, *rest)

    def record_state(self) -> RecordState:
        """The namespace's state, read only. A link on the way to it is refused (``StorageError``).

        A data root and repository that are not kept apart, and a data root
        inside a Git working tree, are refused first (:meth:`_check_containment`):
        such a namespace is neither read nor written.
        """
        with request_scope():
            self._check_containment()
            namespace = _existing(self._data_root, self._parts())
            if not os.path.lexists(namespace):
                return "absent"
            return _record_state(self._record_file, self.identity)

    def _check_containment(self) -> None:
        """Refuse a data root inside this repository, a repository inside the data root (R5; H1), and a data root
        inside a Git working tree (G-1)."""
        problem = _containment_problem(self._data_root, self.identity)
        if problem == "inside":
            raise StorageError(
                f"BugPilot will not keep its data inside this repository: its data folder "
                f"({display_path(self._data_root)}) is this repository's folder or inside it, so BugPilot's files "
                f"would land in the repository. Set {DATA_ROOT_ENV} to a folder outside every repository. "
                "Nothing was read or written."
            )
        if problem == "contains":
            raise StorageError(
                f"BugPilot will not use a repository inside its own data folder ({display_path(self._data_root)}). "
                "Run BugPilot in the repository's own folder. Nothing was read or written."
            )
        _check_data_root(self._data_root)

    def _refusal(self, state: RecordState) -> StorageIdentityError:
        shown = display_path(self._record_file)
        if state == "mismatch":
            return StorageIdentityError(
                f"BugPilot will not use {shown}: it belongs to a different repository folder. "
                "Nothing was read or written; delete that record only if you are sure it is stale."
            )
        return StorageIdentityError(
            f"BugPilot will not use {shown}: it is not a readable repository record. "
            "Nothing was read or written; delete it to let BugPilot create it again."
        )

    def _check_record(self, location: Path) -> None:
        """Refuse a namespace whose record names another repository or is unreadable; links were checked before.

        ``location`` came from :func:`_existing`: when it exists, so does the
        namespace, and no further look is needed to know it.
        """
        if os.path.lexists(location) or os.path.lexists(self._directory):
            state = _record_state(self._record_file, self.identity)
            if state in ("mismatch", "corrupt"):
                raise self._refusal(state)

    def ensure(self) -> None:
        """Make the namespace ready: its folder (``0700``) and its identity record (§7.5). Idempotent.

        A record that names another repository, or cannot be read as one, is
        refused before anything is written, and is never repaired.
        """
        with request_scope():
            state = self.record_state()
            if state == "ok":
                return
            if state in ("mismatch", "corrupt"):
                raise self._refusal(state)
            _ensure_root(self._data_root)
            _directory(self._data_root, self._parts(), create=True)
            _publish_record(self._record_file, _record_text(self.identity))
            final = _record_state(self._record_file, self.identity)
            if final != "ok":
                raise self._refusal("mismatch" if final == "mismatch" else "corrupt")

    def _location(self, rest: tuple[str, ...], *, create: bool) -> Path:
        with request_scope():
            if create:
                self.ensure()  # the containment and Git checks come first (record_state)
                return _directory(self._data_root, self._parts(*rest), create=True)
            self._check_containment()
            location = _existing(self._data_root, self._parts(*rest))  # refuses a link on the way
            self._check_record(location)
            return location

    def work_item_dir(self, work_item_id: str, *, create: bool) -> Path:
        """``work/<id>``. The id is validated before any path is built; ``create=False`` creates nothing."""
        return self._location(("work", _validated(work_item_id)), create=create)

    def attachments_dir(self, work_item_id: str, *, create: bool) -> Path:
        """``work/<id>/attachments``, link-checked like every other component."""
        return self._location(("work", _validated(work_item_id), "attachments"), create=create)

    def memory_file(self, work_item_id: str, *, create: bool) -> Path:
        """``memory/<id>.md``. ``memory/`` is created only by a memory writer (``create=True``)."""
        name = f"{_validated(work_item_id)}.md"
        with request_scope():
            folder = self._location(("memory",), create=create)
            return _file(folder / name)

    def settings_file(self, name: SettingsName, *, create: bool) -> Path:
        """``settings/<name>`` for one of :data:`SETTINGS_NAMES`; a link there is refused, for reads too."""
        if name not in SETTINGS_NAMES:
            raise StorageError(f"{name!r} is not one of BugPilot's repository settings files.")
        with request_scope():
            folder = self._location(("settings",), create=create)
            return _file(folder / name)

    def fix_modes_dir(self, *, create: bool) -> Path:
        """``settings/fix_modes``: the repository's project-scope Fix Modes."""
        return self._location(("settings", "fix_modes"), create=create)

    def read_settings(self, name: SettingsName, *, limit: int) -> SettingsContent:
        """``settings/<name>``, read without following a link (Option C). Creates nothing.

        :meth:`settings_file`'s checks, in its order and words: the name; the
        data root and the repository kept apart, outside every Git working
        tree; no link or non-folder on the way; then the identity record, read
        in the held namespace. A link at the file is refused too.
        """
        if name not in SETTINGS_NAMES:
            raise StorageError(f"{name!r} is not one of BugPilot's repository settings files.")
        return self._read(("settings",), name, limit, entry=False)

    def fix_mode_names(self) -> list[str]:
        """The ``.json`` names in ``settings/fix_modes``, sorted; a link among them is listed, never followed."""
        with request_scope():
            self._check_containment()
            return _fix_mode_names(self._data_root, self._reach(("settings", "fix_modes")))

    def read_fix_mode(self, file_name: str, *, limit: int | None) -> SettingsContent:
        """One file of ``settings/fix_modes``, read without following a link; a link there is ``link``, left out."""
        return self._read(("settings", "fix_modes"), _fix_mode_file(file_name), limit, entry=True)

    def _reach(self, rest: tuple[str, ...]) -> Callable[[_held_folders.Folder | None], _held_folders.Folder | None]:
        """How ``rest`` in this namespace is held from the data root: :meth:`_location`'s checks, by handle.

        Every folder first, then the record (as :meth:`_check_record`: only when
        the namespace exists), read in the namespace that stays held.
        """
        wanted = _checked_parts(self._parts(*rest))

        def reach(anchor: _held_folders.Folder | None) -> _held_folders.Folder | None:
            namespace = None if anchor is None else _descend(anchor, self._parts(), walked=(), wanted=wanted)
            if namespace is None:
                return None
            folder = _descend(namespace, rest, walked=self._parts(), wanted=wanted)
            state = _held_record_state(namespace, self._record_file, self.identity, self._parts())
            if state in ("mismatch", "corrupt"):
                raise self._refusal(state)
            return folder

        return reach

    def _read(self, rest: tuple[str, ...], name: str, limit: int | None, *, entry: bool) -> SettingsContent:
        with request_scope():
            self._check_containment()
            return _read_held(self._data_root, self._reach(rest), self._parts(*rest), name, limit, entry=entry)

    def work_items(self) -> list[WorkItemEntry]:
        """The work item folders in ``work/``, by id. Read only; links and stray names are skipped."""
        work = self._location(("work",), create=False)
        if not os.path.isdir(work) or is_link_or_junction(work):
            return []
        entries = []
        with os.scandir(work) as listing:
            for entry in listing:
                path = Path(entry.path)
                if not is_work_item_id(entry.name) or is_link_or_junction(path):
                    continue
                if not entry.is_dir(follow_symlinks=False):
                    continue
                try:
                    mtime: float | None = entry.stat(follow_symlinks=False).st_mtime
                except OSError:
                    mtime = None
                entries.append(WorkItemEntry(entry.name, path, mtime))
        return sorted(entries, key=lambda item: item.work_item_id)

    def diagnostics(self) -> dict[str, str]:
        """The paths ``doctor`` reports in its ``storage`` object (§8.10), as text.

        Pure: no check, nothing read or created, so it answers even for a
        namespace every accessor refuses (``doctor`` reports why separately).
        """
        return {
            "data_root": str(self._data_root),
            "data_root_display": display_path(self._data_root),
            "data_root_source": data_root_source(),
            "repository_root": str(self.identity.root),
            "repository_id": self.identity.repository_id,
            "repository_dir": str(self._directory),
            "config_dir": str(self._data_root / "config"),
        }

    def check(self) -> StorageCheck:
        """The namespace's state, without raising or creating anything: usable, uninitialized, refused, unavailable."""

        def examine() -> StorageCheck:
            state = self.record_state()
            if state == "ok":
                return StorageCheck("usable")
            if state in ("absent", "missing-record"):
                return StorageCheck("uninitialized")
            return StorageCheck("refused", str(self._refusal(state)))

        return _checked(examine)

    def remove_work_item(self, work_item_id: str) -> bool:
        """Delete ``work/<id>`` and everything in it. ``False`` when it was not there (Batch 2B-1, for ``clean``)."""
        return self._remove(("work", _validated(work_item_id)), folder=True)

    def remove_memory_file(self, work_item_id: str) -> bool:
        """Delete ``memory/<id>.md``. ``False`` when it was not there (``clean --include-memory``)."""
        return self._remove(("memory", f"{_validated(work_item_id)}.md"), folder=False)

    def _remove(self, rest: tuple[str, ...], *, folder: bool) -> bool:
        """Delete one work item's folder or memory file of this namespace, and nothing else.

        Fails closed. Before anything is deleted, in one request scope:

        - the data root and the repository are kept apart, and the data root
          is outside every Git working tree (:meth:`_check_containment`);
        - every component down to the target's folder exists as a real folder,
          never a link or junction (:func:`_existing`);
        - the namespace's identity record is this repository's: a record that
          is missing, names another repository or is unreadable refuses the
          deletion, so one repository can never delete another's files;
        - the target itself is not a link, has the expected kind, and resolves
          exactly to ``<canonical data root>/repositories/<id>/<rest>``.

        Then :func:`safe_paths.remove_owned_path` removes it; links inside a
        work folder are removed as links, never followed. Only ``work/<id>``
        and ``memory/<id>.md`` can be addressed: never the data root,
        ``repositories``, the namespace, ``settings``, ``work``, ``memory`` or
        ``config``, and never anything in a repository, its 0.1.5 work, memory
        and settings folders included. A same-user process racing the deletion
        is the limit §10.3 states.
        """
        parts = self._parts(*rest)
        shown = "/".join(rest)
        try:
            _check_parts(parts)
        except UnsafePathError as error:
            raise StorageError(str(error)) from None
        with request_scope():
            self._check_containment()
            parent = _existing(
                self._data_root, parts[:-1],
                refusal=lambda _, why: f"BugPilot will not delete {shown}: {why}. Nothing was deleted.",
            )
            if not os.path.lexists(self._directory):
                return False
            state = _record_state(self._record_file, self.identity)
            if state != "ok":
                why = "its identity record is missing" if state == "missing-record" else (
                    "it belongs to a different repository folder" if state == "mismatch"
                    else "its identity record is not readable as one")
                raise StorageError(
                    f"BugPilot will not delete {shown}: the namespace it is in cannot be shown to be this "
                    f"repository's ({why}). Nothing was deleted."
                )
            target = parent / parts[-1]
            try:
                info = os.lstat(target)
            except (FileNotFoundError, NotADirectoryError):
                return False
            except OSError as error:
                raise StorageUnavailable(
                    f"BugPilot cannot examine {display_path(target)} right now ({type(error).__name__}). Nothing was deleted."
                ) from None
            expected_kind = stat.S_ISDIR(info.st_mode) if folder else stat.S_ISREG(info.st_mode)
            if is_link_stat(info) or not expected_kind:
                what = "a symbolic link or junction" if is_link_stat(info) else (
                    "not a folder" if folder else "not a regular file")
                raise StorageError(f"BugPilot will not delete {shown}: it is {what}. Nothing was deleted.")
            expected = os.path.join(os.path.realpath(self._data_root), *parts)
            if os.path.normcase(os.path.realpath(target)) != os.path.normcase(expected):
                raise StorageError(
                    f"BugPilot will not delete {shown}: it does not resolve to its own place in {DATA_ROOT_BOUNDARY}. "
                    "Nothing was deleted."
                )
            try:
                return remove_owned_path(target)
            except OSError as error:
                raise StorageUnavailable(
                    f"BugPilot could not finish deleting {display_path(target)} ({type(error).__name__}); part of it "
                    "may remain. Nothing outside it was touched; try again once no program holds its files."
                ) from None


def repository_storage(repo_root: str | os.PathLike[str]) -> RepositoryStorage:
    """The namespace of the repository at ``repo_root``. Resolves; creates nothing."""
    root = data_root()
    identity = repository_identity(repo_root)
    return RepositoryStorage(root, identity, root / "repositories" / identity.repository_id)
