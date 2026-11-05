"""Global configuration on Unified Storage (0.1.6 Batch 2B-2; plan §14.3, "Batch 2B-2 — final contract resolution").

The user's configuration — ``config.toml``, ``instructions.md`` and ``fix_modes/`` — lives in ``config/`` of
BugPilot's data folder and is reached only through storage's checked methods. These tests hold that, through the
CLI where a command is involved:

- the places, and the credentials file's privacy (G-3);
- no 0.1.5 file at the top of the data folder is read, changed or deleted, and ``BUGPILOT_CONFIG_DIR``'s value is
  never read: the variable earns one warning in text mode (owner decision Q-4), nothing else;
- read-only commands create nothing, and every write comes from a checked method (the write witness);
- one request scope per command, closed before an agent starts;
- the error contract M-1 (owner decision C-1): each command keeps its 0.1.5 error code, every message is one
  sentence that names no absolute path, and text mode prints no traceback;
- the independent evidence for the designed differences DD-1, DD-2 and DD-3
  (``tests/baselines/0.1.6-batch2b2/designed_differences.json``).

POSIX permission bits are checked where they exist; on Windows the privacy gate's access-list check runs instead.
"""

from __future__ import annotations

import errno
import json
import os
import stat
import sys
import uuid
import weakref
from contextlib import contextmanager
from pathlib import Path

import pytest

from bugpilot import cli
from bugpilot.cli import main
from bugpilot.core import _held_folders, jira, private_folder, storage, user_config
from bugpilot.core.agent_runner import AgentRunResult
from bugpilot.core.fix_mode_store import custom_mode_payload
from bugpilot.core.fix_modes import builtin_fix_mode_registry
from bugpilot.core.instructions import load_instructions
from bugpilot.core.storage import StorageError, global_storage
from bugpilot.core.user_config import CONFIG_DIR_WARNING, UserConfig

from _storage_witness import witness

POSIX = os.name == "posix"
EMAIL, TOKEN, SITE = "dev@example.invalid", "synthetic-token-JR-12345", "https://jira.example.invalid"


# --- helpers -----------------------------------------------------------------------------------------


_seen: list[str] | None = None


def _audit(event: str, args: tuple) -> None:
    if _seen is None or event not in ("open", "os.scandir", "os.listdir") or not args:
        return
    target = args[0]
    if isinstance(target, (str, bytes, os.PathLike)):
        _seen.append(os.path.normcase(os.path.abspath(os.fsdecode(target))))


sys.addaudithook(_audit)  # installed once; it records nothing outside `_reads()`


@contextmanager
def _reads():
    """Every path opened or listed in the block, as ``normcase``-d absolute text."""
    global _seen
    _seen = []
    try:
        yield _seen
    finally:
        _seen = None


def _data_root() -> Path:
    return Path(os.environ["BUGPILOT_HOME"])


def _repo(tmp_path: Path, monkeypatch) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    monkeypatch.chdir(repo)
    return repo


def _json(capsys, *argv: str) -> tuple[int, dict]:
    code = main([*argv, "--json"])
    return code, json.loads(capsys.readouterr().out)


def _no_absolute_path(text: str, *roots: Path) -> None:
    for root in (*roots, _data_root(), Path.home()):
        for spelling in {str(root), root.as_posix(), os.path.realpath(root)}:
            assert spelling not in text, (spelling, text)


def _mode(path: Path) -> int:
    return stat.S_IMODE(os.lstat(path).st_mode)


# --- where the configuration lives ---------------------------------------------------------------------


