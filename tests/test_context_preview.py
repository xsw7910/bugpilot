"""The Effective Context: `bugpilot context-preview` (0.1.4, plan section 43).

The context BugPilot last generated — the stored `context.md`, byte for byte —
and whether it is still current, from the Effective AI Task's comparison and
the prepared files. Never a new context: no search, no Git, no Jira, no
process, no file written. Stale is still shown; nothing is not an error.
"""

from __future__ import annotations

import hashlib
import json
import subprocess
from pathlib import Path

import pytest

from bugpilot.core.config import data_dir, issue_dir
from bugpilot.cli import main
from bugpilot.core.ai_behavior import render_document as render_ai_behavior
from bugpilot.core.context import (
    CONTEXT_FORMAT,
    MISSING_CORE_EVIDENCE_CAP,
    ContextQuality,
    _quality_markdown,
    read_context_quality,
)
from bugpilot.core.context_preview import NO_CONTEXT, UNCHECKED, preview_context
from bugpilot.core.doctor import CAPABILITIES
from bugpilot.core.retrieval import load_retrieval
from bugpilot.core.storage import StorageError
from bugpilot.core.verification import render_document as render_verification


@pytest.fixture
def repo(tmp_path) -> Path:
    root = tmp_path / "repo"
    root.mkdir()
    (root / "pyproject.toml").write_text('[project]\nname = "inventory"\nversion = "1.0"\n', encoding="utf-8")
    (root / "inventory").mkdir()
    (root / "inventory" / "app.py").write_text(
        "def save_record(record):\n    return record['employee_search']\n", encoding="utf-8"
    )
    return root


def _json(monkeypatch, capsys, root: Path, *argv: str) -> tuple[int, dict]:
    monkeypatch.chdir(root)
    code = main([*argv, "--json"])
    return code, json.loads(capsys.readouterr().out)


def _prepare(monkeypatch, capsys, root: Path, *argv: str) -> str:
    code, payload = _json(monkeypatch, capsys, root, "bug", *(argv or ("JR-12345", "--allow-mock")), "--prepare-only")
    assert code == 0, payload
    return payload["work_item_id"]


def _context_md(root: Path, work_item: str) -> str:
    return (issue_dir(root, work_item) / "context.md").read_bytes().decode("utf-8").replace("\r\n", "\n")


def _settings_file(root: Path, name: str) -> Path:
    """A repository's own settings file, where 0.1.6 keeps it, its folder made ready by storage (Batch 2B-3a)."""
    from bugpilot.core import storage

    return storage.repository_storage(root).settings_file(name, create=True)


def _snapshot(*roots: Path) -> dict[str, tuple[int, int, str]]:
    found = {}
    for root in roots:
        for path in sorted(root.rglob("*")):
            if path.is_file():
                data = path.read_bytes()
                found[str(path)] = (len(data), path.stat().st_mtime_ns, hashlib.sha256(data).hexdigest())
    return found


# --- the last generated context, as it was handed over -----------------------------------------


def test_a_current_context_is_the_stored_file_with_its_stored_quality_and_confidence(repo, monkeypatch, capsys):
    work_item = _prepare(monkeypatch, capsys, repo)
    stored = _context_md(repo, work_item)
    before = _snapshot(repo)

    code, payload = _json(monkeypatch, capsys, repo, "context-preview", work_item)

    assert code == 0 and payload["ok"]
    assert (payload["work_item"], payload["state"], payload["label"]) == (work_item, "current", "Context status: Current")
    assert payload["text"] == stored
    assert payload["freshness"]["current"] is True and payload["freshness"]["reasons"] == []
    assert payload["freshness"]["checked"] == ["task_inputs", "artifacts"]
    assert [item["code"] for item in payload["freshness"]["unchecked"]] == ["retrieval_inputs", "issue_source"]
    assert payload["task"] == {"exists": True, "current": True, "changed_sections": []}
    # Context Quality as the file states it — this mock issue has no reproduction, actual or expected result.
    quality = read_context_quality(stored)
    assert payload["quality"] == {
        "overall": quality.overall, "issue_completeness": quality.issue_completeness,
        "retrieval_quality": quality.retrieval_quality, "repository_context": quality.repository_context,
        "cap": MISSING_CORE_EVIDENCE_CAP,
    }
    assert f"Overall: {quality.overall}/100\n" in stored
    # Search Confidence as retrieval.json stores it.
    retrieval = load_retrieval(repo, work_item)
    assert payload["retrieval"]["confidence"] == retrieval.confidence
    assert payload["retrieval"]["related_files"] == len(retrieval.related_files)
    assert payload["retrieval"]["terms"] == len(retrieval.terms)
    assert payload["retrieval"]["reason_codes"] == list(retrieval.confidence_details.reasons)
    assert payload["retrieval"]["reasons"] == list(retrieval.reasons)
    assert payload["generated"] == {
        "artifacts": {"issue": True, "context": True, "retrieval": True, "task": True, "run": True},
        "run_status": "prepared",
        "context_step": "pass",
        # S7 (0.1.5): written in today's format, as the run recorded — so no note that it predates containment.
        "context_format": CONTEXT_FORMAT,
        "context_format_current": CONTEXT_FORMAT,
    }
    assert payload["sources"]["issue"] == {"source": "jira", "mock": True}
    assert (payload["sources"]["hint"], payload["sources"]["attachments"], payload["sources"]["code_search"]) == (False, 0, True)
    assert payload["sources"]["fix_mode"] == {"id": "standard", "name": "Standard Fix"}
    assert payload["problems"] == [] and payload["warnings"] == []
    assert _snapshot(repo) == before


