"""context.md and task.md: the two agent-facing artifacts (plan §37, Batch 3).

Six files used to carry what an agent reads — a context, a git report, a memory
report, a task, a handoff and a copy of the team instructions. Two remain.
Git history and similar fixes are gathered in memory and rendered into
``context.md``; the handoff and the team instructions are sections of
``task.md``. These tests hold the file contract, that nothing the agent used to
receive was lost on the way, that the standalone commands work without the
intermediate files, and that the old layout is not read.
"""

from __future__ import annotations

import copy
import json
import shutil
import subprocess
from pathlib import Path

import pytest

from bugpilot import mcp_server
from bugpilot.cli import main
from bugpilot.core import workflow
from bugpilot.core.input_adapters import bug_spec_from_description
from bugpilot.core.jira import JiraFetchResult
from bugpilot.core.models import InvestigationOptions, InvestigationRequest

needs_rg = pytest.mark.skipif(shutil.which("rg") is None, reason="code search needs ripgrep")
needs_git = pytest.mark.skipif(shutil.which("git") is None, reason="git history needs git")

# The canonical prepare-stage contract: exactly these five, nothing else.
PREPARED_FILES = {"issue.json", "retrieval.json", "context.md", "task.md", "run.json"}
# Every file context.md, task.md and run.json replaced. Normal execution writes none.
LEGACY_FILES = (
    "bug_context.md",
    "git_context.md",
    "memory_search.md",
    "agent_task.md",
    "agent_handoff.md",
    "agent_team_instructions.md",
    "workflow_status.json",
    "execution.log",
)

HINT = "Check output validation"

PAYLOAD = {
    "key": "JR-12345",
    "fields": {
        "summary": "WidgetController rejects a valid output type",
        "description": (
            "Steps to Reproduce\n"
            "1. Open sample-repo\n"
            "2. Select the CSV output type\n\n"
            "Actual Result\n"
            "Error: InvalidOutputType: CSV is not allowed\n\n"
            "Expected Result\n"
            "CSV is accepted.\n"
        ),
        "issuetype": {"name": "Bug"},
        "status": {"name": "Open"},
        "priority": {"name": "High"},
        "labels": ["output"],
        "comment": {"comments": [{"created": "2026-05-10T09:00:00.000+0000", "body": "Still broken on 2026.1"}]},
    },
}


@pytest.fixture
def fake_jira(monkeypatch):
    def fetch(repo_root, issue_key, allow_mock=False):
        return JiraFetchResult(issue_key, "jira", True, None, None, copy.deepcopy(PAYLOAD))

    monkeypatch.setattr(workflow, "fetch_issue", fetch)


def _repo(root: Path) -> Path:
    (root / "src").mkdir()
    (root / "src" / "WidgetController.cpp").write_text(
        '#include "WidgetController.h"\n'
        "bool WidgetController::validate(OutputType type) {\n"
        "  // CSV output type is filtered here\n"
        "  return type != OutputType::CSV;\n"
        "}\n",
        encoding="utf-8",
    )
    (root / "src" / "WidgetController.h").write_text(
        "class WidgetController {\n public:\n  bool validate(OutputType type);\n};\n", encoding="utf-8"
    )
    return root


def _git(root: Path, *args: str) -> None:
    subprocess.run(["git", *args], cwd=root, check=True, capture_output=True)


def _git_repo(root: Path) -> Path:
    _repo(root)
    _git(root, "init", "-q")
    _git(root, "config", "user.email", "dev@example.com")
    _git(root, "config", "user.name", "Dev")
    _git(root, "add", "src")
    _git(root, "commit", "-q", "-m", "Filter the CSV output type in WidgetController")
    return root


def _seed_memory(root: Path) -> None:
    """A past fix the search should find: it shares the issue's vocabulary."""
    bugs = root / ".ai_memory" / "bugs"
    bugs.mkdir(parents=True, exist_ok=True)
    (bugs / "JR-11111.md").write_text(
        "# JR-11111: WidgetController dropped the CSV output type\n\n"
        "Fixed in src/WidgetController.cpp: validate() filtered CSV.\n",
        encoding="utf-8",
    )


def _manual(root: Path, *, hint: str | None = HINT, fix_mode_id: str | None = None) -> str:
    spec = bug_spec_from_description(
        "WidgetController rejects the CSV output type.\n\nError: InvalidOutputType thrown by validate",
        title="Output type cannot select CSV",
    )
    request = InvestigationRequest(
        spec=spec,
        options=InvestigationOptions(hint=hint, keywords=["WidgetController"]),
        fix_mode_id=fix_mode_id,
    )
    workflow.run_investigation(root, request)
    return spec.work_item_id


