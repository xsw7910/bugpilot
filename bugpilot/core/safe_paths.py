"""Link-safe paths for the things BugPilot deletes and writes.

Writes follow the same rule as deletion:
:func:`writable_dir` and :func:`refuse_link` check every generated path under
BugPilot's data folder (``work/``, ``memory/``, ``settings/``; storage calls
them) before anything is created or written there, and
refuse a link or junction with one sentence rather than writing through it.

BugPilot deletes only what it generated, in the repository's own folder of its
data folder: ``work/<work item>/`` and, when asked, ``memory/<work item>.md``. A
symbolic link or a Windows junction anywhere on that path would turn "delete
this work item's folder" into "delete whatever the link points at", so every
destructive path is checked here, component by component, before anything is
removed.

``Path.resolve()`` cannot answer the question on its own, and that is exactly
how ``clean`` once escaped: resolving both the boundary and the target follows
the same link, the two agree, and the containment check passes while the
deletion lands outside the repository. The check is therefore made on each
component *as it is* (``lstat``, never followed), and then the resolved target
is compared with the path it should be.

What counts as a link, stated precisely: a symbolic link on any platform; on
Windows, any reparse point whose tag is a *name surrogate* — a symbolic link, a
directory junction, or anything else that stands in for another path. Reparse
points that hold their own data (cloud-file placeholders, deduplicated files)
are not links and are deleted normally.

Reads follow the same rule (O-1): :func:`read_generated_file` is the one way
BugPilot reads a file it generated in a work item's folder or in bug memory. A
cloned repository can commit a link at any of those names, and a reader that
followed it would hand the link's target — a file outside the repository — to
an MCP client, a prompt or a Jira comment. So every component is judged as it
stands, the file must be a regular file, and the read is bounded.
"""

from __future__ import annotations

import os
import shutil
import stat
from pathlib import Path
from typing import Callable, Sequence

# IsReparseTagNameSurrogate(): bit 29 of a reparse tag marks a tag that names
# another file or directory — junctions and symbolic links among them.
_NAME_SURROGATE_BIT = 0x20000000
_FILE_ATTRIBUTE_REPARSE_POINT = getattr(stat, "FILE_ATTRIBUTE_REPARSE_POINT", 0x400)


class UnsafePathError(ValueError):
    """A deletion, a write or a read refused before anything was deleted, written or used.

    A ``ValueError`` so every entry point that already reports a bad argument
    as one sentence (``ERROR: …`` in a terminal, ``INVALID_INPUT`` in JSON)
    reports this the same way, never as a traceback.
    """


def is_link_or_junction(path: Path) -> bool:
    """Whether ``path`` itself is a link that sends reads and writes elsewhere.

    Asked of the path as it stands, never followed. A path that does not exist
    is not a link.
    """
    try:
        info = os.lstat(path)
    except (FileNotFoundError, NotADirectoryError):
        return False
    if is_link_stat(info):
        return True
    # Belt and braces where the interpreter knows about junctions (3.12+).
    is_junction = getattr(path, "is_junction", None)
    return bool(is_junction()) if callable(is_junction) else False


def is_link_stat(info: os.stat_result) -> bool:
    """Whether an ``lstat`` result describes a link: the test :func:`is_link_or_junction` applies.

    For a caller that already holds the ``lstat`` (0.1.6 storage reads each
    component once): a symbolic link, or a Windows reparse point whose tag is
    a name surrogate or unknown.
    """
    if stat.S_ISLNK(info.st_mode):
        return True
    if getattr(info, "st_file_attributes", 0) & _FILE_ATTRIBUTE_REPARSE_POINT:
        tag = getattr(info, "st_reparse_tag", 0)
        # An unknown tag is treated as a link: refusing a deletion costs the
        # developer one manual step, following one can cost them anything.
        if tag == 0 or tag & _NAME_SURROGATE_BIT:
            return True
    return False


#: How a refusal names the folder BugPilot's files stay inside: the repository by default.
REPOSITORY_BOUNDARY = "this repository"


