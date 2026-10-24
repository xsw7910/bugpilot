"""Folders held open while a file in them is read: reads that follow no link (0.1.6, Option C, M1).

A path that is checked and then opened by name can change in between: a
folder or a file replaced by a link after the check is followed by the open.
Reading through this module leaves no such gap. It starts from one anchor
folder, which is followed (BugPilot's data root may be a link the user chose,
owner decision B4-2), and from there reaches each folder and file one
component at a time, never through a link, with every folder on the way held
open until :func:`held` ends.

- **POSIX:** each component is opened relative to its parent's descriptor
  (``dir_fd``) with ``O_NOFOLLOW`` (and ``O_DIRECTORY`` for a folder), so the
  system itself refuses a link at the name; a file is read from its own
  descriptor once ``fstat`` shows a regular file. A system without these
  primitives is refused (:class:`Unsupported`), never read the old way.
- **Windows:** documented Win32 has no open relative to a folder handle, so
  each folder is *held* instead: opened as itself, never a link's target
  (``FILE_FLAG_OPEN_REPARSE_POINT``), with list access and without sharing
  delete, which refuses its rename and its deletion while it is held. A child
  is opened by the name built from its held parent's final path
  (``GetFinalPathNameByHandleW``), and its own final path must then be
  exactly its parent's, read the same before the open and after it, followed
  by its name (folded, as the name asked for), or it is refused. A reparse
  point is never gone through: a link or junction (a name-surrogate tag, or
  none) counts as a link, any other tag as unsupported. A file is opened
  sharing read, write and delete, so BugPilot's atomic writers can still
  replace it, and is read from that handle only. Its data is opened without
  ``FILE_FLAG_BACKUP_SEMANTICS``, which folders need and with which a CI
  runner's process opened a file another program held exclusively; what
  cannot be opened that way is looked at for its attributes only.

The anchor is opened through its ``\\\\?\\`` form, so a data root longer than
``MAX_PATH`` is opened, never taken as missing: only "not found" there means
absent. A handle query the file system cannot answer (``ERROR_INVALID_FUNCTION``,
``ERROR_NOT_SUPPORTED``, ``ERROR_INVALID_PARAMETER``) is :class:`Unsupported`, as
a missing primitive is.

What Windows rests on without proof: the ancestors of a held folder are not
renamed while it is held (refused on NTFS when measured, but not documented),
and the volume is a local NTFS one. The final-path check narrows what such a
rename could do, but compares paths read at different moments, so it is no
proof of containment on its own (M3-R1, F1). Network shares, other file
systems and cloud placeholders were not tested.

Every handle and descriptor is closed when :func:`held` ends. An ``OSError``
raised here carries no path, only the system error. A held folder's own
failure is told apart from its entry's (:class:`FolderDenied`,
:class:`FolderFailed`). The module knows nothing of BugPilot's layout: its
caller names every component.
"""

from __future__ import annotations

import contextlib
import ntpath
import os
import stat
import struct
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Iterator, Literal

Kind = Literal["file", "absent", "folder", "link", "reparse", "other"]
Reason = Literal["link", "not-a-folder", "reparse", "moved"]

#: Bytes asked for per read of a held file.
_CHUNK = 64 * 1024
#: Never part of a plain name; on Windows ``:`` would name an alternate data stream.
_NEVER_IN_NAME = ("/", "\\", "\0") + ((":",) if os.name == "nt" else ())


class Unsupported(Exception):
    """This system lacks what a held read needs. Nothing is read the old way instead."""


class Refused(Exception):
    """A component that is not gone through: a link, not a folder, an unsupported reparse point, or one that moved."""

    def __init__(self, reason: Reason) -> None:
        super().__init__(reason)
        self.reason = reason


class FolderDenied(PermissionError):
    """A held folder denied even a look at an entry in it (POSIX: read permission, no search): the folder's failure.

    Raised by :meth:`Folder.open_file` instead of the entry's own error, so a reader never takes a folder it cannot
    search for a file it cannot read. ``error`` is the open's error, without a path.
    """

    def __init__(self, error: OSError) -> None:
        super().__init__(error.errno, error.strerror)
        self.error = error


