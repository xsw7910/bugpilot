"""Reads that follow no link: storage's held-folder readers (0.1.6, Option C, M1).

``RepositoryStorage.read_settings``, ``fix_mode_names`` and ``read_fix_mode``,
and ``GlobalStorage.read_config``, ``read_user_instructions``,
``user_fix_mode_names`` and ``read_user_fix_mode``: their states, their
limits, their names, their parity with the path accessors' checks and words,
the identity record, and what they leave behind (no writes, no open handles,
no absolute paths).

Every link here is planted before the read and stays as it is: these tests
show what a read does with a link it meets, never what happens when one is
swapped in while a read runs. That is the adversarial validation's job, a
separate gate. Every test runs in Batch 0A's isolation, with a fresh
``BUGPILOT_HOME``; links point at a decoy in ``tmp_path``.
"""

from __future__ import annotations

import contextlib
import errno
import hashlib
import json
import os
import re
import stat
from pathlib import Path

import pytest

from bugpilot.core import _held_folders, fix_mode_store, storage, user_config
from bugpilot.core.artifact_io import atomic_write_text
from bugpilot.core.errors import StorageAccessError
from bugpilot.core.instructions import read_instructions
from bugpilot.core.project_settings import ProjectSettings, load_project_settings
from bugpilot.core.repository_profile import load_repository_profile
from bugpilot.core.storage import (
    SETTINGS_NAMES,
    SettingsContent,
    StorageError,
    StorageIdentityError,
    data_root,
    global_storage,
    repository_storage,
    request_scope,
)

WINDOWS = os.name == "nt"
POSIX = os.name == "posix"
LINK_KINDS = ["symlink"] + (["junction"] if WINDOWS else [])
SENTINEL = b"decoy content that no read may return\n"


@pytest.fixture(autouse=True)
def fresh_caches(monkeypatch):
    monkeypatch.delenv(storage.GIT_WORK_TREE_ENV, raising=False)
    storage._identities.clear()
    yield
    storage._identities.clear()


@pytest.fixture
def repo(tmp_path: Path) -> Path:
    root = tmp_path / "checkout"
    root.mkdir()
    (root / "README.md").write_text("synthetic\n", encoding="utf-8")
    return root


@pytest.fixture
def decoy(tmp_path: Path) -> Path:
    """Where a planted link points: a folder holding files no read may return."""
    target = tmp_path / "decoy"
    target.mkdir()
    for name in ("instructions.md", "inner.json", "config.toml"):
        (target / name).write_bytes(SENTINEL)
    return target


@pytest.fixture
def namespace(repo: Path):
    found = repository_storage(repo)
    found.ensure()
    return found


def _plant(kind: str, link: Path, target: Path) -> None:
    """A link at ``link``, planted before any read: a junction on Windows, else a symbolic link."""
    if kind == "junction":
        import _winapi

        _winapi.CreateJunction(str(target), str(link))
        return
    try:
        os.symlink(target, link, target_is_directory=target.is_dir())
    except (OSError, NotImplementedError) as error:
        pytest.skip(f"symbolic links are not available here: {type(error).__name__}")


def _settings(namespace, name: str, data: bytes) -> Path:
    path = namespace.settings_file(name, create=True)
    path.write_bytes(data)
    return path


def _assert_no_absolute_path(message: str, *places: Path) -> None:
    assert "\n" not in message
    for place in (data_root(), Path(os.environ["BUGPILOT_HOME"]), *places):
        assert str(place) not in message and os.path.normcase(str(place)) not in os.path.normcase(message)
    assert not re.search(r"(?<![\w])[A-Za-z]:[\\/]", message), message


def _readers(namespace):
    """Every new reader, each as a call, for the checks that apply to all of them."""
    user = global_storage()
    return {
        "read_settings": lambda: namespace.read_settings("instructions.md", limit=1024),
        "fix_mode_names": namespace.fix_mode_names,
        "read_fix_mode": lambda: namespace.read_fix_mode("triage.json", limit=1024),
        "read_config": user.read_config,
        "read_user_instructions": lambda: user.read_user_instructions(limit=1024),
        "user_fix_mode_names": user.user_fix_mode_names,
        "read_user_fix_mode": lambda: user.read_user_fix_mode("triage.json", limit=1024),
    }


# --- legitimate reads ------------------------------------------------------------------------------


@pytest.mark.parametrize("name", sorted(SETTINGS_NAMES))
def test_each_settings_file_is_read_back_byte_for_byte(namespace, name):
    data = b"\xef\xbb\xbfline one\r\nline two\rline three\n"
    _settings(namespace, name, data)
    assert namespace.read_settings(name, limit=1024) == SettingsContent("present", data)


def test_an_empty_file_is_present_and_empty(namespace):
    _settings(namespace, "instructions.md", b"")
    assert namespace.read_settings("instructions.md", limit=0) == SettingsContent("present", b"")


def test_the_limit_is_inclusive_and_a_larger_file_returns_no_bytes(namespace):
    _settings(namespace, "project_settings.json", b"x" * 10)
    assert namespace.read_settings("project_settings.json", limit=10) == SettingsContent("present", b"x" * 10)
    assert namespace.read_settings("project_settings.json", limit=9) == SettingsContent("too_large")


def test_a_file_of_many_chunks_is_read_whole_or_bounded(user_config_folder):
    data = bytes(range(256)) * 1024  # 256 KiB, several reads
    user = global_storage()
    user.config_file(create=True).write_bytes(data)
    assert user.read_config() == SettingsContent("present", data)
    assert user.read_config(limit=len(data)) == SettingsContent("present", data)
    assert user.read_config(limit=len(data) - 1) == SettingsContent("too_large")


def test_the_user_files_are_read(user_config_folder):
    user = global_storage()
    user.user_instructions_file(create=True).write_bytes(b"user instructions\n")
    user.config_file(create=True).write_bytes(b"[jira]\n")
    assert user.read_user_instructions(limit=100) == SettingsContent("present", b"user instructions\n")
    assert user.read_config() == SettingsContent("present", b"[jira]\n")


# --- nothing there ---------------------------------------------------------------------------------


def test_without_a_data_root_every_reader_finds_nothing_and_creates_nothing(repo):
    namespace = repository_storage(repo)
    assert not os.path.lexists(data_root())
    for name, read in _readers(namespace).items():
        assert read() in (SettingsContent("absent"), []), name
    assert not os.path.lexists(data_root())
    assert sorted(os.listdir(repo)) == ["README.md"]


def test_a_namespace_without_its_folders_is_absent(namespace):
    assert namespace.read_settings("verification.md", limit=100) == SettingsContent("absent")
    assert namespace.fix_mode_names() == []
    assert namespace.read_fix_mode("triage.json", limit=100) == SettingsContent("absent")
    assert not os.path.lexists(namespace.settings_file("verification.md", create=False).parent)


def test_a_missing_file_in_existing_folders_is_absent(namespace, user_config_folder):
    _settings(namespace, "instructions.md", b"present\n")
    namespace.fix_modes_dir(create=True)
    global_storage().user_fix_modes_dir(create=True)
    assert namespace.read_settings("ai_behavior.md", limit=100) == SettingsContent("absent")
    assert namespace.read_fix_mode("triage.json", limit=100) == SettingsContent("absent")
    assert global_storage().read_user_fix_mode("triage.json", limit=100) == SettingsContent("absent")
    assert global_storage().read_config() == SettingsContent("absent")


# --- not a regular file ----------------------------------------------------------------------------


def test_a_folder_at_the_name_is_not_a_file(namespace, user_config_folder):
    namespace.settings_file("verification.md", create=True).mkdir()
    (namespace.fix_modes_dir(create=True) / "folder.json").mkdir()
    (user_config_folder / "instructions.md").mkdir()
    assert namespace.read_settings("verification.md", limit=100) == SettingsContent("not_a_file")
    assert namespace.read_fix_mode("folder.json", limit=100) == SettingsContent("not_a_file")
    assert global_storage().read_user_instructions(limit=100) == SettingsContent("not_a_file")


# --- names -----------------------------------------------------------------------------------------


def test_a_name_outside_the_settings_set_is_refused(namespace):
    with pytest.raises(StorageError) as refused:
        namespace.read_settings("config.toml", limit=100)  # type: ignore[arg-type]
    assert str(refused.value) == "'config.toml' is not one of BugPilot's repository settings files."


