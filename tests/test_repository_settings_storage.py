"""A repository's own settings in BugPilot's data folder (0.1.6 Batch 2B-3a, plan §14.3).

Project Instructions, project Fix Modes, project settings and the Repository
Profile live in the repository's namespace,
``<data folder>/repositories/<repository id>/settings/``, reached only through
``bugpilot.core.repository_settings``. These tests hold, on synthetic folders:

- where the files live, and that the repository's path decides it (T-1 to
  T-16; T-15, a different repository at a former path inheriting it, is an
  accepted limitation, pinned here, never a detection);
- the storage-failure contract (the 11-row matrix, F2-S, M-1) at the CLI's
  text, its JSON, its JSON lines and the MCP tools;
- fail-closed refusals (P-1), R-PRE, M-P and row 22's display paths;
- that the 0.1.5 ``.bugpilot/`` is never read, copied or deleted (R4);
- the independent evidence for the designed differences DD-4 to DD-12.

Every expected place is built here from the repository's ID and the test's
``BUGPILOT_HOME``, never read back from the product.
"""

from __future__ import annotations

import asyncio
import errno
import io
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

import _isolation
from bugpilot import cli_json
from bugpilot.cli import main
from bugpilot.core import repository_settings, storage
from bugpilot.core.fix_mode_store import custom_mode_payload
from bugpilot.core.fix_modes import builtin_fix_mode_registry
from bugpilot.core.instructions import load_instructions
from bugpilot.core.project_settings import load_project_settings
from bugpilot.core.repository_profile import load_repository_profile
from bugpilot.core.storage import StorageError

GIT = ["git", "-c", "user.name=Dev", "-c", "user.email=dev@example.invalid", "-c", "commit.gpgsign=false"]
TEMPLATE = {"branch_naming": {"template": "fix/{issue}"}}


# --- helpers: places built from first principles ------------------------------------------------------


def _repo(root: Path) -> Path:
    (root / "src").mkdir(parents=True)
    (root / "src" / "app.py").write_text("def save(record):\n    return record['id']\n", encoding="utf-8")
    return root


def _id(root: Path) -> str:
    return storage.repository_identity(root).repository_id


def _namespace(root: Path) -> Path:
    return storage.data_root() / "repositories" / _id(root)


def _shown(root: Path, name: str) -> str:
    return f"BUGPILOT_HOME/repositories/{_id(root)}/settings/{name}"


def _unreadable_sentence(root: Path) -> str:
    """Storage's own sentence for a record that cannot be read now, with the place in display form."""
    return (
        f"BugPilot cannot read BUGPILOT_HOME/repositories/{_id(root)}/repository.json right now: it is in use or "
        "not readable. Nothing was read or written; try again, and check the folder's permissions if it persists."
    )


def _run(monkeypatch, capsys, root: Path, *argv: str, stdin: str | None = None) -> tuple[int, str, str]:
    monkeypatch.chdir(root)
    if stdin is not None:
        monkeypatch.setattr(sys, "stdin", io.TextIOWrapper(io.BytesIO(stdin.encode("utf-8")), encoding="utf-8"))
    code = main(list(argv))
    out, err = capsys.readouterr()
    return code, out, err


def _json(monkeypatch, capsys, root: Path, *argv: str, stdin: str | None = None) -> tuple[int, dict]:
    code, out, _err = _run(monkeypatch, capsys, root, *argv, "--json", stdin=stdin)
    return code, json.loads(out)


def _failure(command: str, code: str, message: str) -> dict:
    return {"schema_version": cli_json.SCHEMA_VERSION, "ok": False, "command": command,
            "error": {"code": code, "message": message}}


def _save_settings(monkeypatch, capsys, root: Path, data: dict = TEMPLATE) -> None:
    source = root.parent / f"{root.name}-settings.json"
    source.write_text(json.dumps(data), encoding="utf-8")
    assert _json(monkeypatch, capsys, root, "project-settings", "set", "--from-file", str(source))[0] == 0


def _no_absolute_path(text: str, *roots: Path) -> None:
    for root in (*roots, storage.data_root(), Path.home()):
        for spelling in (str(root), root.as_posix()):
            assert spelling not in text, (spelling, text)


def _tree(*roots: Path) -> dict[str, bytes | None]:
    found: dict[str, bytes | None] = {}
    for root in roots:
        for path in sorted(root.rglob("*")):
            found[str(path)] = path.read_bytes() if path.is_file() else None
    return found


def _mode(mode_id: str) -> dict:
    payload = custom_mode_payload(builtin_fix_mode_registry().default)
    payload["id"] = mode_id
    payload["name"] = mode_id.replace("-", " ").title()
    return payload


def _server(root: Path):
    pytest.importorskip("mcp")
    from bugpilot.mcp_server import build_server

    return build_server(root)


def _tool_error(server, name: str, arguments: dict) -> str:
    from mcp.server.mcpserver.exceptions import ToolError, UnexpectedToolError

    with pytest.raises(ToolError) as excinfo:
        asyncio.run(server.call_tool(name, arguments))
    assert not isinstance(excinfo.value, UnexpectedToolError), "a crash, where one sentence was expected"
    return str(excinfo.value)


