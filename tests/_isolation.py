"""Test isolation: no test reaches the developer's real BugPilot data (0.1.6 Batch 0A, plan §11.1).

Two layers, both test-only:

1. **The environment.** ``isolate_session()`` runs from the first statements of
   ``tests/conftest.py`` — before pytest collects or imports any test module, so
   collection-time renders and module-scoped fixtures already see it — and from
   ``main()`` of every helper that is also run as a script. It creates one
   disposable session folder and points ``HOME``, ``USERPROFILE`` (and on
   Windows ``HOMEDRIVE``/``HOMEPATH``), ``BUGPILOT_HOME`` and
   ``BUGPILOT_CONFIG_DIR`` into it. It removes the variables that reach a real
   service or choose a real folder: every ``JIRA_*``, ``SMTP_*``, ``GRAPH_*``
   and ``BUGPILOT_EMAIL_*`` variable, ``BUGPILOT_AUTO_JIRA_COMMENT`` and
   ``BUGPILOT_MCP_REPO_ROOT`` (:data:`SANITIZED_PREFIXES`,
   :data:`SANITIZED_NAMES`). Agent-command variables (``BUGPILOT_CLAUDE_*``,
   ``BUGPILOT_COPILOT_*``) are kept: a test that starts an agent sets a stub
   itself. Every child process inherits the result.

2. **A guard that fails closed.** ``sys.addaudithook`` sees the interpreter's
   file events *before* they happen. An event whose path falls under a
   protected root — the real home's ``.bugpilot`` and any BugPilot data folder
   the developer configured — raises :class:`IsolationViolation` and nothing
   is read or written. A ``subprocess.Popen`` (or ``os.exec*``, ``os.spawn*``,
   ``os.posix_spawn``) whose environment, given or inherited, would let the
   child reach a protected root is refused the same way. Python children get
   the same guard through a test-only ``sitecustomize.py`` (the *loader*) put
   first on their ``PYTHONPATH``, and a Python child that would start without
   it is refused too: the loader not first on ``PYTHONPATH``, or the guard's
   file, log or protected roots missing from its environment. A test that
   needs its own import path uses :func:`child_pythonpath`, never a replaced
   ``PYTHONPATH``. The loader fails closed: a child started with the guard
   configured but unable to install it stops (exit ``70``) instead of running
   unguarded.

3. **Every refusal is reported.** Each test's check reports the refusals made
   during it; a session-wide check reports any other one — at collection, in a
   module- or session-scoped fixture, in a teardown — so a refusal that code
   caught and swallowed still fails the run (:func:`collect_since`,
   :func:`collect_unreported`).

The real home is found as a path *string* only — from the OS account database
(``pwd`` on POSIX, the profile-folder API on Windows) and from the variables
as they were before isolation. It is never listed, read or probed.

What it does not do, stated (plan §10.2, §14.1.A, T-S24/T-S25):

- it is not an OS sandbox. These children are isolated by their environment
  only: non-Python programs (``git``, ``rg``, ``node``); Python started with
  ``-I``, ``-E`` or ``-S``, which ignores ``PYTHONPATH`` or skips ``site``;
  Python started through something the check cannot recognize as Python — a
  shell (``os.system``, ``shell=True``), the ``py`` launcher, or a console
  script such as an installed ``bugpilot``;
- ``scripts/check_cli_contract.py`` runs on its own, outside pytest: it builds
  its own disposable home and removes every ``BUGPILOT_*`` variable, so it
  never carries this guard;
- path aliases the string comparison does not see: a ``dir_fd=`` path or one
  used after ``os.fchdir`` (relative to a directory handle, not to the working
  directory the comparison resolves against); an already-open file handle,
  whose reads and writes carry no path; a Windows 8.3 short name
  (``RUNNER~1``); an extended-length or device prefix (``\\\\?\\``, ``\\\\.\\``);
  and a symbolic link or junction a test planted inside its own folder,
  pointing into the real data (creating one that points there is refused);
- native file access that raises no event the guard judges: Python's own
  ``_winapi.CreateFile`` and ``sqlite3.connect`` (each measured to create a file
  with no ``open`` event), and anything done through ``ctypes`` or a compiled
  extension. Windows' ``_winapi.CopyFile2`` (``shutil.copy2``, ``Path.copy``)
  and ``_winapi.CreateJunction`` *are* judged;
- metadata-only operations (``stat``, ``lstat``, ``exists``, ``access``) raise
  no audit event, so a metadata probe of a real path is not refused (no content
  can be read that way);
- the loader installs nothing in a child where the guard is not configured at
  all (neither its file nor its roots given); the parent's check above is what
  refuses such a Python child.

Nothing here is imported by BugPilot itself; the hook exists only in processes
the test suites start.
"""