def owned_path(repo_root: Path, parts: Sequence[str], *, boundary: str = REPOSITORY_BOUNDARY) -> Path:
    """``repo_root / parts``, checked to be a BugPilot-owned path safe to delete.

    Raises :class:`UnsafePathError` when any component below the base —
    ``work``, ``work/<id>``, … — is a link or junction, or when the target
    resolves anywhere other than where it should be. The base itself may sit
    behind a link; storage checks the data folder down to it.

    ``boundary`` names the base in the refusal, as :func:`writable_dir`'s does
    (0.1.7: ``"BugPilot's data folder"`` for ``clean``). With the default every
    message is as it was.
    """
    if not parts or any(part in ("", ".", "..") or "/" in part or "\\" in part for part in parts):
        raise UnsafePathError(f"Refusing to delete an invalid generated path: {'/'.join(parts)!r}.")
    display = "/".join(parts)
    current = repo_root
    for index, part in enumerate(parts):
        current = current / part
        if is_link_or_junction(current):
            link = "/".join(parts[: index + 1])
            raise UnsafePathError(
                f"Refusing to delete {display}: {link} is a symbolic link or junction. "
                f"BugPilot deletes only real directories it generated inside {boundary}, "
                "and never through a link. Nothing was deleted."
            )
    target = repo_root.joinpath(*parts)
    if os.path.lexists(target):
        expected = repo_root.resolve().joinpath(*parts)
        if os.path.normcase(str(target.resolve())) != os.path.normcase(str(expected)):
            raise UnsafePathError(
                f"Refusing to delete {display}: it resolves outside {boundary}'s generated "
                "files. Nothing was deleted."
            )
    return target


def writable_dir(
    repo_root: Path,
    parts: Sequence[str],
    *,
    create: bool = True,
    mode: int | None = None,
    boundary: str = REPOSITORY_BOUNDARY,
) -> Path:
    """``repo_root / parts`` as a real directory BugPilot may write generated files into.

    The write-side twin of :func:`owned_path`. Every
    component below the base — ``repositories``, ``<id>``, ``work``,
    ``work/<item>`` — is checked as it stands, never followed: a link or
    junction raises :class:`UnsafePathError` before anything is created or
    written. Missing components are created one at a time (``create=True``) and
    checked again once they exist; with ``create=False`` a missing directory is
    returned as a path for the caller to report. The repository root itself
    may sit behind a link: that is where the developer chose to work.

    ``repo_root`` may be any base BugPilot writes under (0.1.6, plan §8.5): its
    data folder too. ``mode`` is given to each ``mkdir`` (the umask still
    narrows it, never widens it), and ``boundary`` names the base in the
    refusal (``"this repository"``, or ``"BugPilot's data folder"``). With the
    defaults every message is as it was.
    """
    _check_parts(parts)
    display = "/".join(parts)
    current = repo_root
    for index, part in enumerate(parts):
        current = current / part
        shown = "/".join(parts[: index + 1])
        if is_link_or_junction(current):
            raise UnsafePathError(_write_refusal(display, f"{shown} is a symbolic link or junction", boundary))
        if not os.path.lexists(current):
            if not create:
                return repo_root.joinpath(*parts)
            if mode is None:
                current.mkdir(exist_ok=True)
            else:
                current.mkdir(mode=mode, exist_ok=True)
            if is_link_or_junction(current):
                raise UnsafePathError(
                    _write_refusal(display, f"{shown} became a symbolic link or junction", boundary)
                )
        elif not current.is_dir():
            raise UnsafePathError(_write_refusal(display, f"{shown} is not a directory", boundary))
    expected = repo_root.resolve().joinpath(*parts)
    if os.path.normcase(str(current.resolve())) != os.path.normcase(str(expected)):
        raise UnsafePathError(_write_refusal(display, f"it resolves outside {boundary}", boundary))
    return current


def refuse_link(path: Path, *, boundary: str = REPOSITORY_BOUNDARY) -> Path:
    """``path`` itself, unless it is a link or junction a write would follow."""
    if is_link_or_junction(path):
        raise UnsafePathError(_write_refusal(path.name, f"{path.name} is a symbolic link or junction", boundary))
    return path


def _write_refusal(target: str, reason: str, boundary: str = REPOSITORY_BOUNDARY) -> str:
    return (
        f"BugPilot cannot write {target}: {reason}. BugPilot writes generated files only into real "
        f"directories inside {boundary}, and never through a link. Nothing was written."
    )


def _check_parts(parts: Sequence[str]) -> None:
    if not parts or any(part in ("", ".", "..") or "/" in part or "\\" in part for part in parts):
        raise UnsafePathError(f"Refusing an invalid generated path: {'/'.join(parts)!r}.")


