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
  A failure of the system itself (an ``OSError``) is not translated; until the
  owner chooses an error code for it (US-D26) it surfaces as it does today.
- **No legacy reads.** Nothing here reads, copies or migrates the folders
  BugPilot 0.1.5 kept inside a repository, or the 0.1.5 files at the top of
  the data root.

Standard library only; Python 3.10 and later.
"""

from __future__ import annotations

import errno
import hashlib
import json
import ntpath
import os
import posixpath
import re
import stat
import tempfile
import time
import unicodedata
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path, PurePosixPath, PureWindowsPath
from typing import Literal

from .artifact_io import _check_temp
from .identity import is_work_item_id, validate_work_item_id
from .safe_paths import (
    UnsafePathError,
    _check_parts,
    is_link_or_junction,
    is_link_stat,
    refuse_link,
    writable_dir,
)

__all__ = [
    "DATA_ROOT_ENV",
    "DATA_ROOT_BOUNDARY",
    "DIRECTORY_MODE",
    "GlobalStorage",
    "RECORD_NAME",
    "REPOSITORY_ID_RE",
    "RecordState",
    "RepositoryIdentity",
    "RepositoryStorage",
    "SETTINGS_NAMES",
    "STORAGE_LAYOUT_VERSION",
    "SettingsName",
    "StorageError",
    "StorageIdentityError",
    "WorkItemEntry",
    "data_root",
    "data_root_source",
    "display_path",
    "global_storage",
    "repository_id_for",
    "repository_identity",
    "repository_storage",
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


class StorageError(UnsafePathError):
    """BugPilot's data folder cannot be used as asked. One sentence; never an absolute path.

    An :class:`~bugpilot.core.safe_paths.UnsafePathError`, so every entry point
    already reports it as one sentence (``ERROR: …``, or ``INVALID_INPUT`` in
    JSON), never as a traceback.
    """


class StorageIdentityError(StorageError):
    """A repository's identity record names another repository, or is not a readable record (§7.5)."""


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
    no remote URL, no inode. Memoized per process and spelling.
    """
    try:
        given = os.fspath(repo_root)
        if not isinstance(given, str):
            raise TypeError("a text path is required")
        absolute = os.path.abspath(given)
    except (TypeError, ValueError):
        raise StorageError("BugPilot cannot use that repository folder: its path is not valid.") from None
    return _identity(absolute)


@lru_cache(maxsize=128)
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
    if os.path.lexists(root):
        raise StorageError(f"BugPilot cannot use {display_path(root)} as its data folder: it is not a folder.")
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


def _existing(root: Path, parts: tuple[str, ...]) -> Path:
    """``root / parts`` for a read: every component that exists is a real directory, never a link. Creates nothing.

    The read contract of §8.3: the path is returned whether or not it exists
    (the caller reports "not prepared"), and a link or junction on the way is
    refused, checked component by component as it stands, never followed.
    Unlike a write, nothing is created that could land elsewhere, so the
    canonical comparison a write makes (``_directory``) is not repeated here.
    Every component is first checked to be a plain name (no separator, ``.``,
    ``..`` or empty part), as a write's are: defence in depth, since every
    caller builds them from validated ids and fixed names.
    """
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
            raise StorageError(_read_refusal(parts, f"{shown} is a symbolic link or junction"))
        if not stat.S_ISDIR(info.st_mode):
            raise StorageError(_read_refusal(parts, f"{shown} is not a directory"))
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


# --- the identity record -----------------------------------------------------------------------

#: Records verified in this process, by path, with the lstat signature they had (§12: read once).
_verified: dict[str, tuple[int, int, int, int, str]] = {}


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


def _unreadable(path: Path) -> StorageError:
    """A record that cannot be read now (in use, or no permission): not a corrupt one, and never "delete it"."""
    return StorageError(
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
    """
    try:
        info = _transient(lambda: os.lstat(path))
    except FileNotFoundError:
        return "missing-record"
    except PermissionError:
        raise _unreadable(path) from None
    except OSError:
        return "corrupt"
    signature = (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, str(identity.root))
    if _verified.get(str(path)) == signature:
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
    _verified[str(path)] = signature
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

#: (canonical data root, canonical repository root) pairs found apart in this process.
_apart: set[tuple[str, str]] = set()


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
    folder). A pair found apart is remembered for the process.
    """
    repo = str(identity.root)
    remembered = (str(root), repo)
    if remembered in _apart:
        return None
    data = os.path.realpath(root)
    data_parts, repo_parts = _components(data), _components(repo)
    if data_parts[: len(repo_parts)] == repo_parts or _physically_within(data, repo):
        return "inside"
    if repo_parts[: len(data_parts)] == data_parts or _physically_within(repo, data):
        return "contains"
    _apart.add(remembered)
    return None


# --- the two storages --------------------------------------------------------------------------


@dataclass(frozen=True)
class GlobalStorage:
    """The data root's global part: ``config/`` (plan §6.1)."""

    root: Path
    config_dir: Path
    config_file: Path
    user_instructions_file: Path
    user_fix_modes_dir: Path

    def ensure_config_dir(self) -> Path:
        """Create ``config/`` (``0700``, link-checked) and the data root if missing; never touch the root's mode."""
        _ensure_root(self.root)
        return _directory(self.root, ("config",), create=True)