from __future__ import annotations

import atexit
import os
import re
import shutil
import sys
import tempfile
import threading
from collections.abc import Iterable, Iterator, Mapping
from threading import local as _thread_state  # by name: the publishability scan reads a dotted "local" suffix as a host
from contextlib import contextmanager

__all__ = [
    "IsolationViolation",
    "child_pythonpath",
    "collect_since",
    "collect_unreported",
    "expecting_violations",
    "install_guard",
    "install_guard_from_environment",
    "is_isolated",
    "isolate_session",
    "new_test_home",
    "protected_roots",
    "protecting",
    "require_isolated",
    "session_root",
    "violation_marker",
    "violations_since",
]

#: Where the child guard finds this module, its protected roots and its log.
GUARD_FILE_ENV = "BUGPILOT_TEST_GUARD_FILE"
GUARD_ROOTS_ENV = "BUGPILOT_TEST_GUARD_ROOTS"
GUARD_LOG_ENV = "BUGPILOT_TEST_GUARD_LOG"
#: The session folder, for children and for :func:`require_isolated`.
SESSION_ENV = "BUGPILOT_TEST_SESSION_ROOT"
#: Set to keep the session folder after the run, for debugging.
KEEP_ENV = "BUGPILOT_TEST_KEEP_SESSION"
#: The session subfolder holding the loader (`sitecustomize.py`); the extension's suite uses the same name.
LOADER_DIR_NAME = "pyguard"

DATA_DIR_NAME = ".bugpilot"

#: Removed from the session environment: anything that could reach a real
#: service or the developer's own configuration. A test that needs one sets a
#: synthetic value itself (monkeypatch), after isolation.
SANITIZED_PREFIXES: tuple[str, ...] = ("JIRA_", "SMTP_", "GRAPH_", "BUGPILOT_EMAIL_")
SANITIZED_NAMES: tuple[str, ...] = (
    "BUGPILOT_AUTO_JIRA_COMMENT",
    "BUGPILOT_MCP_REPO_ROOT",
    "BUGPILOT_HOME",
    "BUGPILOT_CONFIG_DIR",
)


class IsolationViolation(BaseException):
    """A test reached for the developer's real BugPilot data, and was stopped first.

    A ``BaseException``, not an ``Exception``: product code that catches
    ``Exception`` (or ``OSError``) to degrade gracefully must not swallow it,
    and the run must fail. A swallowed one is caught anyway, because every
    violation is also recorded (:func:`violations_since`).
    """


# --- normalization --------------------------------------------------------------------------


def _norm(path: str) -> str:
    """``normcase(abspath(path))``: the form every comparison here uses. No file-system access."""
    return os.path.normcase(os.path.abspath(path))


def _within(candidate: str, root: str) -> bool:
    if candidate == root:
        return True
    prefix = root if root.endswith(os.sep) else root + os.sep
    return candidate.startswith(prefix)


def _text(value: object) -> str | None:
    """A path argument as text, or ``None`` for a file descriptor, ``None`` or anything else."""
    if value is None or isinstance(value, (int, bool)):
        return None
    try:
        text = os.fsdecode(os.fspath(value))  # type: ignore[arg-type]
    except TypeError:
        return None
    return text or None


# --- the real home, as strings only ------------------------------------------------------------