def test_the_json_carries_the_context_once_and_no_paths(repo, monkeypatch, capsys, tmp_path):
    work_item = _prepare(monkeypatch, capsys, repo)
    _, payload = _json(monkeypatch, capsys, repo, "context-preview", work_item)
    assert list(payload) == [
        "schema_version", "ok", "command", "work_item", "state", "label", "text", "generated", "freshness", "task",
        "quality", "retrieval", "sources", "problems", "warnings",
    ]
    outside_text = json.dumps({key: value for key, value in payload.items() if key != "text"})
    assert "# Bug Context" not in outside_text and "## Issue Details" not in outside_text
    assert str(tmp_path) not in json.dumps(payload)


# --- stale: still shown, and why ----------------------------------------------------------------


@pytest.mark.parametrize(
    ("layer", "code", "label"),
    [
        ("user", "user_instructions_changed", "User Instructions"),
        ("project", "project_instructions_changed", "Project Instructions"),
        ("verification", "verification_changed", "Verification Policy"),
        ("ai_behavior", "ai_behavior_changed", "AI Behavior"),
        ("repository_profile", "repository_profile_changed", "Repository Profile"),
    ],
)
def test_a_changed_task_input_makes_the_context_stale_and_it_is_still_shown(
    repo, monkeypatch, capsys, user_config_folder, layer, code, label
):
    work_item = _prepare(monkeypatch, capsys, repo)
    stored = _context_md(repo, work_item)
    prepared_files = _snapshot((data_dir(repo) / "work"))
    if layer == "repository_profile":
        payload = repo / "profile.json"
        payload.write_text(json.dumps({"mode": "generic"}), encoding="utf-8")
        monkeypatch.chdir(repo)
        assert main(["repository-profile", "set", "--from-file", str(payload)]) == 0
        capsys.readouterr()
        payload.unlink()
    else:
        path, text = {
            "user": (user_config_folder / "instructions.md", "Explain every decision.\n"),
            "project": (None, "Name the module owner.\n"),  # where 0.1.6 keeps it: made below
            "verification": ((data_dir(repo) / "settings" / "verification.md"), render_verification("- Run the full suite.")),
            "ai_behavior": ((data_dir(repo) / "settings" / "ai_behavior.md"), render_ai_behavior("- Quote the failing line.")),
        }[layer]
        path = path or _settings_file(repo, "instructions.md")
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text, encoding="utf-8")

    _, stale = _json(monkeypatch, capsys, repo, "context-preview", work_item)

    assert (stale["state"], stale["label"]) == ("stale", "Context status: Needs rebuild")
    assert stale["freshness"]["current"] is False
    assert stale["freshness"]["reasons"] == [{"code": code, "label": label}]
    assert stale["text"] == stored, "a stale context must still be shown as it was generated"
    assert _snapshot((data_dir(repo) / "work")) == prepared_files, "previewing rebuilt something"

    monkeypatch.chdir(repo)
    assert main(["context-preview", work_item]) == 0
    out = capsys.readouterr().out
    assert out.startswith("Context status: Needs rebuild\n") and f"Changed since generation:\n- {label}\n" in out


