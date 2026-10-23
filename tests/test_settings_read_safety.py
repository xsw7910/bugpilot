"""Settings read through storage's held folders, by every consumer (0.1.6, Option C, M2).

The consumer migration of Option C: project and user instructions, project settings,
the Repository Profile, project and user Fix Modes, and ``config.toml`` take a file's
bytes from storage (``SettingsContent``), never a path they open themselves. These
tests hold, on synthetic files in each test's own data folder:

- legitimate files read exactly as before; nothing there is the defaults and creates nothing;
- the file's own failure keeps each reader's handling (a warning, an issue, the defaults;
  for ``config.toml``, one sentence), while a folder on the way that cannot be read fails
  the command;
- refusals stay refusals, never the defaults, and name places in display form only;
- no bare ``OSError`` reaches the CLI or an MCP tool;
- a Fix Mode listed and gone before it is read keeps its issue, and every link among the
  Fix Modes is one issue, never followed.

Links are planted before a read and stay as they are, and failures are injected at the
held-folder seam (the folder class's ``child`` and ``open_file``). Nothing here swaps a
file or a folder while a read runs: the adversarial link-race suite is a separate gate
(M3), and this file is no evidence that the race is closed.
"""

from __future__ import annotations

import asyncio
import errno
import json
import os
from pathlib import Path

import pytest

from bugpilot import cli_json
from bugpilot.cli import main
from bugpilot.core import _held_folders, fix_mode_store, project_settings, repository_settings, storage, user_config
from bugpilot.core.errors import StorageAccessError
from bugpilot.core.fix_mode_store import FixModeStore, custom_mode_payload
from bugpilot.core.fix_modes import FixModeNotFoundError, builtin_fix_mode_registry
from bugpilot.core.instructions import read_instructions
from bugpilot.core.project_settings import load_project_settings
from bugpilot.core.repository_profile import load_repository_profile
from bugpilot.core.safe_paths import decode_text
from bugpilot.core.storage import StorageError, StorageIdentityError

WINDOWS = os.name == "nt"
LINK_KINDS = ["symlink"] + (["junction"] if WINDOWS else [])
#: The folder class storage holds on this system: the seam every injection below goes through.
FOLDER_CLASS = _held_folders._WindowsFolder if WINDOWS else _held_folders._PosixFolder
SENTINEL = "decoy content no read may return"
#: The owner-approved issue for a link among a storage-owned scope's Fix Modes (DD-27) and for one mode read by its
#: id that is such a link (DD-28), written out here, never taken from the code: a change of wording fails these tests.
APPROVED_LINK_ISSUE = (
    "{name} is a symbolic link or junction. Custom Fix Modes must be real files inside their scope directory."
)
#: DD-28's cases: a link to a sibling inside the Fix Mode folder, which `mode_path`'s containment check lets through.
IN_FOLDER_LINKS = ["to-sibling-file", "to-sibling-folder", "dangling-sibling"] + (
    ["junction-sibling"] if WINDOWS else []
)

#: Every consumer, as one call on a prepared repository.
READERS = {
    "project instructions": lambda repo: read_instructions("project", repo),
    "user instructions": lambda repo: read_instructions("user", repo),
    "project settings": load_project_settings,
    "repository profile": load_repository_profile,
    "fix modes": fix_mode_store.catalog_for,
    "config.toml": lambda repo: user_config._read_config(),
}


@pytest.fixture(autouse=True)
def no_retry_delay(monkeypatch):
    """An injected permission error is retried as a file in use is: without the waits."""
    monkeypatch.setattr(storage, "_TRANSIENT_DELAY", 0)


@pytest.fixture
def decoy(tmp_path: Path) -> Path:
    """Where a planted link points: files no read may return."""
    target = tmp_path / "decoy"
    target.mkdir()
    for name in ("instructions.md", "project_settings.json", "repository_profile.json", "config.toml", "inner.json"):
        (target / name).write_text(SENTINEL, encoding="utf-8")
    return target


def _repo(root: Path) -> Path:
    (root / "src").mkdir(parents=True)
    (root / "src" / "app.py").write_text("def save(record):\n    return record['id']\n", encoding="utf-8")
    return root


def _settings(root: Path, name: str, text: str) -> Path:
    path = storage.repository_storage(root).settings_file(name, create=True)
    path.write_text(text, encoding="utf-8")
    return path