def global_storage() -> GlobalStorage:
    """The global locations, resolved. Creates nothing."""
    root = data_root()
    config = root / "config"
    return GlobalStorage(root, config, config / "config.toml", config / "instructions.md", config / "fix_modes")


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
    Every accessor checks the identity record first: a namespace whose record
    names another repository, or is not a readable record, is refused for
    reads and writes alike (§7.5).
    """

    root: Path
    identity: RepositoryIdentity
    directory: Path
    settings_dir: Path
    work_root: Path
    memory_dir: Path

    @property
    def record_file(self) -> Path:
        return self.directory / RECORD_NAME

    def _parts(self, *rest: str) -> tuple[str, ...]:
        return ("repositories", self.identity.repository_id, *rest)

    def record_state(self) -> RecordState:
        """The namespace's state, read only. A link on the way to it is refused (``StorageError``).

        A data root and repository that are not kept apart are refused first
        (:meth:`_check_containment`): such a namespace is neither read nor written.
        """
        self._check_containment()
        namespace = _existing(self.root, self._parts())
        if not os.path.lexists(namespace):
            return "absent"
        return _record_state(self.record_file, self.identity)

    def _check_containment(self) -> None:
        """Refuse a data root inside this repository, and a repository inside the data root (R5; finding H1)."""
        problem = _containment_problem(self.root, self.identity)
        if problem == "inside":
            raise StorageError(
                f"BugPilot will not keep its data inside this repository: its data folder "
                f"({display_path(self.root)}) is this repository's folder or inside it, so BugPilot's files "
                f"would land in the repository. Set {DATA_ROOT_ENV} to a folder outside every repository. "
                "Nothing was read or written."
            )
        if problem == "contains":
            raise StorageError(
                f"BugPilot will not use a repository inside its own data folder ({display_path(self.root)}). "
                "Run BugPilot in the repository's own folder. Nothing was read or written."
            )

    def _refusal(self, state: RecordState) -> StorageIdentityError:
        shown = display_path(self.record_file)
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
        if os.path.lexists(location) or os.path.lexists(self.directory):
            state = _record_state(self.record_file, self.identity)
            if state in ("mismatch", "corrupt"):
                raise self._refusal(state)

    def ensure(self) -> None:
        """Make the namespace ready: its folder (``0700``) and its identity record (§7.5). Idempotent.

        A record that names another repository, or cannot be read as one, is
        refused before anything is written, and is never repaired.
        """
        state = self.record_state()
        if state == "ok":
            return
        if state in ("mismatch", "corrupt"):
            raise self._refusal(state)
        _ensure_root(self.root)
        _directory(self.root, self._parts(), create=True)
        _publish_record(self.record_file, _record_text(self.identity))
        final = _record_state(self.record_file, self.identity)
        if final != "ok":
            raise self._refusal("mismatch" if final == "mismatch" else "corrupt")

    def _location(self, rest: tuple[str, ...], *, create: bool) -> Path:
        if create:
            self.ensure()  # the containment check comes first (record_state)
            return _directory(self.root, self._parts(*rest), create=True)
        self._check_containment()
        location = _existing(self.root, self._parts(*rest))  # refuses a link on the way, the namespace's included
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
        folder = self._location(("memory",), create=create)
        return _file(folder / name)

    def settings_file(self, name: SettingsName, *, create: bool) -> Path:
        """``settings/<name>`` for one of :data:`SETTINGS_NAMES`; a link there is refused, for reads too."""
        if name not in SETTINGS_NAMES:
            raise StorageError(f"{name!r} is not one of BugPilot's repository settings files.")
        folder = self._location(("settings",), create=create)
        return _file(folder / name)

    def fix_modes_dir(self, *, create: bool) -> Path:
        """``settings/fix_modes``: the repository's project-scope Fix Modes."""
        return self._location(("settings", "fix_modes"), create=create)

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


def repository_storage(repo_root: str | os.PathLike[str]) -> RepositoryStorage:
    """The namespace of the repository at ``repo_root``. Resolves; creates nothing."""
    root = data_root()
    identity = repository_identity(repo_root)
    directory = root / "repositories" / identity.repository_id
    return RepositoryStorage(
        root=root,
        identity=identity,
        directory=directory,
        settings_dir=directory / "settings",
        work_root=directory / "work",
        memory_dir=directory / "memory",
    )