def test_fix_mode_names_are_the_json_entries_sorted_as_the_system_compares_names(namespace):
    folder = namespace.fix_modes_dir(create=True)
    for name in ("b-mode.json", "a-mode.json", "notes.txt", "UPPER.JSON", ".json"):
        (folder / name).write_bytes(b"{}")
    (folder / "folder.json").mkdir()
    expected = [".json", "a-mode.json", "b-mode.json", "folder.json"]
    if WINDOWS:  # names compare without case there, as the glob this replaces matched them
        expected = [".json", "a-mode.json", "b-mode.json", "folder.json", "UPPER.JSON"]
    assert namespace.fix_mode_names() == expected
    assert namespace.read_fix_mode("a-mode.json", limit=100) == SettingsContent("present", b"{}")


def test_the_user_fix_modes_are_listed_and_read(user_config_folder):
    folder = global_storage().user_fix_modes_dir(create=True)
    (folder / "careful.json").write_bytes(b'{"id": "careful"}')
    (folder / "README.md").write_bytes(b"not a mode")
    assert global_storage().user_fix_mode_names() == ["careful.json"]
    assert global_storage().read_user_fix_mode("careful.json", limit=100) == SettingsContent(
        "present", b'{"id": "careful"}'
    )


INVALID_FIX_MODE_NAMES = ["", ".", "..", "a/b.json", "a\\b.json", "x.txt", "x.json\0", "nested/../x.json"] + (
    ["x.json:stream", "C:\\x.json"] if WINDOWS else ["/x.json"]
)


@pytest.mark.parametrize("file_name", INVALID_FIX_MODE_NAMES)
def test_an_invalid_fix_mode_file_name_is_refused_without_being_repeated(namespace, user_config_folder, file_name):
    (namespace.fix_modes_dir(create=True) / "x.json").write_bytes(b"{}")
    for read in (namespace.read_fix_mode, global_storage().read_user_fix_mode):
        with pytest.raises(StorageError) as refused:
            read(file_name, limit=100)
        message = str(refused.value)
        assert message.startswith("BugPilot reads a Fix Mode only by its plain file name")
        if file_name not in ("", ".", ".."):
            assert file_name not in message
        _assert_no_absolute_path(message)


# --- links: met, never followed --------------------------------------------------------------------


@pytest.mark.parametrize("kind", LINK_KINDS)
def test_a_link_at_a_fix_mode_file_is_reported_as_a_link_and_never_followed(namespace, decoy, kind):
    folder = namespace.fix_modes_dir(create=True)
    target = decoy if kind == "junction" else decoy / "inner.json"
    _plant(kind, folder / "linked.json", target)
    (folder / "real.json").write_bytes(b"{}")
    assert namespace.fix_mode_names() == ["linked.json", "real.json"]
    assert namespace.read_fix_mode("linked.json", limit=1024) == SettingsContent("link")
    assert namespace.read_fix_mode("real.json", limit=1024) == SettingsContent("present", b"{}")


@pytest.mark.parametrize("kind", LINK_KINDS)
def test_a_listed_folder_link_shows_its_own_name_and_none_of_its_target(user_config_folder, decoy, kind):
    folder = global_storage().user_fix_modes_dir(create=True)
    _plant(kind, folder / "elsewhere.json", decoy)
    assert global_storage().user_fix_mode_names() == ["elsewhere.json"]


@pytest.mark.parametrize("kind", LINK_KINDS)
def test_a_link_at_a_settings_file_is_refused_in_the_path_accessors_words(namespace, decoy, kind):
    folder = namespace.settings_file("instructions.md", create=True).parent
    _plant(kind, folder / "instructions.md", decoy if kind == "junction" else decoy / "instructions.md")
    with pytest.raises(StorageError) as by_path:
        namespace.settings_file("instructions.md", create=False)
    with pytest.raises(StorageError) as held:
        namespace.read_settings("instructions.md", limit=1024)
    assert str(held.value) == str(by_path.value)
    assert SENTINEL.decode().strip() not in str(held.value)
    _assert_no_absolute_path(str(held.value), decoy)


@pytest.mark.parametrize("kind", LINK_KINDS)
def test_a_link_at_a_user_file_is_refused_in_the_path_accessors_words(user_config_folder, decoy, kind):
    for name, by_path, held in (
        ("instructions.md", lambda: global_storage().user_instructions_file(create=False),
         lambda: global_storage().read_user_instructions(limit=1024)),
        ("config.toml", lambda: global_storage().config_file(create=False), global_storage().read_config),
    ):
        _plant(kind, user_config_folder / name, decoy if kind == "junction" else decoy / name)
        with pytest.raises(StorageError) as expected:
            by_path()
        with pytest.raises(StorageError) as found:
            held()
        assert str(found.value) == str(expected.value), name
        _assert_no_absolute_path(str(found.value), decoy)


#: Where a folder link is planted (relative to the data root) → (the path accessor's call, the held reads' calls).
FOLDER_LINKS = {
    "repositories": (
        lambda ns: ("repositories",),
        lambda ns: ns.settings_file("instructions.md", create=False),
        lambda ns: [lambda: ns.read_settings("instructions.md", limit=10)],
    ),
    "<id>": (
        lambda ns: ("repositories", ns.identity.repository_id),
        lambda ns: ns.settings_file("instructions.md", create=False),
        lambda ns: [lambda: ns.read_settings("instructions.md", limit=10)],
    ),
    "settings": (
        lambda ns: ("repositories", ns.identity.repository_id, "settings"),
        lambda ns: ns.settings_file("instructions.md", create=False),
        lambda ns: [lambda: ns.read_settings("instructions.md", limit=10)],
    ),
    "fix_modes": (
        lambda ns: ("repositories", ns.identity.repository_id, "settings", "fix_modes"),
        lambda ns: ns.fix_modes_dir(create=False),
        lambda ns: [ns.fix_mode_names, lambda: ns.read_fix_mode("x.json", limit=10)],
    ),
    "config": (
        lambda ns: ("config",),
        lambda ns: global_storage().user_instructions_file(create=False),
        lambda ns: [lambda: global_storage().read_user_instructions(limit=10), global_storage().read_config],
    ),
    "config/fix_modes": (
        lambda ns: ("config", "fix_modes"),
        lambda ns: global_storage().user_fix_modes_dir(create=False),
        lambda ns: [
            global_storage().user_fix_mode_names,
            lambda: global_storage().read_user_fix_mode("x.json", limit=10),
        ],
    ),
}


@pytest.mark.parametrize("kind", LINK_KINDS)
@pytest.mark.parametrize("where", list(FOLDER_LINKS))
def test_a_link_on_the_way_is_refused_in_the_path_accessors_words(repo, decoy, kind, where):
    namespace = repository_storage(repo)
    parts_of, by_path, held_reads = FOLDER_LINKS[where]
    parts = parts_of(namespace)
    if parts[0] == "repositories" and len(parts) > 2:
        namespace.ensure()  # the namespace and its record, so the link is met below them
    storage._ensure_root(data_root())
    if len(parts) > 1:
        storage._directory(data_root(), parts[:-1], create=True)
    _plant(kind, data_root().joinpath(*parts), decoy)
    with pytest.raises(StorageError) as expected:
        by_path(namespace)
    for read in held_reads(namespace):
        with pytest.raises(StorageError) as found:
            read()
        assert str(found.value) == str(expected.value)
        _assert_no_absolute_path(str(found.value), decoy, repo)
    assert sorted(os.listdir(decoy)) == ["config.toml", "inner.json", "instructions.md"]


def test_a_data_root_that_is_a_file_is_refused_for_reads(repo, tmp_path, monkeypatch):
    blocker = tmp_path / "not-a-folder"
    blocker.write_bytes(b"x")
    monkeypatch.setenv("BUGPILOT_HOME", str(blocker))
    for name, read in _readers(repository_storage(repo)).items():
        with pytest.raises(StorageError) as refused:
            read()
        assert str(refused.value) == (
            "BugPilot cannot use BUGPILOT_HOME as its data folder: it is not a folder."
        ), name
    assert blocker.read_bytes() == b"x"


# --- the identity record ---------------------------------------------------------------------------


