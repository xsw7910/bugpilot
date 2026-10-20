"""The test isolation and its guard, demonstrated (0.1.6 Batch 0A, plan §11.1; T-S24 to T-S26).

Isolation is shown, not assumed. Every refusal is demonstrated against a
**decoy** — a disposable folder seeded with canaries and protected for the
duration — never against the developer's real home, which no test here lists,
reads or probes. The parent process, which does not guard the decoy, checks
afterwards that every decoy file is byte-identical with an unchanged mtime and
that no canary reached any output.

What the guard cannot do is stated in `tests/_isolation.py` and in the plan
(non-Python children, and Python started with `-I`, `-E` or `-S` or through a
shell, launcher or console script, rely on their environment; a `stat` raises
no audit event; some path aliases are not recognized).
"""

from __future__ import annotations

import glob
import hashlib
import json
import os
import shutil
import subprocess
import sys
import textwrap
import uuid
from dataclasses import dataclass
from pathlib import Path

import pytest

import _isolation
from _isolation import IsolationViolation
from bugpilot.core import user_config
from bugpilot.core.instructions import read_instructions, save_instructions

try:
    import _winapi  # Windows only: the native copy (CopyFile2, 3.12+) and junctions
except ImportError:
    _winapi = None  # type: ignore[assignment]

REPO = Path(__file__).resolve().parents[1]
TESTS = REPO / "tests"
#: Windows' native copy, which `shutil.copy2` and `Path.copy` use instead of `shutil.copyfile`.
NATIVE_COPY = _winapi is not None and hasattr(_winapi, "CopyFile2")

# Captured while pytest imports this module — collection time — so the tests
# below can show that collection already ran inside the isolation.
IMPORT_TIME_HOME = str(Path.home())
IMPORT_TIME_CONFIG_DIR = os.environ.get("BUGPILOT_CONFIG_DIR")
IMPORT_TIME_DATA_ROOT = os.environ.get("BUGPILOT_HOME")


def _norm(path: str) -> str:
    return os.path.normcase(os.path.abspath(path))


def _inside(path: str | None, root: str | None) -> bool:
    if not path or not root:
        return False
    path, root = _norm(path), _norm(root)
    return path == root or path.startswith(root.rstrip(os.sep) + os.sep)


def _snapshot(root: Path) -> dict[str, object]:
    """Every entry under ``root``: a folder, or a file's SHA-256 and mtime. Read by the unguarded parent."""
    entries: dict[str, object] = {}
    for current, folders, files in os.walk(root):
        for name in folders:
            entries[os.path.relpath(os.path.join(current, name), root)] = "dir"
        for name in files:
            path = os.path.join(current, name)
            with open(path, "rb") as handle:
                digest = hashlib.sha256(handle.read()).hexdigest()
            entries[os.path.relpath(path, root)] = (digest, os.stat(path).st_mtime_ns)
    return entries


@dataclass
class Decoy:
    home: Path
    data: Path
    token: str
    canaries: tuple[str, ...]
    before: dict[str, object]


@pytest.fixture
def decoy(tmp_path: Path) -> Decoy:
    """A home whose `.bugpilot` holds canaries, standing in for the real one.

    Canaries sit at the 0.1.5 places and at 0.1.6's `config/` (Batch 2B-2), where the product now reads
    the user's configuration, so a refusal is proven where a real read would land.
    """
    home = tmp_path / "decoy-home"
    data = home / ".bugpilot"
    token = f"canary-token-{uuid.uuid4().hex}"
    instructions = f"canary-instructions-{uuid.uuid4().hex}"
    task = f"canary-task-{uuid.uuid4().hex}"
    config_token = f"canary-config-token-{uuid.uuid4().hex}"
    config_instructions = f"canary-config-instructions-{uuid.uuid4().hex}"
    files = {
        data / "config.toml": f'jira_base_url = "https://jira.example.invalid"\njira_email = "decoy@example.invalid"\njira_token = "{token}"\n',
        data / "instructions.md": f"{instructions}\n",
        data / "config" / "config.toml": (
            f'jira_base_url = "https://jira.example.invalid"\njira_email = "decoy@example.invalid"\njira_token = "{config_token}"\n'
        ),
        data / "config" / "instructions.md": f"{config_instructions}\n",
        data / "repositories" / "app-0123456789abcdef" / "work" / "JR-12345" / "task.md": f"{task}\n",
    }
    for path, text in files.items():
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")
    canaries = (token, instructions, task, config_token, config_instructions)
    return Decoy(home=home, data=data, token=token, canaries=canaries, before=_snapshot(home))


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    root = tmp_path / "repo"
    root.mkdir()
    return root


def _point_home_at(monkeypatch: pytest.MonkeyPatch, home: Path) -> None:
    """Simulate an unisolated test: the product's own `~/.bugpilot` resolution lands in ``home``."""
    for name in ("HOME", "USERPROFILE"):
        monkeypatch.setenv(name, str(home))
    monkeypatch.delenv("BUGPILOT_CONFIG_DIR", raising=False)
    monkeypatch.delenv("BUGPILOT_HOME", raising=False)


