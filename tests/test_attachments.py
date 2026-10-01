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
    MAX_ATTACHMENT_NOTE_CHARS,
    MAX_ATTACHMENTS,
    attachment_names,
    copy_attachments,
    is_plain_attachment_name,
    normalize_attachment_note,
    remove_attachments,
)
from bugpilot.core.prompts import generate_task


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
    task = generate_task("JR-1", "Crash", attachments=["crash.log", "shot.png"])

    assert "## Developer Attachments" in task
    assert "`.ai/JR-1/attachments/crash.log`" in task
    assert "`.ai/JR-1/attachments/shot.png`" in task
    # Told to say so rather than guess: whether a PNG is readable depends on the
    # agent and the model behind it, which is not knowable from here.
    assert "cannot read" in task


def test_no_attachments_means_no_section(tmp_path):
    """An empty heading is a question the agent has to ask and answer itself."""
    for attachments in ([], None):
        task = generate_task("JR-1", "Crash", attachments=attachments)
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
    task = generate_task("JR-1", "Crash", attachments=attachment_names(target))

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


# --- descriptions: why an attachment matters ---------------------------------


def test_a_description_follows_its_file_by_position(tmp_path):
    """The Nth description is the Nth file's, and goes where the file goes."""
    target = tmp_path / "item"
    target.mkdir()
    log = _file(tmp_path / "a", "crash.log")
    shot = _file(tmp_path / "b", "shot.png")

    result = copy_attachments(target, [str(log), str(shot)], ["Console output after Save.", "  "])

    assert result.copied == ["crash.log", "shot.png"]
    assert result.notes == {"crash.log": "Console output after Save."}


def test_a_description_follows_a_renamed_file_and_leaves_with_a_skipped_one(tmp_path):
    target = tmp_path / "item"
    target.mkdir()
    first = _file(tmp_path / "a", "crash.log")
    second = _file(tmp_path / "b", "crash.log")

    result = copy_attachments(
        target,
        [str(first), str(tmp_path / "gone.log"), str(second)],
        ["first run", "never arrived", "second run"],
    )

    assert result.copied == ["crash.log", "crash-2.log"]
    assert result.notes == {"crash.log": "first run", "crash-2.log": "second run"}


def test_a_description_is_one_bounded_line():
    """It sits under a heading: a pasted newline and `##` must not open a section."""
    assert normalize_attachment_note("Console output\n\n## right after\tSave ") == "Console output ## right after Save"
    assert len(normalize_attachment_note("x" * 2000)) == MAX_ATTACHMENT_NOTE_CHARS
    assert normalize_attachment_note(None) == ""


def test_the_task_file_gives_each_attachment_its_own_entry_with_its_description():
    task = generate_task(
        "JR-1",
        "Crash",
        attachments=["crash.log", "shot.png"],
        attachment_notes={"crash.log": "Console output immediately after clicking Save."},
    )
    section = task.split("## Developer Attachments")[1].split("\n## ")[0]

    assert "### crash.log\n\nDescription: Console output immediately after clicking Save.\nFile: `.ai/JR-1/attachments/crash.log`" in section
    # Blank: no empty "Description:" line, just the file.
    assert "### shot.png\n\nFile: `.ai/JR-1/attachments/shot.png`" in section
    assert section.count("Description:") == 1
    # Source-agnostic, and still honest about images.
    assert "Jira" not in section
    assert "cannot read" in section


def test_a_description_for_a_file_that_is_not_there_is_not_mentioned():
    task = generate_task("JR-1", "Crash", attachments=["crash.log"], attachment_notes={"gone.png": "secret note"})
    assert "gone.png" not in task
    assert "secret note" not in task