def _windows_profile_folder() -> str | None:
    """The profile folder from the shell's known-folder API, not from any variable."""
    try:
        import ctypes
        import uuid
        from ctypes import wintypes

        class _GUID(ctypes.Structure):
            _fields_ = [
                ("Data1", wintypes.DWORD),
                ("Data2", wintypes.WORD),
                ("Data3", wintypes.WORD),
                ("Data4", ctypes.c_ubyte * 8),
            ]

        folder_id = _GUID.from_buffer_copy(uuid.UUID("{5E6C858F-0E22-4760-9AFE-EA3317B67173}").bytes_le)
        pointer = ctypes.c_wchar_p()
        result = ctypes.windll.shell32.SHGetKnownFolderPath(  # type: ignore[attr-defined]
            ctypes.byref(folder_id), 0, None, ctypes.byref(pointer)
        )
        try:
            return pointer.value if result == 0 and pointer.value else None
        finally:
            ctypes.windll.ole32.CoTaskMemFree(pointer)  # type: ignore[attr-defined]
    except Exception:  # noqa: BLE001 - a missing API means one candidate fewer, never a crash
        return None


def _account_home() -> str | None:
    if os.name == "nt":
        return _windows_profile_folder()
    try:
        import pwd

        return pwd.getpwuid(os.getuid()).pw_dir or None
    except Exception:  # noqa: BLE001
        return None


def real_data_roots(environ: Mapping[str, str]) -> list[str]:
    """Every folder that may hold the developer's real BugPilot data, as normalized strings.

    The account database's home, and the home and data variables as ``environ``
    holds them before isolation. Nothing is read from the file system.
    """
    homes = [_account_home(), environ.get("HOME"), environ.get("USERPROFILE")]
    if environ.get("HOMEDRIVE") and environ.get("HOMEPATH"):
        homes.append(environ["HOMEDRIVE"] + environ["HOMEPATH"])
    try:
        homes.append(os.path.expanduser("~"))
    except Exception:  # noqa: BLE001
        pass
    roots = [os.path.join(home, DATA_DIR_NAME) for home in homes if home]
    roots += [environ[name] for name in ("BUGPILOT_HOME", "BUGPILOT_CONFIG_DIR") if environ.get(name)]
    ordered: list[str] = []
    for root in roots:
        normalized = _norm(root)
        if normalized not in ordered:
            ordered.append(normalized)
    return ordered


# --- the guard ---------------------------------------------------------------------------------

_lock = threading.Lock()
_local = _thread_state()
_roots: list[str] = []
_violations: list[str] = []
_log_path: str | None = None
_installed = False

#: Events that carry paths, and the positions of the path arguments.
_PATH_EVENTS: dict[str, tuple[int, ...]] = {
    "open": (0,),
    "os.listdir": (0,),
    "os.scandir": (0,),
    "glob.glob": (0,),
    "glob.glob/2": (0, 2),
    "os.mkdir": (0,),
    "os.rename": (0, 1),  # os.replace raises this event too
    "os.remove": (0,),  # and os.unlink
    "os.rmdir": (0,),
    "os.symlink": (0, 1),
    "os.link": (0, 1),
    "os.chmod": (0,),
    "os.chown": (0,),
    "os.utime": (0,),
    "os.truncate": (0,),
    "os.chdir": (0,),
    "os.startfile": (0,),
    "shutil.rmtree": (0,),
    "shutil.copyfile": (0, 1),
    "shutil.copymode": (0, 1),
    "shutil.copystat": (0, 1),
    "shutil.copytree": (0, 1),
    "shutil.move": (0, 1),
    "tempfile.mkstemp": (0,),
    "tempfile.mkdtemp": (0,),
    # Windows' native copy and junction (Python 3.12+): `shutil.copy2`, `Path.copy` and
    # `Path.copy_into` copy through CopyFile2 and raise no `shutil.copyfile` or `open` event.
    # Measured on 3.14: CopyFile2 is (source, destination, flags); CreateJunction is
    # (target, junction). Both paths are judged, so neither end may be protected.
    "_winapi.CopyFile2": (0, 1),
    "_winapi.CreateJunction": (0, 1),
}

#: Process events: the positions of (program, arguments, cwd, env) in their arguments; -1 is
#: "not carried". A child given no environment inherits ``os.environ``, which is then judged
#: instead. ``os.system`` carries a shell command line, whose program is not read.
_PROCESS_EVENTS: dict[str, tuple[int, int, int, int]] = {
    "subprocess.Popen": (0, 1, 2, 3),
    "os.exec": (0, 1, -1, 2),
    "os.posix_spawn": (0, 1, -1, 2),
    "os.spawn": (1, 2, -1, 3),
    "os.system": (-1, -1, -1, -1),
}