def test_putting_the_input_back_makes_it_current_again(repo, monkeypatch, capsys):
    work_item = _prepare(monkeypatch, capsys, repo)
    instructions = _settings_file(repo, "instructions.md")
    instructions.write_text("Name the module owner.\n", encoding="utf-8")
    assert preview_context(repo, work_item).state == "stale"
    instructions.unlink()
    assert preview_context(repo, work_item).state == "current"


def test_a_branch_naming_change_is_named_as_such(repo, monkeypatch, capsys):
    work_item = _prepare(monkeypatch, capsys, repo)
    _settings_file(repo, "project_settings.json").write_text(
        json.dumps({"branch_naming": {"template": "bugfix/{issue}-{slug}"}}), encoding="utf-8"
    )
    codes = [reason.code for reason in preview_context(repo, work_item).reasons]
    # Saving project settings at all also moves the Verification Policy's source: both are true.
    assert codes == ["verification_changed", "branch_changed"]


# --- nothing to show, and things missing ---------------------------------------------------------


def test_no_work_item_is_an_answer_not_an_error(repo, monkeypatch, capsys):
    code, payload = _json(monkeypatch, capsys, repo, "context-preview")
    assert code == 0 and payload["ok"]
    assert (payload["state"], payload["label"], payload["work_item"], payload["text"]) == (
        "unavailable", NO_CONTEXT, None, None,
    )
    assert NO_CONTEXT == "No generated context available. Build context first."
    assert payload["freshness"]["current"] is None and payload["quality"] is None and payload["sources"] is None
    monkeypatch.chdir(repo)
    assert main(["context-preview"]) == 0
    assert capsys.readouterr().out == NO_CONTEXT + "\n"
    assert not ((data_dir(repo) / "work")).exists()


def test_a_work_item_never_prepared_has_no_context_yet(repo, monkeypatch, capsys):
    code, payload = _json(monkeypatch, capsys, repo, "context-preview", "JR-12345")
    assert code == 0 and (payload["state"], payload["text"]) == ("not-generated", None)
    assert not ((data_dir(repo) / "work")).exists()


def test_a_work_item_whose_context_was_never_built_is_not_generated(repo, monkeypatch, capsys):
    monkeypatch.chdir(repo)
    assert main(["bug", "JR-12345", "--allow-mock", "--only-issue-details", "--json"]) == 0
    capsys.readouterr()
    assert not (issue_dir(repo, "JR-12345") / "context.md").exists()
    assert preview_context(repo, "JR-12345").state == "not-generated"


def test_a_context_that_was_generated_and_is_gone_is_missing(repo, monkeypatch, capsys):
    work_item = _prepare(monkeypatch, capsys, repo)
    (issue_dir(repo, work_item) / "context.md").unlink()
    _, payload = _json(monkeypatch, capsys, repo, "context-preview", work_item)
    assert payload["ok"] and payload["state"] == "missing" and payload["text"] is None
    assert payload["generated"]["artifacts"]["context"] is False and payload["generated"]["context_step"] == "pass"


def test_an_unreadable_context_is_said_so_not_shown(repo, monkeypatch, capsys):
    work_item = _prepare(monkeypatch, capsys, repo)
    (issue_dir(repo, work_item) / "context.md").write_bytes(b"\xff\xfe not utf-8")
    _, payload = _json(monkeypatch, capsys, repo, "context-preview", work_item)
    assert payload["ok"] and payload["state"] == "unreadable" and payload["text"] is None
    assert payload["problems"] == [f"work/{work_item}/context.md could not be read as UTF-8 text."]


def test_a_namespace_storage_refuses_is_not_previewed(repo, monkeypatch, capsys):
    """0.1.7: storage's checks of the data folder come before any file of the work item is read, so a namespace
    whose record names another repository fails the preview instead of showing its files."""
    work_item = _prepare(monkeypatch, capsys, repo)
    record = data_dir(repo) / "repository.json"
    record.write_text(json.dumps({**json.loads(record.read_text(encoding="utf-8")), "root": str(repo.parent)}), encoding="utf-8")
    with pytest.raises(StorageError, match="belongs to a different repository folder"):
        preview_context(repo, work_item)