def test_the_credentials_file_is_config_toml_in_the_data_folder_and_private(isolate_bugpilot_config):
    path = user_config.save_user_config(EMAIL, TOKEN, SITE)
    assert path == isolate_bugpilot_config / "config.toml" == user_config.user_config_path()
    assert user_config.load_user_config() == UserConfig(jira_email=EMAIL, jira_token=TOKEN, jira_base_url=SITE)
    for place, role in ((_data_root(), "data-root"), (isolate_bugpilot_config, "config-folder"), (path, "credential-file")):
        verdict = private_folder.verify_private(place, role)
        assert verdict.private, (place, verdict)
    if POSIX:
        assert (_mode(_data_root()), _mode(isolate_bugpilot_config), _mode(path)) == (0o700, 0o700, 0o600)


def test_user_files_live_in_the_configuration_folder_and_project_files_in_the_repository_namespace(
    tmp_path, monkeypatch, capsys, isolate_bugpilot_config
):
    repo = _repo(tmp_path, monkeypatch)
    text = tmp_path / "text.md"
    text.write_text("Prefer small changes.\n", encoding="utf-8")
    for scope in ("user", "project"):
        assert _json(capsys, "instructions", "set", "--scope", scope, "--from-file", str(text))[0] == 0
        assert _json(capsys, "fix-mode", "duplicate", "standard", f"{scope}-mode", "--scope", scope)[0] == 0
    assert (isolate_bugpilot_config / "instructions.md").is_file()
    assert (isolate_bugpilot_config / "fix_modes" / "user-mode.json").is_file()
    assert storage.repository_storage(repo).settings_file("instructions.md", create=False).is_file()
    assert (storage.repository_storage(repo).fix_modes_dir(create=False) / "project-mode.json").is_file()
    assert sorted(os.listdir(_data_root())) == ["config", "repositories"]
    assert sorted(os.listdir(isolate_bugpilot_config)) == ["fix_modes", "instructions.md"]


def test_no_0_1_5_file_at_the_top_of_the_data_folder_is_read_changed_or_deleted(tmp_path, monkeypatch, capsys):
    """R4: the 0.1.5 files are left where they are, untouched; `bugpilot setup` writes the new ones."""
    _repo(tmp_path, monkeypatch)
    root = _data_root()
    global_storage().ensure_config_dir()
    legacy_mode = custom_mode_payload(builtin_fix_mode_registry().default)
    legacy_mode.update(id="legacy-mode", name="Legacy mode")
    legacy = {
        root / "config.toml": f'jira_email = "legacy@example.invalid"\njira_token = "{TOKEN}"\n',
        root / "instructions.md": "LEGACY-USER-INSTRUCTIONS\n",
        root / "fix_modes" / "legacy-mode.json": json.dumps(legacy_mode, indent=2) + "\n",
    }
    for path, content in legacy.items():
        path.parent.mkdir(exist_ok=True)
        path.write_text(content, encoding="utf-8")
    before = {path: (path.read_bytes(), os.stat(path).st_mtime_ns) for path in legacy}
    text = tmp_path / "text.md"
    text.write_text("New instructions.\n", encoding="utf-8")

    with _reads() as seen:
        assert user_config.load_user_config() == UserConfig()
        assert load_instructions(tmp_path / "repo").user.configured is False
        code, listed = _json(capsys, "fix-mode", "list")
        assert code == 0 and "legacy-mode" not in json.dumps(listed)
        user_config.save_user_config(EMAIL, TOKEN, SITE)
        assert _json(capsys, "instructions", "set", "--scope", "user", "--from-file", str(text))[0] == 0
        assert _json(capsys, "fix-mode", "duplicate", "standard", "new-mode", "--scope", "user")[0] == 0
        code, shown = _json(capsys, "instructions", "show")
        assert code == 0 and shown["user"]["text"] == "New instructions."

    legacy_places = [os.path.normcase(os.path.abspath(path)) for path in (*legacy, root / "fix_modes")]
    assert not [path for path in seen if any(path == place or path.startswith(place + os.sep) for place in legacy_places)]
    assert {path: (path.read_bytes(), os.stat(path).st_mtime_ns) for path in legacy} == before
    assert user_config.load_user_config().jira_email == EMAIL


# --- BUGPILOT_CONFIG_DIR: one warning, never read ---------------------------------------------------