# --- the session --------------------------------------------------------------------------------


def test_collection_time_code_ran_inside_the_isolation():
    session = _isolation.session_root()
    assert session
    assert _inside(IMPORT_TIME_HOME, session)
    assert _inside(IMPORT_TIME_CONFIG_DIR, session)
    assert _inside(IMPORT_TIME_DATA_ROOT, session)


@pytest.fixture(scope="module")
def module_scoped_view() -> tuple[str, str | None, str | None]:
    # Module-scoped fixtures run before any function-scoped autouse fixture.
    return str(Path.home()), os.environ.get("BUGPILOT_CONFIG_DIR"), os.environ.get("BUGPILOT_HOME")


def test_module_scoped_fixtures_run_inside_the_isolation(module_scoped_view):
    session = _isolation.session_root()
    assert all(_inside(value, session) for value in module_scoped_view)


def test_each_test_has_its_own_home_and_configuration_inside_the_session(isolate_bugpilot_config):
    session = _isolation.session_root()
    assert _isolation.is_isolated()
    assert _inside(str(Path.home()), session)
    assert _inside(os.path.expanduser("~"), session)
    assert _inside(str(user_config.user_config_dir()), session)
    assert user_config.user_config_dir() == isolate_bugpilot_config
    assert _inside(os.environ["BUGPILOT_HOME"], session)
    assert _inside(os.environ["USERPROFILE"], session) and _inside(os.environ["HOME"], session)
    # A home of its own, not the session's shared one.
    assert _norm(str(Path.home())) != _norm(os.path.join(session, "home"))


def test_no_variable_that_reaches_a_real_service_survives_isolation():
    leaked = [
        name for name in os.environ
        if name.upper().startswith(_isolation.SANITIZED_PREFIXES)
        or name.upper() in {"BUGPILOT_AUTO_JIRA_COMMENT", "BUGPILOT_MCP_REPO_ROOT"}
    ]
    assert leaked == []


def test_the_guard_is_installed_and_protects_the_real_data_by_name_only():
    """The real roots are path strings; nothing here touches them."""
    assert _isolation.guard_installed()
    roots = _isolation.protected_roots()
    assert roots
    session = _isolation.session_root()
    assert not any(_inside(session, root) or _inside(root, session) for root in roots)
    account_home = _isolation._account_home()
    if account_home:
        assert _norm(os.path.join(account_home, ".bugpilot")) in roots


def test_python_children_are_given_the_guard():
    session = _isolation.session_root()
    guard_dir = os.environ["PYTHONPATH"].split(os.pathsep)[0]
    assert _norm(guard_dir) == _norm(os.path.join(session, "pyguard"))
    # The shared template (also used by the extension's integration suite), copied unchanged.
    assert (Path(guard_dir) / "sitecustomize.py").read_bytes() == Path(_isolation.SITECUSTOMIZE_TEMPLATE).read_bytes()
    assert _norm(os.environ[_isolation.GUARD_FILE_ENV]) == _norm(str(REPO / "tests" / "_isolation.py"))
    assert set(os.environ[_isolation.GUARD_ROOTS_ENV].split(os.pathsep)) == set(_isolation.protected_roots())


def test_a_helper_that_touches_storage_refuses_to_run_outside_the_isolation():
    code = "import sys; sys.path.insert(0, sys.argv[1]); import _isolation; _isolation.require_isolated()"
    env = dict(os.environ)
    env.pop(_isolation.SESSION_ENV)
    done = subprocess.run([sys.executable, "-c", code, str(REPO / "tests")], env=env, capture_output=True, text=True, timeout=120)
    assert done.returncode != 0
    assert "refuses to run outside the test isolation" in done.stderr


# --- in this process ----------------------------------------------------------------------------


def test_the_refusal_is_not_an_exception_product_code_could_swallow():
    assert issubclass(IsolationViolation, BaseException)
    assert not issubclass(IsolationViolation, Exception)