def remove_owned_path(path: Path) -> bool:
    """Delete a path :func:`owned_path` returned. True if anything was there.

    Links *inside* the tree are removed as links, never followed: ``rmtree``
    unlinks a symbolic link and, on Windows, removes a junction without
    touching what it points at.
    """
    if not os.path.lexists(path):
        return False
    if path.is_dir() and not is_link_or_junction(path):
        shutil.rmtree(path)
    else:
        path.unlink()
    return True


# --- text as ``Path.read_text`` gave it (Option C, M2) ----------------------------------------------


def decode_text(data: bytes, encoding: str, errors: str = "strict") -> str:
    """``data`` as ``Path.read_text(encoding, errors)`` would have read it: decoded, line endings unified.

    For a reader that now gets a file's bytes from storage instead of opening a path: the same text, the
    same decoding error, and the same line endings, so a JSON error names the same line and position.
    """
    return data.decode(encoding, errors).replace("\r\n", "\n").replace("\r", "\n")


# --- reading what BugPilot generated, never through a link (O-1) -----------------------------------

#: The most bytes BugPilot reads from one file it generated. Far above any real one: a larger file is
#: refused before it is decoded or parsed, never read to its end and then cut.
GENERATED_READ_LIMIT = 16 * 1024 * 1024
#: Bytes asked for per read.
_CHUNK = 64 * 1024
_MIB = 1024 * 1024
_CLOEXEC = getattr(os, "O_CLOEXEC", 0)
_NOCTTY = getattr(os, "O_NOCTTY", 0)
_BINARY = getattr(os, "O_BINARY", 0) | getattr(os, "O_NOINHERIT", 0)
#: Whether this system opens a name relative to a folder's descriptor without following a link (POSIX).
_BY_DESCRIPTOR = (
    os.name == "posix"
    and all(hasattr(os, flag) for flag in ("O_NOFOLLOW", "O_DIRECTORY", "O_NONBLOCK"))
    and os.open in os.supports_dir_fd
    and os.stat in os.supports_dir_fd
    and os.stat in os.supports_follow_symlinks
    and os.scandir in os.supports_fd
)


def read_generated_file(base: Path, path: Path, *, limit: int = GENERATED_READ_LIMIT) -> bytes | None:
    """The bytes of ``path``, a file BugPilot generated below ``base``; ``None`` when it is not there (O-1).

    ``base`` is the repository root, which may itself sit behind a link: that is where the developer chose to
    work. Every component of ``path`` below it is judged as it stands, never followed. A link or junction on the
    way or at the file, a component that is not a folder, a file that is not a regular file (a FIFO, a socket,
    a device) and a file larger than ``limit`` are each refused with :class:`UnsafePathError`, in one sentence
    that names the path relative to ``base`` only. Any other ``OSError`` is raised without the path. A failed
    safe open is never retried the old way.

    - **POSIX:** each folder is opened from its parent's descriptor with ``O_NOFOLLOW``, and the file with
      ``O_NOFOLLOW`` and ``O_NONBLOCK``, so no link is gone through and a FIFO never blocks.
    - **Windows:** each component is looked at (``lstat``) and a link refused before the file is opened; the
      open must reach the very file the look found (device and file index), and the folders are looked at again
      after it. That refuses every link already there. A same-account process racing those looks is outside
      the threat model (plan §10.1), and no protection against it is claimed here.

    The read stops at ``limit`` plus one byte, whatever the file's size said.
    """
    parts = _generated_parts(base, path)
    display = "/".join(parts)
    if _BY_DESCRIPTOR:
        return _read_by_descriptor(base, parts, display, limit)
    return _read_by_look(base, parts, display, limit)


def generated_file_exists(base: Path, path: Path) -> bool:
    """Whether ``path`` below ``base`` is a regular file, judged as :func:`read_generated_file` judges it.

    ``False`` when nothing is there; a link or junction on the way or at the file, or anything there that is
    not a regular file, is refused. Nothing is read.
    """
    parts = _generated_parts(base, path)
    display = "/".join(parts)
    info = _entry(base, parts, display)
    if info is None:
        return False
    _refuse_unless_file(info, display)
    return True


def generated_folder_exists(base: Path, path: Path) -> bool:
    """Whether ``path`` below ``base`` is a real folder, every component judged as it stands, never followed.

    ``False`` when it, or a folder above it, is not there; a link, a junction or a non-folder on the way or at
    ``path`` itself is refused. Nothing is read.
    """
    parts = _generated_parts(base, path)
    display = "/".join(parts)
    info = _entry(base, parts, display)
    if info is None:
        return False
    _refuse_unless_folder(info, display, display)
    return True