@pytest.fixture
def retired_folder(tmp_path, monkeypatch) -> tuple[Path, str]:
    """``BUGPILOT_CONFIG_DIR`` set to a folder holding 0.1.5-style files whose content is a sentinel."""
    sentinel = f"sentinel-{uuid.uuid4().hex}"
    folder = tmp_path / sentinel
    folder.mkdir()
    (folder / "instructions.md").write_text(f"{sentinel} instructions\n", encoding="utf-8")
    (folder / "config.toml").write_text(f'jira_email = "{sentinel}@example.invalid"\n', encoding="utf-8")
    monkeypatch.setenv("BUGPILOT_CONFIG_DIR", str(folder))
    return folder, sentinel


def test_the_retired_variable_earns_one_warning_in_text_mode_and_is_never_read(
    tmp_path, monkeypatch, capsys, retired_folder
):
    folder, sentinel = retired_folder
    _repo(tmp_path, monkeypatch)
    with _reads() as seen:
        assert main(["instructions", "show"]) == 0
    captured = capsys.readouterr()
    assert captured.err.splitlines() == [CONFIG_DIR_WARNING]
    assert sentinel not in captured.out + captured.err
    assert not [path for path in seen if path.startswith(os.path.normcase(str(folder)))]
    assert user_config.load_user_config() == UserConfig()


def test_the_json_modes_print_no_warning_and_stdout_stays_one_object(tmp_path, monkeypatch, capsys, retired_folder):
    _folder, sentinel = retired_folder
    _repo(tmp_path, monkeypatch)
    assert main(["instructions", "show", "--json"]) == 0
    captured = capsys.readouterr()
    payload = json.loads(captured.out)
    assert payload["ok"] is True and payload["user"]["configured"] is False
    assert captured.err == "" and sentinel not in captured.out


@pytest.mark.parametrize("value", [None, ""], ids=["unset", "empty"])
def test_only_whether_the_variable_is_set_is_looked_at(tmp_path, monkeypatch, capsys, value):
    """Presence only: an empty value still earns the warning, since its content is never looked at."""
    _repo(tmp_path, monkeypatch)
    if value is not None:
        monkeypatch.setenv("BUGPILOT_CONFIG_DIR", value)
    assert main(["instructions", "show"]) == 0
    assert capsys.readouterr().err.splitlines() == ([] if value is None else [CONFIG_DIR_WARNING])


# --- nothing is created by reading; every write is a checked one ----------------------------------------


def test_read_only_commands_create_nothing(tmp_path, monkeypatch, capsys):
    _repo(tmp_path, monkeypatch)
    for argv in (["instructions", "show"], ["fix-mode", "list"], ["jira-site", "show"], ["doctor"]):
        assert _json(capsys, *argv)[0] == 0, argv
    assert not os.path.lexists(_data_root())


def test_every_configuration_write_comes_from_a_checked_method(tmp_path, monkeypatch, capsys):
    _repo(tmp_path, monkeypatch)
    text = tmp_path / "text.md"
    text.write_text("Prefer small changes.\n", encoding="utf-8")
    with witness() as observed:
        assert _json(capsys, "jira-site", "set", SITE)[0] == 0
        assert _json(capsys, "instructions", "set", "--scope", "user", "--from-file", str(text))[0] == 0
        assert _json(capsys, "fix-mode", "duplicate", "standard", "my-mode", "--scope", "user")[0] == 0
        assert _json(capsys, "fix-mode", "delete", "my-mode", "--scope", "user", "--expected-version", "1")[0] == 0
        assert _json(capsys, "instructions", "set", "--scope", "user", "--clear")[0] == 0
    observed.assert_clean()
    verdicts: dict[str, set[str]] = {}
    for item in observed.observations:
        verdicts.setdefault(Path(item.path).name, set()).add(item.verdict)
    assert verdicts["config.toml"] == {"storage"}
    assert verdicts["instructions.md"] == {"granted"}
    assert verdicts["my-mode.json"] == {"granted"}


