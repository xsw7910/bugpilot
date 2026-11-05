"""Work items and bug memory in BugPilot's data folder (0.1.7, plan §14.3, "0.1.7 — Simplified Unified Storage").

A work item's files are ``<data folder>/repositories/<repository id>/work/<work item>/`` and its memory entry
``.../memory/<work item>.md``; the Verification Policy and AI Behavior join the other settings in ``.../settings/``.
These tests hold, on synthetic folders:

- that no command writes anything into the repository (R5);
- where the files are, the repository's path deciding it;
- that a 0.1.5/0.1.6 ``.ai/``, ``.ai_memory/`` or ``.bugpilot/`` left in a repository is never read, written or
  deleted (R4);
- what an agent is told: the task file and the report named absolutely, every other file by its plain name;
- that a data folder storage refuses leaves nothing prepared, and ``doctor`` says why;
- that a path an agent instruction cannot hold is refused, never altered.

Every expected place is built here from the repository's ID and the test's ``BUGPILOT_HOME``.
"""

from __future__ import annotations

import json
import os
import subprocess
from pathlib import Path

import pytest

from bugpilot.cli import main
from bugpilot.core import storage
from bugpilot.core.config import prompt_path
from bugpilot.core.safe_paths import UnsafePathError

GIT = ["git", "-c", "user.name=Dev", "-c", "user.email=dev@example.invalid", "-c", "commit.gpgsign=false"]
LEGACY = (".ai", ".ai_memory", ".bugpilot")


# --- helpers: places built from first principles ------------------------------------------------------------


def _repo(root: Path) -> Path:
    (root / "src").mkdir(parents=True)
    (root / "src" / "record.py").write_text("def save_record(record):\n    return record['id']\n", encoding="utf-8")
    for args in (["init", "-q"], ["add", "-A"], ["commit", "-qm", "initial"]):
        subprocess.run([*GIT, *args], cwd=root, check=True, capture_output=True)
    return root


def _namespace(root: Path) -> Path:
    return storage.data_root() / "repositories" / storage.repository_identity(root).repository_id


def _work(root: Path, item: str) -> Path:
    return _namespace(root) / "work" / item


def _tree(root: Path) -> set[str]:
    found = set()
    for current, folders, files in os.walk(root):
        folders[:] = [name for name in folders if not (current == str(root) and name == ".git")]
        found.update(Path(current, name).relative_to(root).as_posix() for name in folders + files)
    return found


def _run(monkeypatch, capsys, root: Path, *argv: str) -> tuple[int, str, str]:
    monkeypatch.chdir(root)
    code = main(list(argv))
    out, err = capsys.readouterr()
    return code, out, err


def _json(monkeypatch, capsys, root: Path, *argv: str) -> tuple[int, dict]:
    code, out, _err = _run(monkeypatch, capsys, root, *argv, "--json")
    return code, json.loads(out)


# --- the repository stays clean (R5) -------------------------------------------------------------------------


def test_no_command_writes_anything_into_the_repository(tmp_path, monkeypatch, capsys):
    """Preparing, retrying, recording and every settings write leave the repository as git committed it."""
    repo = _repo(tmp_path / "repo")
    inputs = tmp_path / "inputs"
    inputs.mkdir()
    review = inputs / "review.json"
    review.write_text(json.dumps({"summary": "Looks right.", "findings": "", "validation_notes": "", "recommendations": ""}), encoding="utf-8")
    checks = inputs / "checks.json"
    checks.write_text(json.dumps({"checks": [{"name": "unit tests", "status": "passed"}]}), encoding="utf-8")
    policy = inputs / "verification.md"
    policy.write_text("Run the focused tests.\n", encoding="utf-8")
    behavior = inputs / "behavior.md"
    behavior.write_text("## Reporting Standards\n\n- Name the formats the change affects.\n", encoding="utf-8")
    before = _tree(repo)
    for argv in (
        ["bug", "JR-12345", "--allow-mock", "--json"],
        ["bug", "--description=Saving a record crashes with a KeyError in src/record.py", "--title", "Save crash", "--json"],
        ["bug", "JR-12345", "--retry", "--json"],
        ["manual-result", "JR-12345"],
        ["record-review", "JR-12345", "--from-file", str(review), "--json"],
        ["record-verification", "JR-12345", "--from-file", str(checks), "--json"],
        ["jira-comment-draft", "JR-12345"],
        ["notify", "JR-12345"],
        ["verification", "set", "--from-file", str(policy), "--json"],
        ["ai-behavior", "set", "--from-file", str(behavior), "--json"],
        ["list", "--json"],
        ["status", "JR-12345", "--json"],
        ["task-preview", "JR-12345", "--json"],
        ["context-preview", "JR-12345", "--json"],
        ["review-package", "JR-12345", "--json"],
    ):
        code, out, err = _run(monkeypatch, capsys, repo, *argv)
        assert code == 0, (argv, out[-400:], err[-400:])
    assert _tree(repo) == before
    status = subprocess.run(["git", "status", "--porcelain", "--untracked-files=all"], cwd=repo, capture_output=True, text=True, check=True)
    assert status.stdout == ""