def test_writes_under_a_protected_root_are_refused_before_they_happen(decoy, repo, tmp_path, monkeypatch):
    _point_home_at(monkeypatch, decoy.home)
    outside = tmp_path / "outside.txt"
    outside.write_text("moved in?", encoding="utf-8")
    writes = {
        "save_user_config": lambda: user_config.save_user_config("x@example.invalid", "t", "https://jira.example.invalid"),
        "save_jira_site": lambda: user_config.save_jira_site("https://jira.example.invalid"),
        "save_instructions(user)": lambda: save_instructions("user", repo, "Prefer small changes."),
        "open(w)": lambda: open(decoy.data / "new.txt", "w").close(),
        "write_text": lambda: (decoy.data / "config.toml").write_text("overwritten", encoding="utf-8"),
        "touch": lambda: (decoy.data / "config.toml").touch(),
        "mkdir": lambda: os.mkdir(decoy.data / "sub"),
        "replace into": lambda: os.replace(outside, decoy.data / "moved.txt"),
        "remove": lambda: os.remove(decoy.data / "instructions.md"),
        "rmtree": lambda: shutil.rmtree(decoy.data / "repositories"),
        "copyfile into": lambda: shutil.copyfile(outside, decoy.data / "copied.txt"),
        "utime": lambda: os.utime(decoy.data / "config.toml"),
    }
    outcomes = {}
    with _isolation.protecting(str(decoy.data)), _isolation.expecting_violations() as refused:
        for name, write in writes.items():
            try:
                write()
                outcomes[name] = "allowed"
            except IsolationViolation:
                outcomes[name] = "refused"
    assert outcomes == {name: "refused" for name in writes}
    assert len(refused) == len(writes)
    assert _snapshot(decoy.home) == decoy.before
    assert outside.read_text(encoding="utf-8") == "moved in?"


def test_reads_under_a_protected_root_are_refused_before_they_happen(decoy, repo, monkeypatch):
    _point_home_at(monkeypatch, decoy.home)
    reads = {
        "load_user_config": user_config.load_user_config,
        "read_instructions(user)": lambda: read_instructions("user", repo),
        "open(r)": lambda: open(decoy.data / "instructions.md", encoding="utf-8").read(),
        "read_bytes": lambda: (decoy.data / "config.toml").read_bytes(),
        "listdir": lambda: os.listdir(decoy.data),
        "scandir": lambda: list(os.scandir(decoy.data)),
        "iterdir": lambda: list(decoy.data.iterdir()),
        "glob": lambda: glob.glob(str(decoy.data / "*")),
        "walk": lambda: list(os.walk(decoy.data)),
    }
    outcomes, messages = {}, []
    with _isolation.protecting(str(decoy.data)), _isolation.expecting_violations() as refused:
        for name, read in reads.items():
            try:
                read()
                outcomes[name] = "allowed"
            except IsolationViolation as violation:
                outcomes[name] = "refused"
                messages.append(str(violation))
    assert outcomes == {name: "refused" for name in reads}
    assert len(refused) == len(reads)
    assert not any(canary in message for message in messages + refused for canary in decoy.canaries)
    assert not any(str(decoy.home) in message for message in messages)
    assert _snapshot(decoy.home) == decoy.before


def _outcomes(operations: dict) -> tuple[dict[str, str], dict[str, str]]:
    """Run each operation: whether the guard refused it, and the refusal's message."""
    outcomes, messages = {}, {}
    for name, operation in operations.items():
        try:
            operation()
            outcomes[name] = "allowed"
        except IsolationViolation as violation:
            outcomes[name] = "refused"
            messages[name] = str(violation)
    return outcomes, messages


def test_copies_into_or_out_of_a_protected_root_are_refused(decoy, tmp_path):
    """`shutil.copy2` and `shutil.copy`, both directions. On Windows with Python 3.12+, `copy2` raises
    only `_winapi.CopyFile2` — no `shutil.copyfile`, no `open` — and that event is what refuses it."""
    source = tmp_path / "outside.txt"
    source.write_text("outside\n", encoding="utf-8")
    copies = {
        "copy2 out of": lambda: shutil.copy2(decoy.data / "config.toml", tmp_path / "copied-2.toml"),
        "copy2 into": lambda: shutil.copy2(source, decoy.data / "planted-2.txt"),
        "copy out of": lambda: shutil.copy(decoy.data / "config.toml", tmp_path / "copied-1.toml"),
        "copy into": lambda: shutil.copy(source, decoy.data / "planted-1.txt"),
    }
    with _isolation.protecting(str(decoy.data)), _isolation.expecting_violations():
        outcomes, messages = _outcomes(copies)
        inside = shutil.copy2(source, tmp_path / "inside.txt")  # entirely inside the test's folder
    assert outcomes == {name: "refused" for name in copies}
    if NATIVE_COPY:
        assert all("_winapi.CopyFile2" in messages[name] for name in ("copy2 out of", "copy2 into")), messages
    assert not (tmp_path / "copied-2.toml").exists() and not (tmp_path / "copied-1.toml").exists()
    assert Path(inside).read_text(encoding="utf-8") == "outside\n"
    assert _snapshot(decoy.home) == decoy.before
    assert not any(str(decoy.home) in message for message in messages.values())