@pytest.fixture
def unreadable_record(monkeypatch):
    """Every read of a ``repository.json`` fails with a permission error, as an unreadable record would (row 1)."""
    real = storage._read_regular

    def refuse(path, expected):
        if Path(path).name == storage.RECORD_NAME:
            raise PermissionError(errno.EACCES, "Permission denied", str(path))
        return real(path, expected)

    def install() -> None:
        monkeypatch.setattr(storage, "_TRANSIENT_DELAY", 0)
        monkeypatch.setattr(storage, "_read_regular", refuse)

    return install


def _symlink(link: Path, target: Path) -> None:
    try:
        os.symlink(target, link, target_is_directory=target.is_dir())
    except (OSError, NotImplementedError) as exc:
        pytest.skip(f"cannot create a symbolic link here: {exc}")


# --- T-1 to T-16: identity decides where a repository's settings are (G-2, B-1) -------------------------


def test_t1_one_folder_spelled_differently_reaches_the_same_settings(tmp_path, monkeypatch, capsys):
    repo = _repo(tmp_path / "repo")
    _save_settings(monkeypatch, capsys, repo)
    spellings = [str(repo) + os.sep, str(repo / "src" / ".."), repo.as_posix()]
    if os.name == "nt":
        spellings.append(str(repo.parent / repo.name.upper()))
    for spelling in spellings:
        assert load_project_settings(Path(spelling))[0].branch_template == "fix/{issue}", spelling


def test_t2_a_subfolder_is_its_own_repository_and_reads_create_nothing(tmp_path, monkeypatch, capsys):
    repo = _repo(tmp_path / "repo")
    _save_settings(monkeypatch, capsys, repo)
    sub = repo / "src"
    settings, warnings = load_project_settings(sub)
    assert (settings.branch_template, warnings) == ("", [])
    assert not _namespace(sub).exists()


def test_t3_a_nested_repository_and_its_outer_repository_are_independent(tmp_path, monkeypatch, capsys):
    outer = _repo(tmp_path / "outer")
    inner = outer / "vendor" / "lib"
    (inner / ".git").mkdir(parents=True)
    _save_settings(monkeypatch, capsys, outer)
    assert load_project_settings(inner)[0].branch_template == ""
    _save_settings(monkeypatch, capsys, inner, {"branch_naming": {"template": "inner/{issue}"}})
    assert load_project_settings(outer)[0].branch_template == "fix/{issue}"
    assert load_project_settings(inner)[0].branch_template == "inner/{issue}"


@pytest.mark.skipif(shutil.which("git") is None, reason="needs git for a real worktree")
def test_t4_each_git_worktree_is_configured_on_its_own(tmp_path, monkeypatch, capsys):
    repo = _repo(tmp_path / "repo")
    for args in (["init", "-q"], ["add", "-A"], ["commit", "-qm", "initial"]):
        subprocess.run([*GIT, *args], cwd=repo, check=True, capture_output=True)
    worktree = tmp_path / "worktree"
    subprocess.run([*GIT, "worktree", "add", "-q", str(worktree)], cwd=repo, check=True, capture_output=True)
    _save_settings(monkeypatch, capsys, repo)
    assert load_project_settings(worktree)[0].branch_template == ""
    assert _id(worktree) != _id(repo)


def test_t5_a_folder_outside_any_repository_works_as_today(tmp_path, monkeypatch, capsys):
    folder = _repo(tmp_path / "plain")
    assert not (folder / ".git").exists()
    _save_settings(monkeypatch, capsys, folder)
    code, shown = _json(monkeypatch, capsys, folder, "project-settings", "show")
    assert code == 0 and shown["saved"] is True and shown["settings"]["branch_naming"]["template"] == "fix/{issue}"


def test_t6_the_home_folder_as_the_repository_is_refused_with_the_default_data_folder(tmp_path, monkeypatch, capsys):
    """P-1: the default data folder is inside the home folder, so a home folder used as a repository is refused."""
    home = _repo(tmp_path / "home")
    for name, value in _isolation._home_environment(str(home)).items():
        monkeypatch.setenv(name, value)
    monkeypatch.delenv("BUGPILOT_HOME", raising=False)
    source = tmp_path / "settings.json"
    source.write_text(json.dumps(TEMPLATE), encoding="utf-8")
    for argv in (("project-settings", "show"), ("project-settings", "set", "--from-file", str(source))):
        code, payload = _json(monkeypatch, capsys, home, *argv)
        assert code == 1 and payload["error"]["code"] == "INVALID_INPUT", argv
        assert payload["error"]["message"].startswith("BugPilot will not keep its data inside this repository")
        _no_absolute_path(payload["error"]["message"], tmp_path)
    code, _out, err = _run(monkeypatch, capsys, home, "bug", "JR-12345", "--allow-mock")
    assert code == 1 and "ERROR: BugPilot will not keep its data inside this repository" in err
    assert not (home / ".bugpilot").exists() and not (home / ".ai").exists()


def test_t7_a_repository_inside_the_data_folder_is_refused(tmp_path, monkeypatch, capsys):
    inside = _repo(storage.data_root() / "elsewhere" / "repo")
    code, payload = _json(monkeypatch, capsys, inside, "project-settings", "show")
    assert code == 1 and payload["error"]["code"] == "INVALID_INPUT"
    assert "will not use a repository inside its own data folder" in payload["error"]["message"]
    assert not (storage.data_root() / "repositories").exists()