def test_descriptions_are_recorded_with_the_hint_and_survive_a_resume(tmp_path):
    """Written to issue.json's guidance, regenerated into task.md on --resume."""
    import json

    from bugpilot.core.input_adapters import bug_spec_from_description
    from bugpilot.core.models import InvestigationOptions, InvestigationRequest
    from bugpilot.core.workflow import run_investigation

    repo = tmp_path / "repo"
    (repo / "src").mkdir(parents=True)
    log = _file(tmp_path / "elsewhere", "crash.log", b"stack")
    spec = bug_spec_from_description("crash on save", repo_root=repo)

    first = run_investigation(
        repo,
        InvestigationRequest(
            spec=spec,
            options=InvestigationOptions(attachments=[str(log)], attachment_descriptions=["Console output after Save."]),
        ),
        fresh=True,
    )
    issue = json.loads((first.issue_dir / "issue.json").read_text(encoding="utf-8"))
    assert issue["guidance"]["attachment_notes"] == {"crash.log": "Console output after Save."}
    assert "Description: Console output after Save." in (first.issue_dir / "task.md").read_text(encoding="utf-8")

    # --resume with no --attach at all: the file is still there, so is its note.
    run_investigation(repo, InvestigationRequest(spec=spec, options=InvestigationOptions()), fresh=False)
    assert "Description: Console output after Save." in (first.issue_dir / "task.md").read_text(encoding="utf-8")

    # The same file again with its description cleared: the note goes.
    run_investigation(
        repo,
        InvestigationRequest(spec=spec, options=InvestigationOptions(attachments=[str(log)], attachment_descriptions=[""])),
        fresh=False,
    )
    task = (first.issue_dir / "task.md").read_text(encoding="utf-8")
    assert "### crash.log" in task
    assert "Description:" not in task
    issue = json.loads((first.issue_dir / "issue.json").read_text(encoding="utf-8"))
    assert "attachment_notes" not in issue["guidance"]


def test_without_descriptions_issue_json_is_what_it_always_was(tmp_path):
    import json

    from bugpilot.core.input_adapters import bug_spec_from_description
    from bugpilot.core.models import InvestigationOptions, InvestigationRequest
    from bugpilot.core.workflow import run_investigation

    repo = tmp_path / "repo"
    (repo / "src").mkdir(parents=True)
    log = _file(tmp_path / "elsewhere", "crash.log", b"stack")
    result = run_investigation(
        repo,
        InvestigationRequest(
            spec=bug_spec_from_description("crash on save", repo_root=repo),
            options=InvestigationOptions(attachments=[str(log)]),
        ),
        fresh=True,
    )
    issue = json.loads((result.issue_dir / "issue.json").read_text(encoding="utf-8"))
    assert set(issue["guidance"]) == {"hint", "fix_mode"}


def test_the_cli_pairs_descriptions_by_position_and_refuses_a_mismatch(tmp_path, monkeypatch, capsys):
    import json

    from bugpilot.cli import main

    monkeypatch.chdir(tmp_path)
    log = _file(tmp_path / "elsewhere", "crash.log", b"stack")
    shot = _file(tmp_path / "elsewhere", "shot.png", b"png")

    code = main([
        "bug", "--description", "crash on save",
        f"--attach={log}", f"--attach={shot}",
        "--attach-description=Console output after Save.", "--attach-description=",
        "--prepare-only", "--json",
    ])
    assert code == 0
    work_item = json.loads(capsys.readouterr().out)["work_item_id"]
    task = (tmp_path / ".ai" / work_item / "task.md").read_text(encoding="utf-8")
    assert "### crash.log\n\nDescription: Console output after Save." in task
    assert "### shot.png\n\nFile:" in task

    code = main([
        "bug", "--description", "another crash", f"--attach={log}", f"--attach={shot}",
        "--attach-description=only one", "--prepare-only", "--json",
    ])
    assert code != 0
    assert "--attach-description per --attach" in capsys.readouterr().out


# --- the current selection is the whole set (§37.99) ---------------------------


def _exact_run(repo, spec, attachments, descriptions=None, fresh=False):
    """A run the way the extension starts one: --replace-attachments, the full selection."""
    from bugpilot.core.models import InvestigationOptions, InvestigationRequest
    from bugpilot.core.workflow import run_investigation

    return run_investigation(
        repo,
        InvestigationRequest(
            spec=spec,
            options=InvestigationOptions(
                attachments=[str(path) for path in attachments],
                attachment_descriptions=list(descriptions or []),
                replace_attachments=True,
            ),
        ),
        fresh=fresh,
    )


def _workspace(tmp_path):
    from bugpilot.core.input_adapters import bug_spec_from_description

    repo = tmp_path / "repo"
    (repo / "src").mkdir(parents=True)
    a = _file(tmp_path / "elsewhere", "a.png", b"png bytes")
    b = _file(tmp_path / "elsewhere", "b.log", b"log lines")
    return repo, bug_spec_from_description("crash on save", repo_root=repo), a, b