def _mode(mode_id: str) -> dict:
    payload = custom_mode_payload(builtin_fix_mode_registry().default)
    payload["id"] = mode_id
    payload["name"] = mode_id.replace("-", " ").title()
    return payload


def _shown(root: Path, name: str) -> str:
    return f"BUGPILOT_HOME/repositories/{storage.repository_identity(root).repository_id}/settings/{name}"


def _tree(root: Path) -> dict[str, bytes | None]:
    return {str(path): path.read_bytes() if path.is_file() else None for path in sorted(root.rglob("*"))}


def _no_absolute_path(text: str, *roots: Path) -> None:
    for root in (*roots, storage.data_root(), Path.home()):
        for spelling in (str(root), root.as_posix()):
            assert spelling not in text, (spelling, text)


def _prepare_every_file(repo: Path) -> None:
    _settings(repo, "instructions.md", "Keep changes small.\n")
    _settings(repo, "project_settings.json", json.dumps({"branch_naming": {"template": "fix/{issue}"}}))
    _settings(repo, "repository_profile.json", json.dumps({"mode": "custom", "custom": {"notes": "A parser."}}))
    (repository_settings.fix_modes_dir(repo, create=True) / "team.json").write_text(json.dumps(_mode("team")),
                                                                                   encoding="utf-8")
    user = storage.global_storage()
    user.user_instructions_file(create=True).write_text("Mine.\n", encoding="utf-8")
    (user.user_fix_modes_dir(create=True) / "mine.json").write_text(json.dumps(_mode("mine")), encoding="utf-8")
    user.config_file(create=False).write_text('jira_base_url = "https://jira.example.invalid"\n', encoding="utf-8")


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


def _fail_file(monkeypatch, *names: str) -> list[str]:
    """The held open of each named file fails with a permission error; the names, as each open failed."""
    real = FOLDER_CLASS.open_file
    failed: list[str] = []

    def open_file(self, name):
        if name in names:
            failed.append(name)
            raise PermissionError(errno.EACCES, "Permission denied")
        return real(self, name)

    monkeypatch.setattr(FOLDER_CLASS, "open_file", open_file)
    return failed


def _fail_folder(monkeypatch, name: str) -> list[str]:
    """Holding a folder called ``name`` fails with a permission error, wherever it is on the way."""
    real = FOLDER_CLASS.child
    failed: list[str] = []

    def child(self, part):
        if part == name:
            failed.append(part)
            raise PermissionError(errno.EACCES, "Permission denied")
        return real(self, part)

    monkeypatch.setattr(FOLDER_CLASS, "child", child)
    return failed


def _approved_link_issue(name: str) -> str:
    return APPROVED_LINK_ISSUE.format(name=name)


def _fix_modes_with(scope: str, repo: Path, case: str) -> tuple[Path, str]:
    """The scope's Fix Mode folder holding a real mode, a sibling folder and one entry of ``case``; its mode id.

    ``case`` is one of :data:`IN_FOLDER_LINKS` (planted before any read, never swapped), ``folder-entry`` (a real
    folder at a mode's name) or ``no-such-mode`` (nothing there).
    """
    if scope == "user":
        folder = storage.global_storage().user_fix_modes_dir(create=True)
    else:
        folder = repository_settings.fix_modes_dir(repo, create=True)
    (folder / "real.json").write_text(json.dumps(_mode("real")), encoding="utf-8")
    (folder / "sub").mkdir()
    entry = folder / f"{case}.json"
    if case == "to-sibling-file":
        _plant("symlink", entry, folder / "real.json")
    elif case == "to-sibling-folder":
        _plant("symlink", entry, folder / "sub")
    elif case == "dangling-sibling":
        try:
            os.symlink(folder / "missing.json", entry)
        except (OSError, NotImplementedError) as error:
            pytest.skip(f"symbolic links are not available here: {type(error).__name__}")
    elif case == "junction-sibling":
        _plant("junction", entry, folder / "sub")
    elif case == "folder-entry":
        entry.mkdir()
    return folder, case


# --- decoding as ``Path.read_text`` did ---------------------------------------------------------------


@pytest.mark.parametrize("raw, encoding, errors", [
    (b"a\r\nb\rc\n", "utf-8", "strict"),
    ("﻿{\"a\": \"é\"}\r\n".encode("utf-8"), "utf-8-sig", "strict"),
    (b"key = \"\xff\"\r\n", "utf-8", "replace"),
])
def test_decoded_text_is_what_path_read_text_gave(tmp_path: Path, raw, encoding, errors):
    path = tmp_path / "f.txt"
    path.write_bytes(raw)
    assert decode_text(raw, encoding, errors) == path.read_text(encoding=encoding, errors=errors)


