"""A test-only write witness for BugPilot's data folder (0.1.6 Batch 2B-1).

Batch 2B moves every Python reader and writer onto ``bugpilot.core.storage``.
The rule it must keep: every write under the data folder comes from a checked
storage method, within the request that asked for it. This witness observes
and judges; it never blocks an operation, and it never weakens Batch 0A's
isolation guard: it adds its own audit hook, after the guard's, and that hook
never raises (a failure inside it is recorded, so the test fails instead).

**How a write-like event under the data root is judged:**

1. **Storage's own write.** The outermost frame of ``bugpilot/core/storage.py``
   on the stack is one of its public methods (``ensure``, ``write_config_file``,
   ``remove_work_item``, an accessor called with ``create=True``, …). A private
   helper called from elsewhere (``storage._directory(...)``) is not.
2. **A granted write.** A checked accessor called with ``create=True`` inside a
   request scope grants that scope:
   - a folder accessor (``work_item_dir``, ``attachments_dir``,
     ``fix_modes_dir``, ``user_fix_modes_dir``, ``ensure_config_dir``) grants
     everything strictly *inside* the folder, never the folder itself;
   - a file accessor (``memory_file``, ``settings_file``,
     ``user_instructions_file``) grants that file and the atomic writer's
     temporary siblings (``.<name>.<random>.tmp``).

   A grant is valid only while the same scope is active: after the scope
   ends, or in another scope, it authorizes nothing. Only the outermost
   accessor call grants: a method another storage method calls on the way
   grants nothing. ``config.toml`` is never granted: credentials are written
   only by ``write_config_file()``, which checks privacy before and after.
3. Anything else is a **violation**.

**Events observed** (Python audit events): opens for writing, ``os.mkdir``,
``os.rename`` and ``os.replace``, ``os.remove``/``os.unlink``, ``os.rmdir``,
``os.link``, ``os.symlink``, ``shutil.rmtree``, ``shutil.copyfile``,
``shutil.copytree``, ``shutil.move``, ``os.truncate``, ``os.chmod``,
``os.utime``, and on Windows ``_winapi.CopyFile2`` and ``_winapi.CreateJunction``.

**Limits, stated:**

- Only operations that raise an audit event are seen. A native extension
  writing through C calls, a write through an already-open file descriptor or
  an ``mmap``, and anything a non-Python process does (git, an agent) are not.
- A path relative to a directory descriptor (``dir_fd``, as ``shutil.rmtree``
  uses inside a tree on POSIX) cannot be placed: it is recorded as
  ``unresolved``, and the enclosing ``shutil.rmtree`` event is the one judged.
- Paths are compared as written (absolute, case-folded on Windows), not
  through ``realpath``: storage hands out canonical paths, and a write through
  some other alias of the data folder is not recognized as being inside it.
- Python child processes are observed only when started through this module's
  runner, ``python tests/_storage_witness.py <report.json> -m <module> …`` or
  ``… -c <code>``; Batch 0A's child loader is unchanged and still loads first.
- A grant belongs to one request scope, and a scope to the thread that opened
  it (C-2): a worker thread writes under a grant only inside its own scope.
- Audit hooks cannot be removed: the hook is installed once per process and
  does nothing while no witness is active. One witness at a time.
"""

from __future__ import annotations

import json
import os
import runpy
import sys
import threading
from contextlib import contextmanager
from threading import local as thread_local
from dataclasses import asdict, dataclass
from pathlib import Path
from typing import Iterator

from bugpilot.core import storage

_STORAGE_FILE = os.path.normcase(os.path.abspath(storage.__file__))
#: Public storage methods whose own writes are storage's (the outermost storage frame must be one of them).
STORAGE_WRITERS = frozenset(
    {
        "ensure", "ensure_config_dir", "write_config_file", "remove_work_item", "remove_memory_file",
        "work_item_dir", "attachments_dir", "memory_file", "settings_file", "fix_modes_dir",
        "config_file", "user_instructions_file", "user_fix_modes_dir",
    }
)
#: (class, method, kind of grant) for the accessors that grant a scope when called with ``create=True``.
GRANTING = (
    (storage.RepositoryStorage, "work_item_dir", "folder"),
    (storage.RepositoryStorage, "attachments_dir", "folder"),
    (storage.RepositoryStorage, "fix_modes_dir", "folder"),
    (storage.RepositoryStorage, "memory_file", "file"),
    (storage.RepositoryStorage, "settings_file", "file"),
    (storage.GlobalStorage, "user_fix_modes_dir", "folder"),
    (storage.GlobalStorage, "ensure_config_dir", "folder"),
    (storage.GlobalStorage, "user_instructions_file", "file"),
)
_WRITE_FLAGS = os.O_WRONLY | os.O_RDWR | os.O_CREAT | os.O_TRUNC | os.O_APPEND


