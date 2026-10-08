"""`clean` and `bug --fresh` never delete through a link (pre-release Batch 1, E).

A symlinked or junctioned `.ai`, `.ai/<id>` or `.ai_memory` used to pass the
containment check — both sides were resolved through the same link — and
`shutil.rmtree` then deleted the link's target. Every case below puts a canary
outside the repository and proves it survives, that the refusal is one sentence
rather than a traceback, and that a refusal deletes nothing at all.

Links are made for real: POSIX symlinks (skipped where the OS will not create
one) and, on Windows, directory junctions, which need no privilege.
"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path

import pytest

from bugpilot.cli import main
from bugpilot.core.cleanup import clean_issue_artifacts
from bugpilot.core.safe_paths import UnsafePathError, is_link_or_junction, owned_path

WORK_ITEM = "JR-12345"


def _symlink(link: Path, target: Path) -> None:
    try:
        os.symlink(target, link, target_is_directory=True)
    except (OSError, NotImplementedError) as exc:  # Windows without the privilege
        pytest.skip(f"cannot create a symbolic link here: {exc}")


def _junction(link: Path, target: Path) -> None:
    if sys.platform != "win32":
        pytest.skip("directory junctions are a Windows feature")
    import _winapi

    _winapi.CreateJunction(str(target), str(link))


LINKERS = [
    pytest.param(_symlink, id="symlink"),
    pytest.param(_junction, id="junction"),
]


def _outside(tmp_path: Path) -> Path:
    """A directory outside the repository holding a work-item-shaped canary."""
    outside = tmp_path / "outside"
    victim = outside / WORK_ITEM
    victim.mkdir(parents=True)
    (victim / "precious.txt").write_text("not BugPilot's", encoding="utf-8")
    return outside


def _repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    repo.mkdir()
    return repo


def _canary_intact(outside: Path) -> bool:
    return (outside / WORK_ITEM / "precious.txt").read_text(encoding="utf-8") == "not BugPilot's"


# --- the link test itself ----------------------------------------------------


@pytest.mark.parametrize("make_link", LINKERS)
def test_a_link_or_junction_is_recognised_without_following_it(tmp_path, make_link):
    target = tmp_path / "target"
    target.mkdir()
    make_link(tmp_path / "link", target)

    assert is_link_or_junction(tmp_path / "link")
    assert not is_link_or_junction(target)
    assert not is_link_or_junction(tmp_path / "missing")


def test_owned_path_refuses_parts_that_are_not_one_name(tmp_path):
    for parts in ((".ai", ".."), (".ai", "a/b"), (".ai", ""), ()):
        with pytest.raises(UnsafePathError):
            owned_path(tmp_path, parts)


# --- `.ai` is a link -----------------------------------------------------------


@pytest.mark.parametrize("make_link", LINKERS)
def test_clean_refuses_an_ai_folder_that_is_a_link(tmp_path, make_link):
    outside = _outside(tmp_path)
    repo = _repo(tmp_path)
    make_link(repo / ".ai", outside)

    with pytest.raises(UnsafePathError, match=r"\.ai is a symbolic link or junction"):
        clean_issue_artifacts(repo, WORK_ITEM)

    assert _canary_intact(outside)
    assert is_link_or_junction(repo / ".ai"), "the link itself is the developer's, and is left alone"


@pytest.mark.parametrize("make_link", LINKERS)
def test_the_clean_command_reports_the_refusal_as_one_sentence(tmp_path, monkeypatch, capsys, make_link):
    outside = _outside(tmp_path)
    repo = _repo(tmp_path)
    make_link(repo / ".ai", outside)
    monkeypatch.chdir(repo)

    assert main(["clean", WORK_ITEM]) == 1
    err = capsys.readouterr().err

    assert err.startswith("ERROR: Refusing to delete .ai/JR-12345")
    assert "Nothing was deleted." in err
    assert "Traceback" not in err
    assert _canary_intact(outside)


@pytest.mark.parametrize("make_link", LINKERS)
def test_bug_fresh_refuses_an_ai_folder_that_is_a_link(tmp_path, monkeypatch, capsys, make_link):
    outside = _outside(tmp_path)
    repo = _repo(tmp_path)
    make_link(repo / ".ai", outside)
    monkeypatch.chdir(repo)

    assert main(["bug", WORK_ITEM, "--fresh", "--allow-mock"]) == 1
    err = capsys.readouterr().err

    assert "Refusing to delete .ai/JR-12345" in err
    assert "Traceback" not in err
    assert _canary_intact(outside)
    # Nothing was written through the link either: the run stopped first.
    assert sorted(path.name for path in (outside / WORK_ITEM).iterdir()) == ["precious.txt"]


@pytest.mark.parametrize("make_link", LINKERS)
def test_bug_fresh_refusal_is_a_terminal_stream_event(tmp_path, monkeypatch, capsys, make_link):
    """The extension's Fresh run reads this, not stderr."""
    outside = _outside(tmp_path)
    repo = _repo(tmp_path)
    make_link(repo / ".ai", outside)
    monkeypatch.chdir(repo)

    assert main(["bug", WORK_ITEM, "--fresh", "--allow-mock", "--prepare-only", "--json-lines"]) == 1
    events = [json.loads(line) for line in capsys.readouterr().out.splitlines() if line.strip()]

    assert events[-1]["type"] == "completed" and events[-1]["ok"] is False
    assert events[-1]["error"]["code"] == "INVALID_INPUT"
    assert "symbolic link or junction" in events[-1]["error"]["message"]
    assert _canary_intact(outside)


# --- `.ai/<id>` is a link -------------------------------------------------------