def _record(namespace) -> Path:
    return data_root() / "repositories" / namespace.identity.repository_id / storage.RECORD_NAME


def _rewrite_record(namespace, text: str) -> None:
    record = _record(namespace)
    os.chmod(record, 0o600)
    record.write_text(text, encoding="utf-8")


@pytest.mark.parametrize(
    "record",
    [
        "not json",
        json.dumps({"schema_version": 1, "repository_id": "other-0123456789abcdef", "root": "elsewhere"}),
        "MISMATCH",
    ],
)
def test_a_refused_record_refuses_every_repository_read_as_the_path_accessor_does(namespace, record):
    _settings(namespace, "instructions.md", b"kept\n")
    namespace.fix_modes_dir(create=True)
    if record == "MISMATCH":
        record = json.dumps(
            {"schema_version": 1, "repository_id": namespace.identity.repository_id, "root": "another folder"}
        )
    _rewrite_record(namespace, record)
    with pytest.raises(StorageIdentityError) as expected:
        namespace.settings_file("instructions.md", create=False)
    for read in (
        lambda: namespace.read_settings("instructions.md", limit=100),
        namespace.fix_mode_names,
        lambda: namespace.read_fix_mode("x.json", limit=100),
    ):
        with pytest.raises(StorageIdentityError) as found:
            read()
        assert str(found.value) == str(expected.value)
        _assert_no_absolute_path(str(found.value))


def test_a_namespace_without_its_record_is_read_as_the_path_accessor_reads_it(namespace):
    _settings(namespace, "instructions.md", b"kept\n")
    os.chmod(_record(namespace), 0o600)
    _record(namespace).unlink()
    assert namespace.settings_file("instructions.md", create=False).read_bytes() == b"kept\n"
    assert namespace.read_settings("instructions.md", limit=100) == SettingsContent("present", b"kept\n")
    assert not os.path.lexists(_record(namespace))  # reading never writes a record


def test_a_record_verified_by_a_held_read_is_not_remembered_for_the_path_accessor(namespace, monkeypatch):
    # F4 (owner decision Option A): no verdict is kept, so the path accessor reads the record again.
    _settings(namespace, "instructions.md", b"kept\n")
    record = _record(namespace)
    with request_scope():
        assert namespace.read_settings("instructions.md", limit=100).state == "present"
        assert ("record", str(record)) not in storage._active_scope()
        reads = []
        real_read = storage._read_regular
        monkeypatch.setattr(storage, "_read_regular", lambda path, info: reads.append(path) or real_read(path, info))
        assert namespace.record_state() == "ok"
        assert reads == [record]


def test_a_record_verified_by_the_path_accessor_is_judged_again_by_a_held_read(namespace, monkeypatch):
    # F4 (owner decision Option A): the held read judges the record again, inside the same scope.
    _settings(namespace, "instructions.md", b"kept\n")
    with request_scope():
        assert namespace.record_state() == "ok"
        judged = []
        verdict = storage._record_verdict
        monkeypatch.setattr(storage, "_record_verdict", lambda data, identity: judged.append(1) or verdict(data, identity))
        assert namespace.read_settings("instructions.md", limit=100).state == "present"
        assert judged == [1]


def _rewritten_in_place_for_another_repository(namespace) -> None:
    """The record rewritten in place for another root of the same length, its size and modification time kept."""
    record = _record(namespace)
    info = os.stat(record)
    text = storage._record_text(namespace.identity)
    root = json.dumps(str(namespace.identity.root))[1:-1]
    payload = text.replace(root, root[:-1] + ("x" if root[-1] != "x" else "y")).encode("ascii")
    assert len(payload) == info.st_size
    record.write_bytes(payload)
    os.utime(record, ns=(info.st_atime_ns, info.st_mtime_ns))


def test_a_held_read_refuses_a_record_rewritten_within_its_scope(namespace, repo):
    # F4: no verdict is kept, so a rewrite that leaves the record's size and time as they were is still seen.
    _settings(namespace, "instructions.md", b"kept\n")
    (namespace.fix_modes_dir(create=True) / "triage.json").write_bytes(b"{}")
    expected = (f"BugPilot will not use {storage.display_path(_record(namespace))}: it belongs to a different "
                "repository folder. Nothing was read or written; delete that record only if you are sure it is stale.")
    with request_scope():
        assert namespace.read_settings("instructions.md", limit=100).state == "present"
        assert namespace.fix_mode_names() == ["triage.json"]
        _rewritten_in_place_for_another_repository(namespace)
        for read in (
            lambda: namespace.read_settings("instructions.md", limit=100),
            lambda: namespace.read_fix_mode("triage.json", limit=None),
            namespace.fix_mode_names,  # the Fix Mode listing
            lambda: fix_mode_store.catalog_for(repo),  # and its consumer
        ):
            with pytest.raises(StorageIdentityError) as refused:
                read()
            assert str(refused.value) == expected
            _assert_no_absolute_path(str(refused.value), repo)


def test_a_held_record_in_use_is_still_retried_then_a_failure(namespace, repo, monkeypatch):
    monkeypatch.setattr(storage, "_TRANSIENT_DELAY", 0)
    _settings(namespace, "instructions.md", b"kept\n")
    folder_class = _held_folders._WindowsFolder if WINDOWS else _held_folders._PosixFolder
    real_open_file = folder_class.open_file
    busy = {"left": 2}

    def open_file(self, name):
        if name == storage.RECORD_NAME and busy["left"]:
            busy["left"] -= 1
            raise PermissionError(errno.EACCES, "in use")
        return real_open_file(self, name)

    monkeypatch.setattr(folder_class, "open_file", open_file)
    with request_scope():
        assert namespace.read_settings("instructions.md", limit=100).state == "present"  # retried, then read
        busy["left"] = 999
        with pytest.raises(storage.StorageError) as failed:
            namespace.read_settings("instructions.md", limit=100)
    assert "right now" in str(failed.value)
    _assert_no_absolute_path(str(failed.value), repo)


def test_outside_a_scope_the_record_is_judged_on_every_read(namespace, monkeypatch):
    _settings(namespace, "instructions.md", b"kept\n")
    judged = []
    verdict = storage._record_verdict
    monkeypatch.setattr(storage, "_record_verdict", lambda data, identity: judged.append(1) or verdict(data, identity))
    namespace.read_settings("instructions.md", limit=100)
    namespace.read_settings("instructions.md", limit=100)
    assert len(judged) == 2


def test_reads_leave_the_identity_and_its_record_unchanged(namespace):
    _settings(namespace, "instructions.md", b"kept\n")
    before = (namespace.identity, _record(namespace).read_bytes(), os.lstat(_record(namespace)).st_mtime_ns)
    for read in _readers(namespace).values():
        read()
    storage._identities.clear()
    again = repository_storage(namespace.identity.root)
    assert (again.identity, _record(namespace).read_bytes(), os.lstat(_record(namespace)).st_mtime_ns) == before


# --- what reads leave behind ----------------------------------------------------------------------


def _snapshot(*roots: Path) -> list[tuple[str, str, int, int, str]]:
    found = []
    for root in roots:
        for current, folders, files in os.walk(root):
            for name in folders + files:
                path = Path(current, name)
                info = os.lstat(path)
                digest = hashlib.sha256(path.read_bytes()).hexdigest() if path.is_file() else ""
                found.append((str(path.relative_to(root)), oct(info.st_mode), info.st_size, info.st_mtime_ns, digest))
    return sorted(found)


def test_reads_write_nothing(namespace, user_config_folder, repo):
    _settings(namespace, "instructions.md", b"kept\n")
    (namespace.fix_modes_dir(create=True) / "triage.json").write_bytes(b"{}")
    (namespace.fix_modes_dir(create=True) / "folder.json").mkdir()
    global_storage().user_fix_modes_dir(create=True)
    before = _snapshot(data_root(), repo)
    for _ in range(3):
        for read in _readers(namespace).values():
            read()
        namespace.read_fix_mode("folder.json", limit=10)
        with pytest.raises(StorageError):
            namespace.read_settings("missing name", limit=10)  # type: ignore[arg-type]
    assert _snapshot(data_root(), repo) == before