#: A program name that starts CPython: python, python3, python3.13, pythonw, with ``.exe`` on Windows.
_PYTHON_PROGRAM = re.compile(r"python(?:\d+(?:\.\d+)*)?w?(?:\.exe)?", re.IGNORECASE)
_SEPARATORS = re.compile(r"[\\/]")

_WRITE_FLAGS = 0
for _name in ("O_WRONLY", "O_RDWR", "O_CREAT", "O_APPEND", "O_TRUNC"):
    _WRITE_FLAGS |= getattr(os, _name, 0)


def _protected_root_of(value: object) -> str | None:
    text = _text(value)
    if text is None:
        return None
    candidate = _norm(text)
    for root in _roots:
        if _within(candidate, root):
            return root
    return None


def _label(root: str) -> str:
    """A protected root as a message names it: never the path, which holds the developer's name."""
    try:
        return f"protected BugPilot data root #{_roots.index(root) + 1}"
    except ValueError:
        return "a protected BugPilot data root"


def _intent(event: str, args: tuple) -> str:
    if event != "open":
        return event
    mode = args[1] if len(args) > 1 else None
    flags = args[2] if len(args) > 2 else 0
    writes = (isinstance(mode, str) and any(c in mode for c in "wax+")) or (
        isinstance(flags, int) and flags & _WRITE_FLAGS
    )
    return "open for writing" if writes else "open for reading"


def _refuse(message: str) -> None:
    with _lock:
        _violations.append(message)
    if _log_path:
        try:
            with open(_log_path, "a", encoding="utf-8") as log:  # reentrancy flag is set: not audited
                log.write(message.replace("\n", " ") + "\n")
        except OSError:
            pass
    raise IsolationViolation(message)


def _environment_values(env: Mapping) -> dict[str, str]:
    """``env`` as text, with Windows' case-insensitive names upper-cased."""
    values: dict[str, str] = {}
    for key, value in env.items():
        name = os.fsdecode(key) if isinstance(key, bytes) else str(key)
        text = os.fsdecode(value) if isinstance(value, bytes) else str(value)
        values[name.upper() if os.name == "nt" else name] = text
    return values


def _environment_problem(values: Mapping[str, str]) -> str | None:
    """Why a child started with the environment ``values`` could reach a protected root, or ``None``."""
    home_names = ("USERPROFILE",) if os.name == "nt" else ("HOME",)
    for name in home_names:
        if not values.get(name):
            return f"the child's environment has no {name}, so its home would fall back to the real one"
    derived = [os.path.join(values[name], DATA_DIR_NAME) for name in ("HOME", "USERPROFILE") if values.get(name)]
    derived += [values[name] for name in ("BUGPILOT_HOME", "BUGPILOT_CONFIG_DIR") if values.get(name)]
    for path in derived:
        candidate = _norm(path)
        for root in _roots:
            if _within(candidate, root) or _within(root, candidate):
                return f"the child's environment points its BugPilot data at the {_label(root)}"
    return None


def _command_words(line: str) -> list[str]:
    """A Windows command line (``subprocess.Popen`` audits one there) split into words, quotes removed.

    Enough to read the program and the interpreter's own options, which come first; an escaped
    quote further along the line does not matter to either.
    """
    words: list[str] = []
    word: list[str] = []
    quoted = started = False
    for character in line:
        if character == '"':
            quoted, started = not quoted, True
        elif character in " \t" and not quoted:
            if started:
                words.append("".join(word))
            word, started = [], False
        else:
            word.append(character)
            started = True
    if started:
        words.append("".join(word))
    return words


def _launch_words(program: object, arguments: object) -> list[str]:
    """The program a process event starts, then its arguments, as text."""
    if isinstance(arguments, (str, bytes)):
        words = _command_words(os.fsdecode(arguments))
    elif isinstance(arguments, (list, tuple)):
        words = [_text(word) or "" for word in arguments]
    else:
        words = []
    named = _text(program)
    if named is not None:  # the executable, when given, is what runs; the first argument is only its name
        words = [named, *words[1:]]
    return words