@pytest.mark.parametrize("kind", ["symlink", "junction"])
def test_t8_a_repository_reached_through_a_link_has_the_targets_settings(tmp_path, monkeypatch, capsys, kind):
    repo = _repo(tmp_path / "repo")
    link = tmp_path / "link"
    if kind == "junction":
        if sys.platform != "win32":
            pytest.skip("directory junctions are a Windows feature")
        import _winapi

        _winapi.CreateJunction(str(repo), str(link))
    else:
        _symlink(link, repo)
    _save_settings(monkeypatch, capsys, link)
    assert load_project_settings(repo)[0].branch_template == "fix/{issue}"
    assert _id(link) == _id(repo)


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS: /var and /private/var")
def test_t10_macos_private_var_reaches_the_same_settings(tmp_path, monkeypatch, capsys):
    repo = _repo(Path(os.path.realpath(tmp_path)) / "repo")
    assert str(repo).startswith("/private/var/")
    _save_settings(monkeypatch, capsys, repo)
    assert load_project_settings(Path(str(repo).removeprefix("/private")))[0].branch_template == "fix/{issue}"


@pytest.mark.skipif(sys.platform != "darwin", reason="macOS: a case-insensitive volume, a case-sensitive key")
def test_t11_macos_a_case_variant_root_reads_another_namespace_and_creates_nothing(tmp_path, monkeypatch, capsys):
    repo = _repo(tmp_path / "repo")
    _save_settings(monkeypatch, capsys, repo)
    variant = repo.parent / repo.name.upper()
    assert _id(variant) != _id(repo)
    settings, _warnings = load_project_settings(variant)
    assert settings.branch_template == "" and not _namespace(variant).exists()


def test_t12_a_moved_repository_starts_with_the_defaults_and_the_old_settings_stay(tmp_path, monkeypatch, capsys):
    repo = _repo(tmp_path / "repo")
    _save_settings(monkeypatch, capsys, repo)
    old = _namespace(repo) / "settings" / "project_settings.json"
    before = old.read_bytes()
    moved = tmp_path / "moved"
    monkeypatch.chdir(tmp_path)  # Windows renames no folder a process is working in
    os.rename(repo, moved)
    assert load_project_settings(moved)[0].branch_template == ""
    assert old.read_bytes() == before  # orphaned, never deleted or moved


def test_t13_a_case_only_rename_keeps_the_settings_on_windows_only(tmp_path, monkeypatch, capsys):
    repo = _repo(tmp_path / "repo")
    _save_settings(monkeypatch, capsys, repo)
    renamed = tmp_path / "REPO"
    monkeypatch.chdir(tmp_path)  # Windows renames no folder a process is working in
    os.rename(repo, renamed)
    expected = "fix/{issue}" if os.name == "nt" else ""
    assert load_project_settings(renamed)[0].branch_template == expected


def test_t14_two_clones_at_two_paths_are_configured_apart(tmp_path, monkeypatch, capsys):
    first, second = _repo(tmp_path / "one" / "app"), _repo(tmp_path / "two" / "app")
    _save_settings(monkeypatch, capsys, first)
    assert load_project_settings(second)[0].branch_template == ""
    assert _id(first) != _id(second) and _id(first).split("-")[0] == _id(second).split("-")[0] == "app"


def test_t15_a_different_repository_at_a_former_path_inherits_its_settings(tmp_path, monkeypatch, capsys):
    """B-1: accepted for 0.1.6 as a configuration-contamination limitation. Nothing detects the replacement."""
    repo = _repo(tmp_path / "repo")
    _save_settings(monkeypatch, capsys, repo)
    monkeypatch.chdir(tmp_path)  # Windows removes no folder a process is working in
    shutil.rmtree(repo)
    (repo / "lib").mkdir(parents=True)
    (repo / "lib" / "other.ts").write_text("export const other = 1;\n", encoding="utf-8")
    settings, warnings = load_project_settings(repo)
    assert (settings.branch_template, warnings) == ("fix/{issue}", [])


def test_t16_a_repository_folder_that_is_gone_is_refused_before_anything_is_written(tmp_path):
    gone = tmp_path / "gone"
    with pytest.raises(StorageError, match="does not exist or cannot be resolved"):
        repository_settings.settings_file(gone, "project_settings.json", create=True)
    assert not (storage.data_root() / "repositories").exists()

    repo = _repo(tmp_path / "repo")
    server = _server(repo)
    shutil.rmtree(repo)
    message = _tool_error(server, "list_fix_modes", {})
    assert message.startswith("Error executing tool list_fix_modes: Could not list the Fix Modes [INVALID_INPUT]: ")
    assert "does not exist or cannot be resolved" in message
    _no_absolute_path(message, tmp_path)


# --- the storage-failure matrix (US-D26 for 2B-3a: O2 and F2-S) -------------------------------------------