class FolderFailed(OSError):
    """A held folder's own handle could not be queried (Windows): the folder's failure, never an entry's.

    Raised by :meth:`Folder.open_file` instead of the query's error, so a reader never takes a folder that
    failed for a file it cannot read (M3-R2A, F2). ``error`` is the query's error, without a path.
    """

    def __init__(self, error: OSError) -> None:
        super().__init__(error.errno, error.strerror)
        self.error = error


def plain_name(name: str) -> bool:
    """Whether ``name`` names one entry in a folder: no separator, no ``.`` or ``..``, nothing that names a stream."""
    return isinstance(name, str) and name not in ("", ".", "..") and not any(c in name for c in _NEVER_IN_NAME)


@dataclass
class Opened:
    """What :meth:`Folder.open_file` found at a name, never followed; ``info`` and :meth:`read` for a file only."""

    kind: Kind
    info: os.stat_result | None = None
    descriptor: int | None = None

    def read(self, limit: int | None) -> bytes | None:
        """The file's bytes from its own descriptor, at most ``limit``; ``None`` when it holds more."""
        if self.descriptor is None:
            raise ValueError("only a regular file is read")
        wanted = None if limit is None else limit + 1
        chunks: list[bytes] = []
        total = 0
        while wanted is None or total < wanted:
            chunk = os.read(self.descriptor, _CHUNK if wanted is None else min(_CHUNK, wanted - total))
            if not chunk:
                break
            chunks.append(chunk)
            total += len(chunk)
        data = b"".join(chunks)
        return None if limit is not None and len(data) > limit else data


class Folder:
    """One folder held open, reached from the anchor without following a link. Valid only inside :func:`held`."""

    def __init__(self, stack: contextlib.ExitStack) -> None:
        self._stack = stack

    def child(self, name: str) -> Folder | None:
        """The folder ``name`` in this one, held too; ``None`` when nothing is there, :class:`Refused` for the rest."""
        raise NotImplementedError

    def open_file(self, name: str) -> Opened:
        """What is at ``name``, opened as itself; only a regular file stays open, to be read."""
        raise NotImplementedError

    def names(self) -> list[str]:
        """The names of this folder's entries, in no order. Nothing is followed or opened."""
        raise NotImplementedError


@contextlib.contextmanager
def held(anchor: Path) -> Iterator[Folder | None]:
    """The anchor folder, held (it is followed); ``None`` when it does not exist. All closed on exit.

    A file or anything else at the anchor is :class:`Refused` (``not-a-folder``).
    A system without the primitives is :class:`Unsupported`.
    """
    with contextlib.ExitStack() as stack:
        if os.name == "nt":
            if _KERNEL32 is None:
                raise Unsupported("the Windows file functions could not be loaded")
            yield _hold_windows(anchor, stack)
        elif os.name == "posix" and _posix_ready():
            yield _hold_posix(anchor, stack)
        else:
            raise Unsupported("this system cannot open a file relative to a folder without following links")


def _bare(error: OSError) -> OSError:
    """``error`` without the path it may name: the same class and number, the system's text only."""
    if error.errno is None:
        return OSError(error.strerror or type(error).__name__)
    return OSError(error.errno, error.strerror)


# --- POSIX: descriptor-relative opens -------------------------------------------------------------------

_POSIX_FLAGS = ("O_DIRECTORY", "O_NOFOLLOW", "O_CLOEXEC", "O_NONBLOCK", "O_NOCTTY")


def _posix_ready() -> bool:
    return (
        all(hasattr(os, flag) for flag in _POSIX_FLAGS)
        and os.open in os.supports_dir_fd
        and os.stat in os.supports_dir_fd
        and os.stat in os.supports_follow_symlinks
        and os.scandir in os.supports_fd
    )


def _posix_kind(info: os.stat_result) -> Kind:
    if stat.S_ISLNK(info.st_mode):
        return "link"
    if stat.S_ISDIR(info.st_mode):
        return "folder"
    return "file" if stat.S_ISREG(info.st_mode) else "other"