def test_the_witness_sees_a_configuration_write_that_bypasses_storage(user_config_folder):
    """The control for the test above: a write the checked methods did not grant is a violation."""
    with witness() as observed:
        (user_config_folder / "stray.md").write_text("synthetic\n", encoding="utf-8")
    assert [Path(item.path).name for item in observed.violations()] == ["stray.md"]


# --- one request scope per command -------------------------------------------------------------------


def test_each_command_runs_in_one_request_scope_of_its_own(tmp_path, monkeypatch, capsys):
    _repo(tmp_path, monkeypatch)
    seen = []
    real = cli._dispatch

    def recording(args, repo_root):
        seen.append(storage._active_scope())
        return real(args, repo_root)

    monkeypatch.setattr(cli, "_dispatch", recording)
    assert main(["instructions", "show", "--json"]) == 0
    assert main(["instructions", "show"]) == 0
    assert len(seen) == 2 and None not in seen and seen[0] is not seen[1]
    assert storage._active_scope() is None


def test_the_agent_starts_after_the_commands_request_scope_has_closed(tmp_path, monkeypatch, capsys):
    """Preparing runs in the command's scope; the agent, which may run for an hour, never does (2B-5 gate, item 4)."""
    monkeypatch.chdir(tmp_path)
    prepared, launched = [], []
    real = cli._dispatch

    def recording(args, repo_root):
        prepared.append(storage._active_scope())
        return real(args, repo_root)

    def stand_in(repo_root, issue_key, agent, config=None, prompt=None):
        launched.append(storage._active_scope())
        return AgentRunResult(agent=agent, ran=True, command=[agent], returncode=0)

    monkeypatch.setattr(cli, "_dispatch", recording)
    monkeypatch.setattr("bugpilot.core.agent_runner.run_agent", stand_in)
    assert main(["bug", "JR-12345", "--allow-mock", "--launch-agent", "claude"]) == 0
    assert len(prepared) == 1 and prepared[0] is not None
    assert launched == [None]


# --- the error contract (C-1, M-1) ------------------------------------------------------------------


def _fail_with(error: OSError):
    def fail(*args, **kwargs):
        raise error

    return fail


def test_an_unreadable_configuration_file_keeps_the_generic_code_in_one_sentence(
    tmp_path, monkeypatch, capsys, user_config_folder
):
    """A folder where the file should be cannot be read on any system: as 0.1.5, `INTERNAL_ERROR` in JSON."""
    _repo(tmp_path, monkeypatch)
    (user_config_folder / "config.toml").mkdir()
    code, payload = _json(capsys, "jira-site", "show")
    assert code == 1 and payload["error"]["code"] == "INTERNAL_ERROR"
    message = payload["error"]["message"]
    assert message.startswith("BugPilot could not read BUGPILOT_HOME/config/config.toml (")
    _no_absolute_path(message, tmp_path)
    assert main(["jira-site", "show"]) == 1
    err = capsys.readouterr().err
    assert err.startswith("ERROR: BugPilot could not read BUGPILOT_HOME/config/config.toml (") and "Traceback" not in err
    _no_absolute_path(err, tmp_path)


def test_a_configuration_write_that_fails_keeps_the_generic_code_in_one_sentence(tmp_path, monkeypatch, capsys):
    _repo(tmp_path, monkeypatch)
    monkeypatch.setattr(storage, "atomic_write_text", _fail_with(PermissionError(errno.EACCES, "denied", str(tmp_path))))
    code, payload = _json(capsys, "jira-site", "set", SITE)
    assert code == 1 and payload["error"]["code"] == "INTERNAL_ERROR"
    message = payload["error"]["message"]
    assert message.startswith("BugPilot could not write BUGPILOT_HOME/config/config.toml (PermissionError).")
    _no_absolute_path(message, tmp_path)


