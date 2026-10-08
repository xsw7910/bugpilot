"""Finding external programs without trusting the current directory.

BugPilot runs in the repository it is preparing: that directory is the process's
current directory, and every ``git`` and ``rg`` call passes it as ``cwd``. On
Windows a bare program name is looked up in the current directory *before*
``PATH`` — by ``CreateProcess`` and by ``shutil.which`` alike, unless the
``NoDefaultCurrentDirectoryInExePath`` variable happens to be set — so a
``git.exe`` committed to a repository would run instead of Git the moment
BugPilot touched it.

So no program is started by its bare name. :func:`find_executable` resolves a
name to an absolute path using only the absolute entries of ``PATH``, in order,
with ``PATHEXT`` on Windows; it never consults the current directory, and it
skips empty, ``.`` and other relative ``PATH`` entries, which mean the same
thing. Callers start the absolute path it returns.

The VS Code extension applies the same policy to the programs it starts
(``extension/src/executablePath.ts``).
"""

from __future__ import annotations

import os
import sys
from pathlib import Path

_DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD"


def _is_windows() -> bool:
    return sys.platform == "win32"


def _runnable(candidate: Path) -> bool:
    try:
        if not candidate.is_file():
            return False
    except OSError:
        return False
    return True if _is_windows() else os.access(candidate, os.X_OK)


def find_executable(name: str, path: str | None = None) -> str | None:
    """The absolute path ``name`` resolves to, or ``None``.

    - An absolute path is returned as it is, if it names a runnable file.
    - A relative path with a directory part (``tools/rg``) is refused: it would
      resolve against the repository.
    - A bare name is searched in the absolute entries of ``path`` (default: the
      ``PATH`` environment variable), never in the current directory.
    """
    if not name:
        return None
    given = Path(name)
    if given.is_absolute():
        return str(given) if _runnable(given) else None
    if os.sep in name or (os.altsep and os.altsep in name) or "/" in name:
        return None
    search = os.environ.get("PATH", "") if path is None else path
    if _is_windows():
        extensions = [ext for ext in (os.environ.get("PATHEXT") or _DEFAULT_PATHEXT).split(";") if ext]
        has_extension = any(name.lower().endswith(ext.lower()) for ext in extensions)
        names = [name] if has_extension else [name + ext for ext in extensions]
    else:
        names = [name]
    for entry in search.split(os.pathsep):
        entry = entry.strip().strip('"')
        if not entry or not os.path.isabs(entry):
            continue
        for candidate_name in names:
            candidate = Path(entry) / candidate_name
            if _runnable(candidate):
                return str(candidate)
    return None


def child_environment(base: dict[str, str] | None = None) -> dict[str, str]:
    """An environment for a child that starts programs of its own.

    On Windows, ``NoDefaultCurrentDirectoryInExePath`` makes ``cmd.exe`` and
    ``CreateProcess`` callers inside the child skip the current directory too —
    an npm ``claude.cmd`` shim, for one, looks up a bare ``node``.
    """
    env = dict(os.environ if base is None else base)
    if _is_windows():
        env["NoDefaultCurrentDirectoryInExePath"] = "1"
    return env