def _hold_posix(anchor: Path, stack: contextlib.ExitStack) -> Folder | None:
    try:
        descriptor = os.open(anchor, os.O_RDONLY | os.O_DIRECTORY | os.O_CLOEXEC)
    except FileNotFoundError:
        return None
    except NotADirectoryError:
        if os.path.lexists(anchor):
            raise Refused("not-a-folder") from None
        return None  # a file above the anchor: the anchor does not exist
    except OSError as error:
        raise _bare(error) from None
    stack.callback(os.close, descriptor)
    return _PosixFolder(descriptor, stack)


class _PosixFolder(Folder):
    def __init__(self, descriptor: int, stack: contextlib.ExitStack) -> None:
        super().__init__(stack)
        self._descriptor = descriptor

    def _kind(self, name: str) -> Kind | None:
        """What is at ``name`` now, not followed; ``None`` when even that cannot be seen."""
        try:
            return _posix_kind(os.stat(name, dir_fd=self._descriptor, follow_symlinks=False))
        except FileNotFoundError:
            return "absent"
        except OSError:
            return None

    def child(self, name: str) -> Folder | None:
        if not plain_name(name):
            raise ValueError("not a plain name")
        flags = os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW | os.O_CLOEXEC
        try:
            descriptor = os.open(name, flags, dir_fd=self._descriptor)
        except FileNotFoundError:
            return None
        except OSError as error:
            # Judged by what is there, never by the error alone: a link is ELOOP on one system and ENOTDIR on another.
            kind = self._kind(name)
            if kind == "link":
                raise Refused("link") from None
            if kind in ("file", "other"):
                raise Refused("not-a-folder") from None
            raise _bare(error) from None  # a folder that cannot be opened, or one gone since: never "absent"
        self._stack.callback(os.close, descriptor)
        if not stat.S_ISDIR(os.fstat(descriptor).st_mode):
            raise Refused("not-a-folder")
        return _PosixFolder(descriptor, self._stack)

    def open_file(self, name: str) -> Opened:
        if not plain_name(name):
            raise ValueError("not a plain name")
        flags = os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC | os.O_NONBLOCK | os.O_NOCTTY
        try:
            descriptor = os.open(name, flags, dir_fd=self._descriptor)
        except FileNotFoundError:
            return Opened("absent")
        except OSError as error:
            try:
                kind = _posix_kind(os.stat(name, dir_fd=self._descriptor, follow_symlinks=False))
            except FileNotFoundError:
                kind = "absent"
            except PermissionError:
                # A look at an entry needs only search permission on this folder, none on the entry: refused, it is
                # the folder that cannot be searched, never the file that cannot be read.
                raise FolderDenied(_bare(error)) from None
            except OSError:
                kind = None
            if kind in ("link", "folder", "other"):
                return Opened(kind)
            raise _bare(error) from None
        self._stack.callback(os.close, descriptor)
        info = os.fstat(descriptor)
        if stat.S_ISREG(info.st_mode):
            return Opened("file", info, descriptor)
        return Opened("folder" if stat.S_ISDIR(info.st_mode) else "other")

    def names(self) -> list[str]:
        with os.scandir(self._descriptor) as listing:
            return [entry.name for entry in listing]


# --- Windows: held folder handles, documented Win32 through ctypes ------------------------------------