def _jira(root: Path, *, hint: str | None = HINT, fresh: bool = True) -> str:
    request = workflow.jira_request("JR-12345")
    workflow.run_investigation(root, request, hint=hint, fresh=fresh)
    return "JR-12345"


def _files(root: Path, work_item: str) -> set[str]:
    return {path.name for path in (root / ".ai" / work_item).iterdir()}


def _read(root: Path, work_item: str, name: str) -> str:
    return (root / ".ai" / work_item / name).read_text(encoding="utf-8")


def _section(markdown: str, heading: str) -> str:
    """The body under a `## ` heading, up to the next `## ` heading."""
    body = markdown.split(f"\n{heading}\n", 1)[1]
    return body.split("\n## ", 1)[0]


# --- the file contract ----------------------------------------------------------


@needs_rg
def test_a_manual_prepare_writes_exactly_the_canonical_files(tmp_path):
    work_item = _manual(_repo(tmp_path))

    assert _files(tmp_path, work_item) == PREPARED_FILES
    assert len(_files(tmp_path, work_item)) == 5


@needs_rg
def test_a_jira_prepare_writes_exactly_the_canonical_files(tmp_path, fake_jira):
    work_item = _jira(_repo(tmp_path))

    assert _files(tmp_path, work_item) == PREPARED_FILES
    status = json.loads(_read(tmp_path, work_item, "run.json"))
    for name in LEGACY_FILES:
        assert not any(name in path for path in status["generated_files"]), name


@needs_rg
def test_a_resumed_run_rewrites_the_two_files_and_no_others(tmp_path, fake_jira):
    _jira(_repo(tmp_path))
    (tmp_path / ".ai" / "JR-12345" / "context.md").unlink()
    (tmp_path / ".ai" / "JR-12345" / "task.md").unlink()

    _jira(tmp_path, hint=None, fresh=False)

    assert _files(tmp_path, "JR-12345") == PREPARED_FILES
    assert HINT in _read(tmp_path, "JR-12345", "task.md")
    assert HINT in _read(tmp_path, "JR-12345", "context.md")


# --- context.md -----------------------------------------------------------------


@needs_rg
def test_the_context_carries_guidance_issue_and_code_search(tmp_path):
    work_item = _manual(_repo(tmp_path), fix_mode_id="investigate-first")
    context = _read(tmp_path, work_item, "context.md")

    assert context.startswith(f"# Bug Context: {work_item}\n")
    guidance = _section(context, "## Guidance")
    assert f"- Developer hint: {HINT}" in guidance
    assert "Investigate First (`investigate-first`)" in guidance
    issue = _section(context, "## Issue")
    assert "- Source: Hand-written description" in issue
    assert "- Summary: Output type cannot select CSV" in issue
    # The description itself, which the old context left to a separate file.
    assert "WidgetController rejects the CSV output type." in _section(context, "## Issue Details")
    search = _section(context, "## Code Search")
    assert f"`.ai/{work_item}/retrieval.json`" in search
    assert "- `src/WidgetController.cpp` confidence=high" in search
    assert "#### src/WidgetController.cpp" in search
    assert "`return type != OutputType::CSV;`" in search


@needs_rg
def test_a_jira_context_carries_the_jira_fields_and_comments(tmp_path, fake_jira):
    context = _read(tmp_path, _jira(_repo(tmp_path)), "context.md")

    assert "- Source: Jira issue" in context
    assert "### Jira Fields" in context
    assert "- Labels: output" in context
    assert "Still broken on 2026.1" in _section(context, "## Issue Details")


@needs_rg
@needs_git
def test_git_history_reaches_the_context_without_a_file_of_its_own(tmp_path):
    work_item = _manual(_git_repo(tmp_path))
    history = _section(_read(tmp_path, work_item, "context.md"), "## Git History")

    assert "- Current branch:" in history
    # Git History v2: one ranked commit, with the file and the keyword that found it.
    assert "— Filter the CSV output type in WidgetController" in history
    assert "Relevant files:\n- `src/WidgetController.cpp`\n" in history
    assert "matched shared keyword: WidgetController" in history
    assert not (tmp_path / ".ai" / work_item / "git_context.md").exists()


@needs_rg
def test_outside_a_git_repository_the_context_says_so(tmp_path, monkeypatch):
    # The working tree tmp_path sits in must not be the one that answers.
    monkeypatch.setattr(workflow, "collect_git_history", _no_repository_git_context)
    work_item = _manual(_repo(tmp_path))
    history = _section(_read(tmp_path, work_item, "context.md"), "## Git History")

    assert "Current directory is not inside a git repository." in history


