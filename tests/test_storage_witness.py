"""The storage write witness, proven on itself (0.1.6 Batch 2B-1; ``tests/_storage_witness.py``).

No product module uses ``storage`` yet, so these tests drive the witness with
direct storage calls and hand-made writes: each rule it enforces is shown to
allow what it should and to catch what it should. Batch 2B then runs the real
CLI and MCP workflows under it. Everything happens in Batch 0A's isolation,
in the test's own ``BUGPILOT_HOME``.
"""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

import _isolation
import _storage_witness
from _storage_witness import witness
from bugpilot.core import artifact_io, storage
from bugpilot.core.artifact_io import atomic_write_text
from bugpilot.core.storage import data_root, global_storage, repository_storage, request_scope

REPO = Path(__file__).resolve().parents[1]
WINDOWS = os.name == "nt"


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    root = tmp_path / "checkout"
    root.mkdir()
    return root


def _verdicts(observed, verdict: str) -> list[str]:
    return [Path(item.path).name for item in observed.observations if item.verdict == verdict]


# --- what is allowed --------------------------------------------------------------------------------


def test_writes_inside_a_granted_folder_within_its_scope_are_granted(repo):
    namespace = repository_storage(repo)
    with witness() as observed, request_scope():
        work = namespace.work_item_dir("JR-12345", create=True)
        (work / "task.md").write_text("synthetic\n", encoding="utf-8")
        (work / "notes").mkdir()
        atomic_write_text(work / "context.md", "synthetic\n")
        os.replace(work / "task.md", work / "task-renamed.md")
        (work / "notes").rmdir()
    observed.assert_clean()
    assert "task.md" in _verdicts(observed, "granted")
    assert "repository.json" in _verdicts(observed, "storage")  # the record is storage's own write


def test_storage_writes_its_own_files_through_public_methods(repo):
    namespace = repository_storage(repo)
    with witness() as observed, request_scope():
        namespace.ensure()
        namespace.work_item_dir("JR-12345", create=True)
        global_storage().write_config_file("jira_base_url = 'https://jira.example.invalid'\n")
        namespace.remove_work_item("JR-12345")
    observed.assert_clean()
    storage_paths = _verdicts(observed, "storage")
    assert {"repository.json", "config.toml", "JR-12345"} <= set(storage_paths)


def test_a_file_grant_covers_the_file_and_the_atomic_writers_temporary_sibling(repo):
    namespace = repository_storage(repo)
    with witness() as observed, request_scope():
        settings = namespace.settings_file("verification.md", create=True)
        atomic_write_text(settings, "synthetic\n")
        memory = namespace.memory_file("JR-12345", create=True)
        atomic_write_text(memory, "synthetic\n")
    observed.assert_clean()
    names = _verdicts(observed, "granted")
    assert "verification.md" in names and any(name.startswith(".verification.md.") for name in names)


def test_writes_outside_the_data_root_are_not_its_business(repo, tmp_path):
    with witness() as observed:
        (tmp_path / "elsewhere.txt").write_text("synthetic\n", encoding="utf-8")
    assert observed.observations == []


# --- what is caught -------------------------------------------------------------------------------------


def test_an_unchecked_path_built_by_hand_is_a_violation(repo):
    namespace = repository_storage(repo)
    namespace.ensure()
    by_hand = data_root() / "repositories" / namespace.identity.repository_id / "work" / "JR-9"
    with witness() as observed, request_scope():
        by_hand.mkdir(parents=True)
        (by_hand / "task.md").write_text("synthetic\n", encoding="utf-8")
    assert {"JR-9", "task.md"} <= set(_verdicts(observed, "violation"))
    assert (by_hand / "task.md").exists()  # the witness judges; it never blocks


def test_a_grant_for_one_repository_never_covers_another(tmp_path):
    first, second = tmp_path / "first", tmp_path / "second"
    first.mkdir()
    second.mkdir()
    other = repository_storage(second)
    other_work = other.work_item_dir("JR-1", create=True)  # created outside the witness
    with witness() as observed, request_scope():
        repository_storage(first).work_item_dir("JR-1", create=True)
        (other_work / "task.md").write_text("synthetic\n", encoding="utf-8")
    assert _verdicts(observed, "violation") == ["task.md"]