_GENERIC_READ = 0x80000000
_FILE_LIST_DIRECTORY = 0x0001
_FILE_READ_ATTRIBUTES = 0x0080
_SYNCHRONIZE = 0x00100000
#: A held folder shares read and write, never delete: it cannot be renamed or deleted while held.
_SHARE_HOLD = 0x1 | 0x2
#: A file shares delete too, so an atomic writer can still replace it while it is read.
_SHARE_FILE = 0x1 | 0x2 | 0x4
_OPEN_EXISTING = 3
_BACKUP_SEMANTICS = 0x02000000
_OPEN_REPARSE_POINT = 0x00200000
_FILE_ATTRIBUTE_TAG_INFO = 9
_FILE_FULL_DIRECTORY_INFO = 14
_FILE_FULL_DIRECTORY_RESTART_INFO = 15
_ATTRIBUTE_DIRECTORY = 0x10
_ATTRIBUTE_REPARSE_POINT = 0x400
_NAME_SURROGATE = 0x20000000
_ERROR_NOT_FOUND = (2, 3)  # ERROR_FILE_NOT_FOUND, ERROR_PATH_NOT_FOUND
_ERROR_NO_MORE_FILES = 18
#: What a handle query returns where the file system cannot answer it: invalid function, not supported, invalid
#: parameter. Unsupported, never a failure of one file to be shown as such.
_ERROR_NOT_ANSWERED = (1, 50, 87)
_FINAL_PATH_LIMIT = 32768
_EXTENDED_PREFIX = "\\\\?\\"
_LISTING_BYTES = 64 * 1024
#: FILE_FULL_DIR_INFO: NextEntryOffset, then FileAttributes and FileNameLength at 56; the name starts at 68.
_LISTING_ENTRY = struct.Struct("<I52xII")
_LISTING_NAME = 68

_KERNEL32 = None
if os.name == "nt":
    try:
        import ctypes
        import msvcrt
        from ctypes import wintypes

        class _AttributeTag(ctypes.Structure):
            _fields_ = [("FileAttributes", wintypes.DWORD), ("ReparseTag", wintypes.DWORD)]

        _INVALID_HANDLE = wintypes.HANDLE(-1).value
        _KERNEL32 = ctypes.WinDLL("kernel32", use_last_error=True)
        _KERNEL32.CreateFileW.argtypes = (
            wintypes.LPCWSTR, wintypes.DWORD, wintypes.DWORD, wintypes.LPVOID, wintypes.DWORD, wintypes.DWORD,
            wintypes.HANDLE,
        )
        _KERNEL32.CreateFileW.restype = wintypes.HANDLE
        _KERNEL32.GetFileInformationByHandleEx.argtypes = (
            wintypes.HANDLE, ctypes.c_int, wintypes.LPVOID, wintypes.DWORD,
        )
        _KERNEL32.GetFileInformationByHandleEx.restype = wintypes.BOOL
        _KERNEL32.GetFinalPathNameByHandleW.argtypes = (
            wintypes.HANDLE, wintypes.LPWSTR, wintypes.DWORD, wintypes.DWORD,
        )
        _KERNEL32.GetFinalPathNameByHandleW.restype = wintypes.DWORD
        _KERNEL32.CloseHandle.argtypes = (wintypes.HANDLE,)
        _KERNEL32.CloseHandle.restype = wintypes.BOOL
    except (ImportError, OSError, AttributeError):  # pragma: no cover - every supported Windows has these
        _KERNEL32 = None


def _windows_error() -> OSError:
    return ctypes.WinError(ctypes.get_last_error())  # no path: only the system's number and text


def _query_error() -> Exception:
    """Why a handle query failed: :class:`Unsupported` where the file system cannot answer it, else its error."""
    code = ctypes.get_last_error()
    if code in _ERROR_NOT_ANSWERED:
        return Unsupported("the file system cannot describe a held handle")
    return ctypes.WinError(code)


def _create(path: str, access: int, share: int, flags: int, *, audited: str | None = None) -> int:
    """``CreateFileW`` on an existing entry. Raises the ``open`` audit event first, as ``os.open`` does.

    ``audited`` is the path the event names when ``path`` is the anchor's ``\\\\?\\`` form: the form a reader
    of the event (the test suite's isolation guard) compares.
    """
    sys.audit("open", audited or path, None, os.O_RDONLY)
    handle = _KERNEL32.CreateFileW(path, access, share, None, _OPEN_EXISTING, flags, None)
    if handle is None or handle == _INVALID_HANDLE:
        raise _windows_error()
    return handle


def _close(handle: int) -> None:
    _KERNEL32.CloseHandle(handle)


def _windows_kind(handle: int) -> Kind:
    """What the handle is, from the handle: a link, an unsupported reparse point, a folder or a file."""
    found = _AttributeTag()
    if not _KERNEL32.GetFileInformationByHandleEx(
        handle, _FILE_ATTRIBUTE_TAG_INFO, ctypes.byref(found), ctypes.sizeof(found)
    ):
        raise _query_error()
    return _kind_of(found.FileAttributes, found.ReparseTag)