def _starts_python(words: list[str]) -> bool:
    """Whether the program is a CPython interpreter, recognized by its file name."""
    if not words or not words[0]:
        return False
    return bool(_PYTHON_PROGRAM.fullmatch(_SEPARATORS.split(words[0])[-1]))


def _loader_disabled(words: list[str]) -> bool:
    """``-I``, ``-E`` or ``-S`` among the interpreter's own options: ``PYTHONPATH`` or ``site`` is off.

    No loader can load in such a child, so none is required of it (a stated limitation). The
    options end at ``-c``, ``-m``, ``--``, ``-`` or a script; ``-W`` and ``-X`` take a value,
    whose letters are not options (``-Werror::ImportWarning`` is not ``-I``).
    """
    index = 1
    while index < len(words):
        word = words[index]
        if word in ("-", "--") or not word.startswith("-"):
            return False
        if word.startswith("--"):
            index += 2 if word == "--check-hash-based-pycs" else 1
            continue
        for position, letter in enumerate(word[1:], start=1):
            if letter in "IES":
                return True
            if letter in "cm":
                return False
            if letter in "WX":
                if position == len(word) - 1:
                    index += 1  # the value is the next word
                break
        index += 1
    return False


def _loader_problem(values: Mapping[str, str]) -> str | None:
    """Why a Python child started with ``values`` would run without the guard, or ``None``.

    Judged against this process's own session: the loader must come first on ``PYTHONPATH``, and
    the guard's file, its log and at least every root this process passes on must reach the child.
    """
    session = os.environ.get(SESSION_ENV)
    if not session:
        return None  # no session here, so no loader to require
    entries = values.get("PYTHONPATH", "").split(os.pathsep)
    if not entries[0] or _norm(entries[0]) != _norm(os.path.join(session, LOADER_DIR_NAME)):
        return "the isolation guard's loader is not first on the Python child's PYTHONPATH, so the child would run unguarded"
    guard_file = values.get(GUARD_FILE_ENV)
    expected_file = os.environ.get(GUARD_FILE_ENV)
    if not guard_file or (expected_file and _norm(guard_file) != _norm(expected_file)):
        return f"the Python child's environment does not carry this session's {GUARD_FILE_ENV}, so its loader would install no guard"
    if not values.get(GUARD_LOG_ENV):
        return f"the Python child's environment has no {GUARD_LOG_ENV}, so its refusals would go unrecorded"
    given = {_norm(root) for root in values.get(GUARD_ROOTS_ENV, "").split(os.pathsep) if root}
    required = {_norm(root) for root in os.environ.get(GUARD_ROOTS_ENV, "").split(os.pathsep) if root}
    if not given or not required <= given:
        return f"the Python child's {GUARD_ROOTS_ENV} drops protected BugPilot data roots this process passes on"
    return None


def _hook(event: str, args: tuple) -> None:
    positions = _PATH_EVENTS.get(event)
    process = None if positions is not None else _PROCESS_EVENTS.get(event)
    if positions is None and process is None:
        return
    if getattr(_local, "busy", False):
        return
    _local.busy = True
    try:
        if positions is not None:
            for index in positions:
                if index < len(args):
                    root = _protected_root_of(args[index])
                    if root is not None:
                        _refuse(f"IsolationViolation: {_intent(event, args)} under the {_label(root)}")
            return
        program_at, arguments_at, cwd_at, env_at = process  # type: ignore[misc]
        if cwd_at >= 0 and cwd_at < len(args):
            root = _protected_root_of(args[cwd_at])
            if root is not None:
                _refuse(f"IsolationViolation: {event} with its working directory under the {_label(root)}")
        env = args[env_at] if 0 <= env_at < len(args) else None
        if not isinstance(env, Mapping):
            env = os.environ  # inherited: a test may have removed HOME, or the loader, from it
        values = _environment_values(env)
        problem = _environment_problem(values)
        if problem is None and program_at >= 0:
            words = _launch_words(
                args[program_at] if program_at < len(args) else None,
                args[arguments_at] if 0 <= arguments_at < len(args) else None,
            )
            if _starts_python(words) and not _loader_disabled(words):
                problem = _loader_problem(values)
        if problem:
            _refuse(f"IsolationViolation: {event} refused: {problem}")
    finally:
        _local.busy = False