# --- where the files are -------------------------------------------------------------------------------------


def test_work_items_and_memory_are_in_the_repositorys_folder_of_the_data_folder(tmp_path, monkeypatch, capsys):
    repo = _repo(tmp_path / "repo")
    code, payload = _json(monkeypatch, capsys, repo, "bug", "JR-12345", "--allow-mock")
    assert code == 0, payload
    work = _work(repo, "JR-12345")
    assert {"task.md", "context.md", "issue.json", "retrieval.json", "run.json"} <= {path.name for path in work.iterdir()}
    assert (_namespace(repo) / "memory" / "JR-12345.md").is_file()
    assert (_namespace(repo) / "repository.json").is_file()
    # The fields whose job is a path are absolute; the record of what exists names it inside the namespace.
    assert Path(payload["issue_dir"]) == work
    assert Path(payload["agent_task"]) == work / "task.md"
    assert "work/JR-12345/task.md" in payload["generated_files"] and "memory/JR-12345.md" in payload["generated_files"]
    run = json.loads((work / "run.json").read_text(encoding="utf-8"))
    assert all(not os.path.isabs(name) for name in run["generated_files"]), run["generated_files"]
    code, listed = _json(monkeypatch, capsys, repo, "list")
    assert [item["work_item_id"] for item in listed["work_items"]] == ["JR-12345"]


def test_two_repositories_with_the_same_work_item_id_keep_their_own_files(tmp_path, monkeypatch, capsys):
    first, second = _repo(tmp_path / "a" / "app"), _repo(tmp_path / "b" / "app")
    for repo in (first, second):
        assert _run(monkeypatch, capsys, repo, "bug", "JR-12345", "--allow-mock")[0] == 0
    assert _work(first, "JR-12345") != _work(second, "JR-12345")
    assert _work(first, "JR-12345").is_dir() and _work(second, "JR-12345").is_dir()
    assert _run(monkeypatch, capsys, first, "clean", "JR-12345")[0] == 0
    assert not _work(first, "JR-12345").exists() and _work(second, "JR-12345").is_dir()


# --- the 0.1.5/0.1.6 folders: never read, written or deleted (R4) ---------------------------------------------


def test_a_legacy_work_item_memory_or_setting_in_the_repository_is_never_used_or_touched(tmp_path, monkeypatch, capsys):
    repo = _repo(tmp_path / "repo")
    legacy = {
        ".ai/JR-777/issue.json": '{"schema_version": 1, "id": "JR-777"}\n',
        ".ai/JR-12345/context.md": "LEGACY CANARY\n",
        ".ai_memory/bugs/JR-1.md": "# JR-1\n\nsave_record KeyError LEGACY CANARY\n",
        ".bugpilot/verification.md": "---\nschema_version: 1\nbased_on_version: 1\nmode: replace\n---\n\nLEGACY CANARY\n",
        ".bugpilot/ai_behavior.md": "---\nschema_version: 1\nbased_on_version: 1\nmode: append\n---\n\n## Evidence Standards\n\n- LEGACY CANARY\n",
    }
    for relative, text in legacy.items():
        (repo / relative).parent.mkdir(parents=True, exist_ok=True)
        (repo / relative).write_text(text, encoding="utf-8")
    before = {relative: (repo / relative).read_bytes() for relative in legacy}

    code, listed = _json(monkeypatch, capsys, repo, "list")
    assert code == 0 and listed["work_items"] == []
    assert _run(monkeypatch, capsys, repo, "bug", "JR-12345", "--allow-mock")[0] == 0
    task = (_work(repo, "JR-12345") / "task.md").read_text(encoding="utf-8")
    context = (_work(repo, "JR-12345") / "context.md").read_text(encoding="utf-8")
    assert "LEGACY CANARY" not in task and "LEGACY CANARY" not in context
    code, out, _err = _run(monkeypatch, capsys, repo, "memory", "search", "save_record KeyError")
    assert code == 0 and "LEGACY CANARY" not in out and "JR-1.md" not in out
    assert _run(monkeypatch, capsys, repo, "clean", "JR-12345", "--include-memory")[0] == 0
    assert {relative: (repo / relative).read_bytes() for relative in legacy} == before