def test_row1_an_unreadable_record_is_one_sentence_with_each_surfaces_code(tmp_path, monkeypatch, capsys, unreadable_record):
    repo = _repo(tmp_path / "repo")
    _save_settings(monkeypatch, capsys, repo)
    record = _namespace(repo) / storage.RECORD_NAME
    snapshot = _tree(repo, _namespace(repo))
    source = tmp_path / "settings.json"
    source.write_text(json.dumps({}), encoding="utf-8")
    sentence = _unreadable_sentence(repo)
    unreadable_record()

    # R: the read commands reach the last resort: INTERNAL_ERROR, as 0.1.5 gave an unexaminable settings path.
    code, out, err = _run(monkeypatch, capsys, repo, "project-settings", "show", "--json")
    assert (code, json.loads(out)) == (1, _failure("project-settings", "INTERNAL_ERROR", sentence))
    assert err == f"ERROR: {sentence}\n"
    code, out, err = _run(monkeypatch, capsys, repo, "project-settings", "show")
    assert (code, out) == (1, "") and err.endswith(f"ERROR: {sentence}\n") and "Traceback" not in err
    for argv in (("fix-mode", "list"), ("fix-mode", "duplicate", "standard", "mine", "--scope", "project")):
        assert _json(monkeypatch, capsys, repo, *argv) == (1, _failure("fix-mode", "INTERNAL_ERROR", sentence)), argv

    # W: the `set` handlers keep 0.1.5's INVALID_INPUT, with their own prefix.
    assert _json(monkeypatch, capsys, repo, "project-settings", "set", "--from-file", str(source)) == (
        1, _failure("project-settings", "INVALID_INPUT", f"--from-file could not be read: {sentence}."))
    assert _json(monkeypatch, capsys, repo, "instructions", "set", "--scope", "project", "--stdin", stdin="Keep it.\n") == (
        1, _failure("instructions", "INVALID_INPUT", f"The text could not be read: {sentence}."))
    assert _json(monkeypatch, capsys, repo, "repository-profile", "set", "--mode", "generic") == (
        1, _failure("repository-profile", "INVALID_INPUT", sentence))

    # BUG: the run stops at its first read, the Fix Mode catalog, before anything is prepared.
    assert _json(monkeypatch, capsys, repo, "bug", "JR-12345", "--allow-mock") == (
        1, _failure("bug", "INTERNAL_ERROR", sentence))
    code, out, _err = _run(monkeypatch, capsys, repo, "bug", "JR-12345", "--allow-mock", "--json-lines")
    last = json.loads(out.strip().splitlines()[-1])
    assert (code, last) == (1, {"schema_version": cli_json.SCHEMA_VERSION, "type": "completed", "ok": False,
                                "error": {"code": "INTERNAL_ERROR", "message": sentence}})
    code, _out, err = _run(monkeypatch, capsys, repo, "bug", "JR-12345", "--allow-mock")
    assert code == 1 and f"ERROR: {sentence}" in err and "Traceback" not in err and "bugpilot status" not in err

    # MCP: one sentence and its code, as the prepare tools always said them.
    server = _server(repo)
    assert _tool_error(server, "prepare_jira_bug", {"issue_key": "JR-12345"}) == (
        f"Error executing tool prepare_jira_bug: Could not prepare JR-12345 [INTERNAL_ERROR]: {sentence}")
    assert _tool_error(server, "list_fix_modes", {}) == (
        f"Error executing tool list_fix_modes: Could not list the Fix Modes [INTERNAL_ERROR]: {sentence}")
    assert _tool_error(server, "show_fix_mode", {"mode_id": "standard"}) == (
        f"Error executing tool show_fix_mode: Could not read the Fix Modes [INTERNAL_ERROR]: {sentence}")

    # Read as plain files, never through storage's patched reader: nothing was written, repaired or prepared.
    assert _tree(repo, _namespace(repo)) == snapshot and record.exists()
    assert not (repo / ".ai").exists()


@pytest.mark.parametrize("record_text", ["corrupt", "mismatch"])
def test_row2_a_record_that_is_not_this_repositorys_is_refused_everywhere(tmp_path, monkeypatch, capsys, record_text):
    repo = _repo(tmp_path / "repo")
    _save_settings(monkeypatch, capsys, repo)
    record = _namespace(repo) / storage.RECORD_NAME
    if record_text == "corrupt":
        record.write_text("not a record\n", encoding="utf-8")
        expected = "it is not a readable repository record"
    else:
        data = json.loads(record.read_text(encoding="utf-8"))
        record.write_text(json.dumps({**data, "root": str(tmp_path / "another")}, indent=2) + "\n", encoding="utf-8")
        expected = "it belongs to a different repository folder"
    before = record.read_bytes()

    code, payload = _json(monkeypatch, capsys, repo, "project-settings", "show")
    assert code == 1 and payload["error"]["code"] == "INVALID_INPUT" and expected in payload["error"]["message"]
    assert payload["error"]["message"].startswith(
        f"BugPilot will not use BUGPILOT_HOME/repositories/{_id(repo)}/repository.json: ")
    code, _out, err = _run(monkeypatch, capsys, repo, "bug", "JR-12345", "--allow-mock")
    assert code == 1 and expected in err and "Traceback" not in err
    assert _json(monkeypatch, capsys, repo, "instructions", "set", "--scope", "project", "--stdin", stdin="x\n")[1][
        "error"]["code"] == "INVALID_INPUT"
    message = _tool_error(_server(repo), "prepare_jira_bug", {"issue_key": "JR-12345"})
    assert "[INVALID_INPUT]" in message and expected in message
    assert record.read_bytes() == before  # never repaired (US-D24)