def test_a_json_error_names_the_position_path_read_text_gave(tmp_path: Path):
    repo = _repo(tmp_path / "repo")
    raw = b'{\r\n  "branch_naming": oops\r\n}\r\n'
    storage.repository_storage(repo).settings_file("project_settings.json", create=True).write_bytes(raw)
    reference = tmp_path / "reference.json"
    reference.write_bytes(raw)
    with pytest.raises(ValueError) as expected:
        json.loads(reference.read_text(encoding="utf-8-sig"))
    _, warnings = load_project_settings(repo)
    assert warnings == [f"{_shown(repo, 'project_settings.json')} could not be read ({expected.value}). Using the defaults."]


# --- legitimate files, nothing there, nothing written ---------------------------------------------------


def test_legitimate_files_read_as_before_in_every_reader(tmp_path: Path):
    repo = _repo(tmp_path / "repo")
    _prepare_every_file(repo)
    _settings(repo, "instructions.md", "Keep changes small.\r\n")
    _settings(repo, "project_settings.json", "﻿" + json.dumps({"branch_naming": {"template": "fix/{issue}"}}))
    assert read_instructions("project", repo).text == "Keep changes small."
    assert read_instructions("user", repo).text == "Mine."
    settings, warnings = load_project_settings(repo)
    assert (settings.branch_template, warnings) == ("fix/{issue}", [])
    profile, warnings = load_repository_profile(repo)
    assert (profile.mode, profile.custom.notes, warnings) == ("custom", "A parser.", [])
    catalog = fix_mode_store.catalog_for(repo)
    assert [mode.id for mode in catalog.project] == ["team"] and [mode.id for mode in catalog.user] == ["mine"]
    assert catalog.issues == ()
    assert FixModeStore(repo).read("project", "team").id == "team"
    assert FixModeStore(repo).read("user", "mine").id == "mine"
    assert user_config._read_config() == {"jira_base_url": "https://jira.example.invalid"}


def test_malformed_content_keeps_its_existing_warning(tmp_path: Path):
    repo = _repo(tmp_path / "repo")
    _settings(repo, "project_settings.json", "{not json")
    _settings(repo, "repository_profile.json", "[]")
    settings, warnings = load_project_settings(repo)
    assert settings.branch_template == ""
    assert warnings[0].startswith(f"{_shown(repo, 'project_settings.json')} could not be read (")
    profile, warnings = load_repository_profile(repo)
    assert profile.mode == "generic"
    assert warnings == [f"{_shown(repo, 'repository_profile.json')} is not a JSON object. Using the Generic profile."]


def test_missing_files_are_the_defaults_and_create_nothing(tmp_path: Path):
    repo = _repo(tmp_path / "repo")
    before = _tree(storage.data_root())
    assert read_instructions("project", repo).text == "" and read_instructions("user", repo).text == ""
    settings, warnings = load_project_settings(repo)
    assert (settings.branch_template, warnings) == ("", [])
    profile, warnings = load_repository_profile(repo)
    assert (profile.mode, warnings) == ("auto", [])
    assert fix_mode_store.catalog_for(repo).project == ()
    assert user_config._read_config() == {}
    with pytest.raises(FixModeNotFoundError) as missing:
        FixModeStore(repo).read("project", "absent")
    assert str(missing.value) == "No project Fix Mode 'absent'. Run: bugpilot fix-mode list --all-scopes"
    assert _tree(storage.data_root()) == before
    assert not (storage.data_root() / "repositories").exists()


def test_reading_saved_files_writes_nothing(tmp_path: Path, monkeypatch, capsys):
    repo = _repo(tmp_path / "repo")
    _prepare_every_file(repo)
    before = _tree(storage.data_root())
    monkeypatch.chdir(repo)
    for argv in (["instructions", "show", "--json"], ["project-settings", "show", "--json"],
                 ["repository-profile", "show", "--json"], ["fix-mode", "list", "--json"]):
        assert main(argv) == 0, argv
    capsys.readouterr()
    assert _tree(storage.data_root()) == before