# --- what an agent is told -----------------------------------------------------------------------------------


def test_the_task_and_the_handoff_name_the_work_folder_absolutely(tmp_path, monkeypatch, capsys):
    repo = _repo(tmp_path / "repo")
    code, out, _err = _run(monkeypatch, capsys, repo, "bug", "JR-12345", "--allow-mock")
    assert code == 0
    folder = prompt_path(_work(repo, "JR-12345"))
    assert f"  Read {folder}/task.md and complete the workflow." in out
    task = (_work(repo, "JR-12345") / "task.md").read_text(encoding="utf-8")
    assert f"outside the repository, in `{folder}/`. File names in this task are in that folder." in task
    assert f"Write one report: `{folder}/fix_report.md`" in task
    # Every other file by its plain name; no work item path in the repository (the protected staging rule still
    # names `.ai/`, BugPilot's former folders, unchanged).
    assert "- Read `context.md`:" in task and ".ai/JR-12345" not in task
    code, payload = _json(monkeypatch, capsys, repo, "bug", "JR-12345", "--retry")
    retry = (_work(repo, "JR-12345") / "agent_retry_prompt.md").read_text(encoding="utf-8")
    assert f"in its work folder, outside the repository: `{folder}/`" in retry
    assert retry.rstrip().endswith(f"Read {folder}/agent_retry_prompt.md and continue the workflow.")
    assert Path(payload["retry_prompt"]) == _work(repo, "JR-12345") / "agent_retry_prompt.md"


def test_a_path_an_agent_instruction_cannot_hold_is_refused_never_altered():
    assert prompt_path(Path("C:\\Users\\Dev\\.bugpilot\\work\\JR-1")) == "C:/Users/Dev/.bugpilot/work/JR-1"
    assert prompt_path(Path("/home/a dev/é/.bugpilot/work/JR-1")) == "/home/a dev/é/.bugpilot/work/JR-1"
    for bad in ("/home/dev`s/.bugpilot", "/home/dev\x1b[0m/.bugpilot", "/home/dev\u2028/.bugpilot", "/home/dev\x7f/x"):
        with pytest.raises(UnsafePathError, match="cannot name its work folder in an agent's instructions"):
            prompt_path(Path(bad))


# --- a data folder storage refuses ---------------------------------------------------------------------------


def test_a_data_folder_inside_the_repository_prepares_nothing_and_doctor_says_why(tmp_path, monkeypatch, capsys):
    """Refused before anything is read or written; `doctor` fails closed with the same sentence (since 0.1.6 Batch
    2B-2, the user configuration is in the data folder too), which the extension shows in these words."""
    repo = _repo(tmp_path / "repo")
    monkeypatch.setenv("BUGPILOT_HOME", str(repo / "bugpilot-data"))
    code, report = _json(monkeypatch, capsys, repo, "doctor")
    assert code == 1 and report["error"]["code"] == "INVALID_INPUT"
    assert "will not keep its data inside a Git working tree" in report["error"]["message"]
    code, out, err = _run(monkeypatch, capsys, repo, "bug", "JR-12345", "--allow-mock")
    assert code != 0
    assert "will not keep its data inside" in out + err
    assert not (repo / "bugpilot-data").exists()
    assert not any((repo / name).exists() for name in LEGACY)


def test_a_relative_data_folder_is_refused_before_anything_is_read(tmp_path, monkeypatch, capsys):
    repo = _repo(tmp_path / "repo")
    monkeypatch.setenv("BUGPILOT_HOME", "relative/data")
    code, report = _json(monkeypatch, capsys, repo, "doctor")
    assert code == 1 and report["error"]["code"] == "INVALID_INPUT"
    assert "BUGPILOT_HOME must be an absolute path" in report["error"]["message"]
    assert _run(monkeypatch, capsys, repo, "bug", "JR-12345", "--allow-mock")[0] != 0
    assert not (repo / "relative").exists() and not any((repo / name).exists() for name in LEGACY)