def install_guard(roots: Iterable[str], log_path: str | None = None) -> None:
    """Protect ``roots`` in this process from now on. Hooks cannot be removed; roots can be added."""
    global _installed, _log_path
    with _lock:
        for root in roots:
            normalized = _norm(root)
            if normalized not in _roots:
                _roots.append(normalized)
        if log_path:
            _log_path = log_path
        if not _installed:
            sys.addaudithook(_hook)
            _installed = True


def install_guard_from_environment() -> bool:
    """The child half (``sitecustomize``): protect the roots the parent passed. False when none."""
    roots = [root for root in os.environ.get(GUARD_ROOTS_ENV, "").split(os.pathsep) if root]
    if not roots:
        return False
    install_guard(roots, os.environ.get(GUARD_LOG_ENV) or None)
    return True


def protected_roots() -> tuple[str, ...]:
    return tuple(_roots)


def guard_installed() -> bool:
    return _installed


def violation_marker() -> int:
    with _lock:
        return len(_violations)


def violations_since(marker: int) -> list[str]:
    with _lock:
        return list(_violations[marker:])


#: What a check has already reported: indexes into `_violations`, and lines of the guard log.
#: `expecting_violations` removes only entries made inside it, so a reported index never moves.
_reported: set[int] = set()
_reported_log: set[int] = set()


def collect_since(marker: int, log_marker: int) -> list[str]:
    """The refusals since ``marker`` (this process) and ``log_marker`` (its children's log) that no
    check has reported yet, marked reported now: a refusal is reported once, by the first check."""
    lines = guard_log_lines()
    with _lock:
        indexes = [index for index in range(marker, len(_violations)) if index not in _reported]
        found = [_violations[index] for index in indexes]
        _reported.update(indexes)
    new_lines = [index for index in range(log_marker, len(lines)) if index not in _reported_log]
    _reported_log.update(new_lines)
    return found + [lines[index] for index in new_lines]


def collect_unreported() -> list[str]:
    """Every refusal of the session no check has reported yet (see :func:`collect_since`). Idempotent."""
    return collect_since(0, 0)


@contextmanager
def protecting(root: str) -> Iterator[str]:
    """Protect one more root (a decoy, in the guard's own tests) for the duration."""
    normalized = _norm(root)
    added = False
    with _lock:
        if normalized not in _roots:
            _roots.append(normalized)
            added = True
    try:
        yield normalized
    finally:
        if added:
            with _lock:
                _roots.remove(normalized)


@contextmanager
def expecting_violations() -> Iterator[list[str]]:
    """Violations a test provokes on purpose: collected here, and not left for the per-test check."""
    with _lock:
        start = len(_violations)
    collected: list[str] = []
    try:
        yield collected
    finally:
        with _lock:
            collected.extend(_violations[start:])
            del _violations[start:]


# --- the session -------------------------------------------------------------------------------

_session: str | None = None


def _home_environment(home: str) -> dict[str, str]:
    values = {"HOME": home, "USERPROFILE": home}
    if os.name == "nt":
        drive, rest = os.path.splitdrive(home)
        values.update(HOMEDRIVE=drive, HOMEPATH=rest or os.sep)
    return values


#: The child guard's loader, shared with the extension's integration suite. Copied
#: into the session folder; never on a `sys.path` where it lies.
SITECUSTOMIZE_TEMPLATE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "isolation_child", "sitecustomize.py")


def session_root() -> str | None:
    return _session or os.environ.get(SESSION_ENV) or None


def is_isolated() -> bool:
    """This process runs in an isolated session: its home is inside the session folder, guarded."""
    root = session_root()
    if not root or not _installed:
        return False
    home = os.environ.get("USERPROFILE" if os.name == "nt" else "HOME")
    return bool(home) and _within(_norm(home), _norm(root))


def require_isolated() -> None:
    """Fail closed: a helper that touches BugPilot storage refuses to run outside isolation."""
    if not is_isolated():
        raise RuntimeError(
            "This test helper touches BugPilot's storage and refuses to run outside the test isolation "
            "(tests/_isolation.py). Run it through pytest, or through its own main()."
        )