def test_a_grant_expires_with_its_scope(repo):
    namespace = repository_storage(repo)
    with witness() as observed:
        with request_scope():
            work = namespace.work_item_dir("JR-12345", create=True)
        (work / "after-the-scope.md").write_text("synthetic\n", encoding="utf-8")
        with request_scope():
            (work / "in-a-later-scope.md").write_text("synthetic\n", encoding="utf-8")
    assert sorted(_verdicts(observed, "violation")) == ["after-the-scope.md", "in-a-later-scope.md"]


def test_writes_through_private_fields_or_private_helpers_are_violations(repo):
    namespace = repository_storage(repo)
    with witness() as observed, request_scope():
        namespace.ensure()
        (namespace._directory / "work").mkdir()
        storage._directory(data_root(), namespace._parts("memory"), create=True)  # a private helper, called directly
    assert {"work", "memory"} <= set(_verdicts(observed, "violation"))


def test_a_lookup_without_create_grants_nothing(repo):
    namespace = repository_storage(repo)
    namespace.work_item_dir("JR-12345", create=True)
    with witness() as observed, request_scope():
        work = namespace.work_item_dir("JR-12345", create=False)
        (work / "task.md").write_text("synthetic\n", encoding="utf-8")
    assert _verdicts(observed, "violation") == ["task.md"]


def test_a_granted_folder_itself_is_not_granted(repo):
    """Deleting a work folder is ``remove_work_item``'s job, with its checks: an ``rmtree`` of it is a violation."""
    namespace = repository_storage(repo)
    with witness() as observed, request_scope():
        work = namespace.work_item_dir("JR-12345", create=True)
        shutil.rmtree(work)
    assert "JR-12345" in _verdicts(observed, "violation")


def test_credentials_are_written_only_by_write_config_file(repo):
    with witness() as observed, request_scope():
        config = global_storage().ensure_config_dir()
        atomic_write_text(config / "config.toml", "jira_token = 'synthetic'\n")
        path = global_storage().config_file(create=True)
        path.write_text("jira_token = 'synthetic'\n", encoding="utf-8")
        (config / "instructions.md").write_text("synthetic\n", encoding="utf-8")  # granted: not a credential
    violations = _verdicts(observed, "violation")
    assert "config.toml" in violations and any(name.startswith(".config.toml.") for name in violations)
    assert "instructions.md" in _verdicts(observed, "granted")


def test_a_nested_storage_call_grants_nothing(repo):
    """``config_file(create=True)`` calls ``ensure_config_dir()`` on its way: that inner call must not grant ``config/``."""
    with witness() as observed, request_scope():
        global_storage().config_file(create=True)
    assert observed.grants == []


# --- integrity: never blocking, never weakening the guard, its own failures visible -------------------------


def test_the_isolation_guard_still_refuses_while_the_witness_watches(tmp_path):
    protected = tmp_path / "protected"
    protected.mkdir()
    with witness(), _isolation.protecting(str(protected)), _isolation.expecting_violations() as refused:
        with pytest.raises(_isolation.IsolationViolation):
            (protected / "x.txt").write_text("synthetic\n", encoding="utf-8")
    assert len(refused) == 1 and not (protected / "x.txt").exists()


def test_a_failure_inside_the_witness_is_recorded_not_raised(repo, monkeypatch):
    namespace = repository_storage(repo)

    def broken(*args, **kwargs):
        raise RuntimeError("a defect in the witness")

    with witness() as observed, request_scope():
        monkeypatch.setattr(observed, "_observe", broken)
        namespace.work_item_dir("JR-12345", create=True)  # the program goes on
    assert observed.errors and "a defect in the witness" in observed.errors[0]
    with pytest.raises(AssertionError):
        observed.assert_clean()


def test_one_witness_at_a_time_and_the_accessors_are_restored(repo):
    before = storage.RepositoryStorage.__dict__["work_item_dir"]
    with witness():
        with pytest.raises(RuntimeError):
            with witness():
                pass
    assert storage.RepositoryStorage.__dict__["work_item_dir"] is before


@pytest.mark.skipif(not hasattr(os, "supports_dir_fd") or os.mkdir not in os.supports_dir_fd,
                    reason="mkdir with dir_fd is POSIX's")