@pytest.mark.parametrize("case, saved", [
    ("absent", False),
    ("valid", True),
    ("malformed", False),
    ("a folder", False),
    ("too large", False),
    ("unreadable", False),
])
def test_saved_is_what_the_one_storage_read_found(tmp_path: Path, monkeypatch, case, saved):
    repo = _repo(tmp_path / "repo")
    path = storage.repository_storage(repo).settings_file("project_settings.json", create=True)
    if case == "valid":
        path.write_text(json.dumps({"branch_naming": {"template": "fix/{issue}"}}), encoding="utf-8")
    elif case == "malformed":
        path.write_text("{not json", encoding="utf-8")
    elif case == "a folder":
        path.mkdir()
    elif case == "too large":
        path.write_bytes(b" " * (64 * 1024 + 1))
    elif case == "unreadable":
        path.write_text("{}", encoding="utf-8")
        _fail_file(monkeypatch, "project_settings.json")
    reads = []
    real = repository_settings.read_settings

    def counted(*args, **kwargs):
        reads.append(args[1])
        return real(*args, **kwargs)

    monkeypatch.setattr(repository_settings, "read_settings", counted)
    assert project_settings.resolve_project_settings(repo).saved is saved
    assert reads == ["project_settings.json"]  # the settings and whether they are saved: one read


# --- the file's own failure: each reader's handling, as before ---------------------------------------------


def test_a_file_that_cannot_be_opened_keeps_each_readers_handling(tmp_path: Path, monkeypatch):
    repo = _repo(tmp_path / "repo")
    _prepare_every_file(repo)
    failed = _fail_file(monkeypatch, "instructions.md", "project_settings.json", "repository_profile.json",
                        "team.json", "mine.json")
    assert read_instructions("project", repo).problem == "it could not be read (Permission denied)."
    assert read_instructions("user", repo).problem == "it could not be read (Permission denied)."
    settings, warnings = load_project_settings(repo)
    assert (settings.branch_template, warnings) == (
        "", [f"{_shown(repo, 'project_settings.json')} could not be read (Permission denied). Using the defaults."])
    profile, warnings = load_repository_profile(repo)
    assert (profile.mode, warnings) == (
        "generic",
        [f"{_shown(repo, 'repository_profile.json')} could not be read (Permission denied). Using the Generic profile."],
    )
    catalog = fix_mode_store.catalog_for(repo)
    assert (catalog.user, catalog.project) == ((), ())
    assert [(issue.scope, issue.message) for issue in catalog.issues] == [
        ("user", "mine.json could not be read: Permission denied."),
        ("project", "team.json could not be read: Permission denied."),
    ]
    assert {"instructions.md", "project_settings.json", "repository_profile.json", "team.json", "mine.json"} <= set(failed)


def test_a_configuration_file_that_cannot_be_opened_is_one_sentence_as_before(tmp_path: Path, monkeypatch):
    repo = _repo(tmp_path / "repo")
    _prepare_every_file(repo)
    failed = _fail_file(monkeypatch, "config.toml")
    with pytest.raises(StorageAccessError) as raised:
        user_config._read_config()
    assert str(raised.value) == (
        "BugPilot could not read BUGPILOT_HOME/config/config.toml (PermissionError). "
        "Check that folder's permissions and free space, then try again."
    )
    assert failed


def test_a_folder_at_the_configuration_files_name_keeps_its_sentence(tmp_path: Path):
    storage.global_storage().ensure_config_dir()
    storage.global_storage().config_file(create=False).mkdir()
    with pytest.raises(StorageAccessError) as raised:
        user_config._read_config()
    error_class = "PermissionError" if WINDOWS else "IsADirectoryError"
    assert str(raised.value) == (
        f"BugPilot could not read BUGPILOT_HOME/config/config.toml ({error_class}). "
        "Check that folder's permissions and free space, then try again."
    )


@pytest.mark.skipif(not WINDOWS, reason="a share mode that keeps every reader out is Windows'")
def test_a_file_another_program_holds_exclusively_reads_as_permission_denied(tmp_path: Path):
    import _winapi

    repo = _repo(tmp_path / "repo")
    path = _settings(repo, "project_settings.json", "{}")
    handle = _winapi.CreateFile(str(path), _winapi.GENERIC_READ, 0, 0, _winapi.OPEN_EXISTING, 0, 0)  # shares nothing
    try:
        _, warnings = load_project_settings(repo)
    finally:
        _winapi.CloseHandle(handle)
    # The system says "in use" in its own words; the warning keeps the words Python's own open gave it.
    assert warnings == [f"{_shown(repo, 'project_settings.json')} could not be read (Permission denied). Using the defaults."]