def isolate_session() -> str:
    """Isolate this process and every child it starts. Idempotent. Returns the session folder."""
    global _session
    if _session is not None:
        return _session
    original = dict(os.environ)
    roots = real_data_roots(original)
    # Inherited from a parent session (a test that runs a helper as a script): keep its roots too.
    roots += [root for root in original.get(GUARD_ROOTS_ENV, "").split(os.pathsep) if root]
    session = os.path.realpath(tempfile.mkdtemp(prefix="bugpilot-test-"))
    normalized_session = _norm(session)
    for root in roots:
        if _within(normalized_session, _norm(root)) or _within(_norm(root), normalized_session):
            shutil.rmtree(session, ignore_errors=True)
            raise RuntimeError(
                "The test session folder would overlap the developer's BugPilot data; refusing to run. "
                "Point TMPDIR/TEMP somewhere outside it."
            )
    home = os.path.join(session, "home")
    os.mkdir(home)
    guard_dir = os.path.join(session, LOADER_DIR_NAME)
    os.mkdir(guard_dir)
    shutil.copyfile(SITECUSTOMIZE_TEMPLATE, os.path.join(guard_dir, "sitecustomize.py"))
    log = os.path.join(session, "guard-violations.log")

    for name in list(os.environ):
        upper = name.upper()
        if upper.startswith(SANITIZED_PREFIXES) or upper in SANITIZED_NAMES:
            del os.environ[name]
    os.environ.update(_home_environment(home))
    data = os.path.join(home, DATA_DIR_NAME)
    os.environ["BUGPILOT_HOME"] = data
    os.environ["BUGPILOT_CONFIG_DIR"] = data
    os.environ[SESSION_ENV] = session
    os.environ[GUARD_FILE_ENV] = os.path.abspath(__file__)
    os.environ[GUARD_ROOTS_ENV] = os.pathsep.join(_norm(root) for root in roots)
    os.environ[GUARD_LOG_ENV] = log
    previous = os.environ.get("PYTHONPATH")
    os.environ["PYTHONPATH"] = guard_dir + (os.pathsep + previous if previous else "")

    # This process records its own refusals in memory (`violations_since`); the
    # log is for its Python children, which inherit GUARD_LOG_ENV.
    install_guard(roots)
    _session = session
    if not is_isolated():  # pragma: no cover - a broken setup must stop the run, not continue it
        raise RuntimeError("Test isolation could not be established; refusing to run.")
    if not os.environ.get(KEEP_ENV):
        atexit.register(shutil.rmtree, session, True)
    return session


def new_test_home() -> dict[str, str]:
    """A fresh home inside the session, as the variables one test sets. Requires a session."""
    root = session_root()
    if not root:
        raise RuntimeError("new_test_home() needs isolate_session() first")
    tests = os.path.join(root, "tests")
    os.makedirs(tests, exist_ok=True)
    home = tempfile.mkdtemp(prefix="h", dir=tests)
    values = _home_environment(home)
    values["BUGPILOT_HOME"] = os.path.join(home, DATA_DIR_NAME)
    return values


def child_pythonpath(*entries: str | os.PathLike[str]) -> str:
    """``PYTHONPATH`` for a Python child that needs its own import path: the loader, then ``entries``.

    Use it instead of replacing ``PYTHONPATH``, which drops the loader — the guard refuses that
    child before it starts. Joined with ``os.pathsep``; each entry once (compared normalized);
    empty entries left out; an entry that holds ``os.pathsep`` would split in two, so it is refused.
    """
    root = session_root()
    if not root:
        raise RuntimeError("child_pythonpath() needs isolate_session() first")
    ordered: list[str] = []
    seen: set[str] = set()
    for entry in (os.path.join(root, LOADER_DIR_NAME), *(os.fspath(entry) for entry in entries)):
        if not entry:
            continue
        if os.pathsep in entry:
            raise ValueError(f"a PYTHONPATH entry cannot contain {os.pathsep!r}")
        key = _norm(entry)
        if key not in seen:
            seen.add(key)
            ordered.append(entry)
    return os.pathsep.join(ordered)


def guard_log_lines() -> list[str]:
    """What children of this session recorded (their violations), oldest first."""
    log = os.environ.get(GUARD_LOG_ENV)
    if not log:
        return []
    try:
        with open(log, encoding="utf-8") as handle:
            return [line.rstrip("\n") for line in handle]
    except FileNotFoundError:
        return []