def test_row3_a_settings_folder_that_cannot_be_examined_is_one_sentence(tmp_path, monkeypatch, capsys):
    repo = _repo(tmp_path / "repo")
    _save_settings(monkeypatch, capsys, repo)
    folder = _namespace(repo) / "settings"
    real = os.lstat

    def lstat(path, *args, **kwargs):
        if os.path.normcase(os.fspath(path)) == os.path.normcase(str(folder)):
            raise PermissionError(errno.EACCES, "Permission denied", str(path))
        return real(path, *args, **kwargs)

    monkeypatch.setattr(os, "lstat", lstat)
    sentence = (f"BugPilot could not read BUGPILOT_HOME/repositories/{_id(repo)}/settings (PermissionError). "
                "Check that folder's permissions and free space, then try again.")
    assert _json(monkeypatch, capsys, repo, "project-settings", "show") == (
        1, _failure("project-settings", "INTERNAL_ERROR", sentence))
    source = tmp_path / "settings.json"
    source.write_text("{}", encoding="utf-8")
    assert _json(monkeypatch, capsys, repo, "project-settings", "set", "--from-file", str(source)) == (
        1, _failure("project-settings", "INVALID_INPUT", f"--from-file could not be read: {sentence}."))


def test_row4_something_that_is_not_a_folder_on_the_way_is_refused(tmp_path, monkeypatch, capsys):
    repo = _repo(tmp_path / "repo")
    _save_settings(monkeypatch, capsys, repo)
    settings = _namespace(repo) / "settings"
    shutil.rmtree(settings)
    settings.write_text("a file where a folder belongs\n", encoding="utf-8")
    code, payload = _json(monkeypatch, capsys, repo, "project-settings", "show")
    assert code == 1 and payload["error"]["code"] == "INVALID_INPUT"
    assert f"repositories/{_id(repo)}/settings is not a directory" in payload["error"]["message"]
    assert settings.read_text(encoding="utf-8") == "a file where a folder belongs\n"


def test_row5_a_data_folder_whose_parent_is_missing_reads_the_defaults_and_refuses_a_write(tmp_path, monkeypatch, capsys):
    repo = _repo(tmp_path / "repo")
    missing = tmp_path / "missing" / "data"
    monkeypatch.setenv("BUGPILOT_HOME", str(missing))
    code, shown = _json(monkeypatch, capsys, repo, "project-settings", "show")
    assert code == 0 and shown["saved"] is False
    source = tmp_path / "settings.json"
    source.write_text(json.dumps(TEMPLATE), encoding="utf-8")
    code, payload = _json(monkeypatch, capsys, repo, "project-settings", "set", "--from-file", str(source))
    assert code == 1 and payload["error"]["code"] == "INVALID_INPUT"
    assert not (tmp_path / "missing").exists()


def test_row6_a_write_that_fails_keeps_each_handlers_code_and_names_no_absolute_path(tmp_path, monkeypatch, capsys):
    repo = _repo(tmp_path / "repo")
    _save_settings(monkeypatch, capsys, repo)
    saved = (_namespace(repo) / "settings" / "project_settings.json").read_bytes()
    denied = PermissionError(errno.EACCES, "Permission denied", str(tmp_path))

    def fail(*_args, **_kwargs):
        raise denied

    for module in ("bugpilot.core.repository_settings", "bugpilot.core.instructions", "bugpilot.core.fix_mode_store"):
        monkeypatch.setattr(f"{module}.atomic_write_text", fail)
    source = tmp_path / "settings.json"
    source.write_text("{}", encoding="utf-8")
    shown = f"BUGPILOT_HOME/repositories/{_id(repo)}/settings"
    then = "(PermissionError). Check that folder's permissions and free space, then try again."
    cases = [
        (("project-settings", "set", "--from-file", str(source)), None,
         f"--from-file could not be read: BugPilot could not write {shown}/project_settings.json {then}."),
        (("repository-profile", "set", "--mode", "generic"), None,
         f"BugPilot could not write {shown}/repository_profile.json {then}"),
        (("instructions", "set", "--scope", "project", "--stdin"), "Keep it.\n",
         f"The text could not be read: BugPilot could not write {shown}/instructions.md {then}."),
        (("fix-mode", "duplicate", "standard", "mine", "--scope", "project"), None,
         f"Fix Mode storage is not writable: BugPilot could not write {shown}/fix_modes/mine.json {then}"),
    ]
    for argv, stdin, message in cases:
        code, payload = _json(monkeypatch, capsys, repo, *argv, stdin=stdin)
        assert (code, payload["error"]) == (1, {"code": "INVALID_INPUT", "message": message}), argv
        _no_absolute_path(message, tmp_path)
    assert (_namespace(repo) / "settings" / "project_settings.json").read_bytes() == saved


def test_row7_a_record_that_cannot_be_published_fails_the_first_write_and_the_next_one_completes(tmp_path, monkeypatch, capsys):
    import tempfile

    repo = _repo(tmp_path / "repo")
    real = tempfile.mkstemp

    def mkstemp(*args, **kwargs):
        if str(kwargs.get("prefix", "")).startswith(f".{storage.RECORD_NAME}."):
            raise PermissionError(errno.EACCES, "Permission denied", str(kwargs.get("dir")))
        return real(*args, **kwargs)

    monkeypatch.setattr(tempfile, "mkstemp", mkstemp)
    source = tmp_path / "settings.json"
    source.write_text(json.dumps(TEMPLATE), encoding="utf-8")
    code, payload = _json(monkeypatch, capsys, repo, "project-settings", "set", "--from-file", str(source))
    assert (code, payload["error"]) == (1, {"code": "INVALID_INPUT", "message": (
        f"--from-file could not be read: BugPilot could not prepare BUGPILOT_HOME/repositories/{_id(repo)}/settings "
        "(PermissionError). Check that folder's permissions and free space, then try again..")})
    assert not (_namespace(repo) / storage.RECORD_NAME).exists()

    monkeypatch.setattr(tempfile, "mkstemp", real)
    assert _json(monkeypatch, capsys, repo, "project-settings", "set", "--from-file", str(source))[0] == 0
    expected = {"schema_version": 1, "repository_id": _id(repo), "root": os.path.realpath(repo)}
    assert (_namespace(repo) / storage.RECORD_NAME).read_text(encoding="utf-8") == json.dumps(
        expected, indent=2, ensure_ascii=True) + "\n"