def generated_file_names(base: Path, folder: Path) -> list[str] | None:
    """The names of the regular files in ``folder``, a folder BugPilot generated below ``base``; ``None`` when absent.

    The folder is judged as :func:`generated_folder_exists` judges it, and a link, a junction or a non-folder on
    the way or at it is refused. An entry is named only when it is a regular file as it stands: a link or junction
    (whatever it points at, and whether that exists), a folder, a FIFO or a device is left out, never followed.
    Nothing is read. POSIX lists from the folder's own descriptor; Windows looks at the folders again after the
    listing, as :func:`read_generated_file` does.
    """
    return _names_in(base, folder, stat.S_ISREG)


def generated_folder_names(base: Path, folder: Path) -> list[str] | None:
    """The names of the real folders in ``folder``, judged as :func:`generated_file_names` judges files.

    A link or junction among the entries, whatever it points at, is left out and never followed; the folder
    itself, and every one above it below ``base``, is refused when it is a link. ``None`` when it is absent.
    """
    return _names_in(base, folder, stat.S_ISDIR)


def _names_in(base: Path, folder: Path, kind: Callable[[int], bool]) -> list[str] | None:
    parts = _generated_parts(base, folder)
    display = "/".join(parts)
    if _BY_DESCRIPTOR:
        handle = _folder_by_descriptor(base, parts, display)
        if handle is None:
            return None
        try:
            return _names_of_kind(handle, kind)
        finally:
            os.close(handle)
    info = _entry_by_look(base, parts, display)
    if info is None:
        return None
    _refuse_unless_folder(info, display, display)
    names = _names_of_kind(base.joinpath(*parts), kind)
    again = _entry_by_look(base, parts, display)  # the folders again: one made a link since the first look is refused
    if again is not None:
        _refuse_unless_folder(again, display, display)
    return names


def _names_of_kind(folder: int | Path, kind: Callable[[int], bool]) -> list[str]:
    """The entries of ``folder`` of ``kind`` as they stand (never followed, never a link), in listing order."""
    names: list[str] = []
    try:
        listing = os.scandir(folder)
    except OSError as error:
        raise _bare(error) from None
    with listing:
        for entry in listing:
            try:
                info = entry.stat(follow_symlinks=False)
            except OSError:
                continue  # gone since it was listed
            if kind(info.st_mode) and not is_link_stat(info):
                names.append(entry.name)
    return names


def _generated_parts(base: Path, path: Path) -> tuple[str, ...]:
    try:
        parts = path.relative_to(base).parts
    except ValueError:
        raise UnsafePathError("BugPilot reads its generated files only inside the folder it works in.") from None
    _check_parts(parts)
    return parts


def _refusal(display: str, reason: str) -> UnsafePathError:
    return UnsafePathError(
        f"BugPilot will not read {display}: {reason}. It reads the files it generated only as regular files in "
        "real folders, never through a link, and nothing in this one was used."
    )


def _refuse_unless_folder(info: os.stat_result, shown: str, display: str) -> None:
    if is_link_stat(info):
        raise _refusal(display, f"{shown} is a symbolic link or junction")
    if not stat.S_ISDIR(info.st_mode):
        raise _refusal(display, f"{shown} is not a folder")


def _refuse_unless_file(info: os.stat_result, display: str) -> None:
    if is_link_stat(info):
        raise _refusal(display, "it is a symbolic link or junction")
    if not stat.S_ISREG(info.st_mode):
        raise _refusal(display, "it is not a regular file")


def _bare(error: OSError) -> OSError:
    """``error`` without the path it may name: the same class (by its number) and the system's text only."""
    if error.errno is None:
        return OSError(error.strerror or type(error).__name__)
    return OSError(error.errno, error.strerror)


def _bounded(handle: int, info: os.stat_result, display: str, limit: int) -> bytes:
    """The file's bytes from its own descriptor, refused when it is not regular or holds more than ``limit``."""
    _refuse_unless_file(info, display)
    too_large = f"it is larger than the {_size(limit)} BugPilot reads from one generated file"
    if info.st_size > limit:
        raise _refusal(display, too_large)
    chunks: list[bytes] = []
    total = 0
    while total <= limit:
        chunk = os.read(handle, min(_CHUNK, limit + 1 - total))
        if not chunk:
            break
        chunks.append(chunk)
        total += len(chunk)
    if total > limit:
        raise _refusal(display, too_large)
    return b"".join(chunks)