@pytest.mark.skipif(not hasattr(Path, "copy"), reason="Path.copy and Path.copy_into are new in Python 3.14")
def test_path_copies_into_or_out_of_a_protected_root_are_refused(decoy, tmp_path):
    source = tmp_path / "outside.txt"
    source.write_text("outside\n", encoding="utf-8")
    copies = {
        "copy out of": lambda: (decoy.data / "config.toml").copy(tmp_path / "copied.toml"),
        "copy into": lambda: source.copy(decoy.data / "planted.txt"),
        "copy_into into": lambda: source.copy_into(decoy.data),
    }
    with _isolation.protecting(str(decoy.data)), _isolation.expecting_violations():
        outcomes, messages = _outcomes(copies)
        inside = source.copy(tmp_path / "inside.txt")  # entirely inside the test's folder
    assert outcomes == {name: "refused" for name in copies}
    if NATIVE_COPY:
        assert all("_winapi.CopyFile2" in message for message in messages.values()), messages
    assert not (tmp_path / "copied.toml").exists()
    assert inside.read_text(encoding="utf-8") == "outside\n"
    assert _snapshot(decoy.home) == decoy.before


@pytest.mark.skipif(sys.platform != "win32", reason="junctions are Windows' (_winapi.CreateJunction)")
def test_a_junction_into_or_inside_a_protected_root_is_refused(decoy, tmp_path):
    """Neither a junction that points into protected data nor one placed inside it is created."""
    target = tmp_path / "target"
    target.mkdir()
    junctions = {
        "pointing into": lambda: _winapi.CreateJunction(str(decoy.data), str(tmp_path / "into-data")),
        "placed inside": lambda: _winapi.CreateJunction(str(target), str(decoy.data / "planted-junction")),
    }
    with _isolation.protecting(str(decoy.data)), _isolation.expecting_violations():
        outcomes, messages = _outcomes(junctions)
        _winapi.CreateJunction(str(target), str(tmp_path / "inside"))  # entirely inside the test's folder
    assert outcomes == {name: "refused" for name in junctions}
    assert all("_winapi.CreateJunction" in message for message in messages.values()), messages
    assert not os.path.lexists(tmp_path / "into-data")
    assert os.path.realpath(tmp_path / "inside") == os.path.realpath(target)
    assert _snapshot(decoy.home) == decoy.before


def test_a_refusal_swallowed_by_the_code_under_test_is_still_recorded(decoy):
    with _isolation.protecting(str(decoy.data)), _isolation.expecting_violations() as refused:
        try:
            (decoy.data / "config.toml").read_text(encoding="utf-8")
        except BaseException:  # noqa: BLE001 - what careless code under test might do
            pass
    assert len(refused) == 1  # without expecting_violations, the per-test check fails the test
    assert _snapshot(decoy.home) == decoy.before


def test_a_child_with_no_home_is_refused_before_it_starts():
    env = {name: value for name, value in os.environ.items() if name.upper() not in {"HOME", "USERPROFILE"}}
    with _isolation.expecting_violations() as refused, pytest.raises(IsolationViolation):
        subprocess.run([sys.executable, "-c", "pass"], env=env, timeout=60)
    assert refused and "no " in refused[0]


def test_a_child_pointed_at_a_protected_root_is_refused_before_it_starts(decoy):
    env = dict(os.environ, HOME=str(decoy.home), USERPROFILE=str(decoy.home))
    with _isolation.protecting(str(decoy.data)), _isolation.expecting_violations() as refused:
        with pytest.raises(IsolationViolation):
            subprocess.run([sys.executable, "-c", "pass"], env=env, timeout=60)
        with pytest.raises(IsolationViolation):
            subprocess.run([sys.executable, "-c", "pass"], cwd=decoy.data, timeout=60)
    assert len(refused) == 2
    assert _snapshot(decoy.home) == decoy.before


# --- a Python child must carry the guard's loader --------------------------------------------


def _writes(marker: Path) -> list[str]:
    """A Python child whose only effect is creating ``marker``: proof that it started."""
    return [sys.executable, "-c", f"open({str(marker)!r}, 'w').close()"]


def _without(*names: str) -> dict[str, str]:
    return {name: value for name, value in os.environ.items() if name.upper() not in names}


def test_a_python_child_without_the_loader_is_refused_before_it_starts(tmp_path, monkeypatch):
    """Whatever drops the loader — or the variables it needs — the child never starts."""
    loader = os.path.join(_isolation.session_root(), _isolation.LOADER_DIR_NAME)
    roots, guard_file, log = _isolation.GUARD_ROOTS_ENV, _isolation.GUARD_FILE_ENV, _isolation.GUARD_LOG_ENV
    environments = {
        "PYTHONPATH replaced": dict(os.environ, PYTHONPATH=str(REPO)),
        "PYTHONPATH removed": _without("PYTHONPATH"),
        "loader not first": dict(os.environ, PYTHONPATH=os.pathsep.join([str(REPO), loader])),
        "guard file removed": _without(guard_file),
        "guard file replaced": dict(os.environ, **{guard_file: str(tmp_path / "other_isolation.py")}),
        "guard log removed": _without(log),
        "protected roots removed": _without(roots),
        "protected roots replaced": dict(os.environ, **{roots: str(tmp_path / "elsewhere")}),
    }
    outcomes, messages = {}, []
    with _isolation.expecting_violations() as refused:
        for index, (name, env) in enumerate(environments.items()):
            try:
                subprocess.run(_writes(tmp_path / f"started-{index}"), env=env, timeout=60)
                outcomes[name] = "started"
            except IsolationViolation as violation:
                outcomes[name] = "refused"
                messages.append(str(violation))
        # Inherited: this process's own environment, without the loader, and no `env=` given.
        monkeypatch.setenv("PYTHONPATH", str(REPO))
        try:
            subprocess.run(_writes(tmp_path / "started-inherited"), timeout=60)
            outcomes["inherited without the loader"] = "started"
        except IsolationViolation as violation:
            outcomes["inherited without the loader"] = "refused"
            messages.append(str(violation))
    assert outcomes == {name: "refused" for name in outcomes}, outcomes
    assert len(outcomes) == 9 and len(refused) == 9
    assert sorted(path.name for path in tmp_path.iterdir()) == []  # no child ever ran
    assert not any(str(REPO) in message or str(tmp_path) in message for message in messages)


