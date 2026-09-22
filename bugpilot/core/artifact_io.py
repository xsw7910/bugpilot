"""Writes into `.ai/<work item>/` that another process may be reading."""

from __future__ import annotations

import os
import time
from pathlib import Path


def atomic_write_text(path: Path, text: str) -> None:
    """Write via a temp file and one rename, so a reader never sees half a file.

    The retry is for Windows: ``os.replace`` onto a path another process has open
    fails with ``PermissionError`` there, and the readers of these files are
    exactly that — an extension restoring its checklist, an MCP ``get_status``
    call. Those reads last microseconds, so a couple of retries clear it.

    If it still fails, write in place rather than raising: a torn read costs one
    stale checklist, while a raised exception costs the whole step.
    """
    temp = path.with_name(path.name + f".tmp{os.getpid()}")
    temp.write_text(text, encoding="utf-8")
    for attempt in range(4):
        try:
            os.replace(temp, path)
            return
        except PermissionError:
            if attempt == 3:
                break
            time.sleep(0.05)
    try:
        path.write_text(text, encoding="utf-8")
    finally:
        temp.unlink(missing_ok=True)