@dataclass(frozen=True)
class Grant:
    kind: str  # "folder" or "file"
    parts: tuple[str, ...]  # the granted path's components, case-folded
    scope: object  # the request scope's verdict dictionary it belongs to
    source: str  # the accessor that granted it


@dataclass
class Observation:
    event: str
    path: str
    verdict: str  # "storage", "granted", "violation" or "unresolved"
    detail: str = ""


def _parts(path: str) -> tuple[str, ...]:
    return tuple(os.path.normcase(part) for part in Path(os.path.abspath(path)).parts)


class WriteWitness:
    """What one ``witness()`` block observed under one data root."""

    def __init__(self, root: Path) -> None:
        self.root = Path(root)
        self._roots = {_parts(str(self.root)), _parts(os.path.realpath(self.root))}
        self.grants: list[Grant] = []
        self.observations: list[Observation] = []
        self.errors: list[str] = []
        self._lock = threading.Lock()

    def violations(self) -> list[Observation]:
        return [item for item in self.observations if item.verdict == "violation"]

    def assert_clean(self) -> None:
        assert self.errors == [], self.errors
        assert self.violations() == [], [f"{item.event} {item.path} ({item.detail})" for item in self.violations()]

    def report(self) -> dict[str, object]:
        return {"observations": [asdict(item) for item in self.observations], "errors": self.errors}

    # -- judging ---------------------------------------------------------------------------------

    def _relative(self, parts: tuple[str, ...]) -> tuple[str, ...] | None:
        for root in self._roots:
            if parts[: len(root)] == root:
                return parts[len(root):]
        return None

    def _grant(self, kind: str, path: Path, scope: object, source: str) -> None:
        with self._lock:
            self.grants.append(Grant(kind, _parts(str(path)), scope, source))

    def _granted(self, parts: tuple[str, ...]) -> bool:
        scope = storage._active_scope()
        if scope is None:
            return False
        relative = self._relative(parts)
        if relative is not None and relative[:1] == ("config",) and len(relative) == 2 and (
            relative[1] == os.path.normcase(storage.CREDENTIALS_NAME)
            or relative[1].startswith(os.path.normcase(f".{storage.CREDENTIALS_NAME}."))
        ):
            return False  # credentials: write_config_file() only
        with self._lock:
            grants = [grant for grant in self.grants if grant.scope is scope]
        for grant in grants:
            if grant.kind == "folder" and len(parts) > len(grant.parts) and parts[: len(grant.parts)] == grant.parts:
                return True
            if grant.kind == "file":
                if parts == grant.parts:
                    return True
                name = grant.parts[-1]
                if parts[:-1] == grant.parts[:-1] and parts[-1].startswith(f".{name}.") and parts[-1].endswith(".tmp"):
                    return True
        return False

    def _observe(self, event: str, raw: object, frame) -> None:
        if isinstance(raw, int) or raw is None:
            return
        text = os.fsdecode(raw)
        parts = _parts(text)
        if self._relative(parts) is None:
            return
        if _storage_write(frame):
            verdict, detail = "storage", ""
        elif self._granted(parts):
            verdict, detail = "granted", ""
        else:
            verdict = "violation"
            detail = "no checked storage method granted it in the current request scope"
        with self._lock:
            self.observations.append(Observation(event, text, verdict, detail))

    def _unresolved(self, event: str, raw: object) -> None:
        with self._lock:
            self.observations.append(Observation(event, os.fsdecode(raw), "unresolved", "relative to a dir_fd"))


def _storage_write(frame) -> bool:
    """Whether the outermost ``storage.py`` frame on the stack is a public storage writer."""
    outermost = None
    while frame is not None:
        if os.path.normcase(os.path.abspath(frame.f_code.co_filename)) == _STORAGE_FILE:
            outermost = frame
        frame = frame.f_back
    return outermost is not None and outermost.f_code.co_name in STORAGE_WRITERS


# -- the audit hook ------------------------------------------------------------------------------

_current: WriteWitness | None = None
_hook_installed = False
_busy = thread_local()  # per thread: the hook's own file operations are not judged