def test_python_children_that_carry_the_loader_or_cannot_load_it_start(tmp_path):
    """A child given `child_pythonpath`, a `-I`/`-E`/`-S` child and a non-Python program are not refused."""
    started = {
        "child_pythonpath": (_writes(tmp_path / "loader"), dict(os.environ, PYTHONPATH=_isolation.child_pythonpath(REPO))),
        "-I (ignores PYTHONPATH)": ([sys.executable, "-I", *_writes(tmp_path / "isolated")[1:]], dict(os.environ, PYTHONPATH=str(REPO))),
        "-E (ignores PYTHONPATH)": ([sys.executable, "-E", *_writes(tmp_path / "no-env")[1:]], _without("PYTHONPATH")),
        "-S (skips site)": ([sys.executable, "-S", *_writes(tmp_path / "no-site")[1:]], dict(os.environ, PYTHONPATH=str(REPO))),
    }
    for name, (command, env) in started.items():
        done = subprocess.run(command, env=env, capture_output=True, text=True, timeout=60)
        assert done.returncode == 0, (name, done.stderr)
    assert sorted(path.name for path in tmp_path.iterdir()) == ["isolated", "loader", "no-env", "no-site"]
    git = shutil.which("git")
    if git:  # a non-Python program needs no loader; it is isolated by its environment
        assert subprocess.run([git, "--version"], env=_without("PYTHONPATH"), capture_output=True, timeout=60).returncode == 0


def test_every_process_event_form_is_read_for_its_program():
    """The check reads the program from each audit event: argument lists, an explicit executable,
    and the command line `subprocess.Popen` audits on Windows. Driven directly, so nothing starts."""
    unguarded = dict(os.environ, PYTHONPATH=str(REPO))
    python = sys.executable
    refused = {
        "Popen, argument list": ("subprocess.Popen", (python, [python, "-c", "pass"], None, unguarded)),
        "Popen, Windows command line": ("subprocess.Popen", (None, '"C:\\Program Files\\Python313\\python.exe" -X utf8 -m bugpilot doctor', None, unguarded)),
        "Popen, executable given": ("subprocess.Popen", ("/opt/python/bin/python3.10", ["any-name", "-m", "bugpilot"], None, unguarded)),
        "Popen, pythonw": ("subprocess.Popen", (None, "pythonw.exe -c pass", None, unguarded)),
        "os.exec": ("os.exec", (python, [python, "-c", "pass"], unguarded)),
        "os.posix_spawn": ("os.posix_spawn", (python, [python, "-c", "pass"], unguarded)),
        "os.spawn": ("os.spawn", (0, python, [python, "-c", "pass"], unguarded)),
        "-W's value is not -I": ("subprocess.Popen", (python, [python, "-W", "ignore::ImportWarning", "-c", "pass"], None, unguarded)),
        "-W's joined value is not -I": ("subprocess.Popen", (python, [python, "-Werror::ImportWarning", "-c", "pass"], None, unguarded)),
        "-c's code is not an option": ("subprocess.Popen", (python, [python, "-c", "-I"], None, unguarded)),
    }
    allowed = {
        "-I": ("subprocess.Popen", (python, [python, "-I", "-c", "pass"], None, unguarded)),
        "-sE, combined": ("subprocess.Popen", (python, [python, "-sE", "script.py"], None, unguarded)),
        "Windows command line, -S": ("subprocess.Popen", (None, "C:\\Python313\\python.exe -u -S -c pass", None, unguarded)),
        "a non-Python program": ("subprocess.Popen", ("git", ["git", "status"], None, unguarded)),
        "a console script (limitation)": ("subprocess.Popen", (None, "C:\\tools\\bugpilot.exe doctor --json", None, unguarded)),
    }
    outcomes = {}
    with _isolation.expecting_violations() as recorded:
        for name, (event, args) in {**refused, **allowed}.items():
            try:
                _isolation._hook(event, args)
                outcomes[name] = "allowed"
            except IsolationViolation:
                outcomes[name] = "refused"
    assert outcomes == {**{name: "refused" for name in refused}, **{name: "allowed" for name in allowed}}
    assert len(recorded) == len(refused)