def _kind_of(attributes: int, tag: int) -> Kind:
    """A tag that is a name surrogate, or none at all, is a link, as ``safe_paths.is_link_stat`` judges it."""
    if attributes & _ATTRIBUTE_REPARSE_POINT:
        return "link" if tag == 0 or tag & _NAME_SURROGATE else "reparse"
    return "folder" if attributes & _ATTRIBUTE_DIRECTORY else "file"


def _final_path(handle: int) -> str:
    """Where the handle's entry is now, in ``\\\\?\\`` form. A volume without one is unsupported."""
    buffer = ctypes.create_unicode_buffer(_FINAL_PATH_LIMIT)
    length = _KERNEL32.GetFinalPathNameByHandleW(handle, buffer, _FINAL_PATH_LIMIT, 0)
    if not length:
        raise _query_error()
    if length >= _FINAL_PATH_LIMIT or not buffer.value.startswith(_EXTENDED_PREFIX):
        raise Unsupported("the folder has no final path BugPilot can build on")
    return buffer.value


def _joined(base: str, name: str) -> str:
    return (base if base.endswith("\\") else base + "\\") + name


def _directly_inside(child: str, parent: str, name: str) -> bool:
    """Whether the final path ``child`` is ``name`` directly in the folder whose final path is ``parent``.

    The folder's part is compared exactly, as the system spelled both final paths: folded, two different
    folders that differ only in case (a case-sensitive directory) would count as one. Only the last component
    is folded, as before, since the entry was opened by the name asked for, in whatever case it has on disk.
    An exact comparison of two paths read at different moments is not containment by construction (M3-R2A).
    """
    prefix = _joined(parent, "")
    if not child.startswith(prefix):
        return False
    leaf = child[len(prefix) :]
    return "\\" not in leaf and ntpath.normcase(leaf) == ntpath.normcase(name)


def _extended(path: str) -> str:
    """An absolute path in ``\\\\?\\`` form (``\\\\?\\UNC\\`` for a share), which no ``MAX_PATH`` limit applies to."""
    if path.startswith(("\\\\?\\", "\\\\.\\")):
        return path
    if path.startswith("\\\\"):
        return _EXTENDED_PREFIX + "UNC\\" + path[2:]
    return _EXTENDED_PREFIX + path


def _hold_windows(anchor: Path, stack: contextlib.ExitStack) -> Folder | None:
    plain = os.path.abspath(anchor)
    try:
        handle = _create(
            _extended(plain),
            _FILE_LIST_DIRECTORY | _FILE_READ_ATTRIBUTES | _SYNCHRONIZE,
            _SHARE_HOLD,
            _BACKUP_SEMANTICS,
            audited=plain,
        )
    except OSError as error:
        # By the system's own code, never by class: Python makes a name too long, or a network path that
        # cannot be reached, a FileNotFoundError too, and neither is "nothing there".
        if getattr(error, "winerror", None) in _ERROR_NOT_FOUND:
            return None
        raise
    stack.callback(_close, handle)
    if _windows_kind(handle) != "folder":
        raise Refused("not-a-folder")
    _final_path(handle)  # unsupported before anything is read, not halfway through
    return _WindowsFolder(handle, stack)


