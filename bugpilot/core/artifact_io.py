"""Writes into `.ai/<work item>/` that another process may be reading — and the other files BugPilot writes whole.

The Jira credentials file among them (0.1.5, S2): written ``private``.
"""

from __future__ import annotations

import contextlib
import os
import stat
import tempfile
import time
from pathlib import Path

from .safe_paths import UnsafePathError, is_link_or_junction, refuse_link

#: Permission bits are POSIX's: on Windows `chmod` only sets the read-only flag.
_POSIX = os.name == "posix"


def _keep_permissions(handle: int, path: Path) -> None:
    """Give the new file an existing target's permission bits; a new file keeps ``mkstemp``'s 0600.

    BugPilot's permission policy for what it writes: a file it creates is
    owner-only (0600 on POSIX), and a file it rewrites keeps the permission
    bits it had — never widened, never narrowed, so a team file a checkout made
    group- or world-readable stays readable to the others who share it. Only
    the nine permission bits are carried (no setuid, setgid or sticky bit), and
    they are set through the temp file's own descriptor (``fchmod``), never by
    path, so no link is followed. If they cannot be set, the file stays
    owner-only: the safe direction.
    """
    if not _POSIX:
        return
    with contextlib.suppress(OSError):
        existing = os.lstat(path)
        if stat.S_ISREG(existing.st_mode):
            os.fchmod(handle, stat.S_IMODE(existing.st_mode) & 0o777)


def _owner_only(handle: int) -> None:
    """The private rule (0.1.5, S2): 0600 on POSIX, new or rewritten, whatever the umask or the old bits.

    Set through the temp file's own descriptor before a byte is written; the
    target's bits are not consulted. If it cannot be set, the file keeps
    ``mkstemp``'s mode, which is owner-only too.
    """
    if not _POSIX:
        return
    with contextlib.suppress(OSError):
        os.fchmod(handle, 0o600)


def _check_temp(handle: int, temp: Path, path: Path) -> None:
    """The temp file just created is the file at its name, and its name is not a link (0.1.5, Batch 4).

    POSIX's exclusive create never follows a link. Windows' follows a *dangling*
    one and creates its target — observed for Python's ``O_EXCL`` there — so a
    link planted at the random temp name would get what is written next. The
    descriptor's file (``fstat``) is compared with what the name holds
    (``lstat``) before a byte is written; a link, or a different file, is refused.
    """
    opened = os.fstat(handle)
    try:
        named = os.lstat(temp)
    except OSError:
        named = None
    if (
        named is None
        or is_link_or_junction(temp)
        or (named.st_dev, named.st_ino) != (opened.st_dev, opened.st_ino)
    ):
        raise UnsafePathError(
            f"BugPilot cannot write {path.name}: its temporary file's name was a symbolic link or junction. "
            "Nothing was written."
        )


def _replace(temp: Path, path: Path) -> PermissionError | None:
    """``os.replace``, retried for Windows; the last ``PermissionError`` if it never succeeded."""
    for attempt in range(4):
        try:
            os.replace(temp, path)
            return None
        except PermissionError as error:
            if attempt == 3:
                return error
            time.sleep(0.05)
    return None  # not reached: the loop returns on its last attempt


def atomic_write_text(path: Path, text: str, *, private: bool = False) -> None:
    """Write via a temp file and one rename, so a reader never sees half a file.

    The retry is for Windows: ``os.replace`` onto a path another process has open
    fails with ``PermissionError`` there, and the readers of these files are
    exactly that — an extension restoring its checklist, an MCP ``get_status``
    call. Those reads last microseconds, so a couple of retries clear it.

    If it still fails, write in place rather than raising: a torn read costs one
    stale checklist, while a raised exception costs the whole step.

    A target that is itself a symbolic link or junction is refused before
    anything is written: the fallback below would follow it. The temp file is
    created new, under a name nobody can predict (``mkstemp``: exclusive
    create), and checked to be the file at that name before a byte is written
    (`_check_temp`: Windows' exclusive create follows a dangling link), so a link
    planted at the temp name cannot be written through; it is written in text
    mode, as ``Path.write_text`` writes. Its permissions
    follow `_keep_permissions`: owner-only when new, the target's when rewritten.
    The rename replaces whatever is at the target's name and never follows it,
    so a link made there after the first check is replaced, not written through.

    ``private`` is for a file that holds a secret — the Jira credentials file
    (0.1.5, S2): owner-only from the temp file's creation, whether new or
    rewritten, never the old bits (`_owner_only`); and on POSIX never the
    in-place fallback, which would create the file with the umask's bits or keep
    the old ones — the replace's error is raised instead. On Windows, where
    there are no such bits, it falls back like any other file.

    Whatever fails, the temp file is removed and the target is left as it was.
    """
    refuse_link(path)
    handle, name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    temp = Path(name)
    replaced = False
    try:
        try:
            _check_temp(handle, temp, path)
            if private:
                _owner_only(handle)
            else:
                _keep_permissions(handle, path)
            stream = os.fdopen(handle, "w", encoding="utf-8")
        except BaseException:
            os.close(handle)
            raise
        with stream:
            stream.write(text)
        error = _replace(temp, path)
        if error is None:
            replaced = True
            return
        if private and _POSIX:
            raise error
        # Checked again: a link could have been made there since the first check.
        refuse_link(path)
        path.write_text(text, encoding="utf-8")
    finally:
        if not replaced:
            temp.unlink(missing_ok=True)