def test_a_path_relative_to_a_directory_descriptor_is_recorded_as_unresolved(repo):
    namespace = repository_storage(repo)
    with witness() as observed, request_scope():
        work = namespace.work_item_dir("JR-12345", create=True)
        handle = os.open(work, os.O_RDONLY)
        try:
            os.mkdir("inside", dir_fd=handle)
        finally:
            os.close(handle)
    assert [item.verdict for item in observed.observations if item.path == "inside"] == ["unresolved"]


# --- open descriptors: os.fchmod and the like (CI run 39085417171) -----------------------------------------
# On POSIX the atomic writer sets a temp file's mode with os.fchmod on its descriptor; the audit event then
# names a descriptor, not a path. The witness places it through the descriptor and judges that path.

HAS_FCHMOD = hasattr(os, "fchmod")  # POSIX, and Windows from Python 3.13
needs_fchmod = pytest.mark.skipif(not HAS_FCHMOD, reason="os.fchmod: POSIX, and Windows from Python 3.13")


def _events(observed, event: str) -> list[tuple[str, str]]:
    return [(Path(item.path).name, item.verdict) for item in observed.observations if item.event == event]


def _descriptor_operations() -> list[tuple[str, str]]:
    """(operation, the audit event it raises) for every descriptor operation this system has."""
    operations = [("fdopen", "open"), ("ftruncate", "os.truncate")]
    if HAS_FCHMOD:
        operations.append(("fchmod", "os.chmod"))
    if os.chmod in os.supports_fd:
        operations.append(("chmod", "os.chmod"))
    if os.utime in os.supports_fd:
        operations.append(("utime", "os.utime"))
    return operations


def _apply(operation: str, descriptor: int) -> None:
    if operation == "fdopen":
        with os.fdopen(os.dup(descriptor), "w", encoding="utf-8") as stream:
            stream.write("synthetic")
    elif operation == "ftruncate":
        os.ftruncate(descriptor, 0)
    elif operation == "fchmod":
        os.fchmod(descriptor, 0o600)
    elif operation == "chmod":
        os.chmod(descriptor, 0o600)
    else:
        os.utime(descriptor)


@needs_fchmod
def test_storages_own_atomic_write_through_a_descriptor_is_storages(monkeypatch):
    """The CI failure, exactly: ``write_config_file`` → the private atomic writer → ``os.fchmod(temp, 0o600)``.

    Windows' writer skips that step, so it is taken on purpose there (``artifact_io._POSIX``).
    """
    if os.name == "nt":
        monkeypatch.setattr(artifact_io, "_POSIX", True)
    with witness() as observed, request_scope():
        global_storage().write_config_file("jira_base_url = 'https://jira.example.invalid'\n")
    observed.assert_clean()
    chmods = _events(observed, "os.chmod")
    assert chmods and {verdict for _, verdict in chmods} == {"storage"}
    assert all(name.startswith(".config.toml.") and name.endswith(".tmp") for name, _ in chmods)


@needs_fchmod
def test_a_descriptor_chmod_inside_a_granted_folder_is_granted(repo):
    namespace = repository_storage(repo)
    with witness() as observed, request_scope():
        work = namespace.work_item_dir("JR-12345", create=True)
        descriptor = os.open(work / "task.md", os.O_CREAT | os.O_WRONLY, 0o600)
        try:
            os.fchmod(descriptor, 0o600)
        finally:
            os.close(descriptor)
    observed.assert_clean()
    assert _events(observed, "os.chmod") == [("task.md", "granted")]


@pytest.mark.parametrize("operation, event", _descriptor_operations())
def test_a_descriptor_operation_on_an_unchecked_file_is_a_violation(operation, event):
    """The file is opened before the witness starts, so only the descriptor operation itself is judged."""
    global_storage().ensure_config_dir()
    stray = data_root() / "stray.txt"
    stray.write_text("synthetic\n", encoding="utf-8")
    descriptor = os.open(stray, os.O_RDWR)
    try:
        with witness() as observed, request_scope():
            _apply(operation, descriptor)
    finally:
        os.close(descriptor)
    assert observed.errors == []
    assert _events(observed, event) == [("stray.txt", "violation")]