def test_a_linked_work_item_folder_is_not_read(repo, tmp_path):
    elsewhere = tmp_path / "elsewhere"
    elsewhere.mkdir()
    (elsewhere / "context.md").write_text("# Bug Context: JR-12345\n", encoding="utf-8")
    (data_dir(repo) / "work").mkdir(parents=True)
    try:
        (issue_dir(repo, "JR-12345")).symlink_to(elsewhere, target_is_directory=True)
    except OSError as exc:
        pytest.skip(f"cannot create a symbolic link here: {exc}")
    preview = preview_context(repo, "JR-12345")
    assert preview.state == "unreadable" and preview.text is None
    assert "link or junction" in preview.problems[0]


@pytest.mark.parametrize(
    ("damage", "code"),
    [("delete", "retrieval_missing"), ("corrupt", "retrieval_unreadable"), ("old-schema", "retrieval_unreadable")],
)
def test_a_missing_or_unusable_retrieval_never_reads_as_current(repo, monkeypatch, capsys, damage, code):
    work_item = _prepare(monkeypatch, capsys, repo)
    path = issue_dir(repo, work_item) / "retrieval.json"
    if damage == "delete":
        path.unlink()
    elif damage == "corrupt":
        path.write_text("{not json", encoding="utf-8")
    else:
        path.write_text(json.dumps({"schema_version": 0}), encoding="utf-8")
    _, payload = _json(monkeypatch, capsys, repo, "context-preview", work_item)
    assert payload["ok"] and payload["state"] == "stale"
    assert [reason["code"] for reason in payload["freshness"]["reasons"]] == [code]
    assert payload["text"] == _context_md(repo, work_item) and payload["retrieval"] is None
    assert (payload["problems"] != []) == (damage != "delete")


def test_a_context_step_that_did_not_pass_or_a_missing_task_is_stale(repo, monkeypatch, capsys):
    work_item = _prepare(monkeypatch, capsys, repo)
    run = issue_dir(repo, work_item) / "run.json"
    data = json.loads(run.read_text(encoding="utf-8"))
    data["steps"]["context"] = "fail"
    run.write_text(json.dumps(data), encoding="utf-8")
    assert [reason.code for reason in preview_context(repo, work_item).reasons] == ["context_step_not_passed"]

    work_item = _prepare(monkeypatch, capsys, repo, "--description", "Saving a record crashes")
    (issue_dir(repo, work_item) / "task.md").unlink()
    assert [reason.code for reason in preview_context(repo, work_item).reasons] == ["task_missing"]


def test_a_task_that_differs_only_outside_its_sections_is_stale_not_current(repo, monkeypatch, capsys):
    """Its title edited (or its sections reordered): no section's body differs, yet it is not the task BugPilot writes."""
    work_item = _prepare(monkeypatch, capsys, repo)
    task = issue_dir(repo, work_item) / "task.md"
    first, rest = task.read_bytes().decode("utf-8").split("\n", 1)
    task.write_bytes(f"{first} (edited by hand)\n{rest}".encode("utf-8"))

    preview = preview_context(repo, work_item)
    assert preview.task is not None and preview.task.task_current is False and preview.task.changed_sections == ()
    assert preview.state == "stale"
    assert [reason.code for reason in preview.reasons] == ["task_changed_outside_sections"]


def test_a_context_whose_work_item_cannot_be_checked_is_unknown_not_current(repo, monkeypatch, capsys):
    work_item = _prepare(monkeypatch, capsys, repo)
    (issue_dir(repo, work_item) / "issue.json").write_text("{broken", encoding="utf-8")
    _, payload = _json(monkeypatch, capsys, repo, "context-preview", work_item)
    assert payload["ok"] and payload["state"] == "unknown" and payload["freshness"]["current"] is None
    assert payload["text"] == _context_md(repo, work_item)
    assert payload["problems"], "an unknown status must say why"


def test_an_id_that_cannot_be_a_work_item_is_refused(repo, monkeypatch, capsys):
    code, payload = _json(monkeypatch, capsys, repo, "context-preview", "../outside-1")
    assert code == 1 and payload["error"]["code"] == "INVALID_INPUT"


# --- read-only, and no retrieval ------------------------------------------------------------------