def _open_handles() -> int:
    if WINDOWS:
        import ctypes
        from ctypes import wintypes

        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.GetCurrentProcess.restype = wintypes.HANDLE
        kernel32.GetProcessHandleCount.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
        count = wintypes.DWORD()
        assert kernel32.GetProcessHandleCount(kernel32.GetCurrentProcess(), ctypes.byref(count))
        return count.value
    for folder in ("/proc/self/fd", "/dev/fd"):
        if os.path.isdir(folder):
            return len(os.listdir(folder))
    pytest.skip("this system shows no count of open descriptors")


@pytest.mark.parametrize("kind", LINK_KINDS)
def test_every_handle_is_closed_after_reads_refusals_and_links(namespace, user_config_folder, decoy, kind):
    _settings(namespace, "instructions.md", b"kept\n")
    folder = namespace.fix_modes_dir(create=True)
    (folder / "triage.json").write_bytes(b"{}")
    _plant(kind, folder / "linked.json", decoy if kind == "junction" else decoy / "inner.json")
    _plant(kind, user_config_folder / "instructions.md", decoy if kind == "junction" else decoy / "instructions.md")

    def round_of_reads() -> None:
        for read in _readers(namespace).values():
            try:
                read()
            except StorageError:
                pass  # the user instructions are a link: refused, and still nothing left open
        namespace.read_fix_mode("linked.json", limit=10)
        namespace.read_settings("instructions.md", limit=1)

    round_of_reads()  # anything loaded once is loaded before counting
    before = _open_handles()
    for _ in range(25):
        round_of_reads()
    assert _open_handles() - before < 5


def test_no_folder_stays_held_after_a_read_or_a_refusal(namespace):
    settings = _settings(namespace, "instructions.md", b"kept\n").parent
    namespace.read_settings("instructions.md", limit=100)
    record = _record(namespace).read_text(encoding="utf-8")
    _rewrite_record(namespace, "not json")
    with pytest.raises(StorageIdentityError):  # refused with every folder on the way held
        namespace.read_settings("instructions.md", limit=100)
    _rewrite_record(namespace, record)
    namespace_folder = settings.parent
    moved = namespace_folder.with_name(namespace_folder.name + "-moved")
    os.rename(settings, settings.with_name("settings-moved"))
    os.rename(settings.with_name("settings-moved"), settings)
    os.rename(namespace_folder, moved)
    os.rename(moved, namespace_folder)
    assert namespace.read_settings("instructions.md", limit=100) == SettingsContent("present", b"kept\n")


# --- the system: primitives, handles, failures ----------------------------------------------------


def test_a_system_without_the_primitives_is_refused_and_never_read_by_path(namespace, user_config_folder, monkeypatch):
    _settings(namespace, "instructions.md", b"kept\n")
    if WINDOWS:
        monkeypatch.setattr(_held_folders, "_KERNEL32", None)
    else:
        monkeypatch.setattr(os, "supports_dir_fd", set())
    for name, read in _readers(namespace).items():
        with pytest.raises(StorageError) as refused:
            read()
        assert str(refused.value) == (
            "BugPilot cannot read its data folder safely on this system: it cannot open files there without "
            "following links. Nothing was read."
        ), name


@pytest.mark.skipif(not POSIX, reason="descriptor-relative opens are the POSIX implementation")
def test_posix_opens_are_relative_to_a_held_folder_and_never_follow(namespace, monkeypatch):
    _settings(namespace, "instructions.md", b"kept\n")
    calls = []
    original = os.open

    def recording(path, flags, mode=0o777, *, dir_fd=None):
        calls.append((path, flags, dir_fd))
        return original(path, flags, mode, dir_fd=dir_fd)

    monkeypatch.setattr(os, "open", recording)
    monkeypatch.setattr(os, "supports_dir_fd", os.supports_dir_fd | {recording})
    assert namespace.read_settings("instructions.md", limit=100) == SettingsContent("present", b"kept\n")
    anchor, *below = calls
    assert Path(anchor[0]) == data_root() and anchor[2] is None  # the data root itself is followed (B4-2)
    assert [path for path, _flags, _fd in below] == [
        "repositories", namespace.identity.repository_id, "settings", storage.RECORD_NAME, "instructions.md"
    ]
    for _path, flags, descriptor in below:
        assert descriptor is not None and flags & os.O_NOFOLLOW and flags & os.O_CLOEXEC
    assert all(flags & os.O_DIRECTORY for _path, flags, _fd in below[:3])


@pytest.mark.skipif(not WINDOWS, reason="held folder handles are the Windows implementation")
def test_a_held_folder_cannot_be_renamed_or_deleted_until_the_read_ends(namespace):
    settings = _settings(namespace, "instructions.md", b"kept\n").parent
    namespace_folder = settings.parent
    with _held_folders.held(data_root()) as anchor:
        held = anchor.child("repositories").child(namespace.identity.repository_id).child("settings")
        assert held is not None
        with pytest.raises(PermissionError):
            os.rename(settings, settings.with_name("settings-moved"))
        with pytest.raises(PermissionError):
            os.rename(namespace_folder, namespace_folder.with_name("moved"))
    os.rename(settings, settings.with_name("settings-moved"))  # released when the read ends
    os.rename(settings.with_name("settings-moved"), settings)


@pytest.mark.skipif(not WINDOWS, reason="junctions and reparse tags are Windows'")
def test_a_junction_is_opened_as_itself_never_as_its_target(namespace, decoy):
    folder = namespace.fix_modes_dir(create=True)
    _plant("junction", folder / "junction.json", decoy)
    with _held_folders.held(data_root()) as anchor:
        held = anchor
        for part in ("repositories", namespace.identity.repository_id, "settings", "fix_modes"):
            held = held.child(part)
        assert held.open_file("junction.json").kind == "link"
        with pytest.raises(_held_folders.Refused) as refused:
            held.child("junction.json")
        assert refused.value.reason == "link"
        assert sorted(held.names()) == ["junction.json"]


@pytest.mark.skipif(not WINDOWS, reason="reparse tags are Windows'")
@pytest.mark.parametrize(
    "attributes, tag, kind",
    [
        (0x410, 0xA0000003, "link"),  # a junction (mount point)
        (0x420, 0xA000000C, "link"),  # a symbolic link
        (0x420, 0x00000000, "link"),  # a reparse point whose tag cannot be read: judged a link, as is_link_stat does
        (0x420, 0x80000017, "reparse"),  # a tag that is no name surrogate (WOF): not read
        (0x410, 0x9000001A, "reparse"),  # a cloud placeholder: not read
        (0x10, 0, "folder"),
        (0x20, 0, "file"),
    ],
)
def test_reparse_points_are_judged_by_their_tag(attributes, tag, kind):
    assert _held_folders._kind_of(attributes, tag) == kind


def test_a_file_being_read_does_not_stop_the_atomic_writer(namespace):
    path = _settings(namespace, "instructions.md", b"before\n")
    with _held_folders.held(data_root()) as anchor:
        held = anchor
        for part in ("repositories", namespace.identity.repository_id, "settings"):
            held = held.child(part)
        opened = held.open_file("instructions.md")
        assert opened.kind == "file"
        atomic_write_text(path, "after\n")  # BugPilot's own writer, while the file is open: it must not fail
        # POSIX renames over the open file, which keeps the bytes it had. Windows refuses a rename onto an open
        # file even when delete is shared, and the writer then writes in place (atomic_write_text's fallback),
        # as it does for a file Python's own open() holds, which shares no delete at all.
        assert opened.read(100) in ({b"before\n"} if POSIX else {b"before\n", b"after\r\n"})
    assert namespace.read_settings("instructions.md", limit=100).data.replace(b"\r\n", b"\n") == b"after\n"


@pytest.mark.skipif(not WINDOWS, reason="share modes are Windows'")
def test_a_file_in_use_is_a_failure_naming_no_path_never_absent(namespace, repo):
    import _winapi

    path = _settings(namespace, "verification.md", b"locked\n")
    handle = _winapi.CreateFile(str(path), _winapi.GENERIC_READ, 0, 0, _winapi.OPEN_EXISTING, 0, 0)  # no sharing
    try:
        evidence = _exclusive_lock_evidence(path)  # while the lock is held, before the read under test
        try:
            outcome = namespace.read_settings("verification.md", limit=100)
        except Exception as error:  # noqa: BLE001 - judged below, with the evidence
            outcome = error
    finally:
        _winapi.CloseHandle(handle)
    found = _described(outcome, b"locked\n")
    assert not evidence.startswith("open() opened"), f"invalid setup, the lock did not stop open(): {evidence}; {found}"
    assert isinstance(outcome, storage.StorageFileReadError), (
        f"the reader did not refuse the locked file: {found}; {evidence}"
    )
    failed = outcome
    # The file itself (M2): the original's class and number, the standard text Python's own open gave, no path.
    assert isinstance(failed.error, PermissionError) and failed.errno == errno.EACCES
    assert failed.strerror == os.strerror(errno.EACCES) and failed.filename is None
    _assert_no_absolute_path(str(failed), repo)
    assert namespace.read_settings("verification.md", limit=100) == SettingsContent("present", b"locked\n")