def test_row8_a_data_folder_inside_a_git_working_tree_is_refused_for_reads_too(tmp_path, monkeypatch, capsys):
    repo = _repo(tmp_path / "repo")
    checkout = tmp_path / "checkout"
    (checkout / ".git").mkdir(parents=True)
    monkeypatch.setenv("BUGPILOT_HOME", str(checkout / "data"))
    code, payload = _json(monkeypatch, capsys, repo, "project-settings", "show")
    assert code == 1 and payload["error"]["code"] == "INVALID_INPUT"
    assert "inside a Git working tree" in payload["error"]["message"]
    assert not (checkout / "data").exists()


def test_row10_a_settings_file_that_cannot_be_read_is_a_warning_naming_no_absolute_path(tmp_path, monkeypatch, capsys):
    repo = _repo(tmp_path / "repo")
    for name, text in (("project_settings.json", json.dumps(TEMPLATE)), ("repository_profile.json", '{"mode": "generic"}')):
        storage.repository_storage(repo).settings_file(name, create=True).write_text(text, encoding="utf-8")
    broken = storage.repository_storage(repo).fix_modes_dir(create=True) / "broken.json"
    broken.write_text(json.dumps(_mode("broken")), encoding="utf-8")
    real = Path.read_text

    def read_text(self, *args, **kwargs):
        if self.name in ("project_settings.json", "repository_profile.json", "broken.json"):
            raise PermissionError(errno.EACCES, "Permission denied", str(self))
        return real(self, *args, **kwargs)

    monkeypatch.setattr(Path, "read_text", read_text)
    settings, warnings = load_project_settings(repo)
    assert warnings == [f"{_shown(repo, 'project_settings.json')} could not be read (Permission denied). Using the defaults."]
    profile, warnings = load_repository_profile(repo)
    assert profile.mode == "generic"
    assert warnings == [
        f"{_shown(repo, 'repository_profile.json')} could not be read (Permission denied). Using the Generic profile."]
    code, listed = _json(monkeypatch, capsys, repo, "fix-mode", "list")
    assert code == 0 and listed["issues"] == [{
        "scope": "project", "path": _shown(repo, "fix_modes/broken.json"),
        "message": "broken.json could not be read: Permission denied."}]
    _no_absolute_path(json.dumps(listed) + json.dumps(warnings), tmp_path)


def test_row11_reading_with_nothing_saved_creates_nothing_anywhere(tmp_path, monkeypatch, capsys):
    repo = _repo(tmp_path / "repo")
    for argv in (("project-settings", "show"), ("repository-profile", "show"), ("instructions", "show"),
                 ("fix-mode", "list"), ("task-preview",), ("bug", "JR-12345", "--allow-mock")):
        assert _json(monkeypatch, capsys, repo, *argv)[0] == 0, argv
    assert asyncio.run(_server(repo).call_tool("list_fix_modes", {})).is_error is not True
    assert not (storage.data_root() / "repositories").exists()
    assert not (repo / ".bugpilot").exists()


# --- R-PRE: no write before a refusal ---------------------------------------------------------------------


def _refused_namespace(repo: Path, monkeypatch, capsys, tmp_path: Path) -> None:
    """A namespace whose record names another repository: every read of it is refused."""
    _save_settings(monkeypatch, capsys, repo)
    record = _namespace(repo) / storage.RECORD_NAME
    data = json.loads(record.read_text(encoding="utf-8"))
    record.write_text(json.dumps({**data, "root": str(tmp_path / "another")}, indent=2) + "\n", encoding="utf-8")


def test_rpre_user_instructions_are_not_written_when_the_project_scope_will_be_refused(tmp_path, monkeypatch, capsys):
    repo = _repo(tmp_path / "repo")
    _refused_namespace(repo, monkeypatch, capsys, tmp_path)
    user_file = storage.data_root() / "config" / "instructions.md"
    code, payload = _json(monkeypatch, capsys, repo, "instructions", "set", "--scope", "user", "--stdin", stdin="Mine.\n")
    assert code == 1 and payload["error"]["code"] == "INVALID_INPUT"
    assert "it belongs to a different repository folder. Nothing was read or written" in payload["error"]["message"]
    assert not user_file.exists()


def test_rpre_the_verification_policy_is_not_written_or_removed_when_project_settings_will_be_refused(
    tmp_path, monkeypatch, capsys
):
    repo = _repo(tmp_path / "repo")
    _refused_namespace(repo, monkeypatch, capsys, tmp_path)
    code, payload = _json(monkeypatch, capsys, repo, "verification", "set", "--stdin", stdin="- Run the tests.\n")
    assert code == 1 and payload["error"]["code"] == "INVALID_INPUT"
    assert not (repo / ".bugpilot").exists()
    policy = repo / ".bugpilot" / "verification.md"
    policy.parent.mkdir()
    policy.write_text("kept\n", encoding="utf-8")
    for action in ("clear", "reset"):
        assert _json(monkeypatch, capsys, repo, "verification", action)[0] == 1
    assert policy.read_text(encoding="utf-8") == "kept\n"