def test_a_user_instructions_write_that_fails_keeps_its_0_1_5_code(tmp_path, monkeypatch, capsys):
    """`instructions set` reported a write failure as `INVALID_INPUT` in 0.1.5, through its own handler; still so."""
    _repo(tmp_path, monkeypatch)
    text = tmp_path / "text.md"
    text.write_text("Prefer small changes.\n", encoding="utf-8")
    monkeypatch.setattr(
        "bugpilot.core.instructions.atomic_write_text", _fail_with(PermissionError(errno.EACCES, "denied", str(tmp_path)))
    )
    code, payload = _json(capsys, "instructions", "set", "--scope", "user", "--from-file", str(text))
    assert code == 1 and payload["error"]["code"] == "INVALID_INPUT"
    message = payload["error"]["message"]
    assert "BugPilot could not write BUGPILOT_HOME/config/instructions.md (PermissionError)." in message
    _no_absolute_path(message, tmp_path)


def test_a_user_fix_mode_write_that_fails_keeps_its_0_1_5_code(tmp_path, monkeypatch, capsys):
    """`fix-mode` reported a write failure as `INVALID_INPUT` in 0.1.5, through its own handler; still so."""
    _repo(tmp_path, monkeypatch)
    monkeypatch.setattr(
        "bugpilot.core.fix_mode_store.atomic_write_text", _fail_with(PermissionError(errno.EACCES, "denied", str(tmp_path)))
    )
    code, payload = _json(capsys, "fix-mode", "duplicate", "standard", "my-mode", "--scope", "user")
    assert code == 1 and payload["error"]["code"] == "INVALID_INPUT"
    message = payload["error"]["message"]
    assert message.startswith("Fix Mode storage is not writable: BugPilot could not write BUGPILOT_HOME/config/fix_modes/")
    _no_absolute_path(message, tmp_path)


def test_unreadable_user_instructions_are_left_out_with_a_problem_not_an_error(
    tmp_path, monkeypatch, capsys, user_config_folder
):
    """0.1.5's rule for an optional document, kept (C-1): left out whole, visibly; the command goes on."""
    _repo(tmp_path, monkeypatch)
    target = user_config_folder / "instructions.md"
    target.write_text("Prefer small changes.\n", encoding="utf-8")
    # Storage opens the file in its held folders (Option C, M2): fail its open there, in the held config/ folder only.
    folder_class = _held_folders._WindowsFolder if os.name == "nt" else _held_folders._PosixFolder
    real_child, real_open_file = folder_class.child, folder_class.open_file
    config_folders: weakref.WeakSet = weakref.WeakSet()
    denied: list[str] = []

    def child(self, name):
        found = real_child(self, name)
        if name == "config" and found is not None:
            config_folders.add(found)
        return found

    def opening(self, name):
        if self in config_folders and name == target.name:
            denied.append(name)
            raise PermissionError(errno.EACCES, "Permission denied")
        return real_open_file(self, name)

    monkeypatch.setattr(folder_class, "child", child)
    monkeypatch.setattr(folder_class, "open_file", opening)
    code, payload = _json(capsys, "instructions", "show")
    assert denied, "the injected failure never happened"
    assert code == 0
    assert payload["user"]["configured"] is False
    assert payload["user"]["problem"] == "it could not be read (Permission denied)."


def test_a_data_folder_inside_a_git_working_tree_is_refused_as_bad_input_and_nothing_is_written(
    tmp_path, monkeypatch, capsys
):
    """G-1/G-2 for the configuration: a home folder kept in Git (dotfiles) refuses reads and writes alike."""
    _repo(tmp_path, monkeypatch)
    (_data_root().parent / ".git").mkdir()
    code, payload = _json(capsys, "jira-site", "show")
    assert code == 1 and payload["error"]["code"] == "INVALID_INPUT"
    _no_absolute_path(payload["error"]["message"], tmp_path)
    assert main(["jira-site", "show"]) == 1
    err = capsys.readouterr().err
    assert err.startswith("ERROR: ") and "Traceback" not in err
    with pytest.raises(StorageError):
        user_config.save_user_config(EMAIL, TOKEN, SITE)
    assert not os.path.lexists(_data_root())


