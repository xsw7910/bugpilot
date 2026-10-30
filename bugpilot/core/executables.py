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
#: What Windows starts by itself. A `.bat` or `.cmd` it runs through `cmd.exe` (0.1.7, S-8).
_NATIVE_EXTENSIONS = (".exe", ".com")
_BATCH_EXTENSIONS = (".bat", ".cmd")


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
    return _find(name, path, native_only=False)


def find_program(name: str, path: str | None = None) -> str | None:
    """``name`` as a native program: :func:`find_executable`, but on Windows never a ``.bat`` or ``.cmd`` (0.1.7, S-8).

    Windows runs a batch file through ``cmd.exe``, which acts on ``&``, ``%``,
    ``^``, ``|``, ``<``, ``>``, parentheses and quotes in its arguments, and
    nothing escapes them for it. ``git`` and ``rg`` are handed text BugPilot did
    not write (an issue's search terms, ``--grep`` patterns, file names), so they
    are started only as programs: a batch file earlier on ``PATH`` is passed over
    for a program further along, and a name with no program at all is not found.
    """
    return _find(name, path, native_only=True)


def batch_file_only(name: str, path: str | None = None) -> str | None:
    """The batch file ``name`` resolves to when no native program does: why :func:`find_program` found nothing."""
    if find_program(name, path) is not None:
        return None
    found = find_executable(name, path)
    return found if found is not None and found.lower().endswith(_BATCH_EXTENSIONS) else None


def not_found_sentence(name: str) -> str:
    """Why ``name`` cannot be started, in one sentence: not on ``PATH``, or there only as a batch file (S-8)."""
    batch = batch_file_only(name)
    if batch is None:
        return f"{name} was not found on PATH."
    return (
        f"{name} is on PATH only as a batch file ({Path(batch).name}), which BugPilot does not start: Windows would "
        f"run it through cmd.exe. Install {name} as a program."
    )


def _find(name: str, path: str | None, *, native_only: bool) -> str | None:
    if not name:
        return None
    native_only = native_only and _is_windows()
    given = Path(name)
    if given.is_absolute():
        if native_only and given.suffix.lower() not in _NATIVE_EXTENSIONS:
            return None
        return str(given) if _runnable(given) else None
    if os.sep in name or (os.altsep and os.altsep in name) or "/" in name:
        return None
    search = os.environ.get("PATH", "") if path is None else path
    if _is_windows():
        extensions = (
            list(_NATIVE_EXTENSIONS)
            if native_only
            else [ext for ext in (os.environ.get("PATHEXT") or _DEFAULT_PATHEXT).split(";") if ext]
        )
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