def _exclusive_lock_evidence(path: Path) -> str:
    """While another handle holds ``path`` exclusively: what an ordinary open and the reader's own Win32 open get.

    Diagnostics for the Windows CI failures of run 39892585420, as one line for a public annotation. Each probe that
    opens the file closes it at once; the exclusive handle is left as it was. The reader's open is made as it makes
    it (``_held_folders._create``, the long form, ``GENERIC_READ``, sharing read, write and delete), with and without
    ``FILE_FLAG_BACKUP_SEMANTICS``.
    """
    import ctypes
    import platform

    try:
        with open(path, "rb"):
            plain = "opened"
    except OSError as error:
        plain = f"refused ({type(error).__name__})"
    probes = []
    for label, flags in (("reader flags", _held_folders._BACKUP_SEMANTICS | _held_folders._OPEN_REPARSE_POINT),
                         ("without backup semantics", _held_folders._OPEN_REPARSE_POINT)):
        try:
            probe = _held_folders._create(_held_folders._extended(os.path.abspath(path)), _held_folders._GENERIC_READ,
                                          _held_folders._SHARE_FILE, flags)
        except OSError as error:
            probes.append(f"{label} refused (winerror {getattr(error, 'winerror', None)})")
        else:
            _held_folders._close(probe)
            probes.append(f"{label} opened")
    file_system = ctypes.create_unicode_buffer(64)
    drive = os.path.splitdrive(os.path.abspath(path))[0] + "\\"
    known = ctypes.windll.kernel32.GetVolumeInformationW(drive, None, 0, None, None, None, file_system, 64)
    return (f"open() {plain}; CreateFileW {', '.join(probes)}; python {platform.python_version()}; "
            f"{platform.platform()}; file system {file_system.value if known else 'unknown'}")


def _described(outcome: object, fixture: bytes) -> str:
    """What a read under test gave, without its contents: a state and a size, or an error's class and numbers."""
    if isinstance(outcome, SettingsContent):
        match = "matches" if outcome.data == fixture else "differs from"
        return f"read returned {outcome.state} ({len(outcome.data)} bytes; {match} the fixture)"
    if isinstance(outcome, BaseException):
        return (f"read raised {type(outcome).__name__} (errno {getattr(outcome, 'errno', None)}, "
                f"winerror {getattr(outcome, 'winerror', None)})")
    return f"read returned {type(outcome).__name__}"


# --- Windows: a file's data opened without backup semantics (run 39989051086) ----------------------------------


@pytest.mark.skipif(not WINDOWS, reason="CreateFileW's flags are Windows'")
def test_a_files_data_is_opened_without_backup_semantics_and_every_folder_keeps_them(namespace, monkeypatch):
    # With FILE_FLAG_BACKUP_SEMANTICS, a runner holding the backup privilege opened a file another program held
    # exclusively. Only opens that never reach a file's data keep the flag: folders, and the look at an entry that
    # could not be opened for its data, which asks for its attributes alone.
    _settings(namespace, "instructions.md", b"kept\n")
    namespace.settings_file("verification.md", create=True).mkdir()
    real_create = _held_folders._create
    opened = []

    def create(path, access, share, flags, *, audited=None):
        opened.append((os.path.basename(path), access, share, flags))
        return real_create(path, access, share, flags, audited=audited)

    monkeypatch.setattr(_held_folders, "_create", create)
    assert namespace.read_settings("instructions.md", limit=100) == SettingsContent("present", b"kept\n")
    assert namespace.read_settings("verification.md", limit=100) == SettingsContent("not_a_file")
    folder = _held_folders._FILE_LIST_DIRECTORY | _held_folders._FILE_READ_ATTRIBUTES | _held_folders._SYNCHRONIZE
    look = _held_folders._FILE_READ_ATTRIBUTES | _held_folders._SYNCHRONIZE
    data = [entry for entry in opened if entry[1] == _held_folders._GENERIC_READ]
    assert {name for name, *_ in data} == {"instructions.md", "verification.md", storage.RECORD_NAME}
    assert all(
        (share, flags) == (_held_folders._SHARE_FILE, _held_folders._OPEN_REPARSE_POINT) for _, _, share, flags in data
    )
    folders = [entry for entry in opened if entry[1] == folder]
    assert folders and all(
        share == _held_folders._SHARE_HOLD and flags & _held_folders._BACKUP_SEMANTICS for _, _, share, flags in folders
    )
    # Only the folder at a file's name was looked at, after its data open failed, and never for its data.
    looks = [entry for entry in opened if entry[1] == look]
    both = _held_folders._BACKUP_SEMANTICS | _held_folders._OPEN_REPARSE_POINT
    assert looks == [("verification.md", look, _held_folders._SHARE_FILE, both)]
    assert len(opened) == len(data) + len(folders) + len(looks)


@pytest.mark.skipif(not WINDOWS, reason="share modes are Windows'")
@pytest.mark.parametrize("look", ["finds nothing", "fails"])
def test_a_file_in_use_stays_the_opens_own_failure_whatever_the_look_at_it_gives(namespace, monkeypatch, look):
    import _winapi

    monkeypatch.setattr(storage, "_TRANSIENT_DELAY", 0)
    path = _settings(namespace, "verification.md", b"locked\n")
    real_create = _held_folders._create
    looked = []

    def create(path, access, share, flags, *, audited=None):
        if access == _held_folders._FILE_READ_ATTRIBUTES | _held_folders._SYNCHRONIZE:
            looked.append(os.path.basename(path))
            code = 2 if look == "finds nothing" else 5  # ERROR_FILE_NOT_FOUND, ERROR_ACCESS_DENIED
            raise OSError(None, "injected", None, code)
        return real_create(path, access, share, flags, audited=audited)

    monkeypatch.setattr(_held_folders, "_create", create)
    handle = _winapi.CreateFile(str(path), _winapi.GENERIC_READ, 0, 0, _winapi.OPEN_EXISTING, 0, 0)  # no sharing
    try:
        with pytest.raises(storage.StorageFileReadError) as failed:
            namespace.read_settings("verification.md", limit=100)  # never "absent"
    finally:
        _winapi.CloseHandle(handle)
    assert looked and set(looked) == {"verification.md"}
    assert isinstance(failed.value.error, PermissionError) and failed.value.error.winerror == 32  # in use
    assert failed.value.filename is None


# --- M3-R2A: the final-path check (F1) and a held folder's own failure (F2) -------------------------------------

_SETTINGS_FINAL = r"\\?\C:\data\repositories\checkout-0123456789abcdef\settings"


@pytest.mark.parametrize(
    "child, parent, inside",
    [
        (_SETTINGS_FINAL + r"\instructions.md", _SETTINGS_FINAL, True),
        (_SETTINGS_FINAL + r"\Instructions.MD", _SETTINGS_FINAL, True),  # the entry in its own case on disk
        (_SETTINGS_FINAL.replace("settings", "Settings") + r"\instructions.md", _SETTINGS_FINAL, False),
        (_SETTINGS_FINAL + r"2\instructions.md", _SETTINGS_FINAL, False),  # a sibling folder sharing the prefix
        (_SETTINGS_FINAL + r"\nested\instructions.md", _SETTINGS_FINAL, False),
        (_SETTINGS_FINAL + r"\verification.md", _SETTINGS_FINAL, False),
        (_SETTINGS_FINAL.replace("C:", "D:") + r"\instructions.md", _SETTINGS_FINAL, False),
        (_SETTINGS_FINAL, _SETTINGS_FINAL, False),  # the folder itself
        (r"\\?\C:\instructions.md", "\\\\?\\C:\\", True),  # a folder at a volume's root
    ],
)
def test_the_final_path_check_takes_the_folders_part_exactly_and_folds_only_the_name(child, parent, inside):
    # The third case is what folding the whole path accepted: another folder whose name differs only in case.
    assert _held_folders._directly_inside(child, parent, "instructions.md") is inside