def _no_repository_git_context(repo_root, issue_key, query=None, settings=None):
    from bugpilot.core.git_history import NOT_A_REPOSITORY_WARNING, GitHistoryOutcome
    from bugpilot.core.retrieval import GitHistoryRecord

    return GitHistoryOutcome(issue_key, GitHistoryRecord("unavailable", warnings=(NOT_A_REPOSITORY_WARNING,)))


@needs_rg
def test_similar_fixes_reach_the_context_without_a_file_of_their_own(tmp_path):
    _repo(tmp_path)
    _seed_memory(tmp_path)
    work_item = _manual(tmp_path)
    similar = _section(_read(tmp_path, work_item, "context.md"), "## Similar Fixes")

    assert "`.ai_memory/bugs/JR-11111.md`" in similar
    assert "JR-11111: WidgetController dropped the CSV output type" in similar
    assert not (tmp_path / ".ai" / work_item / "memory_search.md").exists()


@needs_rg
def test_with_no_past_fixes_the_context_says_there_are_none(tmp_path):
    work_item = _manual(_repo(tmp_path))

    assert "No similar memory entries found." in _section(_read(tmp_path, work_item, "context.md"), "## Similar Fixes")


# --- task.md --------------------------------------------------------------------


@needs_rg
def test_the_task_carries_the_task_the_handoff_and_the_team_rules(tmp_path):
    work_item = _manual(_repo(tmp_path), fix_mode_id="investigate-first")
    task = _read(tmp_path, work_item, "task.md")

    assert task.startswith(f"# BugPilot Task: {work_item}\n")
    assert HINT in _section(task, "## Developer Hint")
    assert "- Mode: Investigate First" in _section(task, "## AI Fix Mode")
    assert "### Objective" in task
    # BugPilot's safety rules, inline, where the agent reads them.
    rules = _section(task, "## BugPilot Safety Rules")
    assert "### Core Principles" in task
    assert "### Git Safety" in task
    assert "Nothing later in this task relaxes them." in rules
    # Then what the repository is, from its profile (pre-release Batch 1).
    assert "Repository profile:" in _section(task, "## Repository Context")
    inputs = _section(task, "## Required Input Files")
    assert f"- Read `.ai/{work_item}/context.md`." in inputs
    assert "Similar fixes and git history are included in `context.md`." in inputs
    outputs = _section(task, "## Required Output Files")
    assert f"Write one report: `.ai/{work_item}/fix_report.md`" in outputs
    for heading in ("`## Summary`", "`## Analysis`", "`## Changes`", "`## Tests`", "`## Review Notes`"):
        assert heading in outputs, heading
    assert "- Do not update Jira." in _section(task, "## Forbidden Actions")
    assert "## Investigation Handoff" in task
    for name in LEGACY_FILES:
        assert name not in task, name


@needs_rg
def test_the_context_does_not_repeat_what_the_task_asks(tmp_path):
    """The mode's workflow text is the task's; the context only names the mode."""
    work_item = _manual(_repo(tmp_path), fix_mode_id="investigate-first")
    context = _read(tmp_path, work_item, "context.md")

    assert "### Objective" not in context
    assert "## BugPilot Safety Rules" not in context
    assert "## Repository Context" not in context
    assert "`task.md` carries what it asks of the agent." in context


# --- standalone commands --------------------------------------------------------


@needs_rg
def test_a_standalone_rebuild_reproduces_the_pipelines_context(tmp_path, monkeypatch):
    """`--keywords` must survive a rebuild.

    They are not derivable from `issue.json`, but `retrieval.json` records them
    as `source: "user"` terms. A rebuild that forgot them would show Search
    Terms and a quality score that disagree with the Relevant Files rendered
    from that same retrieval — found by the Batch 3 review.
    """
    _repo(tmp_path)
    spec = bug_spec_from_description(
        "WidgetController rejects the CSV output type.\n\nError: InvalidOutputType thrown by validate",
        title="Output type cannot select CSV",
    )
    request = InvestigationRequest(
        # A keyword the issue text never says, so extraction alone cannot supply it.
        spec=spec,
        options=InvestigationOptions(hint=HINT, keywords=["FilterPipeline"]),
    )
    workflow.run_investigation(tmp_path, request)
    original = _read(tmp_path, spec.work_item_id, "context.md")
    assert "FilterPipeline" in original
    (tmp_path / ".ai" / spec.work_item_id / "context.md").unlink()
    monkeypatch.chdir(tmp_path)

    assert main(["context", spec.work_item_id]) == 0

    rebuilt = _read(tmp_path, spec.work_item_id, "context.md")
    assert "FilterPipeline" in rebuilt.split("### Search Terms", 1)[1].split("### Relevant Files", 1)[0]
    assert rebuilt == original