@pytest.mark.parametrize("make_link", LINKERS)
def test_clean_refuses_a_work_item_folder_that_is_a_link(tmp_path, make_link):
    outside = _outside(tmp_path)
    repo = _repo(tmp_path)
    (repo / ".ai").mkdir()
    make_link(repo / ".ai" / WORK_ITEM, outside / WORK_ITEM)

    with pytest.raises(UnsafePathError, match=r"\.ai/JR-12345 is a symbolic link or junction"):
        clean_issue_artifacts(repo, WORK_ITEM)

    assert _canary_intact(outside)
    assert is_link_or_junction(repo / ".ai" / WORK_ITEM)


@pytest.mark.parametrize("make_link", LINKERS)
def test_bug_fresh_refuses_a_work_item_folder_that_is_a_link(tmp_path, monkeypatch, capsys, make_link):
    outside = _outside(tmp_path)
    repo = _repo(tmp_path)
    (repo / ".ai").mkdir()
    make_link(repo / ".ai" / WORK_ITEM, outside / WORK_ITEM)
    monkeypatch.chdir(repo)

    assert main(["bug", WORK_ITEM, "--fresh", "--allow-mock"]) == 1
    assert "Traceback" not in capsys.readouterr().err
    assert _canary_intact(outside)


# --- a refusal deletes nothing ---------------------------------------------------


@pytest.mark.parametrize("make_link", LINKERS)
def test_a_linked_memory_folder_refuses_before_the_work_item_is_touched(tmp_path, make_link):
    outside = tmp_path / "outside"
    (outside / "bugs").mkdir(parents=True)
    (outside / "bugs" / f"{WORK_ITEM}.md").write_text("someone else's memory", encoding="utf-8")
    repo = _repo(tmp_path)
    (repo / ".ai" / WORK_ITEM).mkdir(parents=True)
    (repo / ".ai" / WORK_ITEM / "task.md").write_text("task", encoding="utf-8")
    make_link(repo / ".ai_memory", outside)

    with pytest.raises(UnsafePathError, match=r"\.ai_memory is a symbolic link or junction"):
        clean_issue_artifacts(repo, WORK_ITEM, include_memory=True)

    # Not a partial clean: the work item folder was checked-then-kept, not deleted.
    assert (repo / ".ai" / WORK_ITEM / "task.md").exists()
    assert (outside / "bugs" / f"{WORK_ITEM}.md").exists()


# --- the normal cases still work ---------------------------------------------------


def test_a_real_work_item_folder_is_cleaned(tmp_path):
    repo = _repo(tmp_path)
    work_item = repo / ".ai" / WORK_ITEM
    (work_item / "attachments").mkdir(parents=True)
    (work_item / "task.md").write_text("task", encoding="utf-8")
    (work_item / "attachments" / "crash.log").write_text("log", encoding="utf-8")

    result = clean_issue_artifacts(repo, WORK_ITEM)

    assert not work_item.exists()
    assert result.deleted_paths == [f".ai/{WORK_ITEM}/"]


def test_a_missing_work_item_folder_is_harmless(tmp_path):
    repo = _repo(tmp_path)

    result = clean_issue_artifacts(repo, WORK_ITEM, include_memory=True)

    assert result.deleted_paths == []
    assert result.missing_paths == [f".ai/{WORK_ITEM}/", f".ai_memory/bugs/{WORK_ITEM}.md"]


def test_only_the_named_work_item_and_its_memory_are_removed(tmp_path):
    repo = _repo(tmp_path)
    for name in (WORK_ITEM, "JR-99999", "local_20260926010922"):
        (repo / ".ai" / name).mkdir(parents=True)
        (repo / ".ai" / name / "task.md").write_text(name, encoding="utf-8")
    (repo / ".ai" / "notes.txt").write_text("the developer's", encoding="utf-8")
    (repo / ".ai_memory" / "bugs").mkdir(parents=True)
    for name in (WORK_ITEM, "JR-99999"):
        (repo / ".ai_memory" / "bugs" / f"{name}.md").write_text(name, encoding="utf-8")

    clean_issue_artifacts(repo, WORK_ITEM, include_memory=True)

    assert not (repo / ".ai" / WORK_ITEM).exists()
    assert not (repo / ".ai_memory" / "bugs" / f"{WORK_ITEM}.md").exists()
    assert (repo / ".ai" / "JR-99999" / "task.md").exists()
    assert (repo / ".ai" / "local_20260926010922" / "task.md").exists()
    assert (repo / ".ai" / "notes.txt").exists()
    assert (repo / ".ai_memory" / "bugs" / "JR-99999.md").exists()


@pytest.mark.parametrize("make_link", LINKERS)
def test_a_link_inside_the_work_item_is_removed_as_a_link_never_followed(tmp_path, make_link):
    """A developer's attachment folder linked elsewhere loses the link, not the files."""
    outside = _outside(tmp_path)
    repo = _repo(tmp_path)
    (repo / ".ai" / WORK_ITEM).mkdir(parents=True)
    make_link(repo / ".ai" / WORK_ITEM / "attachments", outside / WORK_ITEM)

    clean_issue_artifacts(repo, WORK_ITEM)

    assert not (repo / ".ai" / WORK_ITEM).exists()
    assert _canary_intact(outside)


def test_an_invalid_work_item_id_is_refused_before_any_path_is_built(tmp_path):
    repo = _repo(tmp_path)
    (repo / "keep").mkdir()

    for bad in ("..", "../keep", "keep/..", "JR-1/../../keep"):
        with pytest.raises(ValueError):
            clean_issue_artifacts(repo, bad)
    assert (repo / "keep").is_dir()