# --- a folder on the way that cannot be read: the command fails, never the defaults -------------------------


@pytest.mark.parametrize("folder, readers", [
    ("settings", ["project instructions", "project settings", "repository profile", "fix modes"]),
    ("config", ["user instructions", "config.toml", "fix modes"]),
    ("fix_modes", ["fix modes"]),
])
def test_a_folder_on_the_way_that_cannot_be_read_fails_the_reader(tmp_path: Path, monkeypatch, folder, readers):
    repo = _repo(tmp_path / "repo")
    _prepare_every_file(repo)
    failed = _fail_folder(monkeypatch, folder)
    for reader in readers:
        with pytest.raises(StorageAccessError) as raised:
            READERS[reader](repo)
        assert not isinstance(raised.value, repository_settings.FileReadError), reader
        message = str(raised.value)
        assert message.startswith("BugPilot could not read ") and "(PermissionError)" in message, (reader, message)
        _no_absolute_path(message, tmp_path)
    assert failed


def test_a_settings_folder_that_cannot_be_read_is_named_as_before(tmp_path: Path, monkeypatch):
    repo = _repo(tmp_path / "repo")
    _prepare_every_file(repo)
    _fail_folder(monkeypatch, "settings")
    with pytest.raises(StorageAccessError) as raised:
        load_project_settings(repo)
    assert str(raised.value) == (
        f"BugPilot could not read {_shown(repo, '')[:-1]} (PermissionError). "
        "Check that folder's permissions and free space, then try again."
    )


# --- refusals stay refusals ---------------------------------------------------------------------------------


@pytest.mark.parametrize("kind", LINK_KINDS)
@pytest.mark.parametrize("reader, name", [
    ("project instructions", "instructions.md"),
    ("project settings", "project_settings.json"),
    ("repository profile", "repository_profile.json"),
    ("user instructions", "instructions.md"),
    ("config.toml", "config.toml"),
])
def test_a_link_at_a_settings_file_is_refused_never_the_defaults(tmp_path, decoy, kind, reader, name):
    repo = _repo(tmp_path / "repo")
    if reader in ("user instructions", "config.toml"):
        folder = storage.global_storage().ensure_config_dir()
    else:
        folder = storage.repository_storage(repo).settings_file(name, create=True).parent
    _plant(kind, folder / name, decoy if kind == "junction" else decoy / name)
    with pytest.raises(StorageError) as refused:
        READERS[reader](repo)
    assert f"{name} is a symbolic link or junction" in str(refused.value)
    assert SENTINEL not in str(refused.value)
    _no_absolute_path(str(refused.value), tmp_path)


@pytest.mark.parametrize("reader, name", [
    ("project settings", "project_settings.json"),
    ("user instructions", "instructions.md"),
    ("fix modes", "team.json"),
    ("config.toml", "config.toml"),
])
def test_an_unsupported_reparse_point_is_refused_even_among_the_fix_modes(tmp_path, monkeypatch, reader, name):
    repo = _repo(tmp_path / "repo")
    _prepare_every_file(repo)
    real = FOLDER_CLASS.open_file

    def open_file(self, entry):
        return _held_folders.Opened("reparse") if entry == name else real(self, entry)

    monkeypatch.setattr(FOLDER_CLASS, "open_file", open_file)
    with pytest.raises(StorageError) as refused:
        READERS[reader](repo)
    assert f"{name} is a reparse point BugPilot does not support" in str(refused.value)


@pytest.mark.parametrize("reader", list(READERS))
def test_a_system_that_cannot_hold_folders_is_refused_by_every_reader(tmp_path, monkeypatch, reader):
    repo = _repo(tmp_path / "repo")
    _prepare_every_file(repo)
    if WINDOWS:
        monkeypatch.setattr(_held_folders, "_KERNEL32", None)
    else:
        monkeypatch.setattr(os, "supports_dir_fd", set())
    with pytest.raises(StorageError) as refused:
        READERS[reader](repo)
    assert str(refused.value).startswith("BugPilot cannot read its data folder safely on this system")


@pytest.mark.parametrize("reader", ["project instructions", "project settings", "repository profile", "fix modes"])
def test_a_record_naming_another_repository_refuses_every_project_reader(tmp_path, reader):
    repo = _repo(tmp_path / "repo")
    _prepare_every_file(repo)
    namespace = storage.repository_storage(repo)
    record = storage.data_root() / "repositories" / namespace.identity.repository_id / storage.RECORD_NAME
    os.chmod(record, 0o600)
    record.write_text(json.dumps({"schema_version": 1, "repository_id": namespace.identity.repository_id,
                                  "root": "another folder"}), encoding="utf-8")
    with pytest.raises(StorageIdentityError):
        READERS[reader](repo)