@needs_rg
def test_a_multi_line_hint_stays_one_guidance_bullet(tmp_path):
    """The hint field is a textarea; a raw newline must not end the bullet or
    turn a `#` line into a heading. `task.md` keeps the full text."""
    work_item = _manual(_repo(tmp_path), hint="Check validate().\n# Not a heading\nThen the caller.")
    guidance = _section(_read(tmp_path, work_item, "context.md"), "## Guidance")

    assert "- Developer hint: Check validate(). # Not a heading Then the caller." in guidance


@needs_rg
def test_the_context_command_gathers_git_and_memory_in_memory(tmp_path, monkeypatch, capsys):
    work_item = _manual(_repo(tmp_path))
    _seed_memory(tmp_path)
    (tmp_path / ".ai" / work_item / "context.md").unlink()
    monkeypatch.chdir(tmp_path)
    capsys.readouterr()

    assert main(["context", work_item, "--json"]) == 0

    payload = json.loads(capsys.readouterr().out)
    assert payload["generated_files"] == [f".ai/{work_item}/context.md"]
    context = _read(tmp_path, work_item, "context.md")
    assert "`.ai_memory/bugs/JR-11111.md`" in context
    assert "_Git context has not been generated yet._" not in context
    assert _files(tmp_path, work_item) == PREPARED_FILES


@needs_rg
@pytest.mark.parametrize(
    ("argv", "printed"),
    [
        (["git-context"], "# Git Context:"),
        (["memory", "search"], "# Memory Search:"),
        (["agent-instructions"], "## Core Principles"),
    ],
)
def test_the_intermediate_commands_print_and_write_nothing(tmp_path, monkeypatch, capsys, argv, printed):
    work_item = _manual(_repo(tmp_path))
    before = {path.name: path.read_bytes() for path in (tmp_path / ".ai" / work_item).iterdir()}
    monkeypatch.chdir(tmp_path)
    capsys.readouterr()

    assert main([*argv, work_item]) == 0

    assert printed in capsys.readouterr().out
    after = {path.name: path.read_bytes() for path in (tmp_path / ".ai" / work_item).iterdir()}
    # run.json records the step; nothing new appears and nothing else changes.
    assert set(after) == set(before)
    for name in ("issue.json", "retrieval.json", "context.md", "task.md"):
        assert after[name] == before[name], name


@needs_rg
def test_agent_task_rewrites_task_md_from_the_canonical_files(tmp_path, monkeypatch, capsys):
    work_item = _manual(_repo(tmp_path))
    original = _read(tmp_path, work_item, "task.md")
    (tmp_path / ".ai" / work_item / "task.md").unlink()
    monkeypatch.chdir(tmp_path)

    assert main(["agent-task", work_item]) == 0

    assert f"Regenerated task.md for {work_item}." in capsys.readouterr().out
    assert _read(tmp_path, work_item, "task.md") == original
    assert _files(tmp_path, work_item) == PREPARED_FILES


# --- the old layout is not read -------------------------------------------------


def _old_layout(root: Path, work_item: str = "JR-12345") -> Path:
    """A work item directory from before Batch 3: context and task under the old names."""
    target = root / ".ai" / work_item
    target.mkdir(parents=True)
    (target / "bug_context.md").write_text("# Bug Context: JR-12345\n", encoding="utf-8")
    (target / "agent_task.md").write_text("# Agent Task: JR-12345\n", encoding="utf-8")
    (target / "agent_handoff.md").write_text("Read .ai/JR-12345/agent_task.md.\n", encoding="utf-8")
    return target


def test_agent_task_does_not_accept_bug_context_md(tmp_path, monkeypatch, capsys):
    target = _old_layout(tmp_path)
    monkeypatch.chdir(tmp_path)

    assert main(["agent-task", "JR-12345"]) == 1

    assert "Missing .ai/JR-12345/context.md." in capsys.readouterr().err
    assert not (target / "task.md").exists()


def test_a_jira_comment_draft_does_not_accept_the_old_files(tmp_path):
    _old_layout(tmp_path)

    with pytest.raises(FileNotFoundError, match="No core context found"):
        workflow.jira_comment_draft_step(tmp_path, "JR-12345")


def test_the_mcp_package_does_not_point_at_the_old_files(tmp_path):
    _old_layout(tmp_path)
    result = workflow.WorkflowResult("JR-12345", tmp_path / ".ai" / "JR-12345", generated_files=[])

    package = mcp_server._package(tmp_path, "JR-12345", result)

    assert package["agent_task"] is None
    assert package["context_excerpt"] is None
    assert "agent_task.md" not in package["next_step"]