@pytest.mark.skipif(not WINDOWS, reason="final paths are Windows'")
@pytest.mark.parametrize("elsewhere", ["another folder", "this folder's name in another case"])
def test_an_entry_whose_final_path_is_not_directly_in_the_held_folder_is_refused_as_moved(namespace, monkeypatch,
                                                                                          elsewhere):
    _settings(namespace, "instructions.md", b"kept\n")
    real_final_path = _held_folders._final_path
    with _held_folders.held(data_root()) as anchor:
        folder = anchor
        for part in ("repositories", namespace.identity.repository_id, "settings"):
            folder = folder.child(part)
        own = real_final_path(folder._handle)
        above, name = os.path.split(own)
        reported = os.path.join(above, "elsewhere" if elsewhere == "another folder" else name.upper())

        def final_path(handle):  # the entry's own final path names another folder; the held folder's is its own
            found = real_final_path(handle)
            return reported + found[len(own):] if handle != folder._handle and found.startswith(own + "\\") else found

        monkeypatch.setattr(_held_folders, "_final_path", final_path)
        before = _open_handles()
        with pytest.raises(_held_folders.Refused) as refused:
            folder.open_file("instructions.md")
        assert refused.value.reason == "moved"
        assert _open_handles() == before  # the entry's handle is closed before the refusal


@pytest.mark.skipif(not WINDOWS, reason="final paths are Windows'")
@pytest.mark.parametrize("entry", ["instructions.md", "absent.md"])
def test_a_held_folder_whose_final_path_reads_differently_after_an_open_is_refused_as_moved(namespace, monkeypatch,
                                                                                           entry):
    # After an open that found the entry, and after one that found nothing (never "absent" then). The second
    # reading differs only in case: the same folder for a folded comparison, another one for an exact one.
    _settings(namespace, "instructions.md", b"kept\n")
    real_final_path = _held_folders._final_path
    with _held_folders.held(data_root()) as anchor:
        folder = anchor
        for part in ("repositories", namespace.identity.repository_id, "settings"):
            folder = folder.child(part)
        own = real_final_path(folder._handle)
        reads = []

        def final_path(handle):
            if handle != folder._handle:
                return real_final_path(handle)
            reads.append(handle)
            return own if len(reads) == 1 else own[: -len("settings")] + "SETTINGS"

        monkeypatch.setattr(_held_folders, "_final_path", final_path)
        with pytest.raises(_held_folders.Refused) as refused:
            folder.open_file(entry)
        assert refused.value.reason == "moved" and len(reads) == 2


@pytest.mark.skipif(not WINDOWS, reason="final paths are Windows'")
def test_a_settings_file_reported_in_another_folder_fails_every_reader_never_the_defaults(namespace, repo,
                                                                                         monkeypatch):
    _settings(namespace, "instructions.md", b"kept\n")
    _settings(namespace, "project_settings.json", b"{}")
    _settings(namespace, "repository_profile.json", b"{}")
    real_final_path = _held_folders._final_path
    redirected = []

    def final_path(handle):  # each settings file reports itself under a sibling folder of the same name's prefix
        found = real_final_path(handle)
        above, name = os.path.split(found)
        if os.path.basename(above) == "settings" and name in SETTINGS_NAMES:
            redirected.append(name)
            return os.path.join(above + "2", name)
        return found

    monkeypatch.setattr(_held_folders, "_final_path", final_path)
    with pytest.raises(StorageError) as held:
        namespace.read_settings("instructions.md", limit=100)
    assert "instructions.md changed while it was being read" in str(held.value)
    _assert_no_absolute_path(str(held.value), repo)
    for read in (lambda: read_instructions("project", repo), lambda: load_project_settings(repo),
                 lambda: load_repository_profile(repo)):
        with pytest.raises(StorageError):
            read()  # a refusal, never a warning and the defaults
    assert {"instructions.md", "project_settings.json", "repository_profile.json"} <= set(redirected)


def _fail_the_folder_holding(monkeypatch, file_name: str, code: int) -> list[int]:
    """From the moment ``file_name`` is opened in a held folder, that folder's own final-path query fails with
    Windows error ``code`` (the internal handle-query boundary, ``_held_folders._final_path``). Returns the
    folder handles the failure fired for."""
    import ctypes

    real_open_file, real_final_path = _held_folders._WindowsFolder.open_file, _held_folders._final_path
    holders: set[int] = set()
    fired: list[int] = []

    def open_file(self, name):
        if name == file_name:
            holders.add(self._handle)
        return real_open_file(self, name)

    def final_path(handle):
        if handle in holders:
            fired.append(handle)
            raise ctypes.WinError(code)
        return real_final_path(handle)

    monkeypatch.setattr(_held_folders._WindowsFolder, "open_file", open_file)
    monkeypatch.setattr(_held_folders, "_final_path", final_path)
    return fired


@pytest.mark.skipif(not WINDOWS, reason="handle queries are Windows'")
@pytest.mark.parametrize("code", [5, 1117])  # ERROR_ACCESS_DENIED (a PermissionError), ERROR_IO_DEVICE
def test_a_held_folder_whose_own_handle_cannot_be_queried_fails_as_the_folder_never_as_the_file(namespace,
                                                                                               monkeypatch, code):
    monkeypatch.setattr(storage, "_TRANSIENT_DELAY", 0)
    _settings(namespace, "instructions.md", b"kept\n")
    fired = _fail_the_folder_holding(monkeypatch, "instructions.md", code)
    with pytest.raises(OSError) as failed:
        namespace.read_settings("instructions.md", limit=100)
    assert fired
    assert not isinstance(failed.value, (storage.StorageFileReadError, _held_folders.FolderFailed))
    assert failed.value.winerror == code and failed.value.filename is None  # the query's own error, as any folder's


@pytest.mark.skipif(not WINDOWS, reason="handle queries are Windows'")
def test_a_namespace_whose_own_handle_cannot_be_queried_fails_as_the_folder_never_as_a_corrupt_record(namespace,
                                                                                                    monkeypatch):
    _settings(namespace, "instructions.md", b"kept\n")
    fired = _fail_the_folder_holding(monkeypatch, storage.RECORD_NAME, 1117)
    with pytest.raises(OSError) as failed:
        namespace.read_settings("instructions.md", limit=100)
    assert fired
    assert not isinstance(failed.value, (StorageError, storage.StorageFileReadError, _held_folders.FolderFailed))
    assert failed.value.winerror == 1117 and failed.value.filename is None


_FOLDER_FAILURE_READERS = {
    "project instructions": ("instructions.md", lambda repo: read_instructions("project", repo)),
    "user instructions": ("instructions.md", lambda repo: read_instructions("user", repo)),
    "project settings": ("project_settings.json", load_project_settings),
    "repository profile": ("repository_profile.json", load_repository_profile),
    "fix modes": ("triage.json", fix_mode_store.catalog_for),
    "config.toml": ("config.toml", lambda repo: user_config._read_config()),
}


@pytest.mark.skipif(not WINDOWS, reason="handle queries are Windows'")
@pytest.mark.parametrize("reader", list(_FOLDER_FAILURE_READERS))
def test_a_held_folder_query_failure_fails_each_consumer_in_one_sentence_never_the_defaults(
    namespace, user_config_folder, repo, monkeypatch, reader
):
    monkeypatch.setattr(storage, "_TRANSIENT_DELAY", 0)
    file_name, read = _FOLDER_FAILURE_READERS[reader]
    if reader in ("user instructions", "config.toml"):
        (user_config_folder / file_name).write_bytes(b"kept\n")
    elif reader == "fix modes":
        (namespace.fix_modes_dir(create=True) / file_name).write_bytes(b"{}")
    else:
        _settings(namespace, file_name, b"{}" if file_name.endswith(".json") else b"kept\n")
    fired = _fail_the_folder_holding(monkeypatch, file_name, 1117)
    with pytest.raises(StorageAccessError) as failed:
        read(repo)  # fatal: no warning with the defaults, no problem, no Fix Mode issue
    assert fired
    assert str(failed.value).startswith("BugPilot could not read ") and "(OSError)" in str(failed.value)
    _assert_no_absolute_path(str(failed.value), repo)