def test_child_pythonpath_puts_the_loader_first_and_each_entry_once(tmp_path):
    loader = os.path.join(_isolation.session_root(), _isolation.LOADER_DIR_NAME)
    value = _isolation.child_pythonpath(REPO, str(REPO), "", loader, tmp_path)
    assert value.split(os.pathsep) == [loader, str(REPO), str(tmp_path)]
    with pytest.raises(ValueError):
        _isolation.child_pythonpath(f"{REPO}{os.pathsep}{tmp_path}")


# --- in a Python child, and its own child ------------------------------------------------------

_CHILD = textwrap.dedent(
    """
    import glob, json, os, shutil, subprocess, sys
    from pathlib import Path

    data = Path(os.environ["DECOY_DATA"])
    repo = Path(os.environ["DECOY_REPO"])
    safe_home = os.environ["DECOY_SAFE_HOME"]
    guard = sys.modules.get("_bugpilot_test_isolation")
    results = {"guard_loaded": bool(guard and guard.guard_installed())}

    def attempt(name, operation):
        try:
            operation()
            results[name] = "allowed"
        except BaseException as error:  # the guard's refusal is a BaseException
            results[name] = "refused" if type(error).__name__ == "IsolationViolation" else "error " + type(error).__name__

    from bugpilot.core import user_config
    from bugpilot.core.instructions import read_instructions, save_instructions

    attempt("save_user_config", lambda: user_config.save_user_config("x@example.invalid", "t", "https://jira.example.invalid"))
    attempt("save_instructions(user)", lambda: save_instructions("user", repo, "Prefer small changes."))
    attempt("load_user_config", user_config.load_user_config)
    attempt("read_instructions(user)", lambda: read_instructions("user", repo))
    attempt("open(w)", lambda: open(data / "new.txt", "w").close())
    attempt("open(r)", lambda: (data / "config.toml").read_text(encoding="utf-8"))
    attempt("listdir", lambda: os.listdir(data))
    attempt("glob", lambda: glob.glob(str(data / "*")))
    attempt("rmtree", lambda: shutil.rmtree(data / "repositories"))
    attempt("grandchild pointed at the decoy", lambda: subprocess.run(
        [sys.executable, "-c", "pass"], env=dict(os.environ, HOME=str(data.parent), USERPROFILE=str(data.parent)), timeout=60))
    grandchild = subprocess.run(
        [sys.executable, "-c", "import os, pathlib; print(pathlib.Path(os.environ['DECOY_DATA'], 'config.toml').read_text())"],
        env=dict(os.environ, HOME=safe_home, USERPROFILE=safe_home), capture_output=True, text=True, timeout=60)
    results["grandchild reading the decoy"] = (
        "refused" if grandchild.returncode != 0 and "IsolationViolation" in grandchild.stderr
        else "allowed rc=%s" % grandchild.returncode)
    results["grandchild output"] = grandchild.stdout
    print(json.dumps(results))
    """
)


def test_a_python_child_and_its_own_child_fail_closed_against_the_decoy(decoy, repo, tmp_path):
    safe_home = tmp_path / "safe-home"
    safe_home.mkdir()
    child_log = tmp_path / "child-guard.log"
    env = {name: value for name, value in os.environ.items() if name not in {"BUGPILOT_CONFIG_DIR", "BUGPILOT_HOME"}}
    env.update(
        HOME=str(decoy.home),
        USERPROFILE=str(decoy.home),
        PYTHONPATH=_isolation.child_pythonpath(REPO),
        DECOY_DATA=str(decoy.data),
        DECOY_REPO=str(repo),
        DECOY_SAFE_HOME=str(safe_home),
    )
    # The decoy, on top of every root this session passes on: a Python child may protect more, never less.
    env[_isolation.GUARD_ROOTS_ENV] = os.pathsep.join([str(decoy.data), os.environ[_isolation.GUARD_ROOTS_ENV]])
    env[_isolation.GUARD_LOG_ENV] = str(child_log)
    done = subprocess.run([sys.executable, "-c", _CHILD], env=env, cwd=repo, capture_output=True, text=True, timeout=180)
    assert done.returncode == 0, done.stderr
    results = json.loads(done.stdout.strip().splitlines()[-1])
    assert results.pop("guard_loaded") is True
    assert results.pop("grandchild output") == ""
    assert results == {name: "refused" for name in results}, results
    assert len(results) == 11
    # The child's refusals went to its own log, not this session's.
    assert len(child_log.read_text(encoding="utf-8").splitlines()) >= 10
    assert _snapshot(decoy.home) == decoy.before
    output = done.stdout + done.stderr + child_log.read_text(encoding="utf-8")
    assert not any(canary in output for canary in decoy.canaries)
    assert str(decoy.home) not in child_log.read_text(encoding="utf-8")


# --- every refusal is reported, inside a test or not --------------------------------------------