def _state(result):
    import json

    task = (result.issue_dir / "task.md").read_text(encoding="utf-8")
    guidance = json.loads((result.issue_dir / "issue.json").read_text(encoding="utf-8"))["guidance"]
    on_disk = sorted(path.name for path in (result.issue_dir / ATTACHMENTS_DIR).iterdir()) if (result.issue_dir / ATTACHMENTS_DIR).is_dir() else []
    return task, guidance, on_disk


def test_resume_with_the_same_selection_keeps_every_file_and_description(tmp_path):
    repo, spec, a, b = _workspace(tmp_path)
    _exact_run(repo, spec, [a, b], ["The dialog.", "After Save."], fresh=True)
    task, guidance, on_disk = _state(_exact_run(repo, spec, [a, b], ["The dialog.", "After Save."]))

    assert on_disk == ["a.png", "b.log"]
    assert guidance["attachment_files"] == ["a.png", "b.log"]
    assert guidance["attachment_notes"] == {"a.png": "The dialog.", "b.log": "After Save."}
    assert "### a.png\n\nDescription: The dialog." in task
    assert "### b.log\n\nDescription: After Save." in task


def test_removing_one_attachment_removes_it_from_the_folder_the_record_and_the_task(tmp_path):
    repo, spec, a, b = _workspace(tmp_path)
    _exact_run(repo, spec, [a, b], ["The dialog.", "After Save."], fresh=True)
    result = _exact_run(repo, spec, [a], ["The dialog."])
    task, guidance, on_disk = _state(result)

    assert on_disk == ["a.png"]
    assert guidance["attachment_files"] == ["a.png"]
    assert guidance["attachment_notes"] == {"a.png": "The dialog."}
    assert "b.log" not in task
    assert "After Save." not in task
    # The developer's original is untouched: only the work item's copy went.
    assert b.exists()


def test_removing_every_attachment_leaves_no_section_and_an_empty_record(tmp_path):
    repo, spec, a, b = _workspace(tmp_path)
    _exact_run(repo, spec, [a, b], ["The dialog.", ""], fresh=True)
    task, guidance, on_disk = _state(_exact_run(repo, spec, []))

    assert on_disk == []
    assert guidance["attachment_files"] == []
    assert "attachment_notes" not in guidance
    assert "Developer Attachments" not in task


def test_a_changed_description_replaces_the_old_one_and_a_cleared_one_is_gone(tmp_path):
    repo, spec, a, b = _workspace(tmp_path)
    _exact_run(repo, spec, [a, b], ["Old words.", "Kept words."], fresh=True)
    task, guidance, _ = _state(_exact_run(repo, spec, [a, b], ["New words.", ""]))

    assert guidance["attachment_notes"] == {"a.png": "New words."}
    assert "Description: New words." in task
    assert "Old words." not in task
    assert "Kept words." not in task
    assert task.count("Description:") == 1


def test_files_bugpilot_did_not_record_are_never_deleted(tmp_path):
    """Only recorded names go: a file someone put in the folder by hand stays."""
    repo, spec, a, b = _workspace(tmp_path)
    first = _exact_run(repo, spec, [a, b], fresh=True)
    by_hand = _file(first.issue_dir / ATTACHMENTS_DIR, "by-hand.txt", b"mine")
    context = first.issue_dir / "context.md"
    assert context.exists()

    result = _exact_run(repo, spec, [a])
    task, guidance, on_disk = _state(result)

    assert on_disk == ["a.png", "by-hand.txt"]
    assert by_hand.read_bytes() == b"mine"
    assert context.exists()
    # Not named either: the record is the selection.
    assert "by-hand.txt" not in task
    assert guidance["attachment_files"] == ["a.png"]


def test_a_tampered_record_cannot_delete_outside_the_attachments_folder(tmp_path):
    import json

    repo, spec, a, b = _workspace(tmp_path)
    first = _exact_run(repo, spec, [a], fresh=True)
    outside = _file(tmp_path, "outside.txt", b"keep me")
    sibling = first.issue_dir / "context.md"
    issue_path = first.issue_dir / "issue.json"
    issue = json.loads(issue_path.read_text(encoding="utf-8"))
    issue["guidance"]["attachment_files"] = [
        "a.png", "../context.md", "..\\context.md", "../../../outside.txt", str(outside), "sub/x.png", "", ".", "..",
    ]
    issue_path.write_text(json.dumps(issue), encoding="utf-8")

    _exact_run(repo, spec, [])

    assert outside.read_bytes() == b"keep me"
    assert sibling.exists()
    assert not (first.issue_dir / ATTACHMENTS_DIR / "a.png").exists()