class _WindowsFolder(Folder):
    def __init__(self, handle: int, stack: contextlib.ExitStack) -> None:
        super().__init__(stack)
        self._handle = handle

    def _own_path(self) -> str:
        """This folder's final path. A failed query is the folder's (:class:`FolderFailed`), never an entry's."""
        try:
            return _final_path(self._handle)
        except OSError as error:
            raise FolderFailed(error) from None

    def _open(self, name: str, access: int, share: int, flags: int) -> int | None:
        """``name`` in this folder, opened as itself and shown to be in it; ``None`` when nothing is there."""
        if not plain_name(name):
            raise ValueError("not a plain name")
        base = self._own_path()
        try:
            handle = _create(_joined(base, name), access, share, flags)
        except OSError as error:
            if getattr(error, "winerror", None) not in _ERROR_NOT_FOUND:
                raise  # in use, no permission, being deleted: never "absent"
            if self._own_path() != base:
                raise Refused("moved") from None
            return None
        try:
            # The entry opened is the one in this held folder only if its own final path is this folder's, as it
            # was before the open and still is, followed by its name.
            inside = _directly_inside(_final_path(handle), base, name) and self._own_path() == base
        except BaseException:
            _close(handle)
            raise
        if not inside:
            _close(handle)
            raise Refused("moved")
        return handle

    def child(self, name: str) -> Folder | None:
        try:
            handle = self._open(
                name, _FILE_LIST_DIRECTORY | _FILE_READ_ATTRIBUTES | _SYNCHRONIZE, _SHARE_HOLD,
                _BACKUP_SEMANTICS | _OPEN_REPARSE_POINT,
            )
        except FolderFailed as failed:
            raise failed.error from None  # on the way, every failure is a folder's, raised as it always was
        if handle is None:
            return None
        self._stack.callback(_close, handle)
        kind = _windows_kind(handle)
        if kind == "link":
            raise Refused("link")
        if kind == "reparse":
            raise Refused("reparse")
        if kind != "folder":
            raise Refused("not-a-folder")
        return _WindowsFolder(handle, self._stack)

    def _kind(self, name: str) -> Kind | None:
        """What is at ``name`` now, opened for its attributes only, never its data; ``None`` when even that fails."""
        try:
            handle = self._open(
                name, _FILE_READ_ATTRIBUTES | _SYNCHRONIZE, _SHARE_FILE, _BACKUP_SEMANTICS | _OPEN_REPARSE_POINT
            )
        except FolderFailed:
            raise  # the folder's failure, which says nothing about the entry
        except OSError:
            return None
        if handle is None:
            return "absent"
        try:
            return _windows_kind(handle)
        except OSError:
            return None
        finally:
            _close(handle)

    def open_file(self, name: str) -> Opened:
        # The data is opened without FILE_FLAG_BACKUP_SEMANTICS: with it, a CI runner's process (run 39989051086,
        # presumably through its backup privilege) opened a file another program held exclusively. Without it a folder,
        # a junction or a directory link cannot be opened at all, so a failed open is judged by what is at the
        # name, as on POSIX: one of those is reported as itself, anything else keeps the open's own error.
        try:
            handle = self._open(name, _GENERIC_READ, _SHARE_FILE, _OPEN_REPARSE_POINT)
        except FolderFailed:
            raise  # the folder's failure: never judged as the entry's
        except OSError:
            kind = self._kind(name)
            if kind in ("folder", "link", "reparse"):
                return Opened(kind)
            raise  # a file in use or not readable, or one gone since: never "absent"
        if handle is None:
            return Opened("absent")
        try:
            kind = _windows_kind(handle)
            if kind != "file":
                _close(handle)
                return Opened(kind)
            descriptor = msvcrt.open_osfhandle(handle, os.O_RDONLY | os.O_BINARY)  # it owns the handle now
        except BaseException:
            _close(handle)
            raise
        self._stack.callback(os.close, descriptor)
        return Opened("file", os.fstat(descriptor), descriptor)

    def names(self) -> list[str]:
        buffer = ctypes.create_string_buffer(_LISTING_BYTES)
        found: list[str] = []
        information = _FILE_FULL_DIRECTORY_RESTART_INFO
        while True:
            if not _KERNEL32.GetFileInformationByHandleEx(self._handle, information, buffer, _LISTING_BYTES):
                if ctypes.get_last_error() == _ERROR_NO_MORE_FILES:
                    break
                raise _query_error()
            raw = buffer.raw
            offset = 0
            while True:
                following, _attributes, length = _LISTING_ENTRY.unpack_from(raw, offset)
                start = offset + _LISTING_NAME
                name = raw[start : start + length].decode("utf-16-le", "surrogatepass")
                if name not in (".", ".."):
                    found.append(name)
                if not following:
                    break
                offset += following
            information = _FILE_FULL_DIRECTORY_INFO
        return found
