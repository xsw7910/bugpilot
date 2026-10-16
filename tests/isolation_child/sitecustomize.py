"""Test-only (BugPilot 0.1.6 plan §11.1): install the isolation guard in a Python child.

Never imported from here. `tests/_isolation.py` and the extension's
integration suite (`extension/test-integration/isolation.ts`) copy this file
into their session folder and put that folder first on the child's
`PYTHONPATH`, so every Python child of a test run — the CLI, the MCP server, a
helper run as a script — refuses to read or write the developer's real
BugPilot data before it happens. It loads the guard from the path in
`BUGPILOT_TEST_GUARD_FILE` and the roots from `BUGPILOT_TEST_GUARD_ROOTS`.

Three cases, told apart by those two variables:

- **not configured** — neither is set: a Python program that merely finds this
  folder on its path. Nothing is installed and nothing changes;
- **configured** — the guard loads and protects at least one root: the child
  runs guarded;
- **configured but broken** — either variable is set, and the guard cannot be
  loaded or would protect nothing. The child fails closed: it says so on
  stderr and in `BUGPILOT_TEST_GUARD_LOG` (which the parent's per-test check
  reads), and exits with status 70 before any of its own code runs. `site`
  would otherwise report an exception from here and carry on unguarded.
"""

import importlib.machinery
import importlib.util
import os
import sys

#: The exit status of a child whose guard was configured but could not be installed.
FAIL_CLOSED_STATUS = 70


def _fail_closed(reason: str) -> None:
    """Stop this child now, visibly: it must not run unguarded. Names no path."""
    message = (
        "IsolationViolation: a Python child started with the BugPilot test guard configured, "
        f"but {reason}; it stops rather than run unguarded"
    )
    try:
        sys.stderr.write(message + "\n")
        sys.stderr.flush()
    except Exception:  # noqa: BLE001 - no stderr is no reason to run on
        pass
    log = os.environ.get("BUGPILOT_TEST_GUARD_LOG")
    if log:
        try:
            with open(log, "a", encoding="utf-8") as handle:
                handle.write(message + "\n")
        except OSError:
            pass
    os._exit(FAIL_CLOSED_STATUS)


_guard_file = os.environ.get("BUGPILOT_TEST_GUARD_FILE")
if _guard_file or os.environ.get("BUGPILOT_TEST_GUARD_ROOTS"):
    _installed = False
    try:
        if not _guard_file:
            raise LookupError("BUGPILOT_TEST_GUARD_FILE is not set")
        _spec = importlib.util.spec_from_file_location("_bugpilot_test_isolation", _guard_file)
        if _spec is None or _spec.loader is None:
            raise ImportError("the guard file cannot be loaded")
        _module = importlib.util.module_from_spec(_spec)
        sys.modules["_bugpilot_test_isolation"] = _module
        _spec.loader.exec_module(_module)
        _installed = bool(_module.install_guard_from_environment())
    except BaseException as error:  # noqa: BLE001 - any failure here must stop the child
        _fail_closed(f"the guard could not be installed ({type(error).__name__})")
    if not _installed:
        _fail_closed("no protected BugPilot data root was given")

# Chain to the next sitecustomize, if the interpreter has one of its own.
_here = os.path.normcase(os.path.dirname(os.path.abspath(__file__)))
_rest = [entry for entry in sys.path if os.path.normcase(os.path.abspath(entry or ".")) != _here]
_next = importlib.machinery.PathFinder.find_spec("sitecustomize", _rest)
if _next is not None and _next.origin and os.path.normcase(os.path.abspath(_next.origin)) != os.path.normcase(os.path.abspath(__file__)):
    _chained = importlib.util.module_from_spec(_next)
    _next.loader.exec_module(_chained)