def test_remove_attachments_takes_plain_names_inside_the_folder_only(tmp_path):
    target = tmp_path / "item"
    keep = _file(target, "context.md", b"x")
    outside = _file(tmp_path, "outside.txt", b"x")
    inside = _file(target / ATTACHMENTS_DIR, "a.png", b"x")

    removed = remove_attachments(
        target, ["../context.md", "..\\outside.txt", str(outside), "C:x", "", ".", "..", "attachments/a.png", "a.png", "gone.png"]
    )

    assert removed == ["a.png"]
    assert not inside.exists()
    assert keep.exists() and outside.exists()
    assert not is_plain_attachment_name("../a.png")
    assert is_plain_attachment_name("screenshot-1.png")


def test_a_work_item_from_before_the_record_keeps_its_old_files_but_stops_naming_them(tmp_path):
    """No record means no proof of ownership: nothing is deleted, the task names only the selection."""
    from bugpilot.core.models import InvestigationOptions, InvestigationRequest
    from bugpilot.core.workflow import run_investigation

    repo, spec, a, b = _workspace(tmp_path)
    # Additive, as every run was before: no record is kept.
    first = run_investigation(
        repo, InvestigationRequest(spec=spec, options=InvestigationOptions(attachments=[str(a), str(b)])), fresh=True
    )
    task, guidance, _ = _state(first)
    assert "attachment_files" not in guidance
    assert "### b.log" in task

    task, guidance, on_disk = _state(_exact_run(repo, spec, [a]))
    assert on_disk == ["a.png", "b.log"]
    assert guidance["attachment_files"] == ["a.png"]
    assert "b.log" not in task


def test_without_the_flag_a_resume_still_adds_to_what_is_there(tmp_path):
    """The CLI's behaviour for everyone else is unchanged: --attach adds."""
    from bugpilot.core.models import InvestigationOptions, InvestigationRequest
    from bugpilot.core.workflow import run_investigation

    repo, spec, a, b = _workspace(tmp_path)
    run_investigation(repo, InvestigationRequest(spec=spec, options=InvestigationOptions(attachments=[str(a), str(b)])), fresh=True)
    result = run_investigation(repo, InvestigationRequest(spec=spec, options=InvestigationOptions(attachments=[str(a)])), fresh=False)
    task, _, on_disk = _state(result)
    assert on_disk == ["a.png", "b.log"]
    assert "### b.log" in task


def test_fresh_still_starts_from_nothing(tmp_path):
    repo, spec, a, b = _workspace(tmp_path)
    _exact_run(repo, spec, [a, b], ["The dialog.", "After Save."], fresh=True)
    task, guidance, on_disk = _state(_exact_run(repo, spec, [b], fresh=True))
    assert on_disk == ["b.log"]
    assert guidance["attachment_files"] == ["b.log"]
    assert "attachment_notes" not in guidance
    assert "a.png" not in task


def test_the_cli_flag_makes_the_selection_the_whole_set(tmp_path, monkeypatch, capsys):
    import json

    from bugpilot.cli import main

    monkeypatch.chdir(tmp_path)
    a = _file(tmp_path / "elsewhere", "a.png", b"png")
    b = _file(tmp_path / "elsewhere", "b.log", b"log")
    # A Jira work item, so the second run resumes the same one (a typed bug gets a new id each run).
    assert main(["bug", "JR-12345", "--allow-mock", f"--attach={a}", f"--attach={b}", "--replace-attachments", "--prepare-only", "--json"]) == 0
    work_item = json.loads(capsys.readouterr().out)["work_item_id"]
    folder = tmp_path / ".ai" / work_item
    assert sorted(path.name for path in (folder / ATTACHMENTS_DIR).iterdir()) == ["a.png", "b.log"]

    # The panel's resume with everything removed: no --attach at all, the flag says so.
    assert main(["bug", "JR-12345", "--allow-mock", "--resume", "--replace-attachments", "--prepare-only", "--json"]) == 0
    capsys.readouterr()
    assert sorted(path.name for path in (folder / ATTACHMENTS_DIR).iterdir()) == []
    assert "Developer Attachments" not in (folder / "task.md").read_text(encoding="utf-8")