#: A nested session's conftest: the suite's own (`tests/conftest.py`) — its isolation, guard and checks.
_NESTED_CONFTEST = """\
import importlib.util
import sys

TESTS = {tests!r}
sys.path.insert(0, TESTS)
_spec = importlib.util.spec_from_file_location("bugpilot_suite_conftest", TESTS + "/conftest.py")
_suite = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(_suite)
globals().update({{name: value for name, value in vars(_suite).items() if not name.startswith("__")}})
"""

#: Refusals the code swallows outside any single test: at collection, and in a module-scoped fixture.
_SWALLOWED_OUTSIDE_A_TEST = """\
import os

import pytest

DECOY = os.environ["DECOY_DATA"]

try:
    open(os.path.join(DECOY, "config.toml"), encoding="utf-8").read()
except BaseException:
    pass


@pytest.fixture(scope="module")
def careless_module_fixture():
    try:
        os.listdir(DECOY)
    except BaseException:
        pass
    yield


def test_passes(careless_module_fixture):
    assert True
"""

#: A refusal a test swallows itself: its own check reports it, and nothing reports it twice.
_SWALLOWED_IN_A_TEST = """\
import os

DECOY = os.environ["DECOY_DATA"]


def test_swallows_its_own():
    try:
        os.listdir(DECOY)
    except BaseException:
        pass
"""


def _nested_session(tmp_path: Path, decoy: Decoy, name: str, source: str, *options: str) -> subprocess.CompletedProcess[str]:
    """A whole pytest session with the suite's conftest, its decoy protected, in a Python child.

    Started with `-E`, as a top-level run is: no inherited loader, only the conftest's own
    isolation and guard, so its checks see every refusal. Nothing in it touches the decoy but
    the reads its tests swallow.
    """
    folder = tmp_path / name
    folder.mkdir()
    (folder / "pytest.ini").write_text("[pytest]\n", encoding="utf-8")
    (folder / "conftest.py").write_text(_NESTED_CONFTEST.format(tests=str(TESTS)), encoding="utf-8")
    (folder / "test_nested.py").write_text(source, encoding="utf-8")
    env = dict(os.environ, DECOY_DATA=str(decoy.data))
    env[_isolation.GUARD_ROOTS_ENV] = os.pathsep.join([str(decoy.data), os.environ[_isolation.GUARD_ROOTS_ENV]])
    command = [
        sys.executable, "-E", "-X", "utf8", "-m", "pytest", "-q", "-rfE", "-p", "no:cacheprovider",
        "-c", str(folder / "pytest.ini"), "--rootdir", str(folder), "--basetemp", str(folder / "basetemp"),
        str(folder / "test_nested.py"), *options,
    ]
    return subprocess.run(command, cwd=folder, env=env, capture_output=True, text=True,
                          encoding="utf-8", errors="replace", timeout=300)


def test_a_refusal_swallowed_outside_any_test_fails_the_session(decoy, tmp_path):
    """At collection and in a module-scoped fixture, where no test's own check is watching."""
    done = _nested_session(tmp_path, decoy, "outside", _SWALLOWED_OUTSIDE_A_TEST)
    output = done.stdout + done.stderr
    assert done.returncode == 1, output
    assert "outside any single test" in output, output
    assert output.count("ERROR at teardown of") == 1, output  # the session check's one error
    assert "ERROR test isolation - " not in output, output  # and the backstop found nothing left to repeat
    assert "open for reading under the protected BugPilot data root" in output
    assert "os.listdir under the protected BugPilot data root" in output
    assert "1 passed, 1 error" in output
    assert any(line.startswith("ERROR ") for line in output.splitlines())  # what CI's annotations read
    assert not any(canary in output for canary in decoy.canaries) and str(decoy.home) not in output
    assert _snapshot(decoy.home) == decoy.before


def test_a_refusal_a_test_swallows_is_reported_once(decoy, tmp_path):
    done = _nested_session(tmp_path, decoy, "inside", _SWALLOWED_IN_A_TEST)
    output = done.stdout + done.stderr
    assert done.returncode == 1, output
    assert output.count("ERROR at teardown of") == 1, output  # the test's own check, once
    assert "refused access to real BugPilot data:" in output
    assert "outside any single test" not in output  # not again at the session's end
    assert "ERROR test isolation - " not in output
    assert "1 passed, 1 error" in output
    assert _snapshot(decoy.home) == decoy.before


def test_a_refusal_in_a_session_where_no_test_ran_still_fails_it(decoy, tmp_path):
    """Every test deselected: the session check never ran, and the end-of-session backstop reports it."""
    done = _nested_session(tmp_path, decoy, "none-ran", _SWALLOWED_OUTSIDE_A_TEST, "-k", "no_such_test")
    output = done.stdout + done.stderr
    assert done.returncode == 1, output  # not 5, "no tests ran"
    assert output.count("ERROR test isolation - ") == 1, output
    assert "open for reading under the protected BugPilot data root" in output
    assert _snapshot(decoy.home) == decoy.before