# --- no bare OSError at the boundaries ------------------------------------------------------------------------


@pytest.mark.parametrize("argv, folder", [
    (("project-settings", "show"), "settings"),
    (("repository-profile", "show"), "settings"),
    (("instructions", "show"), "settings"),
    (("instructions", "show"), "config"),
    (("fix-mode", "list"), "fix_modes"),
    (("fix-mode", "list"), "config"),
])
def test_a_folder_failure_reaches_the_cli_as_one_sentence(tmp_path, monkeypatch, capsys, argv, folder):
    repo = _repo(tmp_path / "repo")
    _prepare_every_file(repo)
    _fail_folder(monkeypatch, folder)
    monkeypatch.chdir(repo)
    assert main([*argv, "--json"]) == 1
    out, _err = capsys.readouterr()
    payload = json.loads(out)
    assert (payload["ok"], payload["command"], payload["error"]["code"]) == (False, argv[0], "INTERNAL_ERROR")
    assert payload["error"]["message"].startswith("BugPilot could not read ")
    assert main(list(argv)) == 1
    out, err = capsys.readouterr()
    assert err.startswith("ERROR: BugPilot could not read ") and "Traceback" not in err
    _no_absolute_path(out + err, tmp_path, repo)


@pytest.mark.parametrize("folder", ["fix_modes", "config", "settings"])
def test_a_folder_failure_reaches_an_mcp_tool_as_one_sentence_never_a_crash(tmp_path, monkeypatch, folder):
    pytest.importorskip("mcp")
    from mcp.server.mcpserver.exceptions import ToolError, UnexpectedToolError

    from bugpilot.mcp_server import build_server

    repo = _repo(tmp_path / "repo")
    _prepare_every_file(repo)
    _fail_folder(monkeypatch, folder)
    with pytest.raises(ToolError) as raised:
        asyncio.run(build_server(repo).call_tool("list_fix_modes", {}))
    assert not isinstance(raised.value, UnexpectedToolError), "a crash, where one sentence was expected"
    message = str(raised.value)
    assert "Could not list the Fix Modes [INTERNAL_ERROR]: BugPilot could not read " in message
    _no_absolute_path(message, tmp_path, repo)


# --- Fix Modes: listed then gone, links, decoding --------------------------------------------------------------


def test_a_fix_mode_listed_and_gone_before_it_is_read_keeps_its_issue(tmp_path: Path, monkeypatch):
    repo = _repo(tmp_path / "repo")
    folder = repository_settings.fix_modes_dir(repo, create=True)
    for mode_id in ("gone", "team"):
        (folder / f"{mode_id}.json").write_text(json.dumps(_mode(mode_id)), encoding="utf-8")
    real = repository_settings.fix_mode_names

    def listed(root):
        names = real(root)
        (folder / "gone.json").unlink()  # removed after it was listed, before it is read
        return names

    monkeypatch.setattr(repository_settings, "fix_mode_names", listed)
    catalog = fix_mode_store.catalog_for(repo)
    assert [mode.id for mode in catalog.project] == ["team"]
    assert [(issue.scope, issue.path, issue.message) for issue in catalog.issues] == [
        ("project", _shown(repo, "fix_modes/gone.json"), "gone.json is not a file.")
    ]


@pytest.mark.parametrize("kind", LINK_KINDS)
def test_every_link_among_the_fix_modes_is_one_issue_and_never_followed(tmp_path: Path, decoy, kind):
    repo = _repo(tmp_path / "repo")
    folder = repository_settings.fix_modes_dir(repo, create=True)
    (folder / "team.json").write_text(json.dumps(_mode("team")), encoding="utf-8")
    links = {"to-a-folder.json": decoy}
    if kind == "symlink":
        links.update({"to-a-file.json": decoy / "inner.json", "dangling.json": decoy / "missing.json"})
    for name, target in links.items():
        _plant(kind, folder / name, target)
    catalog = fix_mode_store.catalog_for(repo)
    assert [mode.id for mode in catalog.project] == ["team"]
    issues = {issue.path: issue.message for issue in catalog.issues}
    assert issues == {_shown(repo, f"fix_modes/{name}"): fix_mode_store._LINK_ISSUE.format(name=name) for name in links}
    assert issues == {_shown(repo, f"fix_modes/{name}"): _approved_link_issue(name) for name in links}  # DD-27
    for message in issues.values():
        assert SENTINEL not in message
        _no_absolute_path(message, tmp_path)
    # One mode read by its id is refused before any read, as before: its path resolves outside the folder.
    with pytest.raises(fix_mode_store.FixModeError) as raised:
        FixModeStore(repo).read("project", "to-a-folder")
    assert str(raised.value) == (
        f"Refusing to work on {_shown(repo, 'fix_modes/to-a-folder.json')}: it resolves outside the project "
        "Fix Mode directory."
    )