# --- M-P: the MCP Fix Mode tools ---------------------------------------------------------------------------


def test_mp_an_identity_refusal_is_one_sentence_with_invalid_input(tmp_path, monkeypatch, capsys):
    repo = _repo(tmp_path / "repo")
    _refused_namespace(repo, monkeypatch, capsys, tmp_path)
    server = _server(repo)
    for tool, arguments, action in (("list_fix_modes", {}, "list the Fix Modes"),
                                    ("show_fix_mode", {"mode_id": "standard"}, "read the Fix Modes")):
        message = _tool_error(server, tool, arguments)
        assert message.startswith(f"Error executing tool {tool}: Could not {action} [INVALID_INPUT]: BugPilot will not use ")
        _no_absolute_path(message, tmp_path)
    assert storage._active_scope() is None


def test_mp_a_raw_system_error_stays_the_sdks_crash_and_shows_nothing(tmp_path, monkeypatch):
    from mcp.server.mcpserver.exceptions import UnexpectedToolError

    from bugpilot import mcp_server

    repo = _repo(tmp_path / "repo")

    def crash(_repo_root):
        raise OSError(errno.EIO, "I/O error", str(tmp_path / "secret"))

    monkeypatch.setattr(mcp_server, "catalog_for", crash)
    with pytest.raises(UnexpectedToolError) as excinfo:
        asyncio.run(_server(repo).call_tool("list_fix_modes", {}))
    assert str(excinfo.value) == "Error executing tool list_fix_modes"


def test_mp_a_healthy_catalog_answers_as_before(tmp_path, monkeypatch, capsys):
    repo = _repo(tmp_path / "repo")
    assert _json(monkeypatch, capsys, repo, "fix-mode", "duplicate", "standard", "team-fix", "--scope", "project")[0] == 0
    result = asyncio.run(_server(repo).call_tool("list_fix_modes", {}))
    assert result.is_error is not True
    assert set(result.structured_content) == {"default_mode_id", "modes", "issues"}
    assert any(mode["id"] == "team-fix" and mode["source"] == "project" for mode in result.structured_content["modes"])


# --- row 22: Fix Mode issues name their file in display form -----------------------------------------------


def test_row22_fix_mode_issues_name_their_file_in_display_form_for_both_scopes(tmp_path, monkeypatch, capsys):
    repo = _repo(tmp_path / "repo")
    (storage.repository_storage(repo).fix_modes_dir(create=True) / "broken.json").write_text("{ not json", encoding="utf-8")
    (storage.global_storage().user_fix_modes_dir(create=True) / "broken.json").write_text("{ not json", encoding="utf-8")
    code, listed = _json(monkeypatch, capsys, repo, "fix-mode", "list")
    assert code == 0
    assert sorted((issue["scope"], issue["path"]) for issue in listed["issues"]) == [
        ("project", _shown(repo, "fix_modes/broken.json")), ("user", "BUGPILOT_HOME/config/fix_modes/broken.json")]
    code, _out, err = _run(monkeypatch, capsys, repo, "fix-mode", "list")
    assert f"WARN: project Fix Mode {_shown(repo, 'fix_modes/broken.json')}: broken.json is not valid JSON" in err
    _no_absolute_path(json.dumps(listed) + err, tmp_path)
    issues = asyncio.run(_server(repo).call_tool("list_fix_modes", {})).structured_content["issues"]
    assert all(set(issue) == {"scope", "message"} for issue in issues) and len(issues) == 2


# --- R4: the 0.1.5 `.bugpilot/` is never read, copied or deleted ------------------------------------------


def test_r4_a_legacy_bugpilot_folder_is_never_read_copied_or_deleted(tmp_path, monkeypatch, capsys):
    repo = _repo(tmp_path / "repo")
    legacy = repo / ".bugpilot"
    (legacy / "fix_modes").mkdir(parents=True)
    (legacy / "instructions.md").write_text("LEGACY-SENTINEL-INSTRUCTIONS\n", encoding="utf-8")
    (legacy / "project_settings.json").write_text(json.dumps({"branch_naming": {"template": "legacy/{issue}"}}), encoding="utf-8")
    (legacy / "repository_profile.json").write_text(
        json.dumps({"mode": "custom", "custom": {"notes": "LEGACY-SENTINEL-PROFILE"}}), encoding="utf-8")
    (legacy / "fix_modes" / "legacy-mode.json").write_text(
        json.dumps({**_mode("legacy-mode"), "name": "LEGACY-SENTINEL-MODE"}), encoding="utf-8")
    before = _tree(legacy)

    seen = []
    for argv in (("instructions", "show"), ("project-settings", "show"), ("repository-profile", "show"),
                 ("fix-mode", "list", "--all-scopes"), ("bug", "JR-12345", "--allow-mock")):
        code, out, _err = _run(monkeypatch, capsys, repo, *argv, "--json")
        assert code == 0, argv
        seen.append(out)
    seen.append((repo / ".ai" / "JR-12345" / "task.md").read_text(encoding="utf-8"))
    seen.append(json.dumps(asyncio.run(_server(repo).call_tool("list_fix_modes", {})).structured_content))
    for text in seen:
        assert "LEGACY-SENTINEL" not in text and "legacy/{issue}" not in text
    assert load_project_settings(repo)[0].branch_template == ""
    assert load_instructions(repo).project.text == ""
    assert _tree(legacy) == before
    assert not (_namespace(repo) / "settings").exists()