def test_collecting_unreported_refusals_reports_each_once(decoy):
    """Collected once, then never again — not by a second collection, not by this test's own check."""
    with _isolation.protecting(str(decoy.data)), pytest.raises(IsolationViolation):
        os.listdir(decoy.data)
    first = _isolation.collect_unreported()
    assert len(first) == 1 and "os.listdir under the protected BugPilot data root" in first[0], first
    assert _isolation.collect_unreported() == []
    # Teardown: this test's own check finds the refusal already reported, so the test passes.


# --- the child's loader fails closed -------------------------------------------------------------

#: Runs each case in a Python child of its own, from a launcher that has no guard (started with `-E`):
#: the parent's guard would refuse these misconfigured children before they start, and what is
#: shown here is the child's own behaviour when one starts anyway.
_LOADER_LAUNCHER = """\
import json, os, subprocess, sys
cases = json.loads(sys.argv[1])
results = {}
for name, case in cases.items():
    env = {key: value for key, value in os.environ.items() if not key.upper().startswith("BUGPILOT_TEST_GUARD_")}
    env.update(case["env"])
    done = subprocess.run([sys.executable, "-c", case["code"]], env=env, capture_output=True, text=True, timeout=120)
    results[name] = {"status": done.returncode, "stdout": done.stdout[-400:], "stderr": done.stderr[-2000:]}
print(json.dumps(results))
"""


def test_a_child_whose_configured_guard_cannot_install_stops_before_its_code_runs(tmp_path):
    loader = os.path.join(_isolation.session_root(), _isolation.LOADER_DIR_NAME)
    (tmp_path / "broken_guard.py").write_text('raise RuntimeError("deliberately broken")\n', encoding="utf-8")
    (tmp_path / "not_a_guard.py").write_text("VALUE = 1\n", encoding="utf-8")
    roots = os.pathsep.join([str(tmp_path / "decoy-data"), os.environ[_isolation.GUARD_ROOTS_ENV]])
    guard = os.environ[_isolation.GUARD_FILE_ENV]

    def case(name: str, **variables: str) -> dict[str, object]:
        marker = tmp_path / f"ran-{name}"
        code = (
            f"open({str(marker)!r}, 'w').close(); import sys; "
            "m = sys.modules.get('_bugpilot_test_isolation'); print(bool(m and m.guard_installed()))"
        )
        env = {"PYTHONPATH": loader}
        env.update({getattr(_isolation, key): value for key, value in variables.items()})
        return {"code": code, "env": env}

    log = str(tmp_path / "child-guard.log")
    cases = {
        "file-missing": case("file-missing", GUARD_FILE_ENV=str(tmp_path / "missing.py"), GUARD_ROOTS_ENV=roots, GUARD_LOG_ENV=log),
        "file-broken": case("file-broken", GUARD_FILE_ENV=str(tmp_path / "broken_guard.py"), GUARD_ROOTS_ENV=roots, GUARD_LOG_ENV=log),
        "file-not-the-guard": case("file-not-the-guard", GUARD_FILE_ENV=str(tmp_path / "not_a_guard.py"), GUARD_ROOTS_ENV=roots, GUARD_LOG_ENV=log),
        "file-not-given": case("file-not-given", GUARD_ROOTS_ENV=roots, GUARD_LOG_ENV=log),
        "roots-not-given": case("roots-not-given", GUARD_FILE_ENV=guard, GUARD_LOG_ENV=log),
        "not-configured": case("not-configured"),
        "configured": case("configured", GUARD_FILE_ENV=guard, GUARD_ROOTS_ENV=roots, GUARD_LOG_ENV=log),
    }
    done = subprocess.run(
        [sys.executable, "-E", "-c", _LOADER_LAUNCHER, json.dumps(cases)],
        capture_output=True, text=True, timeout=600,
    )
    assert done.returncode == 0, done.stderr
    results = json.loads(done.stdout.strip().splitlines()[-1])
    broken = ("file-missing", "file-broken", "file-not-the-guard", "file-not-given", "roots-not-given")
    for name in broken:
        assert results[name]["status"] == 70, (name, results[name])
        assert "it stops rather than run unguarded" in results[name]["stderr"], (name, results[name])
        assert not (tmp_path / f"ran-{name}").exists(), name  # none of its own code ran
        assert str(tmp_path) not in results[name]["stderr"], name
    assert len(Path(log).read_text(encoding="utf-8").splitlines()) == len(broken)  # what a parent's check reads
    # Not configured: an ordinary program that finds the loader on its path runs, unguarded and unchanged.
    assert results["not-configured"]["status"] == 0 and results["not-configured"]["stdout"].strip() == "False"
    assert results["configured"]["status"] == 0 and results["configured"]["stdout"].strip() == "True"
    assert (tmp_path / "ran-not-configured").exists() and (tmp_path / "ran-configured").exists()