@pytest.mark.skipif(not WINDOWS, reason="handle queries are Windows'")
def test_the_files_own_final_path_query_failing_stays_the_files_failure(namespace, repo, monkeypatch):
    # Only the held folder's own queries are the folder's: a query of the entry's handle is the file's (F2's bound).
    import ctypes

    _settings(namespace, "instructions.md", b"kept\n")
    real_create, real_final_path, real_close = _held_folders._create, _held_folders._final_path, _held_folders._close
    data_handles: set[int] = set()

    def create(path, access, share, flags, *, audited=None):
        handle = real_create(path, access, share, flags, audited=audited)
        if access == _held_folders._GENERIC_READ and path.endswith("\\instructions.md"):
            data_handles.add(handle)
        return handle

    def final_path(handle):
        if handle in data_handles:
            raise ctypes.WinError(1117)
        return real_final_path(handle)

    def close(handle):
        # Windows reuses a closed handle's value: a folder opened later must not inherit the file's failure.
        data_handles.discard(handle)
        real_close(handle)

    monkeypatch.setattr(_held_folders, "_create", create)
    monkeypatch.setattr(_held_folders, "_final_path", final_path)
    monkeypatch.setattr(_held_folders, "_close", close)
    with pytest.raises(storage.StorageFileReadError) as failed:
        namespace.read_settings("instructions.md", limit=100)
    assert failed.value.error.winerror == 1117 and failed.value.filename is None
    found = read_instructions("project", repo)  # the file's own failure keeps the reader's handling: a problem
    assert found.text == "" and found.problem.startswith("it could not be read (")


# --- M2: the file's own failure, told apart from a folder's -----------------------------------------------

_FOLDER_CLASS = _held_folders._WindowsFolder if WINDOWS else _held_folders._PosixFolder


def test_only_the_files_own_failure_is_a_file_read_error(namespace, user_config_folder, monkeypatch):
    monkeypatch.setattr(storage, "_TRANSIENT_DELAY", 0)
    _settings(namespace, "instructions.md", b"kept\n")
    (namespace.fix_modes_dir(create=True) / "triage.json").write_bytes(b"{}")
    real_open_file, real_child = _FOLDER_CLASS.open_file, _FOLDER_CLASS.child

    def open_file(self, name):
        if name in ("instructions.md", "triage.json"):
            raise OSError(errno.EIO, "Input/output error")
        return real_open_file(self, name)

    monkeypatch.setattr(_FOLDER_CLASS, "open_file", open_file)
    for read in (lambda: namespace.read_settings("instructions.md", limit=100),
                 lambda: namespace.read_fix_mode("triage.json", limit=None)):
        with pytest.raises(storage.StorageFileReadError) as failed:
            read()
        assert (failed.value.errno, failed.value.strerror) == (errno.EIO, os.strerror(errno.EIO))
        assert type(failed.value.error) is OSError and failed.value.filename is None
    monkeypatch.setattr(_FOLDER_CLASS, "open_file", real_open_file)

    def child(self, name):
        if name == "settings":
            raise PermissionError(errno.EACCES, "Permission denied")
        return real_child(self, name)

    monkeypatch.setattr(_FOLDER_CLASS, "child", child)
    for read in (lambda: namespace.read_settings("instructions.md", limit=100), namespace.fix_mode_names):
        with pytest.raises(PermissionError) as failed:
            read()
        assert not isinstance(failed.value, storage.StorageFileReadError)  # a folder on the way: never the file's


def test_a_file_in_use_is_retried_before_it_fails(namespace, monkeypatch):
    monkeypatch.setattr(storage, "_TRANSIENT_DELAY", 0)
    _settings(namespace, "instructions.md", b"kept\n")
    real_open_file = _FOLDER_CLASS.open_file
    attempts = []

    def busy_twice(self, name):
        if name == "instructions.md" and len(attempts) < 2:
            attempts.append(name)
            raise PermissionError(errno.EACCES, "Permission denied")
        return real_open_file(self, name)

    monkeypatch.setattr(_FOLDER_CLASS, "open_file", busy_twice)
    assert namespace.read_settings("instructions.md", limit=100) == SettingsContent("present", b"kept\n")
    assert len(attempts) == 2


# --- M2: the data root opened by its long form; file systems that cannot answer -------------------------------


@pytest.mark.skipif(not WINDOWS, reason="MAX_PATH and the long form are Windows'")
def test_the_data_root_is_opened_by_its_long_form_and_audited_by_its_own(namespace, monkeypatch):
    _settings(namespace, "instructions.md", b"kept\n")
    real_create = _held_folders._create
    opened = []

    def create(path, access, share, flags, *, audited=None):
        opened.append((path, audited))
        return real_create(path, access, share, flags, audited=audited)

    monkeypatch.setattr(_held_folders, "_create", create)
    assert namespace.read_settings("instructions.md", limit=100).state == "present"
    anchor_path, anchor_audited = opened[0]
    assert anchor_path == _held_folders._EXTENDED_PREFIX + str(data_root())
    assert anchor_audited == str(data_root())  # what the test isolation guard compares


@pytest.mark.skipif(not WINDOWS, reason="MAX_PATH and the long form are Windows'")
def test_a_data_root_longer_than_max_path_is_read(tmp_path, repo, monkeypatch):
    deep = str(tmp_path)
    while len(deep) < 300:
        deep += "\\" + "d" * 40
    os.makedirs(_held_folders._EXTENDED_PREFIX + deep)
    monkeypatch.setenv("BUGPILOT_HOME", deep)
    storage._identities.clear()
    folder = _held_folders._EXTENDED_PREFIX + deep + "\\config"
    os.mkdir(folder)
    with open(folder + "\\instructions.md", "wb") as stream:
        stream.write(b"long\n")
    assert len(str(data_root())) > 260
    assert global_storage().read_user_instructions(limit=100) == SettingsContent("present", b"long\n")


@pytest.mark.skipif(not WINDOWS, reason="the data root's own open is Windows' CreateFileW")
def test_a_data_root_that_cannot_be_opened_is_a_failure_never_absent(namespace, monkeypatch):
    monkeypatch.setattr(storage, "_TRANSIENT_DELAY", 0)
    _settings(namespace, "instructions.md", b"kept\n")
    real_create = _held_folders._create

    def create(path, access, share, flags, *, audited=None):
        if audited is not None:  # the data root's own open
            raise OSError(None, "The filename or extension is too long.", None, 206)
        return real_create(path, access, share, flags, audited=audited)

    monkeypatch.setattr(_held_folders, "_create", create)
    for read in (lambda: namespace.read_settings("instructions.md", limit=100), global_storage().read_config):
        with pytest.raises(OSError) as failed:
            read()  # raised, never "absent": Python files a name too long under FileNotFoundError too
        assert failed.value.winerror == 206 and failed.value.filename is None
        assert not isinstance(failed.value, storage.StorageFileReadError)
    from bugpilot.core import repository_settings
    from bugpilot.core.errors import StorageAccessError

    with pytest.raises(StorageAccessError) as carried:  # a consumer's one sentence, never the defaults
        repository_settings.read_settings(namespace.identity.root, "instructions.md", limit=100)
    assert str(carried.value).startswith("BugPilot could not read ") and "(FileNotFoundError)" in str(carried.value)


class _Kernel32Without:
    """kernel32, with one function failing as a file system that cannot answer it fails."""

    def __init__(self, real, name: str, code: int) -> None:
        self._real, self._name, self._code = real, name, code

    def __getattr__(self, attribute):
        if attribute != self._name:
            return getattr(self._real, attribute)

        def failing(*_args):
            import ctypes

            ctypes.set_last_error(self._code)
            return 0

        return failing