@pytest.mark.parametrize("case", IN_FOLDER_LINKS + ["to-outside"])
def test_dd27_every_list_surface_shows_the_approved_issue(tmp_path: Path, monkeypatch, capsys, decoy, case):
    repo = _repo(tmp_path / "repo")
    if case == "to-outside":
        folder = repository_settings.fix_modes_dir(repo, create=True)
        _plant("junction" if WINDOWS else "symlink", folder / "to-outside.json", decoy)
    else:
        folder, _ = _fix_modes_with("project", repo, case)
    name = f"{case}.json"
    shown = _shown(repo, f"fix_modes/{name}")
    monkeypatch.chdir(repo)
    # `fix-mode list --json`: the issue's fields as before, its message the approved text.
    assert main(["fix-mode", "list", "--json"]) == 0
    out, _err = capsys.readouterr()
    assert json.loads(out)["issues"] == [{"scope": "project", "path": shown, "message": _approved_link_issue(name)}]
    # `fix-mode list` in text: the WARN line.
    assert main(["fix-mode", "list"]) == 0
    out, err = capsys.readouterr()
    assert f"WARN: project Fix Mode {shown}: {_approved_link_issue(name)}" in err.splitlines()
    # MCP `list_fix_modes`: the issue's scope and message, as the tool always returned them.
    pytest.importorskip("mcp")
    from bugpilot.mcp_server import build_server

    result = asyncio.run(build_server(repo).call_tool("list_fix_modes", {}))
    assert result.is_error is not True
    assert result.structured_content["issues"] == [{"scope": "project", "message": _approved_link_issue(name)}]
    assert SENTINEL not in out + err + json.dumps(result.structured_content)
    _no_absolute_path(out + err + json.dumps(result.structured_content), tmp_path, repo)


#: The commands that read one mode by its id, with the arguments each needs besides the id (DD-28).
SINGLE_READS = {
    "show": [],
    "update": ["--from-file", "{payload}", "--expected-version", "1"],
    "delete": ["--expected-version", "1"],
}


@pytest.mark.parametrize("command", list(SINGLE_READS))
@pytest.mark.parametrize("case", IN_FOLDER_LINKS)
def test_dd28_one_mode_read_by_its_id_gives_the_approved_issue(tmp_path: Path, monkeypatch, capsys, case, command):
    repo = _repo(tmp_path / "repo")
    folder, mode_id = _fix_modes_with("project", repo, case)
    payload = tmp_path / "payload.json"
    payload.write_text(json.dumps(_mode(mode_id)), encoding="utf-8")
    extra = [part.format(payload=payload) for part in SINGLE_READS[command]]
    before = _tree(folder)
    monkeypatch.chdir(repo)
    argv = ["fix-mode", command, mode_id, "--scope", "project", *extra]
    assert main([*argv, "--json"]) == 1
    out, _err = capsys.readouterr()
    assert json.loads(out) == {"schema_version": cli_json.SCHEMA_VERSION, "ok": False, "command": "fix-mode",
                               "error": {"code": "INVALID_INPUT", "message": _approved_link_issue(f"{mode_id}.json")}}
    assert main(argv) == 1
    out, err = capsys.readouterr()
    assert (out, err) == ("", f"ERROR: {_approved_link_issue(f'{mode_id}.json')}\n")
    with pytest.raises(fix_mode_store.FixModeError) as raised:
        FixModeStore(repo).read("project", mode_id)
    assert str(raised.value) == _approved_link_issue(f"{mode_id}.json")
    assert _tree(folder) == before  # refused before anything was written or deleted