def _size(limit: int) -> str:
    return f"{limit // _MIB} MiB" if limit % _MIB == 0 else f"{limit:,} bytes"


def _entry(base: Path, parts: tuple[str, ...], display: str) -> os.stat_result | None:
    """The last component's ``lstat``, every folder above it judged first; ``None`` when something is missing."""
    if not _BY_DESCRIPTOR:
        return _entry_by_look(base, parts, display)
    folder = _folder_by_descriptor(base, parts[:-1], display)
    if folder is None:
        return None
    try:
        return _stat_at(folder, parts[-1])
    finally:
        os.close(folder)


# POSIX: one component at a time, from the parent's descriptor.


def _folder_by_descriptor(base: Path, folders: tuple[str, ...], display: str) -> int | None:
    """A descriptor for ``base / folders``, each opened with ``O_NOFOLLOW``; ``None`` when one is missing."""
    try:
        folder = os.open(base, os.O_RDONLY | os.O_DIRECTORY | _CLOEXEC)
    except FileNotFoundError:
        return None
    except OSError as error:
        raise _bare(error) from None
    for index, part in enumerate(folders):
        try:
            child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | _CLOEXEC, dir_fd=folder)
        except FileNotFoundError:
            os.close(folder)
            return None
        except OSError as error:
            # Judged by what is there, never by the error alone: a link is ELOOP on one system, ENOTDIR on another.
            try:
                info = _stat_at(folder, part)
            finally:
                os.close(folder)
            if info is not None:
                _refuse_unless_folder(info, "/".join(folders[: index + 1]), display)
            raise _bare(error) from None
        os.close(folder)
        folder = child
    return folder


def _stat_at(folder: int, name: str) -> os.stat_result | None:
    try:
        return os.stat(name, dir_fd=folder, follow_symlinks=False)
    except FileNotFoundError:
        return None
    except OSError as error:
        raise _bare(error) from None


def _read_by_descriptor(base: Path, parts: tuple[str, ...], display: str, limit: int) -> bytes | None:
    folder = _folder_by_descriptor(base, parts[:-1], display)
    if folder is None:
        return None
    try:
        try:
            handle = os.open(
                parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK | _CLOEXEC | _NOCTTY, dir_fd=folder
            )
        except FileNotFoundError:
            return None
        except OSError as error:
            info = _stat_at(folder, parts[-1])
            if info is not None:
                _refuse_unless_file(info, display)
            raise _bare(error) from None
        try:
            return _bounded(handle, os.fstat(handle), display, limit)
        finally:
            os.close(handle)
    finally:
        os.close(folder)


# Windows: look at each component, then hold the open to the file the look found.


def _entry_by_look(base: Path, parts: tuple[str, ...], display: str) -> os.stat_result | None:
    current = base
    for index, part in enumerate(parts[:-1]):
        current = current / part
        try:
            info = os.lstat(current)
        except (FileNotFoundError, NotADirectoryError):
            return None
        except OSError as error:
            raise _bare(error) from None
        _refuse_unless_folder(info, "/".join(parts[: index + 1]), display)
    try:
        return os.lstat(current / parts[-1])
    except (FileNotFoundError, NotADirectoryError):
        return None
    except OSError as error:
        raise _bare(error) from None


def _same_file(seen: os.stat_result, opened: os.stat_result) -> bool:
    """Whether the open reached the file the look found (device and file index).

    A file system that reports no file index proves nothing either way, and is judged by the look alone.
    """
    if seen.st_ino == 0 or opened.st_ino == 0:
        return True
    return (seen.st_dev, seen.st_ino) == (opened.st_dev, opened.st_ino)


def _read_by_look(base: Path, parts: tuple[str, ...], display: str, limit: int) -> bytes | None:
    seen = _entry_by_look(base, parts, display)
    if seen is None:
        return None
    _refuse_unless_file(seen, display)
    try:
        handle = os.open(base.joinpath(*parts), os.O_RDONLY | _BINARY)
    except FileNotFoundError:
        return None
    except OSError as error:
        raise _bare(error) from None
    try:
        opened = os.fstat(handle)
        if not _same_file(seen, opened):
            raise _refusal(display, "it changed while it was being opened")
        data = _bounded(handle, opened, display, limit)
    finally:
        os.close(handle)
    _entry_by_look(base, parts, display)  # the folders again: one made a link since the first look is refused
    return data