def test_previewing_runs_no_retrieval_no_process_no_jira_and_writes_nothing(repo, monkeypatch, capsys, isolate_bugpilot_config):
    subprocess.run(["git", "init", "-q"], cwd=repo, check=True)
    git = ["git", "-c", "user.email=dev@example.invalid", "-c", "user.name=Dev"]
    subprocess.run([*git, "add", "-A"], cwd=repo, check=True)
    subprocess.run([*git, "commit", "-qm", "init"], cwd=repo, check=True)
    work_item = _prepare(monkeypatch, capsys, repo)
    project = _settings_file(repo, "instructions.md")
    project.write_text("Name the module owner.\n", encoding="utf-8")
    namespace = project.parent.parent  # the repository's namespace in the data folder: nothing written there either
    before = _snapshot(repo, isolate_bugpilot_config, namespace)

    def refuse(*_args, **_kwargs):
        raise AssertionError("the context preview searched, started a process or talked to Jira")

    from bugpilot.core import git_history, jira, memory, search, workflow

    monkeypatch.setattr(subprocess, "run", refuse)
    monkeypatch.setattr(subprocess, "Popen", refuse)
    monkeypatch.setattr(search, "run_code_search", refuse)
    monkeypatch.setattr(workflow, "run_code_search", refuse)
    monkeypatch.setattr(git_history, "collect_git_history", refuse)
    monkeypatch.setattr(workflow, "collect_git_history", refuse)
    monkeypatch.setattr(memory, "search_memory", refuse)
    monkeypatch.setattr(workflow, "search_memory", refuse)
    for module in (jira, workflow):
        monkeypatch.setattr(module, "fetch_issue", refuse)
    for argv in (("context-preview", work_item), ("context-preview",), ("context-preview", "JR-99999")):
        _json(monkeypatch, capsys, repo, *argv)
        monkeypatch.chdir(repo)
        assert main(list(argv)) == 0
        capsys.readouterr()

    assert _snapshot(repo, isolate_bugpilot_config, namespace) == before


# --- Context Quality, read back exactly -----------------------------------------------------------


@pytest.mark.parametrize(
    "quality",
    [
        ContextQuality(75, 25, 85, 70, 75, ("Description found: yes", "Overall at most 75: the report has no reproduction steps, actual result or expected result.")),
        ContextQuality(86, 90, 80, 100, None, ("Reproduction steps found: yes",)),
        ContextQuality(100, 100, 100, 100, None, ()),
    ],
)
def test_context_quality_is_read_back_exactly_as_written(quality):
    text = "# Bug Context: JR-12345\n\n## Context Quality\n\n" + _quality_markdown(quality) + "\n\n## Issue Details\n\nx\n"
    assert read_context_quality(text) == quality


def test_a_context_without_a_quality_section_reads_as_none_with_a_warning(repo, monkeypatch, capsys):
    assert read_context_quality("# Bug Context: JR-12345\n\n## Issue\n\nx\n") is None
    work_item = _prepare(monkeypatch, capsys, repo)
    path = issue_dir(repo, work_item) / "context.md"
    path.write_text(_context_md(repo, work_item).replace("## Context Quality", "## Quality Notes"), encoding="utf-8")
    _, payload = _json(monkeypatch, capsys, repo, "context-preview", work_item)
    assert payload["quality"] is None and payload["state"] == "current"
    assert payload["warnings"] == [f"The Context Quality section of work/{work_item}/context.md could not be read."]


# --- the CLI ------------------------------------------------------------------------------------


def test_the_text_output_is_the_status_then_the_context(repo, monkeypatch, capsys):
    work_item = _prepare(monkeypatch, capsys, repo)
    monkeypatch.chdir(repo)
    assert main(["context-preview", work_item]) == 0
    out = capsys.readouterr().out
    head, context, tail = out.split("---\n", 2)
    assert head.startswith(f"Context status: Current\nWork item: {work_item}\nContext quality: ")
    assert "Search confidence: " in head and "Not checked here: " in head
    for _code, label in UNCHECKED:
        assert label in head
    assert context == _context_md(repo, work_item) and tail == ""


def test_the_help_says_it_never_builds_a_context(capsys):
    with pytest.raises(SystemExit) as stopped:
        main(["context-preview", "--help"])
    assert stopped.value.code == 0
    text = " ".join(capsys.readouterr().out.split())
    for expected in ("WORK_ITEM_ID", "--json", "never a new one, which only retrieval can produce",
                     "It runs no search, contacts no Jira, runs no Git command and writes nothing"):
        assert expected in text, expected


def test_doctor_lists_the_capability_last():
    # 0.1.7 appended one after it: the work items are in BugPilot's data folder.
    assert CAPABILITIES == (
        "verification-text", "ai-behavior-text", "protected-rules", "task-preview", "context-preview", "unified-storage"
    )
