"""Files a developer hands to the agent, and the one rule that governs them.

The rule: **the agent is told about exactly the files it can read.** An
attachment that did not make it is never named in the task file, and the
developer is told it did not make it. Those two halves are the same fact from
the two sides that matter.
"""

from __future__ import annotations

import hashlib
from pathlib import Path

from bugpilot.core.attachments import (
    ATTACHMENTS_DIR,
    MAX_ATTACHMENT_BYTES,
    MAX_ATTACHMENTS,
    attachment_names,
    copy_attachments,
)
from bugpilot.core.prompts import generate_prompts


def _file(directory: Path, name: str, content: bytes = b"data") -> Path:
    path = directory / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return path


# --- copying ----------------------------------------------------------------


def test_a_file_is_copied_byte_for_byte(tmp_path):
    """No encoding assumption anywhere: a screenshot is the point of this feature."""
    png = bytes([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]) + bytes(range(256))
    source = _file(tmp_path / "elsewhere", "shot.png", png)
    target = tmp_path / "item"
    target.mkdir()

    result = copy_attachments(target, [str(source)])

    assert result.copied == ["shot.png"]
    copied = (target / ATTACHMENTS_DIR / "shot.png").read_bytes()
    assert hashlib.sha256(copied).digest() == hashlib.sha256(png).digest()


def test_a_missing_file_costs_itself_and_nothing_else(tmp_path):
    """One unreadable screenshot must not take an investigation down with it."""
    good = _file(tmp_path / "elsewhere", "crash.log", b"stack trace")
    target = tmp_path / "item"
    target.mkdir()

    result = copy_attachments(target, [str(good), str(tmp_path / "gone.log")])

    assert result.copied == ["crash.log"]
    assert len(result.skipped) == 1
    assert result.skipped[0][1] == "not a file"


def test_a_directory_is_not_an_attachment(tmp_path):
    target = tmp_path / "item"
    target.mkdir()
    (tmp_path / "folder").mkdir()

    result = copy_attachments(target, [str(tmp_path / "folder")])

    assert result.copied == []
    assert result.skipped[0][1] == "not a file"


def test_an_oversized_file_is_refused_with_its_size_named(tmp_path):
    """A crash dump is a download, not an attachment, and `.ai/` lives in a repo."""
    source = _file(tmp_path / "elsewhere", "dump.bin", b"x" * (MAX_ATTACHMENT_BYTES + 1))
    target = tmp_path / "item"
    target.mkdir()

    result = copy_attachments(target, [str(source)])

    assert result.copied == []
    assert "10 MB" in result.skipped[0][1]


def test_two_files_with_the_same_name_do_not_overwrite_each_other(tmp_path):
    """The loss nobody notices until the agent quotes the wrong log."""
    first = _file(tmp_path / "a", "log.txt", b"first")
    second = _file(tmp_path / "b", "log.txt", b"second")
    target = tmp_path / "item"
    target.mkdir()

    result = copy_attachments(target, [str(first), str(second)])

    assert result.copied == ["log.txt", "log-2.txt"]
    assert (target / ATTACHMENTS_DIR / "log.txt").read_bytes() == b"first"
    assert (target / ATTACHMENTS_DIR / "log-2.txt").read_bytes() == b"second"


def test_there_is_a_ceiling_on_how_many(tmp_path):
    """Past this it is a directory, and an agent handed thirty files reads none."""
    target = tmp_path / "item"
    target.mkdir()
    sources = [str(_file(tmp_path / "many", f"file{index}.txt")) for index in range(MAX_ATTACHMENTS + 3)]

    result = copy_attachments(target, sources)

    assert len(result.copied) == MAX_ATTACHMENTS
    assert len(result.skipped) == 3
    assert all("more than" in reason for _, reason in result.skipped)


def test_nothing_asked_for_means_no_directory_at_all(tmp_path):
    """An empty `attachments/` folder in every work item would be noise."""
    target = tmp_path / "item"
    target.mkdir()

    assert copy_attachments(target, []).copied == []
    assert not (target / ATTACHMENTS_DIR).exists()
    assert attachment_names(target) == []


def test_names_are_read_back_from_disk(tmp_path):
    """So a `--resume` run lists what a previous run copied."""
    target = tmp_path / "item"
    target.mkdir()
    copy_attachments(target, [str(_file(tmp_path / "e", "b.log")), str(_file(tmp_path / "e", "a.log"))])

    assert attachment_names(target) == ["a.log", "b.log"]


# --- what the agent is told --------------------------------------------------


def test_the_task_file_names_each_attachment(tmp_path):
    task = generate_prompts("JR-1", "Crash", attachments=["crash.log", "shot.png"])["agent_task.md"]

    assert "## Developer Attachments" in task
    assert "`.ai/JR-1/attachments/crash.log`" in task
    assert "`.ai/JR-1/attachments/shot.png`" in task
    # Told to say so rather than guess: whether a PNG is readable depends on the
    # agent and the model behind it, which is not knowable from here.
    assert "cannot read" in task


def test_no_attachments_means_no_section(tmp_path):
    """An empty heading is a question the agent has to ask and answer itself."""
    for attachments in ([], None):
        task = generate_prompts("JR-1", "Crash", attachments=attachments)["agent_task.md"]
        assert "Developer Attachments" not in task


def test_the_task_file_can_only_name_files_that_arrived(tmp_path):
    """The two halves of the rule, together.

    `copy_attachments` drops what it could not take, the prompt is built from
    what is on disk, and so the agent is never sent after a file that is not
    there.
    """
    target = tmp_path / "item"
    target.mkdir()
    good = _file(tmp_path / "elsewhere", "crash.log", b"stack")

    result = copy_attachments(target, [str(good), str(tmp_path / "vanished.png")])
    task = generate_prompts("JR-1", "Crash", attachments=attachment_names(target))["agent_task.md"]

    assert "crash.log" in task
    assert "vanished.png" not in task
    assert result.skipped[0][0].endswith("vanished.png")


def test_a_run_that_writes_no_task_file_says_the_agent_will_not_see_them(tmp_path):
    """The same silent loss, arriving from the other direction.

    `--only-issue-details` copies the files and skips the `prompt` step, so
    nothing names them — and without this the developer attaches a log, the run
    succeeds, and the agent is never told. Found by running it, not by reading.
    """
    from bugpilot.core.input_adapters import bug_spec_from_description
    from bugpilot.core.models import InvestigationOptions, InvestigationPlan, InvestigationRequest
    from bugpilot.core.workflow import run_investigation

    repo = tmp_path / "repo"
    (repo / "src").mkdir(parents=True)
    source = _file(tmp_path / "elsewhere", "crash.log", b"stack")

    request = InvestigationRequest(
        spec=bug_spec_from_description("crash on save", repo_root=repo),
        options=InvestigationOptions(attachments=[str(source)]),
        # `--only-issue-details`: no context is built, so no task file is written.
        plan=InvestigationPlan(
            code_search=False, git_history=False, similar_fixes=False, build_context=False
        ),
    )
    result = run_investigation(repo, request, fresh=True)

    assert any("no agent will be told" in warning for warning in result.warnings)
    # The file is still there: a human may well want to look at it.
    assert attachment_names(result.issue_dir) == ["crash.log"]