@pytest.mark.parametrize("case", IN_FOLDER_LINKS)
def test_dd28_holds_in_the_user_scope_too(tmp_path: Path, monkeypatch, capsys, case):
    repo = _repo(tmp_path / "repo")
    _, mode_id = _fix_modes_with("user", repo, case)
    monkeypatch.chdir(repo)
    assert main(["fix-mode", "show", mode_id, "--scope", "user", "--json"]) == 1
    out, _err = capsys.readouterr()
    assert json.loads(out)["error"] == {"code": "INVALID_INPUT", "message": _approved_link_issue(f"{mode_id}.json")}


@pytest.mark.parametrize("case", IN_FOLDER_LINKS)
def test_dd28_leaves_duplicate_as_it_was(tmp_path: Path, monkeypatch, capsys, case):
    """`duplicate` reads no mode by its id: a link source is unknown to the catalog and a link target is refused by
    the writer's own checks, both exactly as in `d834082`."""
    repo = _repo(tmp_path / "repo")
    _, mode_id = _fix_modes_with("project", repo, case)
    monkeypatch.chdir(repo)
    assert main(["fix-mode", "duplicate", mode_id, "copy-of-it", "--scope", "project", "--json"]) == 1
    out, _err = capsys.readouterr()
    message = json.loads(out)["error"]["message"]
    assert message.startswith(f"Unknown Fix Mode '{mode_id}'. Available modes: ")
    assert main(["fix-mode", "duplicate", "standard", mode_id, "--scope", "project", "--json"]) == 1
    out, _err = capsys.readouterr()
    expected = (  # the writer's checks: a dangling link does not exist, and every other link does
        f"{mode_id}.json is a symbolic link. BugPilot will not write through it." if case == "dangling-sibling"
        else f"A project Fix Mode '{mode_id}' already exists. Choose another id."
    )
    assert json.loads(out)["error"] == {"code": "INVALID_INPUT", "message": expected}


@pytest.mark.parametrize("case, expected", [
    ("folder-entry", "folder-entry.json is not a file."),
    ("no-such-mode", "No project Fix Mode 'no-such-mode'. Run: bugpilot fix-mode list --all-scopes"),
])
@pytest.mark.parametrize("command", list(SINGLE_READS))
def test_dd28_leaves_entries_that_are_not_links_as_they_were(tmp_path, monkeypatch, capsys, case, expected, command):
    repo = _repo(tmp_path / "repo")
    _, mode_id = _fix_modes_with("project", repo, case)
    payload = tmp_path / "payload.json"
    payload.write_text(json.dumps(_mode(mode_id)), encoding="utf-8")
    extra = [part.format(payload=payload) for part in SINGLE_READS[command]]
    monkeypatch.chdir(repo)
    assert main(["fix-mode", command, mode_id, "--scope", "project", *extra, "--json"]) == 1
    out, _err = capsys.readouterr()
    assert json.loads(out)["error"] == {"code": "INVALID_INPUT", "message": expected}


def test_an_invalid_utf8_fix_mode_still_stops_the_catalog_as_before(tmp_path: Path):
    """Pre-existing behaviour, kept for this slice (owner decision 5.6): recorded as its own defect, not fixed here."""
    repo = _repo(tmp_path / "repo")
    (repository_settings.fix_modes_dir(repo, create=True) / "broken.json").write_bytes(b'{"id": "\xff\xfe"}')
    with pytest.raises(UnicodeDecodeError):
        fix_mode_store.catalog_for(repo)


@pytest.mark.parametrize("json_output", [True, False])
def test_the_cli_reports_a_refusal_as_one_sentence_with_invalid_input(tmp_path, monkeypatch, capsys, decoy,
                                                                      json_output):
    repo = _repo(tmp_path / "repo")
    folder = storage.repository_storage(repo).settings_file("project_settings.json", create=True).parent
    kind = "junction" if WINDOWS else "symlink"
    _plant(kind, folder / "project_settings.json", decoy if WINDOWS else decoy / "project_settings.json")
    monkeypatch.chdir(repo)
    argv = ["project-settings", "show"] + (["--json"] if json_output else [])
    assert main(argv) == 1
    out, err = capsys.readouterr()
    if json_output:
        payload = json.loads(out)
        assert payload["error"]["code"] == "INVALID_INPUT"
        assert "project_settings.json is a symbolic link or junction" in payload["error"]["message"]
    else:
        assert err.startswith("ERROR: ") and "project_settings.json is a symbolic link or junction" in err
        assert "Traceback" not in err
    assert SENTINEL not in out + err
    _no_absolute_path(out + err, tmp_path, repo)