def test_configuration_messages_name_the_file_in_display_form(tmp_path, monkeypatch, capsys):
    """D-9 (US-D22, in part): `jira-site set` and `setup` say where they saved, never the user's own folder."""
    _repo(tmp_path, monkeypatch)
    assert main(["jira-site", "set", SITE]) == 0
    out = capsys.readouterr().out
    assert "Saved the Jira site in BUGPILOT_HOME/config/config.toml." in out
    _no_absolute_path(out, tmp_path)

    from bugpilot.core.jira import JiraValidationResult
    from bugpilot.core.setup import run_setup

    monkeypatch.setattr("bugpilot.core.git_ops.command_available", lambda command: True)
    monkeypatch.setattr(
        "bugpilot.core.jira.validate_credentials",
        lambda base_url, email, token, timeout=30: JiraValidationResult(ok=True, account_email=email),
    )
    answers = iter([SITE, EMAIL, TOKEN])
    lines: list[str] = []
    assert run_setup(prompt=lambda _prompt: next(answers), out=lines.append) == 0
    assert "Configuration saved to: BUGPILOT_HOME/config/config.toml" in lines
    _no_absolute_path("\n".join(lines), tmp_path)


# --- the evidence for the designed differences (tests/baselines/0.1.6-batch2b2/) ---------------------


def test_dd1_instructions_show_names_the_user_file_in_display_form(tmp_path, monkeypatch, capsys):
    """DD-1 (cli_paths.json): the user `path` is the display form of the file storage hands out (D-2, D-9)."""
    _repo(tmp_path, monkeypatch)
    code, payload = _json(capsys, "instructions", "show")
    expected = storage.display_path(global_storage().user_instructions_file(create=False))
    assert code == 0 and payload["user"]["path"] == expected == "BUGPILOT_HOME/config/instructions.md"


def test_dd2_the_not_configured_message_names_the_file_load_user_config_reads(monkeypatch):
    """DD-2 (handoff.json): under the default data folder the message names `~/.bugpilot/config/config.toml`,
    which is the file BugPilot reads (C-3)."""
    monkeypatch.delenv("BUGPILOT_HOME")  # the default: the test's own home's `.bugpilot`
    folder = global_storage().ensure_config_dir()
    (folder / "config.toml").write_text('jira_email = "read@example.invalid"\n', encoding="utf-8")
    assert user_config.load_user_config().jira_email == "read@example.invalid"
    shown = user_config.shown_config_path()
    assert shown == storage.display_path(folder / "config.toml") == "~/.bugpilot/config/config.toml"
    assert f"found in the environment or in {shown}. Run `bugpilot setup`" in jira.ERROR_MESSAGES["missing_env"]


def test_dd3_the_retired_variables_folder_gets_nothing(tmp_path, monkeypatch, capsys, isolate_bugpilot_config):
    """DD-3 (pollution.json): with `BUGPILOT_CONFIG_DIR` set, `instructions set --scope user` writes in the data
    folder's `config/`, and the variable's folder stays empty (D-2, D-3)."""
    _repo(tmp_path, monkeypatch)
    retired = tmp_path / "retired-config"
    retired.mkdir()
    monkeypatch.setenv("BUGPILOT_CONFIG_DIR", str(retired))
    text = tmp_path / "text.md"
    text.write_text("Prefer small changes.\n", encoding="utf-8")
    assert _json(capsys, "instructions", "set", "--scope", "user", "--from-file", str(text))[0] == 0
    assert os.listdir(retired) == []
    assert (isolate_bugpilot_config / "instructions.md").read_text(encoding="utf-8") == "Prefer small changes.\n"