@pytest.mark.skipif(not WINDOWS, reason="handle queries are Windows'")
@pytest.mark.parametrize("function", ["GetFileInformationByHandleEx", "GetFinalPathNameByHandleW"])
@pytest.mark.parametrize("code", [1, 50, 87])
def test_a_file_system_that_cannot_answer_a_handle_query_is_refused(namespace, user_config_folder, monkeypatch,
                                                                     function, code):
    _settings(namespace, "instructions.md", b"kept\n")
    monkeypatch.setattr(_held_folders, "_KERNEL32", _Kernel32Without(_held_folders._KERNEL32, function, code))
    for read in (lambda: namespace.read_settings("instructions.md", limit=100), global_storage().read_config,
                 namespace.fix_mode_names):
        with pytest.raises(StorageError) as refused:
            read()
        assert str(refused.value).startswith("BugPilot cannot read its data folder safely on this system")


@pytest.mark.skipif(not WINDOWS, reason="handle queries are Windows'")
def test_any_other_failed_handle_query_stays_the_systems_error(namespace, monkeypatch):
    monkeypatch.setattr(storage, "_TRANSIENT_DELAY", 0)
    _settings(namespace, "instructions.md", b"kept\n")
    monkeypatch.setattr(_held_folders, "_KERNEL32",
                        _Kernel32Without(_held_folders._KERNEL32, "GetFileInformationByHandleEx", 5))
    with pytest.raises(PermissionError) as failed:
        namespace.read_settings("instructions.md", limit=100)
    assert failed.value.winerror == 5 and failed.value.filename is None


def test_plain_names_exclude_separators_dots_and_streams():
    assert _held_folders.plain_name("instructions.md") and _held_folders.plain_name(".json")
    for name in ("", ".", "..", "a/b", "a\\b", "a\0b"):
        assert not _held_folders.plain_name(name), name
    assert _held_folders.plain_name("a:b.json") is (not WINDOWS)


# --- POSIX permission bits: folders without read or search, a file without read --------------------------------

#: Permission bits decide these cases only on POSIX, and only for an account they bind: a privileged account passes
#: every check and is skipped here; any other account the bits do not bind is skipped when the case is set up.
_POSIX_BITS = pytest.mark.skipif(
    not POSIX or getattr(os, "geteuid", lambda: 0)() == 0,
    reason="permission bits decide access only on POSIX, and only for an unprivileged account",
)


@contextlib.contextmanager
def _mode(path: Path, mode: int):
    """``path`` with ``mode`` for the block, and its own mode back afterwards, before anything is cleaned up."""
    before = stat.S_IMODE(os.lstat(path).st_mode)
    os.chmod(path, mode)
    try:
        yield
    finally:
        os.chmod(path, before)


def _denied(action) -> None:
    """Go on only if the bits just set really deny ``action`` here: where they do not, the case proves nothing."""
    try:
        action()
    except PermissionError:
        return
    pytest.skip("the permission bits are not enforced for this account or file system")


def _assert_a_folder_failure(error: BaseException, *places: Path) -> None:
    """One fatal sentence about a folder that cannot be read, in display form: never the defaults or a warning."""
    message = str(error)
    assert isinstance(error, StorageAccessError), (type(error), message)
    assert message.startswith("BugPilot could not read ") and "(PermissionError)" in message, message
    _assert_no_absolute_path(message, *places)


@_POSIX_BITS
def test_posix_a_search_only_folder_fails_every_read_never_the_defaults(namespace, repo, monkeypatch):
    """Case A: search permission without read. Each folder is opened, which takes read permission (decision 5.2)."""
    monkeypatch.setattr(storage, "_TRANSIENT_DELAY", 0)
    settings = _settings(namespace, "instructions.md", b"kept\n").parent
    _settings(namespace, "project_settings.json", b"{}")
    with _mode(settings, 0o100):
        _denied(lambda: os.listdir(settings))
        with pytest.raises(PermissionError) as failed:
            namespace.read_settings("instructions.md", limit=100)
        assert not isinstance(failed.value, storage.StorageFileReadError)  # the folder's failure, never "absent"
        for read in (lambda: read_instructions("project", repo), lambda: load_project_settings(repo)):
            with pytest.raises(StorageAccessError) as raised:
                read()
            _assert_a_folder_failure(raised.value, repo)


@_POSIX_BITS
def test_posix_a_folder_that_can_be_read_but_not_searched_fails_every_reader(
    namespace, repo, user_config_folder, monkeypatch
):
    """Case B: read permission without search. The folder opens and lists, but nothing in it can even be looked at:
    the folder's failure (owner decision), fatal for every reader, never a file's warning, the defaults or a Fix
    Mode issue."""
    monkeypatch.setattr(storage, "_TRANSIENT_DELAY", 0)
    settings = _settings(namespace, "instructions.md", b"kept\n").parent
    _settings(namespace, "project_settings.json", b"{}")
    _settings(namespace, "repository_profile.json", b'{"mode": "generic"}')
    fix_modes = namespace.fix_modes_dir(create=True)
    (fix_modes / "team.json").write_bytes(b"{}")
    global_storage().user_instructions_file(create=True).write_bytes(b"mine\n")
    global_storage().config_file(create=False).write_bytes(b'jira_base_url = "https://jira.example.invalid"\n')

    with _mode(settings, 0o400):
        _denied(lambda: os.stat(settings / "instructions.md"))
        assert "instructions.md" in os.listdir(settings)  # readable: this is case B, not case A
        with pytest.raises(PermissionError) as failed:
            namespace.read_settings("instructions.md", limit=100)
        assert type(failed.value) is PermissionError  # a folder's plain failure: not the file's, not the marker
        for read in (lambda: read_instructions("project", repo), lambda: load_project_settings(repo),
                     lambda: load_repository_profile(repo)):
            with pytest.raises(StorageAccessError) as raised:
                read()
            _assert_a_folder_failure(raised.value, repo)

    with _mode(fix_modes, 0o400):
        _denied(lambda: os.stat(fix_modes / "team.json"))
        assert namespace.fix_mode_names() == ["team.json"]  # listed, as the folder is readable
        with pytest.raises(PermissionError) as failed:
            namespace.read_fix_mode("team.json", limit=None)
        assert type(failed.value) is PermissionError
        with pytest.raises(StorageAccessError) as raised:
            fix_mode_store.catalog_for(repo)  # fatal for the catalog: never one issue among the modes
        _assert_a_folder_failure(raised.value, repo)

    with _mode(user_config_folder, 0o400):
        _denied(lambda: os.stat(user_config_folder / "instructions.md"))
        for read in (lambda: read_instructions("user", repo), user_config._read_config):
            with pytest.raises(StorageAccessError) as raised:
                read()
            _assert_a_folder_failure(raised.value, repo)


@_POSIX_BITS
def test_posix_a_file_that_cannot_be_read_keeps_each_readers_handling(namespace, repo, user_config_folder, monkeypatch):
    """Case C: the folder can be searched, the file cannot be read: the file's own failure, as before. A warning or
    an issue for the settings readers and the Fix Modes; one fatal sentence for ``config.toml``."""
    monkeypatch.setattr(storage, "_TRANSIENT_DELAY", 0)
    instructions = _settings(namespace, "instructions.md", b"kept\n")
    project = _settings(namespace, "project_settings.json", b"{}")
    mode_file = namespace.fix_modes_dir(create=True) / "team.json"
    mode_file.write_bytes(b"{}")
    config = global_storage().config_file(create=False)
    config.write_bytes(b'jira_base_url = "https://jira.example.invalid"\n')

    with _mode(instructions, 0o000), _mode(project, 0o000), _mode(mode_file, 0o000), _mode(config, 0o000):
        _denied(instructions.read_bytes)
        with pytest.raises(storage.StorageFileReadError) as failed:
            namespace.read_settings("instructions.md", limit=100)
        reason = failed.value.strerror  # the system's own words for its own error, whatever its number
        assert reason == os.strerror(failed.value.errno) and failed.value.filename is None
        assert read_instructions("project", repo).problem == f"it could not be read ({reason})."
        assert load_project_settings(repo) == (
            ProjectSettings(), [f"{storage.display_path(project)} could not be read ({reason}). Using the defaults."]
        )
        catalog = fix_mode_store.catalog_for(repo)
        assert [(issue.scope, issue.message) for issue in catalog.issues] == [
            ("project", f"team.json could not be read: {reason}.")
        ]
        with pytest.raises(StorageAccessError) as raised:
            user_config._read_config()
        assert str(raised.value) == (
            f"BugPilot could not read {storage.display_path(config)} (PermissionError). "
            "Check that folder's permissions and free space, then try again."
        )