def test_a_descriptor_that_is_no_file_is_passed_over():
    reader, writer = os.pipe()
    try:
        with witness() as observed:
            with os.fdopen(writer, "w", encoding="utf-8") as stream:  # closes the writer
                stream.write("synthetic")
    finally:
        os.close(reader)
    assert observed.observations == [] and observed.errors == []


@pytest.mark.parametrize("operation, event", _descriptor_operations())
def test_a_descriptor_whose_file_cannot_be_placed_is_unresolved_never_granted(repo, monkeypatch, operation, event):
    namespace = repository_storage(repo)
    with witness() as observed, request_scope():
        work = namespace.work_item_dir("JR-12345", create=True)
        descriptor = os.open(work / "task.md", os.O_CREAT | os.O_RDWR, 0o600)
        monkeypatch.setattr(_storage_witness, "_platform_place", lambda descriptor: None)
        try:
            _apply(operation, descriptor)
        finally:
            os.close(descriptor)
    observed.assert_clean()  # unresolved is reported, not a violation; but never granted
    unplaced = [item for item in observed.observations if item.path.startswith("<descriptor ")]
    assert [(item.event, item.verdict) for item in unplaced] == [(event, "unresolved")]
    assert unplaced == [item for item in observed.unresolved() if item.path.startswith("<descriptor ")]


@pytest.mark.skipif(os.name == "nt", reason="a file held open cannot be deleted on Windows")
def test_a_descriptor_of_a_deleted_file_is_unresolved(repo):
    namespace = repository_storage(repo)
    work = namespace.work_item_dir("JR-12345", create=True)
    descriptor = os.open(work / "gone.md", os.O_CREAT | os.O_RDWR, 0o600)
    os.remove(work / "gone.md")
    try:
        with witness() as observed, request_scope():
            os.ftruncate(descriptor, 0)
    finally:
        os.close(descriptor)
    assert [(item.event, item.verdict) for item in observed.observations] == [("os.truncate", "unresolved")]


def test_a_path_relative_to_the_working_directory_is_judged(monkeypatch):
    """``dir_fd`` -1 means none: the name is relative to the working directory, and is judged there."""
    global_storage().ensure_config_dir()
    monkeypatch.chdir(data_root())
    with witness() as observed, request_scope():
        os.mkdir("made-by-hand")
    assert [(item.event, Path(item.path).name, item.verdict) for item in observed.observations] == [
        ("os.mkdir", "made-by-hand", "violation")]


def test_an_argument_that_is_neither_a_path_nor_a_descriptor_is_unresolved():
    with witness() as observed:
        _storage_witness._hook("os.chmod", (None, 0o600, -1))
    assert [(item.verdict, item.detail) for item in observed.observations] == [
        ("unresolved", "neither a path nor a descriptor")]
    assert observed.errors == []


# --- Python children, through the witness runner ----------------------------------------------------------


def _child(tmp_path: Path, code: str) -> dict:
    report = tmp_path / "witness-report.json"
    done = subprocess.run(
        [sys.executable, str(Path(_storage_witness.__file__)), str(report), "-c", code],
        env=dict(os.environ, PYTHONPATH=_isolation.child_pythonpath(REPO)),
        capture_output=True, text=True, timeout=120,
    )
    assert done.returncode == 0, done.stderr
    return json.loads(report.read_text(encoding="utf-8"))


def test_a_python_child_started_through_the_runner_is_observed(repo, tmp_path):
    code = (
        "import sys\n"
        "from bugpilot.core.storage import repository_storage, request_scope, data_root\n"
        f"namespace = repository_storage({str(repo)!r})\n"
        "with request_scope():\n"
        "    work = namespace.work_item_dir('JR-12345', create=True)\n"
        "    (work / 'task.md').write_text('synthetic', encoding='utf-8')\n"
        "    (data_root() / 'stray.txt').write_text('synthetic', encoding='utf-8')\n"
    )
    found = _child(tmp_path, code)
    assert found["errors"] == []
    verdicts = {Path(item["path"]).name: item["verdict"] for item in found["observations"]}
    assert verdicts["task.md"] == "granted"
    assert verdicts["repository.json"] == "storage"
    assert verdicts["stray.txt"] == "violation"