def _paths(event: str, args: tuple) -> list[tuple[object, object]]:
    """(path, dir_fd) pairs an event writes to; empty when it writes nothing there."""
    if event == "open":
        path, mode, flags = (tuple(args) + (None, None, None))[:3]
        writes = (isinstance(mode, str) and any(letter in mode for letter in "wax+")) or (
            isinstance(flags, int) and bool(flags & _WRITE_FLAGS)
        )
        return [(path, None)] if writes else []
    if event in ("os.mkdir", "os.remove", "os.rmdir", "shutil.rmtree"):
        return [(args[0], args[-1] if len(args) > 1 else None)]
    if event in ("os.rename", "os.replace"):
        return [(args[0], args[2] if len(args) > 2 else None), (args[1], args[3] if len(args) > 3 else None)]
    if event == "os.link":
        return [(args[1], args[3] if len(args) > 3 else None)]
    if event == "os.symlink":
        return [(args[1], args[2] if len(args) > 2 else None)]
    if event in ("shutil.copyfile", "shutil.copytree", "_winapi.CopyFile2", "_winapi.CreateJunction"):
        return [(args[1], None)]
    if event == "shutil.move":
        return [(args[0], None), (args[1], None)]
    if event in ("os.truncate", "os.chmod", "os.utime"):
        return [(args[0], args[-1] if event != "os.truncate" else None)]
    return []


def _hook(event: str, args: tuple) -> None:
    witness = _current
    if witness is None or getattr(_busy, "on", False):
        return
    _busy.on = True
    try:
        for path, dir_fd in _paths(event, args):
            if isinstance(dir_fd, int) and not os.path.isabs(os.fsdecode(path)):
                witness._unresolved(event, path)
                continue
            witness._observe(event, path, sys._getframe(1))
    except Exception as error:  # never raise into the program: a broken witness fails the test instead
        witness.errors.append(f"{event}: {type(error).__name__}: {error}")
    finally:
        _busy.on = False


def _called_from_storage(frame) -> bool:
    """Whether a ``storage.py`` frame is already on the stack: then this call is storage calling itself."""
    while frame is not None:
        if os.path.normcase(os.path.abspath(frame.f_code.co_filename)) == _STORAGE_FILE:
            return True
        frame = frame.f_back
    return False


def _granting(original, kind: str, name: str):
    def accessor(self, *args, **kwargs):
        nested = _called_from_storage(sys._getframe(1))
        result = original(self, *args, **kwargs)
        creates = kwargs.get("create", name == "ensure_config_dir")
        scope = storage._active_scope()
        if _current is not None and not nested and creates and scope is not None:
            _current._grant(kind, result, scope, name)
        return result

    accessor.__wrapped__ = original
    return accessor


@contextmanager
def witness(root: Path | None = None) -> Iterator[WriteWitness]:
    """Observe and judge every write-like event under the data root (``data_root()`` by default)."""
    global _current, _hook_installed
    if _current is not None:
        raise RuntimeError("one witness at a time")
    observed = WriteWitness(Path(root) if root is not None else storage.data_root())
    if not _hook_installed:
        sys.addaudithook(_hook)  # cannot be removed; it does nothing while no witness is active
        _hook_installed = True
    originals = [(cls, name, cls.__dict__[name]) for cls, name, _ in GRANTING]
    for cls, name, kind in GRANTING:
        setattr(cls, name, _granting(cls.__dict__[name], kind, name))
    _current = observed
    try:
        yield observed
    finally:
        _current = None
        for cls, name, original in originals:
            setattr(cls, name, original)


# -- Python children ------------------------------------------------------------------------------


def run_child(argv: list[str]) -> int:
    """``<report.json> -m <module> [args…]`` or ``<report.json> -c <code> [args…]``: run it under a witness."""
    report, mode, target, *rest = argv
    code = 0
    with witness() as observed:
        try:
            if mode == "-m":
                sys.argv = [target, *rest]
                runpy.run_module(target, run_name="__main__", alter_sys=True)
            elif mode == "-c":
                sys.argv = ["-c", *rest]
                exec(compile(target, "<witness-child>", "exec"), {"__name__": "__main__"})
            else:
                raise SystemExit(f"unknown mode {mode!r}")
        except SystemExit as exit_:
            code = exit_.code if isinstance(exit_.code, int) else (0 if exit_.code is None else 1)
        finally:
            Path(report).write_text(json.dumps(observed.report()), encoding="utf-8")
    return code


if __name__ == "__main__":
    raise SystemExit(run_child(sys.argv[1:]))