# --- the designed differences' independent evidence (DD-4 to DD-12) -------------------------------------------


@pytest.fixture
def git_repo(tmp_path: Path) -> Path:
    repo = _repo(tmp_path / "repo")
    for args in (["init", "-q"], ["add", "-A"], ["commit", "-qm", "initial"]):
        subprocess.run([*GIT, *args], cwd=repo, check=True, capture_output=True)
    return repo


def _git_status(repo: Path) -> list[str]:
    return sorted(subprocess.run(["git", "status", "--porcelain=v1", "--untracked-files=all"], cwd=repo,
                                 check=True, capture_output=True, text=True).stdout.splitlines())


def test_dd4_project_instructions_are_written_to_the_namespace_and_nothing_into_the_repository(git_repo, monkeypatch, capsys):
    assert _json(monkeypatch, capsys, git_repo, "instructions", "set", "--scope", "project", "--stdin", stdin="Small.\n")[0] == 0
    assert _git_status(git_repo) == [] and not (git_repo / ".bugpilot").exists()
    assert (_namespace(git_repo) / "settings" / "instructions.md").read_text(encoding="utf-8") == "Small.\n"


def test_dd5_the_verification_policy_now_creates_the_bugpilot_folder_itself(git_repo, monkeypatch, capsys):
    assert _json(monkeypatch, capsys, git_repo, "instructions", "set", "--scope", "project", "--stdin", stdin="Small.\n")[0] == 0
    assert not (git_repo / ".bugpilot").exists()
    assert _json(monkeypatch, capsys, git_repo, "verification", "set", "--stdin", stdin="- Run the tests.\n")[0] == 0
    assert _git_status(git_repo) == ["?? .bugpilot/verification.md"]


def test_dd6_project_settings_are_written_to_the_namespace_and_nothing_into_the_repository(git_repo, monkeypatch, capsys):
    _save_settings(monkeypatch, capsys, git_repo)
    assert _git_status(git_repo) == [] and not (git_repo / ".bugpilot").exists()
    assert (_namespace(git_repo) / "settings" / "project_settings.json").is_file()


def test_dd7_the_repository_profile_is_written_to_the_namespace_and_nothing_into_the_repository(git_repo, monkeypatch, capsys):
    assert _run(monkeypatch, capsys, git_repo, "repository-profile", "set", "--mode", "generic")[0] == 0
    assert _git_status(git_repo) == [] and not (git_repo / ".bugpilot").exists()
    stored = json.loads((_namespace(git_repo) / "settings" / "repository_profile.json").read_text(encoding="utf-8"))
    assert stored["mode"] == "generic"


def test_dd8_a_project_fix_mode_is_written_to_the_namespace_and_nothing_into_the_repository(git_repo, monkeypatch, capsys):
    assert _json(monkeypatch, capsys, git_repo, "fix-mode", "duplicate", "standard", "team-fix", "--scope", "project")[0] == 0
    assert _git_status(git_repo) == [] and not (git_repo / ".bugpilot").exists()
    assert (_namespace(git_repo) / "settings" / "fix_modes" / "team-fix.json").is_file()


def test_dd9_only_the_verification_policy_and_ai_behavior_still_reach_git_status(git_repo, monkeypatch, capsys):
    source = git_repo.parent / "settings.json"
    source.write_text(json.dumps(TEMPLATE), encoding="utf-8")
    for argv, stdin in ((("instructions", "set", "--scope", "project", "--stdin"), "Small.\n"),
                        (("verification", "set", "--stdin"), "- Run the tests.\n"),
                        (("ai-behavior", "set", "--stdin"), "## Reporting Standards\n\n- Name the formats.\n"),
                        (("project-settings", "set", "--from-file", str(source)), None),
                        (("repository-profile", "set", "--mode", "generic"), None),
                        (("fix-mode", "duplicate", "standard", "team-fix", "--scope", "project"), None)):
        assert _json(monkeypatch, capsys, git_repo, *argv, stdin=stdin)[0] == 0, argv
    assert _git_status(git_repo) == ["?? .bugpilot/ai_behavior.md", "?? .bugpilot/verification.md"]


def test_dd10_instructions_show_names_the_project_file_in_display_form(tmp_path, monkeypatch, capsys):
    repo = _repo(tmp_path / "repo")
    assert _json(monkeypatch, capsys, repo, "instructions", "show")[1]["project"]["path"] == _shown(repo, "instructions.md")


def test_dd11_project_settings_show_names_its_file_in_display_form(tmp_path, monkeypatch, capsys):
    repo = _repo(tmp_path / "repo")
    assert _json(monkeypatch, capsys, repo, "project-settings", "show")[1]["path"] == _shown(repo, "project_settings.json")


def test_dd12_repository_profile_show_names_its_file_in_display_form(tmp_path, monkeypatch, capsys):
    repo = _repo(tmp_path / "repo")
    assert _json(monkeypatch, capsys, repo, "repository-profile", "show")[1]["path"] == _shown(
        repo, "repository_profile.json")
