"""Writes into `.ai/<work item>/` that another process may be reading."""

from __future__ import annotations

import contextlib
import os
import stat
import tempfile
import time
from pathlib import Path

from .safe_paths import refuse_link

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


def atomic_write_text(path: Path, text: str) -> None:
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
    create), so a link planted at the temp name cannot be written through; it
    is written in text mode, as ``Path.write_text`` writes. Its permissions
    follow `_keep_permissions`: owner-only when new, the target's when rewritten.
    """
    refuse_link(path)
    handle, name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    temp = Path(name)
    _keep_permissions(handle, path)
    with os.fdopen(handle, "w", encoding="utf-8") as stream:
        stream.write(text)
    for attempt in range(4):
        try:
            os.replace(temp, path)
            return
        except PermissionError:
            if attempt == 3:
                break
            time.sleep(0.05)
    try:
        # Checked again: a link could have been made there since the first check.
        refuse_link(path)
        path.write_text(text, encoding="utf-8")
    finally:
        temp.unlink(missing_ok=True)
