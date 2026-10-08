"""BugPilot never writes a generated file through a link (pre-release Batch 2, D).

Batch 1 made deletion link-safe. A normal run could still write `issue.json`,
`task.md`, attachments and memory entries through a symlinked or junctioned
`.ai`, `.ai/<id>` or `.ai_memory`, landing them wherever the link pointed. Every
generated path is now checked by `safe_paths.writable_dir` / `refuse_link`
before anything is created or written: these tests put a canary outside the
repository and prove nothing reaches it, that the refusal is one sentence, and
that a refused run writes nothing at all — while ordinary folders, missing
folders and a repository reached through a link keep working.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

from bugpilot.cli import main
from bugpilot.core.config import writable_issue_dir, writable_memory_file
from bugpilot.core.safe_paths import UnsafePathError, writable_dir

WORK_ITEM = "JR-12345"


def _symlink(link: Path, target: Path) -> None:
    try:
        os.symlink(target, link, target_is_directory=target.is_dir())
    except (OSError, NotImplementedError) as exc:
        pytest.skip(f"cannot create a symbolic link here: {exc}")


def _junction(link: Path, target: Path) -> None:
    if sys.platform != "win32":
        pytest.skip("directory junctions are a Windows feature")
    import _winapi

    _winapi.CreateJunction(str(target), str(link))


LINKERS = [pytest.param(_symlink, id="symlink"), pytest.param(_junction, id="junction")]


@pytest.fixture
def repo(tmp_path, monkeypatch):
    root = tmp_path / "repo"
    root.mkdir()
    monkeypatch.chdir(root)
    return root


@pytest.fixture
def outside(tmp_path):
    target = tmp_path / "outside"
    target.mkdir()
    (target / "canary.txt").write_text("not BugPilot's", encoding="utf-8")
    return target


def _untouched(outside: Path) -> bool:
    return sorted(path.name for path in outside.rglob("*")) == ["canary.txt"]


def _prepare(*extra: str) -> int:
    return main(["bug", WORK_ITEM, "--allow-mock", "--prepare-only", *extra])


@pytest.mark.parametrize("make_link", LINKERS)
def test_a_run_refuses_to_write_through_a_linked_ai_folder(repo, outside, capsys, make_link):
    make_link(repo / ".ai", outside)

    assert _prepare() == 1
    err = capsys.readouterr().err

    assert "BugPilot cannot write .ai/JR-12345: .ai is a symbolic link or junction" in err
    assert "Nothing was written." in err
    assert "Traceback" not in err
    assert _untouched(outside)


@pytest.mark.parametrize("make_link", LINKERS)
def test_a_run_refuses_to_write_through_a_linked_work_item_folder(repo, outside, capsys, make_link):
    (repo / ".ai").mkdir()
    make_link(repo / ".ai" / WORK_ITEM, outside)

    assert _prepare() == 1
    assert "BugPilot cannot write .ai/JR-12345: .ai/JR-12345 is a symbolic link or junction" in capsys.readouterr().err
    assert _untouched(outside)


@pytest.mark.parametrize("make_link", LINKERS)
def test_a_linked_memory_folder_refuses_the_run_before_anything_is_written(repo, outside, capsys, make_link):
    make_link(repo / ".ai_memory", outside)

    assert _prepare() == 1
    assert ".ai_memory is a symbolic link or junction" in capsys.readouterr().err
    assert _untouched(outside)
    assert not (repo / ".ai").exists(), "a partial package was written before the refusal"


@pytest.mark.parametrize("make_link", LINKERS)
def test_a_linked_memory_bugs_folder_is_refused_too(repo, outside, capsys, make_link):
    (repo / ".ai_memory").mkdir()
    make_link(repo / ".ai_memory" / "bugs", outside)

    assert _prepare() == 1
    assert _untouched(outside)


def test_the_json_lines_stream_ends_with_a_terminal_failure(repo, outside, capsys):
    _junction(repo / ".ai", outside) if sys.platform == "win32" else _symlink(repo / ".ai", outside)

    assert _prepare("--json-lines") == 1
    events = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.strip()]
    assert events[-1]["type"] == "completed" and events[-1]["ok"] is False
    assert events[-1]["error"]["code"] == "INVALID_INPUT"
    assert _untouched(outside)


def test_a_linked_file_inside_the_work_item_is_never_written_through(repo, outside, capsys):
    assert _prepare() == 0
    task = repo / ".ai" / WORK_ITEM / "task.md"
    task.unlink()
    _symlink(task, outside / "canary.txt")

    assert _prepare() == 1
    assert "task.md is a symbolic link or junction" in capsys.readouterr().err
    assert (outside / "canary.txt").read_text(encoding="utf-8") == "not BugPilot's"


def test_the_retry_prompt_is_never_written_through_a_linked_file(repo, outside, capsys):
    assert _prepare() == 0
    prompt = repo / ".ai" / WORK_ITEM / "agent_retry_prompt.md"
    _symlink(prompt, outside / "canary.txt")

    assert main(["retry-prompt", WORK_ITEM]) == 1
    assert "agent_retry_prompt.md is a symbolic link or junction" in capsys.readouterr().err
    assert (outside / "canary.txt").read_text(encoding="utf-8") == "not BugPilot's"


@pytest.mark.parametrize("make_link", LINKERS)
def test_an_attachments_folder_that_is_a_link_is_not_copied_into(repo, outside, tmp_path, make_link):
    assert _prepare() == 0
    make_link(repo / ".ai" / WORK_ITEM / "attachments", outside)
    log = tmp_path / "crash.log"
    log.write_text("Traceback", encoding="utf-8")

    main(["bug", WORK_ITEM, "--allow-mock", "--prepare-only", "--attach", str(log)])

    assert _untouched(outside)


@pytest.mark.parametrize("make_link", LINKERS)
def test_recording_a_review_refuses_a_linked_work_item(repo, outside, tmp_path, capsys, make_link):
    (repo / ".ai").mkdir()
    make_link(repo / ".ai" / WORK_ITEM, outside)
    review = tmp_path / "review.json"
    review.write_text(json.dumps({"summary": "Looks fine."}), encoding="utf-8")

    assert main(["record-review", WORK_ITEM, "--from-file", str(review)]) == 1
    assert "symbolic link or junction" in capsys.readouterr().err
    assert _untouched(outside)


@pytest.mark.parametrize("make_link", LINKERS)
def test_standalone_steps_refuse_too(repo, outside, capsys, make_link):
    """`context`, `retry-prompt`, `memory add`: every writer, not only `bug`."""
    assert _prepare() == 0
    (repo / ".ai" / WORK_ITEM).rename(outside / WORK_ITEM)
    (repo / ".ai").rmdir()
    make_link(repo / ".ai", outside)
    before = sorted(path.name for path in (outside / WORK_ITEM).iterdir())

    for argv in (["context", WORK_ITEM], ["retry-prompt", WORK_ITEM], ["memory", "add", WORK_ITEM], ["agent-task", WORK_ITEM]):
        assert main(argv) == 1, argv
        assert "Traceback" not in capsys.readouterr().err
    assert sorted(path.name for path in (outside / WORK_ITEM).iterdir()) == before


def test_a_work_item_id_that_would_leave_ai_is_refused(repo, capsys):
    for bad in ("../../escape-1", "..", "JR-1/../../x-1"):
        assert main(["context", bad]) == 1, bad
    assert not (repo.parent / "escape-1").exists()
    assert not any(path.name == "escape-1" for path in repo.parent.rglob("*"))


# --- what must keep working -----------------------------------------------------------


def test_missing_folders_are_created_and_ordinary_ones_used(repo):
    assert _prepare() == 0
    assert (repo / ".ai" / WORK_ITEM / "task.md").is_file()
    assert (repo / ".ai_memory" / "bugs" / f"{WORK_ITEM}.md").is_file()
    assert _prepare() == 0, "a second run into the real folders it made"


@pytest.mark.parametrize("make_link", LINKERS)
def test_a_repository_reached_through_a_link_still_works(tmp_path, monkeypatch, make_link):
    """Only the generated folders are checked: the repository may live behind a link."""
    real = tmp_path / "real-repo"
    real.mkdir()
    make_link(tmp_path / "linked-repo", real)
    monkeypatch.chdir(tmp_path / "linked-repo")

    assert _prepare() == 0
    assert (real / ".ai" / WORK_ITEM / "task.md").is_file()


def test_the_helpers_directly(repo, outside):
    created = writable_dir(repo, (".ai", WORK_ITEM))
    assert created.is_dir()
    assert writable_dir(repo, (".ai", "JR-99999"), create=False) == repo / ".ai" / "JR-99999"
    assert not (repo / ".ai" / "JR-99999").exists()
    assert writable_issue_dir(repo, WORK_ITEM) == created
    assert writable_memory_file(repo, WORK_ITEM).name == f"{WORK_ITEM}.md"
    with pytest.raises(UnsafePathError):
        writable_issue_dir(repo, "../x-1")
    (repo / "not-a-dir").write_text("x", encoding="utf-8")
    with pytest.raises(UnsafePathError, match="is not a directory"):
        writable_dir(repo, ("not-a-dir", "y"))
