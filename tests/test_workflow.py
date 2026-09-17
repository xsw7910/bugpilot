from __future__ import annotations

import json
import socket
import urllib.error
from pathlib import Path
from subprocess import CompletedProcess

import pytest

from bugpilot.core import workflow
from bugpilot.cli import main
from bugpilot.core.agent_runner import AgentRunResult
from bugpilot.core.context import _code_search_summary
from bugpilot.core.git_ops import branch_name, summary_slug
from bugpilot.core.jira import JiraFetchError, classify_attachment, fetch_issue
from bugpilot.core.jira import jira_field_report_markdown, jira_summary_markdown, normalize_core_fields, normalize_attachments, parse_issue, parsed_markdown
from bugpilot.core.jira_parse import extract_parsed_details
from bugpilot.core.jira_adf import adf_to_markdown
from bugpilot.core.keywords import extract_keywords
from bugpilot.core.memory import build_memory_entry, search_memory
from bugpilot.core.search import INCLUDE_GLOBS, _noise_flags, run_code_search
from bugpilot.core.workflow import copilot_task_step, git_context_step, run_bug_workflow


@pytest.fixture(autouse=True)
def clear_jira_env(monkeypatch):
    monkeypatch.delenv("JIRA_BASE_URL", raising=False)
    monkeypatch.delenv("JIRA_EMAIL", raising=False)
    monkeypatch.delenv("JIRA_TOKEN", raising=False)


@pytest.fixture(autouse=True)
def stub_agent_launch(monkeypatch):
    # `bug` launches Claude by default; stub the launch so prepare-focused tests
    # here don't spawn a real agent process. Agent-launch behavior is covered
    # explicitly in test_agent_runner.py.
    monkeypatch.setattr(
        "bugpilot.core.agent_runner.run_agent",
        lambda repo_root, issue_key, agent, config=None, prompt=None: AgentRunResult(
            agent=agent, ran=True, command=[agent], returncode=0
        ),
    )


def test_output_directory_creation(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    run_bug_workflow(tmp_path, "JR-12345", allow_mock=True)

    assert (tmp_path / ".ai" / "JR-12345").is_dir()
    assert (tmp_path / ".ai_memory" / "bugs" / "JR-12345.md").is_file()


def test_branch_name_generation():
    assert branch_name("JR-23110", "Amplitude Spectrum - min/max ranges are not converted to dB") == (
        "feature/JR-23110-amplitude-spectrum-min-max-ranges-not-converted-to-db"
    )
    assert branch_name("JR-12345", "Fix crash: OpenVDS import fails on .vds file") == (
        "feature/JR-12345-fix-crash-openvds-import-fails-on-vds-file"
    )
    assert branch_name("JR-12345") == "feature/JR-12345-jira-workflow"


def test_summary_slug_rules():
    assert summary_slug("[Import] As a user, I can import a 3D, post-stack VDS file into Mapview") == (
        "import-as-a-user-i-can-import-a-3d-post-stack-vds-file-into-mapview"
    )
    assert summary_slug("Amplitude Spectrum - min/max ranges are not converted to dB") == (
        "amplitude-spectrum-min-max-ranges-not-converted-to-db"
    )
    assert summary_slug("Fix --- crash /// OpenVDS") == "fix-crash-openvds"
    assert summary_slug("") == ""
    assert len(summary_slug("word " * 40)) <= 85


def test_workflow_status_json_generation(tmp_path):
    run_bug_workflow(tmp_path, "JR-12345", allow_mock=True)
    status = json.loads((tmp_path / ".ai" / "JR-12345" / "workflow_status.json").read_text())

    assert status["issue_key"] == "JR-12345"
    assert status["mode"] == "prepare-only"
    assert status["steps"] == {
        "doctor": "pass",
        "fetch": "pass",
        "parse": "pass",
        "keywords": "pass",
        "memory_search": "pass",
        "code_search": "pass",
        "git_context": "pass",
        "context": "pass",
        "prompt": "pass",
        "agent_instructions": "skipped",
        "memory_add": "pass",
        "agent_fix": "skipped",
        "result_summary": "skipped",
        "manual_validation": "skipped",
        "final_review_prompt": "skipped",
        "memory_update": "skipped",
        "delivery_check": "skipped",
        "commit_plan": "skipped",
        "push_plan": "skipped",
        "notify": "skipped",
        "jira_comment_draft": "skipped",
        "jira_comment": "skipped",
        "retry_prompt": "skipped",
        "manual_result": "skipped",
    }
    assert ".ai/JR-12345/agent_task.md" in status["generated_files"]
    assert ".ai/JR-12345/agent_handoff.md" in status["generated_files"]
    assert ".ai/JR-12345/agent_team_instructions.md" in status["generated_files"]
    assert ".ai/JR-12345/code_search.md" in status["generated_files"]
    assert ".ai/JR-12345/related_files.json" in status["generated_files"]
    assert ".ai/JR-12345/search_quality.json" in status["generated_files"]
    # memory_search.md and git_context.md are intermediate and folded into
    # bug_context.md, so they are not kept in the final output.
    assert ".ai/JR-12345/memory_search.md" not in status["generated_files"]
    assert ".ai/JR-12345/git_context.md" not in status["generated_files"]
    assert ".ai/JR-12345/bug_context.md" in status["generated_files"]
    assert ".ai_memory/bugs/JR-12345.md" in status["generated_files"]


def test_bug_command_runs_in_temporary_directory(tmp_path, monkeypatch):
    _set_jira_env(monkeypatch)
    monkeypatch.setattr(
        "bugpilot.core.jira.urllib.request.urlopen",
        lambda request, timeout: _good_jira_response()(),
    )
    monkeypatch.chdir(tmp_path)
    exit_code = main(["bug", "JR-12345"])

    assert exit_code == 0
    assert (tmp_path / ".ai" / "JR-12345" / "jira_summary.md").is_file()
    assert (tmp_path / ".ai" / "JR-12345" / "workflow_status.json").is_file()


def test_bug_is_the_default_command(tmp_path, monkeypatch):
    # `bugpilot JR-12345` behaves as `bugpilot bug JR-12345`.
    _set_jira_env(monkeypatch)
    monkeypatch.setattr(
        "bugpilot.core.jira.urllib.request.urlopen",
        lambda request, timeout: _good_jira_response()(),
    )
    monkeypatch.chdir(tmp_path)

    assert main(["JR-12345"]) == 0
    assert (tmp_path / ".ai" / "JR-12345" / "jira_summary.md").is_file()


def test_bug_command_prints_progress_and_key_artifacts(tmp_path, monkeypatch, capsys):
    _set_jira_env(monkeypatch)
    monkeypatch.setattr(
        "bugpilot.core.jira.urllib.request.urlopen",
        lambda request, timeout: _good_jira_response()(),
    )
    monkeypatch.chdir(tmp_path)

    assert main(["bug", "JR-12345"]) == 0
    output = capsys.readouterr().out

    assert "bugpilot bug JR-12345" in output
    assert "Checking environment" in output
    assert "Fetching Jira issue JR-12345" in output
    assert "Parsing Jira details" in output
    assert "Extracting keywords" in output
    assert "Searching memory" in output
    assert "Searching codebase" in output
    assert "Building bug context" in output
    assert "Generating agent task package" in output
    assert "Generated:" in output
    assert ".ai/JR-12345/jira_summary.md" in output
    assert ".ai/JR-12345/jira_parsed.md" in output
    assert ".ai/JR-12345/code_search.md" in output
    assert ".ai/JR-12345/bug_context.md" in output
    assert ".ai/JR-12345/agent_task.md" in output
    assert "Prepared bugpilot workflow package for JR-12345." in output
    assert "Artifacts: .ai/JR-12345" in output


def test_bug_command_fetch_failure_prints_clear_error(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("JIRA_BASE_URL", raising=False)
    monkeypatch.delenv("JIRA_EMAIL", raising=False)
    monkeypatch.delenv("JIRA_TOKEN", raising=False)
    monkeypatch.chdir(tmp_path)

    assert main(["bug", "JR-12345"]) == 1
    captured = capsys.readouterr()

    assert "Fetching Jira issue JR-12345" in captured.out
    assert "ERROR" in captured.err
    assert "Fetching Jira issue failed" in captured.err
    assert "See .ai/JR-12345/execution.log for details." in captured.err


def test_bug_command_progress_does_not_print_jira_token(tmp_path, monkeypatch, capsys):
    _set_jira_env(monkeypatch)
    monkeypatch.setattr(
        "bugpilot.core.jira.urllib.request.urlopen",
        lambda request, timeout: _good_jira_response()(),
    )
    monkeypatch.chdir(tmp_path)

    assert main(["bug", "JR-12345"]) == 0
    captured = capsys.readouterr()

    assert "token-value" not in captured.out
    assert "token-value" not in captured.err


def test_execution_log_contains_prepare_only_lifecycle(tmp_path, monkeypatch):
    monkeypatch.delenv("JIRA_BASE_URL", raising=False)
    monkeypatch.delenv("JIRA_EMAIL", raising=False)
    monkeypatch.delenv("JIRA_TOKEN", raising=False)

    run_bug_workflow(tmp_path, "JR-12345", allow_mock=True)
    log_text = (tmp_path / ".ai" / "JR-12345" / "execution.log").read_text()

    assert "[START] command: bugpilot bug JR-12345" in log_text
    assert "[START] doctor" in log_text
    assert "[END] doctor: pass" in log_text
    assert "[START] fetch" in log_text
    assert "[WARN] Jira fetch failed: missing_env - Jira environment variables are missing." in log_text
    assert "[WARN] Using mock/demo Jira data" in log_text
    assert "[END] fetch: pass" in log_text
    assert "[START] parse" in log_text
    assert "[END] parse: pass" in log_text
    assert "[START] keywords" in log_text
    assert "[END] keywords: pass" in log_text
    assert "[START] memory_search" in log_text
    assert "[END] memory_search: pass" in log_text
    assert "[START] code_search" in log_text
    assert "[END] code_search: pass" in log_text
    assert "[START] git_context" in log_text
    assert "[END] git_context: pass" in log_text
    assert "[START] context" in log_text
    assert "[END] context: pass" in log_text
    assert "[START] prompt" in log_text
    assert "[END] prompt: pass" in log_text
    assert "[START] memory_add" in log_text
    assert "[END] memory_add: pass" in log_text
    assert "[SKIP] agent_fix: prepare-only mode" in log_text
    assert "[GENERATED] .ai/JR-12345/code_search.md" in log_text
    assert "[GENERATED] .ai/JR-12345/related_files.json" in log_text
    assert "[GENERATED] .ai/JR-12345/search_quality.json" in log_text
    assert "folded into bug_context.md and removed: .ai/JR-12345/memory_search.md" in log_text
    assert "folded into bug_context.md and removed: .ai/JR-12345/git_context.md" in log_text
    assert "[GENERATED] .ai/JR-12345/memory_search.md" not in log_text
    assert "[GENERATED] .ai/JR-12345/git_context.md" not in log_text
    assert "[GENERATED] .ai/JR-12345/agent_task.md" in log_text
    assert "[GENERATED] .ai/JR-12345/agent_handoff.md" in log_text
    assert "[GENERATED] .ai/JR-12345/agent_team_instructions.md" in log_text
    assert "[GENERATED] .ai_memory/bugs/JR-12345.md" in log_text
    assert "[END] workflow: pass" in log_text


def test_copilot_task_references_code_search(tmp_path):
    run_bug_workflow(tmp_path, "JR-12345", allow_mock=True)
    task = (tmp_path / ".ai" / "JR-12345" / "agent_task.md").read_text()

    assert "Run your AI agent from the target repo root" in task
    assert "Do not run your AI agent from the bugpilot tool source directory" in task
    assert ".ai/JR-12345/` files are relative to the target repo root" in task
    assert "feature/JR-12345-demo-bug-employee-search-returns-stale-results-after" in task
    assert "Check the current branch before editing" in task
    assert "Create or switch to the feature branch before editing files" in task
    assert ".ai/JR-12345/bug_context.md" in task
    assert ".ai/JR-12345/agent_team_instructions.md" in task
    assert "Before editing code" in task
    assert "team instructions" in task
    assert ".ai/JR-12345/code_search.md" in task
    assert ".ai/JR-12345/related_files.json" in task
    assert ".ai/JR-12345/search_quality.json" in task
    # Historical issues and git context now come from bug_context.md, not standalone files.
    assert ".ai/JR-12345/memory_search.md" not in task
    assert ".ai/JR-12345/git_context.md" not in task
    assert "included in `bug_context.md`" in task
    assert "Do not edit code until after reviewing context and related files" in task
    assert "Do not use the Task tool or spawn any background or sub-agents" in task
    assert "If search confidence is Low" in task
    assert "do not assume the matched files are the correct implementation" in task
    assert "write a no-op analysis" in task
    assert "matched line numbers" in task
    assert ".ai/JR-12345/bug_analysis.md" in task
    assert ".ai/JR-12345/fix_summary.md" in task
    assert ".ai/JR-12345/test_result.md" in task
    assert ".ai/JR-12345/diff_summary.md" in task
    assert ".ai/JR-12345/review_notes.md" in task
    assert "git reset --hard" in task
    assert "git clean -fd" in task
    assert "Do you want me to commit and push this branch to origin?" in task
    assert "Only if the developer explicitly answers yes" in task
    assert "Do not push main/master" in task
    assert "Do not force push" in task
    assert "Do not add `.ai/`" in task
    assert "Do not add `.ai_memory/`" in task
    assert "Do not update Jira" in task
    # By default the pre-commit Jira status comment is omitted.
    assert "Report Status to Jira (before commit)" not in task
    assert "- Do not update Jira.\n" in task


def test_default_omits_jira_status_section(tmp_path):
    run_bug_workflow(tmp_path, "JR-12345", allow_mock=True)
    issue_dir = tmp_path / ".ai" / "JR-12345"
    task = (issue_dir / "agent_task.md").read_text()
    handoff = (issue_dir / "agent_handoff.md").read_text()

    # No pre-commit Jira status section, and no marker, by default.
    assert "Report Status to Jira (before commit)" not in task
    assert "jira-comment-draft" not in task
    assert "--execute" not in task
    assert "- Do not update Jira.\n" in task
    assert "the only permitted Jira write" not in task
    assert "the only permitted Jira write" not in handoff
    assert not (issue_dir / "jira_comment_on.flag").exists()


def test_jira_comment_opt_in_includes_status_section(tmp_path):
    run_bug_workflow(tmp_path, "JR-12345", allow_mock=True, jira_comment=True)
    issue_dir = tmp_path / ".ai" / "JR-12345"
    task = (issue_dir / "agent_task.md").read_text()

    # --jira-comment adds the pre-commit status section and its commands.
    assert "Report Status to Jira (before commit)" in task
    assert "bugpilot jira-comment JR-12345 --execute" in task
    assert "Post exactly ONE comment" in task
    # The marker persists so a standalone regeneration keeps the comment on.
    assert (issue_dir / "jira_comment_on.flag").exists()
    copilot_task_step(tmp_path, "JR-12345")
    assert "Report Status to Jira (before commit)" in (issue_dir / "agent_task.md").read_text()


def test_copilot_task_step_jira_comment_flag(tmp_path):
    run_bug_workflow(tmp_path, "JR-12345", allow_mock=True)
    issue_dir = tmp_path / ".ai" / "JR-12345"
    assert "Report Status to Jira (before commit)" not in (issue_dir / "agent_task.md").read_text()

    # Standalone regeneration can turn the status comment on after the fact.
    copilot_task_step(tmp_path, "JR-12345", jira_comment=True)
    assert "Report Status to Jira (before commit)" in (issue_dir / "agent_task.md").read_text()


def test_copilot_task_branch_uses_jira_summary_slug(tmp_path):
    issue_dir = tmp_path / ".ai" / "JR-23110"
    issue_dir.mkdir(parents=True)
    (issue_dir / "jira.json").write_text(
        json.dumps(
            {
                "key": "JR-23110",
                "fields": {
                    "summary": "Amplitude Spectrum - min/max ranges are not converted to dB",
                },
            }
        ),
        encoding="utf-8",
    )

    workflow.prompt_step(tmp_path, "JR-23110")
    task = (issue_dir / "agent_task.md").read_text(encoding="utf-8")

    assert "feature/JR-23110-amplitude-spectrum-min-max-ranges-not-converted-to-db" in task


def test_copilot_task_branch_uses_normalized_summary_fallback(tmp_path):
    issue_dir = tmp_path / ".ai" / "JR-23108"
    issue_dir.mkdir(parents=True)
    (issue_dir / "jira.json").write_text(
        json.dumps(
            {
                "key": "JR-23108",
                "fields": {},
                "bugpilot_normalized": {
                    "summary": "[Import] As a user, I can import a 3D, post-stack VDS file into Mapview",
                },
            }
        ),
        encoding="utf-8",
    )

    workflow.prompt_step(tmp_path, "JR-23108")
    task = (issue_dir / "agent_task.md").read_text(encoding="utf-8")

    assert "feature/JR-23108-import-as-a-user-i-can-import-a-3d-post-stack-vds-file" in task


def test_keyword_schema_matches_phase_2_plan():
    keywords = extract_keywords("EmployeeSearch stale filter query cache actual expected cache")

    assert set(keywords) == {
        "high_value_keywords", "normal_keywords", "dropped_keywords",
        "phrase_keywords", "expanded_keywords",
    }
    for key in keywords:
        assert isinstance(keywords[key], list)


def test_keywords_boost_stack_trace_identifiers():
    text = "The list refreshes slowly and users complain about the SlowThing widget."
    priority = "Traceback: at HrsProcess::commitTransaction (hrs_txn.cxx:88)"
    kw = extract_keywords(text, priority_text=priority)
    top = kw["high_value_keywords"][:3]

    # Identifiers from the stack trace lead, ahead of ordinary description tokens.
    assert "HrsProcess::commitTransaction" in top
    assert "hrs_txn.cxx" in top
    assert kw["high_value_keywords"].index("HrsProcess::commitTransaction") < \
        kw["high_value_keywords"].index("SlowThing")


def test_keywords_expand_compound_identifiers():
    kw = extract_keywords("Fix HrsQtProcessWidget in hrs_process_manager.cxx")
    expanded = {w.lower() for w in kw["expanded_keywords"]}
    # Specific middle token is surfaced for recall...
    assert "process" in expanded
    # ...but generic framework/structural parts are not.
    assert expanded.isdisjoint({"qt", "hrs", "widget", "manager", "class"})


def test_keywords_extract_quoted_phrases():
    kw = extract_keywords('The dialog shows "Selection is lost" when you don\'t save; see “Refresh table”.')
    phrases = kw["phrase_keywords"]
    assert "Selection is lost" in phrases      # straight double quotes
    assert "Refresh table" in phrases          # smart double quotes
    # A contraction's apostrophe must not be mistaken for a quoted phrase.
    assert not any("save" in p and "don" in p for p in phrases)


def test_code_search_matches_exact_phrase(tmp_path):
    (tmp_path / "dialog.cpp").write_text('void f() { label->setText("Selection is lost"); }\n')
    keywords = {"high_value_keywords": [], "normal_keywords": [], "phrase_keywords": ["Selection is lost"]}
    _markdown, related, _quality = run_code_search(tmp_path, "JR-12345", keywords)
    assert any("dialog.cpp" in r["file"] for r in related)


def test_keywords_rank_identifiers_above_prose():
    text = "When the user clicks the button the HrsQtProcessWidget should refresh but selection is lost"
    kw = extract_keywords(text)
    hv = kw["high_value_keywords"]

    # The camelCase identifier is the standout, not the frequent prose words.
    assert "HrsQtProcessWidget" in hv
    # Case is preserved so search.py's identifier detector can recognise it.
    assert any(c.isupper() for c in "".join(hv))
    # Generic prose / bug boilerplate never becomes a keyword at all.
    everything = {w.lower() for w in hv + kw["normal_keywords"] + kw["dropped_keywords"]}
    assert everything.isdisjoint({"when", "the", "clicks", "should", "but", "is"})


def test_keywords_extract_qualified_and_file_names():
    kw = extract_keywords("Crash in HrsProcess::onTabChanged at hrs_process_widget.cxx line 42")
    all_kw = kw["high_value_keywords"] + kw["normal_keywords"]

    assert "HrsProcess::onTabChanged" in kw["high_value_keywords"]
    assert "hrs_process_widget.cxx" in all_kw          # the file reference
    assert "hrs_process_widget" in {k.lower() for k in all_kw}  # and its stem


def test_search_command_generates_code_search_and_related_files(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    source = tmp_path / "employee_search.py"
    source.write_text("class EmployeeSearch:\n    def refresh_filter_cache(self):\n        return 'filter cache'\n")
    issue_dir = tmp_path / ".ai" / "JR-12345"
    issue_dir.mkdir(parents=True)
    (issue_dir / "extracted_keywords.json").write_text(
        json.dumps(
            {
                "high_value_keywords": ["EmployeeSearch", "filter"],
                "normal_keywords": ["cache"],
                "dropped_keywords": [],
            }
        )
    )

    assert main(["search", "JR-12345"]) == 0
    related = json.loads((issue_dir / "related_files.json").read_text())

    assert (issue_dir / "code_search.md").is_file()
    assert related[0]["file"] == "employee_search.py"
    assert related[0]["score"] >= 3
    assert "confidence" in related[0]
    assert "reasons" in related[0]
    assert "noise_flags" in related[0]


def test_rg_unavailable_fallback_generates_empty_results(tmp_path, monkeypatch):
    monkeypatch.setenv("PATH", "")
    markdown, related, quality = run_code_search(
        tmp_path,
        "JR-12345",
        {"high_value_keywords": ["EmployeeSearch"], "normal_keywords": [], "dropped_keywords": []},
    )

    assert related == []
    assert quality["confidence"] == "low"
    assert "rg is unavailable" in markdown


def test_memory_search_with_no_memory_entries_writes_no_results(tmp_path):
    issue_dir = tmp_path / ".ai" / "JR-12345"
    issue_dir.mkdir(parents=True)
    (issue_dir / "extracted_keywords.json").write_text(
        json.dumps({"high_value_keywords": ["EmployeeSearch"], "normal_keywords": [], "dropped_keywords": []})
    )

    issue_key, markdown, results = search_memory(tmp_path, "JR-12345")

    assert issue_key == "JR-12345"
    assert results == []
    assert "No similar memory entries found." in markdown
    assert "No similar memory entries found." in (issue_dir / "memory_search.md").read_text()


def test_git_context_outside_git_repo_does_not_crash(tmp_path):
    git_context_step(tmp_path, "JR-12345")

    text = (tmp_path / ".ai" / "JR-12345" / "git_context.md").read_text()
    assert "Current directory is not inside a git repository" in text


def test_bug_workflow_generates_phase_2_files_and_enriched_context(tmp_path):
    run_bug_workflow(tmp_path, "JR-12345", allow_mock=True)
    issue_dir = tmp_path / ".ai" / "JR-12345"
    context = (issue_dir / "bug_context.md").read_text()

    assert (issue_dir / "code_search.md").is_file()
    assert (issue_dir / "related_files.json").is_file()
    assert (issue_dir / "search_quality.json").is_file()
    # Folded into bug_context.md and not kept as standalone files.
    assert not (issue_dir / "memory_search.md").exists()
    assert not (issue_dir / "git_context.md").exists()
    assert "## Code Search Summary" in context
    assert "## Similar Historical Issues" in context
    assert "## Git Context" in context
    assert (issue_dir / "agent_handoff.md").is_file()


def test_rg_subprocess_uses_utf8_replace_and_include_globs(tmp_path, monkeypatch):
    calls = []

    def fake_run(args, **kwargs):
        calls.append((args, kwargs))
        return CompletedProcess(args, 0, stdout="employee_search.py:1:EmployeeSearch cache\n", stderr="")

    monkeypatch.setattr("bugpilot.core.search.command_available", lambda command: command == "rg")
    monkeypatch.setattr("bugpilot.core.search.subprocess.run", fake_run)

    markdown, related, quality = run_code_search(
        tmp_path,
        "JR-12345",
        {"high_value_keywords": ["EmployeeSearch"], "normal_keywords": [], "dropped_keywords": []},
    )

    args, kwargs = calls[0]
    assert kwargs["encoding"] == "utf-8"
    assert kwargs["errors"] == "replace"
    assert "text" not in kwargs
    for glob in INCLUDE_GLOBS:
        assert ["-g", glob] in [args[index : index + 2] for index in range(len(args) - 1)]
    assert related[0]["file"] == "employee_search.py"
    assert "confidence" in related[0]
    assert "EmployeeSearch cache" in markdown


def test_noisy_paths_reduce_search_confidence(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    (tmp_path / "ci").mkdir()
    (tmp_path / "ci" / "build_script.py").write_text("stale result update\n", encoding="utf-8")
    (tmp_path / "docs").mkdir()
    (tmp_path / "docs" / "search.md").write_text("stale result change\n", encoding="utf-8")
    issue_dir = tmp_path / ".ai" / "JR-12345"
    issue_dir.mkdir(parents=True)
    (issue_dir / "extracted_keywords.json").write_text(
        json.dumps({"high_value_keywords": ["stale"], "normal_keywords": ["result"], "dropped_keywords": []})
    )

    assert main(["search", "JR-12345"]) == 0
    related = json.loads((issue_dir / "related_files.json").read_text(encoding="utf-8"))
    quality = json.loads((issue_dir / "search_quality.json").read_text(encoding="utf-8"))
    code_search = (issue_dir / "code_search.md").read_text(encoding="utf-8")

    assert quality["confidence"] == "low"
    assert "Confidence: Low" in code_search
    assert any(item["noise_flags"] for item in related)
    assert all(item["confidence"] == "low" for item in related)


def test_noise_flags_use_exact_path_segments_not_filename_substrings(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    files = {
        "src/external_service.py": "class EmployeeSearch: pass\n",
        "src/results_builder.py": "class EmployeeSearch: pass\n",
        "src/license_validator.py": "class EmployeeSearch: pass\n",
        "src/sample_handler.py": "class EmployeeSearch: pass\n",
        "external/service.py": "class EmployeeSearch: pass\n",
        "vendor/invoice.py": "class EmployeeSearch: pass\n",
        "license/sdk_header.h": "class EmployeeSearch {};\n",
        "docs/sample.py": "class EmployeeSearch: pass\n",
    }
    for file_name, content in files.items():
        path = tmp_path / file_name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    issue_dir = tmp_path / ".ai" / "JR-12345"
    issue_dir.mkdir(parents=True)
    (issue_dir / "extracted_keywords.json").write_text(
        json.dumps({"high_value_keywords": ["EmployeeSearch"], "normal_keywords": [], "dropped_keywords": []})
    )

    assert main(["search", "JR-12345"]) == 0
    related = {
        item["file"]: item
        for item in json.loads((issue_dir / "related_files.json").read_text(encoding="utf-8"))
    }

    for file_name in [
        "src/external_service.py",
        "src/results_builder.py",
        "src/license_validator.py",
        "src/sample_handler.py",
    ]:
        assert related[file_name]["noise_flags"] == []
        assert related[file_name]["confidence"] == "high"

    assert "vendor_or_external_path" in _noise_flags("external/service.py")
    assert "vendor_or_external_path" in _noise_flags("vendor/invoice.py")
    assert "license_or_sdk_path" in _noise_flags("license/sdk_header.h")
    assert "docs_or_examples_path" in _noise_flags("docs/sample.py")


def test_application_source_path_increases_search_confidence(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    source_dir = tmp_path / "src"
    source_dir.mkdir()
    (source_dir / "EmployeeSearch.cpp").write_text("class EmployeeSearch { void refresh(); };\n", encoding="utf-8")
    issue_dir = tmp_path / ".ai" / "JR-12345"
    issue_dir.mkdir(parents=True)
    (issue_dir / "extracted_keywords.json").write_text(
        json.dumps({"high_value_keywords": ["EmployeeSearch"], "normal_keywords": [], "dropped_keywords": []})
    )

    assert main(["search", "JR-12345"]) == 0
    related = json.loads((issue_dir / "related_files.json").read_text(encoding="utf-8"))
    quality = json.loads((issue_dir / "search_quality.json").read_text(encoding="utf-8"))

    assert related[0]["file"] == "src/EmployeeSearch.cpp"
    assert related[0]["confidence"] == "high"
    assert quality["confidence"] == "high"


def test_search_quality_json_has_full_field_structure(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    source_dir = tmp_path / "src"
    source_dir.mkdir()
    (source_dir / "EmployeeSearch.cpp").write_text("class EmployeeSearch {};\n", encoding="utf-8")
    issue_dir = tmp_path / ".ai" / "JR-12345"
    issue_dir.mkdir(parents=True)
    (issue_dir / "extracted_keywords.json").write_text(
        json.dumps({"high_value_keywords": ["EmployeeSearch"], "normal_keywords": [], "dropped_keywords": []})
    )

    assert main(["search", "JR-12345"]) == 0
    quality = json.loads((issue_dir / "search_quality.json").read_text(encoding="utf-8"))

    assert set(quality) == {
        "confidence",
        "reasons",
        "high_confidence_files",
        "medium_confidence_files",
        "low_confidence_files",
        "noise_indicators",
    }


def test_mixed_confidence_scenario_populates_multiple_buckets(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    files = {
        "src/EmployeeSearch.cpp": "class EmployeeSearch { void filter(); };\n",
        "docs/search.md": "search result update\n",
    }
    for file_name, content in files.items():
        path = tmp_path / file_name
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
    issue_dir = tmp_path / ".ai" / "JR-12345"
    issue_dir.mkdir(parents=True)
    (issue_dir / "extracted_keywords.json").write_text(
        json.dumps({"high_value_keywords": ["EmployeeSearch"], "normal_keywords": ["search"], "dropped_keywords": []})
    )

    assert main(["search", "JR-12345"]) == 0
    quality = json.loads((issue_dir / "search_quality.json").read_text(encoding="utf-8"))

    assert "src/EmployeeSearch.cpp" in quality["high_confidence_files"]
    assert "docs/search.md" in quality["low_confidence_files"]


def test_code_search_markdown_contains_quality_section_headers(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    source_dir = tmp_path / "src"
    source_dir.mkdir()
    (source_dir / "EmployeeSearch.cpp").write_text("class EmployeeSearch {};\n", encoding="utf-8")
    issue_dir = tmp_path / ".ai" / "JR-12345"
    issue_dir.mkdir(parents=True)
    (issue_dir / "extracted_keywords.json").write_text(
        json.dumps({"high_value_keywords": ["EmployeeSearch"], "normal_keywords": [], "dropped_keywords": []})
    )

    assert main(["search", "JR-12345"]) == 0
    code_search = (issue_dir / "code_search.md").read_text(encoding="utf-8")

    for heading in [
        "## Search Quality",
        "## High-Confidence Matches",
        "## Low-Confidence / Possible False Positives",
        "## Top Related Files",
        "## Matched Lines",
    ]:
        assert heading in code_search


def test_case_insensitive_high_value_keyword_bonus(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    source_dir = tmp_path / "src"
    source_dir.mkdir()
    (source_dir / "EmployeeSearch.cpp").write_text("void employeesearch_refresh();\n", encoding="utf-8")
    issue_dir = tmp_path / ".ai" / "JR-12345"
    issue_dir.mkdir(parents=True)
    (issue_dir / "extracted_keywords.json").write_text(
        json.dumps({"high_value_keywords": ["EmployeeSearch"], "normal_keywords": [], "dropped_keywords": []})
    )

    assert main(["search", "JR-12345"]) == 0
    related = json.loads((issue_dir / "related_files.json").read_text(encoding="utf-8"))

    assert related[0]["file"] == "src/EmployeeSearch.cpp"
    assert related[0]["confidence"] == "high"
    assert related[0]["score"] >= 14


def test_bug_context_includes_code_search_quality(tmp_path):
    run_bug_workflow(tmp_path, "JR-12345", allow_mock=True)
    context = (tmp_path / ".ai" / "JR-12345" / "bug_context.md").read_text(encoding="utf-8")

    assert "## Code Search Quality" in context
    assert "Confidence:" in context
    assert "If search confidence is Low" in context


def test_workflow_generated_files_include_search_quality(tmp_path):
    run_bug_workflow(tmp_path, "JR-12345", allow_mock=True)
    status = json.loads((tmp_path / ".ai" / "JR-12345" / "workflow_status.json").read_text(encoding="utf-8"))

    assert ".ai/JR-12345/search_quality.json" in status["generated_files"]


def test_git_run_command_uses_utf8_replace(monkeypatch, tmp_path):
    calls = []

    def fake_run(args, **kwargs):
        calls.append(kwargs)
        return CompletedProcess(args, 0, stdout="clean\n")

    monkeypatch.setattr("bugpilot.core.git_ops.subprocess.run", fake_run)

    from bugpilot.core.git_ops import run_command

    code, output = run_command(["git", "status", "--short"], tmp_path)

    assert code == 0
    assert output == "clean"
    assert calls[0]["encoding"] == "utf-8"
    assert calls[0]["errors"] == "replace"
    assert "text" not in calls[0]


def test_free_text_memory_search_prints_markdown(tmp_path, monkeypatch, capsys):
    memory_dir = tmp_path / ".ai_memory" / "bugs"
    memory_dir.mkdir(parents=True)
    (memory_dir / "JR-1.md").write_text("# JR-1\n\nEmployeeSearch cache bug\n", encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    assert main(["memory", "search", "EmployeeSearch cache"]) == 0
    output = capsys.readouterr().out

    assert "# Memory Search: EmployeeSearch cache" in output
    assert ".ai_memory/bugs/JR-1.md" in output


def test_memory_entry_uses_prepare_only_phase_2_wording():
    entry = build_memory_entry("JR-12345", {"summary": "Demo", "is_mock": True}, ".ai/JR-12345/bug_context.md")

    assert "Phase 1" not in entry
    assert "Prototype prepare-only workflow" in entry
    assert "## Code Search Summary" in entry
    assert "## Related Files" in entry


def test_context_code_search_summary_prefers_related_files_over_warnings():
    markdown = """# Code Search: JR-12345

## Warnings

- warning first

## Top Related Files

- `src/EmployeeSearch.cpp` score=10 matches=2 keywords=EmployeeSearch
"""

    summary = _code_search_summary(markdown)

    assert summary.startswith("- `src/EmployeeSearch.cpp`")
    assert "Warnings:" in summary


def test_copilot_handoff_is_generated(tmp_path):
    run_bug_workflow(tmp_path, "JR-12345", allow_mock=True)
    handoff = (tmp_path / ".ai" / "JR-12345" / "agent_handoff.md").read_text()

    assert "Read `.ai/JR-12345/agent_task.md` and complete the workflow." in handoff
    assert ".ai/JR-12345/agent_team_instructions.md" in handoff
    assert "Run your AI agent from the target repo root" in handoff
    assert "Do not work directly on main/master" in handoff
    assert "Do not commit or push unless the developer explicitly approves" in handoff
    assert "Never push main/master" in handoff


def test_docs_copilot_team_instructions_exists():
    path = Path(__file__).resolve().parents[1] / "docs" / "agent_team_instructions.md"
    assert path.exists()
    text = path.read_text(encoding="utf-8")

    for heading in [
        "## Purpose",
        "## Core Principles",
        "## Legacy C++ Guidelines",
        "## Qt Guidelines",
        "## Legacy Codebase Guidelines",
        "## Testing Expectations",
        "## Git Safety",
        "## Output Expectations",
        "## No-Op Fix Guidance",
    ]:
        assert heading in text
    assert "Do not commit or push automatically" in text
    assert "Only commit and push after explicit approval" in text
    assert "Never push main/master" in text
    assert "Never force push" in text
    assert "Never commit .ai/ or .ai_memory/" in text


def test_copilot_task_command_regenerates_task_files(tmp_path, monkeypatch):
    issue_dir = tmp_path / ".ai" / "JR-12345"
    issue_dir.mkdir(parents=True)
    (issue_dir / "bug_context.md").write_text("# Bug Context\n", encoding="utf-8")
    (issue_dir / "agent_task.md").write_text("old", encoding="utf-8")
    (issue_dir / "agent_team_instructions.md").write_text("UNIQUE_STALE_TEAM_INSTRUCTIONS", encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    assert main(["agent-task", "JR-12345"]) == 0

    assert "Agent Task" in (issue_dir / "agent_task.md").read_text()
    assert (issue_dir / "agent_handoff.md").is_file()
    assert "UNIQUE_STALE_TEAM_INSTRUCTIONS" not in (issue_dir / "agent_team_instructions.md").read_text()
    assert "Agent Team Instructions" in (issue_dir / "agent_team_instructions.md").read_text()
    # The standalone per-phase prompt files are no longer generated (their content
    # is contained in agent_task.md).
    assert not (issue_dir / "agent_fix_prompt.md").exists()
    assert not (issue_dir / "review_prompt.md").exists()


def test_bug_hint_is_injected_into_copilot_task(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    hint = "Fix in HrsQtProcessWidgetInversion.cxx: preserve non-Seismic input volume on tab switch"

    assert main(["bug", "JR-12345", "--allow-mock", "--hint", hint]) == 0
    issue_dir = tmp_path / ".ai" / "JR-12345"
    task = (issue_dir / "agent_task.md").read_text(encoding="utf-8")

    assert (issue_dir / "developer_hint.md").read_text(encoding="utf-8").strip() == hint
    assert "## Developer Hint" in task
    assert hint in task
    assert "Trust this hint" in task


def test_bug_without_hint_has_no_developer_hint_section(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)

    assert main(["bug", "JR-12345", "--allow-mock"]) == 0
    issue_dir = tmp_path / ".ai" / "JR-12345"

    assert not (issue_dir / "developer_hint.md").exists()
    assert "## Developer Hint" not in (issue_dir / "agent_task.md").read_text(encoding="utf-8")


def test_bug_hint_persists_across_resume(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    hint = "Look at HrsQtProcessWidgetInversion.cxx"

    assert main(["bug", "JR-12345", "--allow-mock", "--hint", hint]) == 0
    # Resume without repeating --hint: the stored hint should still apply.
    assert main(["bug", "JR-12345", "--allow-mock", "--resume"]) == 0
    task = (tmp_path / ".ai" / "JR-12345" / "agent_task.md").read_text(encoding="utf-8")

    assert hint in task


def test_copilot_task_command_reports_missing_bug_context(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)

    assert main(["agent-task", "JR-12345"]) == 1
    error = capsys.readouterr().err

    assert "Missing .ai/JR-12345/bug_context.md." in error
    assert "Run: bugpilot bug JR-12345" in error


def test_copilot_instructions_command_generates_file(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)

    assert main(["agent-instructions", "JR-12345"]) == 0
    output = capsys.readouterr().out
    path = tmp_path / ".ai" / "JR-12345" / "agent_team_instructions.md"
    status = json.loads((tmp_path / ".ai" / "JR-12345" / "workflow_status.json").read_text())
    log_text = (tmp_path / ".ai" / "JR-12345" / "execution.log").read_text()

    assert str(path) in output
    assert path.is_file()
    assert "Agent Team Instructions" in path.read_text(encoding="utf-8")
    assert status["steps"]["agent_instructions"] == "pass"
    assert ".ai/JR-12345/agent_team_instructions.md" in status["generated_files"]
    assert "[START] copilot_instructions" in log_text
    assert "[GENERATED] .ai/JR-12345/agent_team_instructions.md" in log_text
    assert "[END] copilot_instructions: pass" in log_text


def test_copilot_instructions_command_creates_missing_issue_dir(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    assert not (tmp_path / ".ai" / "JR-12345").exists()

    assert main(["agent-instructions", "JR-12345"]) == 0

    assert (tmp_path / ".ai" / "JR-12345" / "agent_team_instructions.md").is_file()


def test_check_results_reports_missing_files(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)

    assert main(["check-results", "JR-12345"]) == 0
    output = capsys.readouterr().out

    assert "WARN: missing 5 agent result file(s)." in output
    assert ".ai/JR-12345/bug_analysis.md" in output
    assert ".ai/JR-12345/review_notes.md" in output


def test_check_results_strict_missing_files_exits_nonzero(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)

    assert main(["check-results", "JR-12345", "--strict"]) == 1
    output = capsys.readouterr().out

    assert "WARN: missing 5 agent result file(s)." in output


def test_check_results_passes_when_all_files_exist(tmp_path, monkeypatch, capsys):
    issue_dir = tmp_path / ".ai" / "JR-12345"
    issue_dir.mkdir(parents=True)
    for file_name in ["bug_analysis.md", "fix_summary.md", "test_result.md", "diff_summary.md", "review_notes.md"]:
        (issue_dir / file_name).write_text("done", encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    assert main(["check-results", "JR-12345"]) == 0

    assert "PASS: all agent result files exist." in capsys.readouterr().out


def test_check_results_strict_passes_when_all_files_exist(tmp_path, monkeypatch, capsys):
    issue_dir = tmp_path / ".ai" / "JR-12345"
    issue_dir.mkdir(parents=True)
    for file_name in ["bug_analysis.md", "fix_summary.md", "test_result.md", "diff_summary.md", "review_notes.md"]:
        (issue_dir / file_name).write_text("done", encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    assert main(["check-results", "JR-12345", "--strict"]) == 0

    assert "PASS: all agent result files exist." in capsys.readouterr().out


def test_bug_agent_fix_remains_manual_and_safe(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)

    assert main(["bug", "JR-12345", "--agent-fix", "--allow-mock"]) == 0
    output = capsys.readouterr().out
    log_text = (tmp_path / ".ai" / "JR-12345" / "execution.log").read_text()
    status = json.loads((tmp_path / ".ai" / "JR-12345" / "workflow_status.json").read_text())

    assert "Agent automatic invocation is not enabled." in output
    assert "Read .ai/JR-12345/agent_task.md and complete the workflow." in output
    assert "[INFO] Agent automatic invocation is not enabled, using manual handoff" in log_text
    assert "[INFO] Next agent instruction: Read .ai/JR-12345/agent_task.md and complete the workflow." in log_text
    assert status["steps"]["agent_fix"] == "skipped"


def test_summarize_results_generates_summary_and_manual_validation(tmp_path, monkeypatch):
    issue_dir = tmp_path / ".ai" / "JR-12345"
    issue_dir.mkdir(parents=True)
    (issue_dir / "bug_analysis.md").write_text("Root cause: stale cache", encoding="utf-8")
    (issue_dir / "fix_summary.md").write_text("Cleared cache on filter change", encoding="utf-8")
    (issue_dir / "related_files.json").write_text(json.dumps([{"file": "src/EmployeeSearch.cpp"}]), encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    assert main(["summarize-results", "JR-12345"]) == 0
    summary = (issue_dir / "result_summary.md").read_text()
    manual = (issue_dir / "manual_validation.md").read_text()
    status = json.loads((issue_dir / "workflow_status.json").read_text())

    assert "- bug_analysis.md: present" in summary
    assert "- test_result.md: missing" in summary
    assert "Root cause: stale cache" in summary
    assert "Cleared cache on filter change" in summary
    assert "## Suggested Validation Steps" in manual
    assert "- src/EmployeeSearch.cpp" in manual
    assert status["steps"]["result_summary"] == "pass"
    assert status["steps"]["manual_validation"] == "pass"


def test_memory_update_replaces_final_result_section(tmp_path, monkeypatch):
    issue_dir = tmp_path / ".ai" / "JR-12345"
    memory_dir = tmp_path / ".ai_memory" / "bugs"
    issue_dir.mkdir(parents=True)
    memory_dir.mkdir(parents=True)
    (issue_dir / "result_summary.md").write_text(
        "# Result Summary\n\n"
        "## Root Cause Summary\nOld cache key\n\n"
        "## Fix Summary\nNew query key\n\n"
        "## Test Summary\nFocused tests passed\n\n"
        "## Review Notes\nLooks safe\n",
        encoding="utf-8",
    )
    (memory_dir / "JR-12345.md").write_text(
        "# JR-12345 AI Bug Workflow Memory\n\n"
        "## Jira Summary\n\nPreserve me.\n\n"
        "## Code Search Summary\n\nPreserve code search.\n\n"
        "## Related Files\n\nPreserve related files.\n\n"
        "## Final Result\n\nold final\n",
        encoding="utf-8",
    )
    monkeypatch.chdir(tmp_path)

    assert main(["memory", "update", "JR-12345"]) == 0
    memory = (memory_dir / "JR-12345.md").read_text()
    status = json.loads((issue_dir / "workflow_status.json").read_text())

    assert "Preserve me." in memory
    assert "Preserve code search." in memory
    assert "Preserve related files." in memory
    assert "old final" not in memory
    assert "### Root Cause\nOld cache key" in memory
    assert "### Fix\nNew query key" in memory
    assert "### Tests\nFocused tests passed" in memory
    assert "### Review Notes\nLooks safe" in memory
    assert "Result files incomplete. Manual update required." in memory
    assert status["steps"]["memory_update"] == "pass"


def test_memory_update_missing_result_summary_is_graceful(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)

    assert main(["memory", "update", "JR-12345"]) == 0
    output = capsys.readouterr().out
    status = json.loads((tmp_path / ".ai" / "JR-12345" / "workflow_status.json").read_text())

    assert "WARN: missing .ai/JR-12345/result_summary.md" in output
    assert status["steps"]["memory_update"] == "skipped"


def test_review_package_generates_final_review_prompt(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)

    assert main(["review-package", "JR-12345"]) == 0
    prompt = (tmp_path / ".ai" / "JR-12345" / "final_review_prompt.md").read_text()
    status = json.loads((tmp_path / ".ai" / "JR-12345" / "workflow_status.json").read_text())

    assert "# Final Review Request" in prompt
    assert "Please review the completed fix for Jira issue JR-12345." in prompt
    assert ".ai/JR-12345/result_summary.md if present" in prompt
    assert "Verdict:" in prompt
    assert "PASS / PASS WITH MINOR COMMENTS / NEEDS CHANGES" in prompt
    assert status["steps"]["final_review_prompt"] == "pass"


def test_phase_4_commands_log_generated_and_updated_files(tmp_path, monkeypatch):
    issue_dir = tmp_path / ".ai" / "JR-12345"
    memory_dir = tmp_path / ".ai_memory" / "bugs"
    issue_dir.mkdir(parents=True)
    memory_dir.mkdir(parents=True)
    (issue_dir / "bug_analysis.md").write_text("Root cause", encoding="utf-8")
    (issue_dir / "fix_summary.md").write_text("Fix", encoding="utf-8")
    (memory_dir / "JR-12345.md").write_text("# JR-12345\n", encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    main(["summarize-results", "JR-12345"])
    main(["memory", "update", "JR-12345"])
    main(["review-package", "JR-12345"])
    log_text = (issue_dir / "execution.log").read_text()

    assert "[GENERATED] .ai/JR-12345/result_summary.md" in log_text
    assert "[GENERATED] .ai/JR-12345/manual_validation.md" in log_text
    assert "[UPDATED] .ai_memory/bugs/JR-12345.md" in log_text
    assert "[GENERATED] .ai/JR-12345/final_review_prompt.md" in log_text


def _write_delivery_artifacts(tmp_path):
    issue_dir = tmp_path / ".ai" / "JR-12345"
    memory_dir = tmp_path / ".ai_memory" / "bugs"
    issue_dir.mkdir(parents=True, exist_ok=True)
    memory_dir.mkdir(parents=True, exist_ok=True)
    for file_name in ["bug_analysis.md", "fix_summary.md", "test_result.md", "diff_summary.md", "review_notes.md"]:
        (issue_dir / file_name).write_text("done", encoding="utf-8")
    (issue_dir / "result_summary.md").write_text("## Fix Summary\nshort summary\n", encoding="utf-8")
    (issue_dir / "final_review_prompt.md").write_text("review", encoding="utf-8")
    (memory_dir / "JR-12345.md").write_text("memory", encoding="utf-8")
    return issue_dir


def test_delivery_check_warns_when_required_files_missing(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)

    assert main(["delivery-check", "JR-12345"]) == 0
    output = capsys.readouterr().out
    status = json.loads((tmp_path / ".ai" / "JR-12345" / "workflow_status.json").read_text())

    assert "WARN: delivery is not ready." in output
    assert "Missing required result file: .ai/JR-12345/bug_analysis.md" in output
    assert status["steps"]["delivery_check"] == "fail"


def test_delivery_check_passes_when_ready(tmp_path, monkeypatch, capsys):
    _write_delivery_artifacts(tmp_path)

    monkeypatch.setattr("bugpilot.core.workflow.inside_git_repo", lambda repo_root: True)
    monkeypatch.setattr("bugpilot.core.workflow.current_branch", lambda repo_root: "feature/JR-12345-demo")
    monkeypatch.setattr("bugpilot.core.workflow.working_tree_status", lambda repo_root: " M src/file.cpp")
    monkeypatch.chdir(tmp_path)

    assert main(["delivery-check", "JR-12345"]) == 0
    output = capsys.readouterr().out
    status = json.loads((tmp_path / ".ai" / "JR-12345" / "workflow_status.json").read_text())

    assert "PASS: ready for manual commit/push." in output
    assert status["steps"]["delivery_check"] == "pass"


def test_commit_plan_generates_file_without_git_mutation(tmp_path, monkeypatch):
    calls = []

    def fake_run_command(args, repo_root):
        calls.append(args)
        if args[:3] == ["git", "branch", "--show-current"]:
            return 0, "feature/JR-12345-demo"
        if args[:3] == ["git", "diff", "--name-only"]:
            return 0, "src/file.cpp"
        if args[:3] == ["git", "diff", "--stat"]:
            return 0, " src/file.cpp | 2 +-\n 1 file changed"
        return 0, ""

    monkeypatch.setattr("bugpilot.core.workflow.run_command", fake_run_command)
    monkeypatch.chdir(tmp_path)

    assert main(["commit-plan", "JR-12345"]) == 0
    plan = (tmp_path / ".ai" / "JR-12345" / "commit_plan.md").read_text()

    assert "# Commit Plan" in plan
    assert "feature/JR-12345-demo" in plan
    assert "src/file.cpp" in plan
    assert 'git commit -m "Fix JR-12345:' in plan
    assert not any(call[:2] == ["git", "add"] for call in calls)
    assert not any(call[:2] == ["git", "commit"] for call in calls)


def test_push_plan_generates_file_without_git_push(tmp_path, monkeypatch):
    calls = []

    def fake_run_command(args, repo_root):
        calls.append(args)
        if args[:3] == ["git", "branch", "--show-current"]:
            return 0, "feature/JR-12345-demo"
        if args[:2] == ["git", "remote"]:
            return 0, "origin https://example/repo.git (fetch)\norigin https://example/repo.git (push)"
        if args[:2] == ["git", "log"]:
            return 0, "abc123 Fix JR-12345"
        if args[:3] == ["git", "status", "--porcelain"]:
            return 0, " M src/file.cpp"
        return 0, ""

    monkeypatch.setattr("bugpilot.core.workflow.run_command", fake_run_command)
    monkeypatch.chdir(tmp_path)

    assert main(["push-plan", "JR-12345"]) == 0
    plan = (tmp_path / ".ai" / "JR-12345" / "push_plan.md").read_text()

    assert "# Push Plan" in plan
    assert "feature/JR-12345-demo" in plan
    assert "git push -u origin feature/JR-12345-demo" in plan
    assert not any(call[:2] == ["git", "push"] for call in calls)


def test_delivery_commands_are_safe_outside_git_repo(tmp_path, monkeypatch, capsys):
    _write_delivery_artifacts(tmp_path)
    monkeypatch.setattr("bugpilot.core.workflow.inside_git_repo", lambda repo_root: False)
    monkeypatch.setattr("bugpilot.core.workflow.current_branch", lambda repo_root: None)
    monkeypatch.setattr("bugpilot.core.workflow.working_tree_status", lambda repo_root: None)
    monkeypatch.chdir(tmp_path)

    assert main(["delivery-check", "JR-12345"]) == 0
    output = capsys.readouterr().out

    assert "Current directory is not inside a git repository." in output
    assert "Current branch is unavailable." in output


def test_delivery_plan_status_and_log_entries(tmp_path, monkeypatch):
    monkeypatch.setattr("bugpilot.core.workflow.run_command", lambda args, repo_root: (0, "feature/JR-12345-demo"))
    monkeypatch.chdir(tmp_path)

    main(["commit-plan", "JR-12345"])
    main(["push-plan", "JR-12345"])
    status = json.loads((tmp_path / ".ai" / "JR-12345" / "workflow_status.json").read_text())
    log_text = (tmp_path / ".ai" / "JR-12345" / "execution.log").read_text()

    assert status["steps"]["commit_plan"] == "pass"
    assert status["steps"]["push_plan"] == "pass"
    assert ".ai/JR-12345/commit_plan.md" in status["generated_files"]
    assert ".ai/JR-12345/push_plan.md" in status["generated_files"]
    assert "[GENERATED] .ai/JR-12345/commit_plan.md" in log_text
    assert "[GENERATED] .ai/JR-12345/push_plan.md" in log_text


def test_commit_and_push_execute_placeholders_do_not_mutate_git(tmp_path, monkeypatch, capsys):
    calls = []
    monkeypatch.setattr("bugpilot.core.workflow.run_command", lambda args, repo_root: calls.append(args) or (0, ""))
    monkeypatch.chdir(tmp_path)

    assert main(["commit", "JR-12345", "--execute"]) == 0
    assert main(["push", "JR-12345", "--execute"]) == 0
    output = capsys.readouterr().out

    # The guarantee is `calls == []`; the message only has to send the developer
    # somewhere useful, so it is checked for that and not for its exact wording.
    assert "commit-plan" in output and "push-plan" in output
    assert calls == []


def test_clean_removes_issue_artifact_directory(tmp_path, monkeypatch, capsys):
    issue_dir = tmp_path / ".ai" / "JR-12345"
    issue_dir.mkdir(parents=True)
    (issue_dir / "some_old_file.md").write_text("old", encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    assert main(["clean", "JR-12345"]) == 0
    output = capsys.readouterr().out

    assert not issue_dir.exists()
    assert "deleted: .ai/JR-12345/" in output


def test_clean_preserves_memory_by_default(tmp_path, monkeypatch):
    issue_dir = tmp_path / ".ai" / "JR-12345"
    memory_file = tmp_path / ".ai_memory" / "bugs" / "JR-12345.md"
    issue_dir.mkdir(parents=True)
    memory_file.parent.mkdir(parents=True)
    memory_file.write_text("keep me", encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    assert main(["clean", "JR-12345"]) == 0

    assert not issue_dir.exists()
    assert memory_file.read_text(encoding="utf-8") == "keep me"


def test_clean_include_memory_removes_only_that_issue_memory(tmp_path, monkeypatch):
    issue_dir = tmp_path / ".ai" / "JR-12345"
    memory_dir = tmp_path / ".ai_memory" / "bugs"
    issue_dir.mkdir(parents=True)
    memory_dir.mkdir(parents=True)
    (memory_dir / "JR-12345.md").write_text("delete", encoding="utf-8")
    (memory_dir / "JR-99999.md").write_text("keep", encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    assert main(["clean", "JR-12345", "--include-memory"]) == 0

    assert not issue_dir.exists()
    assert not (memory_dir / "JR-12345.md").exists()
    assert (memory_dir / "JR-99999.md").read_text(encoding="utf-8") == "keep"


def test_clean_handles_missing_artifacts_gracefully(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)

    assert main(["clean", "JR-12345"]) == 0
    output = capsys.readouterr().out

    assert "No workflow artifacts found for JR-12345." in output
    assert "Preserved memory entry: .ai_memory/bugs/JR-12345.md" in output


def test_clean_rejects_invalid_issue_keys_without_deleting(tmp_path, monkeypatch, capsys):
    product_file = tmp_path / "src" / "example.cpp"
    product_file.parent.mkdir()
    product_file.write_text("int main() { return 0; }\n", encoding="utf-8")
    protected_dir = tmp_path / ".ai" / "JR-12345"
    protected_dir.mkdir(parents=True)
    (protected_dir / "keep.md").write_text("keep", encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    for invalid in ["../JR-12345", "..\\JR-12345", "JR-12345/../../x", "HR", "12345", " JR-12345", "JR-12345 "]:
        assert main(["clean", invalid]) == 1

    assert protected_dir.exists()
    assert product_file.exists()
    assert "Invalid issue key" in capsys.readouterr().err


def test_clean_accepts_unpadded_valid_issue_key(tmp_path, monkeypatch):
    issue_dir = tmp_path / ".ai" / "JR-12345"
    issue_dir.mkdir(parents=True)
    monkeypatch.chdir(tmp_path)

    assert main(["clean", "JR-12345"]) == 0

    assert not issue_dir.exists()


def test_bug_fresh_removes_old_later_phase_artifacts(tmp_path, monkeypatch):
    issue_dir = tmp_path / ".ai" / "JR-12345"
    issue_dir.mkdir(parents=True)
    (issue_dir / "result_summary.md").write_text("old result", encoding="utf-8")
    (issue_dir / "commit_plan.md").write_text("old commit", encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    assert main(["bug", "JR-12345", "--fresh", "--allow-mock"]) == 0

    assert not (issue_dir / "result_summary.md").exists()
    assert not (issue_dir / "commit_plan.md").exists()
    assert (issue_dir / "workflow_status.json").is_file()
    assert (issue_dir / "bug_context.md").is_file()
    log_text = (issue_dir / "execution.log").read_text(encoding="utf-8")
    assert "[INFO] fresh run requested" in log_text
    assert "[INFO] memory entry preserved" in log_text


def test_bug_default_is_fresh_and_removes_old_artifacts(tmp_path, monkeypatch):
    _set_jira_env(monkeypatch)
    monkeypatch.setattr(
        "bugpilot.core.jira.urllib.request.urlopen",
        lambda request, timeout: _good_jira_response()(),
    )
    issue_dir = tmp_path / ".ai" / "JR-12345"
    issue_dir.mkdir(parents=True)
    (issue_dir / "old_artifact.md").write_text("old", encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    assert main(["bug", "JR-12345"]) == 0

    assert not (issue_dir / "old_artifact.md").exists()
    assert (issue_dir / "bug_context.md").is_file()
    status = json.loads((issue_dir / "workflow_status.json").read_text(encoding="utf-8"))
    log_text = (issue_dir / "execution.log").read_text(encoding="utf-8")
    assert status["fresh"] is True
    assert status["allow_mock"] is False
    assert "[INFO] effective mode: fresh=true, allow_mock=false" in log_text


def test_bug_resume_preserves_old_artifacts(tmp_path, monkeypatch):
    issue_dir = tmp_path / ".ai" / "JR-12345"
    issue_dir.mkdir(parents=True)
    (issue_dir / "old_artifact.md").write_text("old", encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    assert main(["bug", "JR-12345", "--resume", "--allow-mock"]) == 0

    assert (issue_dir / "old_artifact.md").exists()
    log_text = (issue_dir / "execution.log").read_text(encoding="utf-8")
    assert "[INFO] effective mode: fresh=false, allow_mock=true" in log_text
    assert "[INFO] previous workflow artifacts were preserved" in log_text


def test_bug_fresh_preserves_memory_by_default(tmp_path, monkeypatch):
    memory_file = tmp_path / ".ai_memory" / "bugs" / "JR-12345.md"
    memory_file.parent.mkdir(parents=True)
    memory_file.write_text("old memory", encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    assert main(["bug", "JR-12345", "--fresh", "--allow-mock"]) == 0

    assert memory_file.exists()


def test_bug_fresh_include_memory_removes_old_memory_then_recreates(tmp_path, monkeypatch):
    memory_file = tmp_path / ".ai_memory" / "bugs" / "JR-12345.md"
    memory_file.parent.mkdir(parents=True)
    memory_file.write_text("UNIQUE OLD MEMORY", encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    assert main(["bug", "JR-12345", "--fresh", "--include-memory", "--allow-mock"]) == 0

    memory = memory_file.read_text(encoding="utf-8")
    assert "UNIQUE OLD MEMORY" not in memory
    assert "Prototype prepare-only workflow" in memory


def test_bug_default_include_memory_removes_old_memory_then_recreates(tmp_path, monkeypatch):
    memory_file = tmp_path / ".ai_memory" / "bugs" / "JR-12345.md"
    memory_file.parent.mkdir(parents=True)
    memory_file.write_text("UNIQUE OLD MEMORY", encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    assert main(["bug", "JR-12345", "--include-memory", "--allow-mock"]) == 0

    memory = memory_file.read_text(encoding="utf-8")
    assert "UNIQUE OLD MEMORY" not in memory
    assert "Prototype prepare-only workflow" in memory


def test_clean_does_not_affect_product_files(tmp_path, monkeypatch):
    issue_dir = tmp_path / ".ai" / "JR-12345"
    product_file = tmp_path / "src" / "example.cpp"
    issue_dir.mkdir(parents=True)
    product_file.parent.mkdir()
    product_file.write_text("source", encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    assert main(["clean", "JR-12345"]) == 0

    assert product_file.read_text(encoding="utf-8") == "source"


def test_bug_resume_include_memory_conflicts(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)

    assert main(["bug", "JR-12345", "--resume", "--include-memory"]) == 1

    assert "--include-memory requires fresh mode and cannot be used with --resume" in capsys.readouterr().err


def test_bug_fresh_and_resume_conflict():
    with pytest.raises(SystemExit) as exc_info:
        main(["bug", "JR-12345", "--fresh", "--resume"])

    assert exc_info.value.code == 2


def test_bug_allow_mock_and_no_mock_conflict():
    with pytest.raises(SystemExit) as exc_info:
        main(["bug", "JR-12345", "--allow-mock", "--no-mock"])

    assert exc_info.value.code == 2


def test_fetch_allow_mock_and_no_mock_conflict():
    with pytest.raises(SystemExit) as exc_info:
        main(["fetch", "JR-12345", "--allow-mock", "--no-mock"])

    assert exc_info.value.code == 2


def test_missing_env_default_no_mock_fails_without_mock_artifacts(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("JIRA_BASE_URL", raising=False)
    monkeypatch.delenv("JIRA_EMAIL", raising=False)
    monkeypatch.delenv("JIRA_TOKEN", raising=False)
    monkeypatch.chdir(tmp_path)

    assert main(["bug", "JR-12345"]) == 1
    error = capsys.readouterr().err
    issue_dir = tmp_path / ".ai" / "JR-12345"

    assert "ERROR: Jira environment variables are missing." in error
    assert "Mock fallback is disabled by default." in error
    assert "Use --allow-mock only for demo/testing fallback." in error
    assert not (issue_dir / "jira.json").exists()
    assert not (issue_dir / "jira_summary.md").exists()
    status = json.loads((issue_dir / "workflow_status.json").read_text(encoding="utf-8"))
    assert status["fresh"] is True
    assert status["allow_mock"] is False


def test_missing_env_allow_mock_marks_fallback(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("JIRA_BASE_URL", raising=False)
    monkeypatch.delenv("JIRA_EMAIL", raising=False)
    monkeypatch.delenv("JIRA_TOKEN", raising=False)
    monkeypatch.chdir(tmp_path)

    assert main(["bug", "JR-12345", "--allow-mock"]) == 0
    output = capsys.readouterr().out
    issue_dir = tmp_path / ".ai" / "JR-12345"
    jira = json.loads((issue_dir / "jira.json").read_text(encoding="utf-8"))
    summary = (issue_dir / "jira_summary.md").read_text(encoding="utf-8")
    log_text = (issue_dir / "execution.log").read_text(encoding="utf-8")

    assert "WARN: Jira environment variables are missing." in output
    assert jira["source"] == "mock"
    assert jira["mock"] is True
    assert jira["fallback_error_type"] == "missing_env"
    assert "bugpilot_normalized" in jira
    assert "comments" in jira["bugpilot_normalized"]
    assert "attachments" in jira["bugpilot_normalized"]
    assert "## Data Source\n\nmock/demo fallback" in summary
    assert "Jira environment variables are missing" in summary
    assert "[WARN] Jira fetch failed: missing_env" in log_text


def test_missing_env_no_mock_fails_without_mock_artifacts(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("JIRA_BASE_URL", raising=False)
    monkeypatch.delenv("JIRA_EMAIL", raising=False)
    monkeypatch.delenv("JIRA_TOKEN", raising=False)
    monkeypatch.chdir(tmp_path)

    assert main(["bug", "JR-12345", "--no-mock"]) == 1
    error = capsys.readouterr().err
    issue_dir = tmp_path / ".ai" / "JR-12345"
    status = json.loads((issue_dir / "workflow_status.json").read_text(encoding="utf-8"))
    log_text = (issue_dir / "execution.log").read_text(encoding="utf-8")

    assert "ERROR: Jira environment variables are missing." in error
    assert "Mock fallback is disabled by default." in error
    assert not (issue_dir / "jira_summary.md").exists()
    assert not (issue_dir / "jira.json").exists()
    assert status["steps"]["fetch"] == "fail"
    assert status["steps"]["parse"] == "skipped"
    assert "[ERROR] Jira fetch failed: missing_env" in log_text


def test_fetch_default_no_mock_fails_without_mock_fallback(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("JIRA_BASE_URL", raising=False)
    monkeypatch.delenv("JIRA_EMAIL", raising=False)
    monkeypatch.delenv("JIRA_TOKEN", raising=False)
    monkeypatch.chdir(tmp_path)

    assert main(["fetch", "JR-12345"]) == 1
    error = capsys.readouterr().err
    issue_dir = tmp_path / ".ai" / "JR-12345"

    assert "Mock fallback is disabled by default." in error
    assert not (issue_dir / "jira.json").exists()
    assert not (issue_dir / "jira_summary.md").exists()


def test_fetch_allow_mock_generates_mock_files(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("JIRA_BASE_URL", raising=False)
    monkeypatch.delenv("JIRA_EMAIL", raising=False)
    monkeypatch.delenv("JIRA_TOKEN", raising=False)
    monkeypatch.chdir(tmp_path)

    assert main(["fetch", "JR-12345", "--allow-mock"]) == 0
    output = capsys.readouterr().out
    jira = json.loads((tmp_path / ".ai" / "JR-12345" / "jira.json").read_text(encoding="utf-8"))

    assert "WARN: Jira environment variables are missing." in output
    assert jira["source"] == "mock"
    assert jira["mock"] is True


def test_fetch_no_mock_fails_without_mock_fallback(tmp_path, monkeypatch, capsys):
    monkeypatch.delenv("JIRA_BASE_URL", raising=False)
    monkeypatch.delenv("JIRA_EMAIL", raising=False)
    monkeypatch.delenv("JIRA_TOKEN", raising=False)
    monkeypatch.chdir(tmp_path)

    assert main(["fetch", "JR-12345", "--no-mock"]) == 1
    error = capsys.readouterr().err
    issue_dir = tmp_path / ".ai" / "JR-12345"

    assert "Mock fallback is disabled by default." in error
    assert not (issue_dir / "jira.json").exists()
    assert not (issue_dir / "jira_summary.md").exists()
    status = json.loads((issue_dir / "workflow_status.json").read_text(encoding="utf-8"))
    assert status["steps"]["fetch"] == "fail"


def _set_jira_env(monkeypatch):
    monkeypatch.setenv("JIRA_BASE_URL", "https://jira.example.test")
    monkeypatch.setenv("JIRA_EMAIL", "dev@example.test")
    monkeypatch.setenv("JIRA_TOKEN", "token-value")


def _http_error(status_code: int) -> urllib.error.HTTPError:
    return urllib.error.HTTPError(
        "https://jira.example.test/rest/api/3/issue/JR-12345",
        status_code,
        "error",
        hdrs=None,
        fp=None,
    )


def test_jira_http_401_403_classifies_auth_or_permission(tmp_path, monkeypatch):
    _set_jira_env(monkeypatch)
    monkeypatch.setattr("bugpilot.core.jira.urllib.request.urlopen", lambda request, timeout: (_ for _ in ()).throw(_http_error(401)))

    fallback = fetch_issue(tmp_path, "JR-12345", allow_mock=True)
    assert fallback.source == "mock"
    assert fallback.error_type == "auth_or_permission"

    monkeypatch.setattr("bugpilot.core.jira.urllib.request.urlopen", lambda request, timeout: (_ for _ in ()).throw(_http_error(403)))
    with pytest.raises(JiraFetchError) as exc_info:
        fetch_issue(tmp_path, "JR-12345", allow_mock=False)
    assert exc_info.value.result.error_type == "auth_or_permission"


def test_jira_http_404_classifies_not_found(tmp_path, monkeypatch):
    _set_jira_env(monkeypatch)
    monkeypatch.setattr("bugpilot.core.jira.urllib.request.urlopen", lambda request, timeout: (_ for _ in ()).throw(_http_error(404)))

    result = fetch_issue(tmp_path, "JR-12345")

    assert result.error_type == "not_found"
    assert result.source == "mock"


def test_jira_http_429_classifies_rate_limited(tmp_path, monkeypatch):
    _set_jira_env(monkeypatch)
    monkeypatch.setattr("bugpilot.core.jira.urllib.request.urlopen", lambda request, timeout: (_ for _ in ()).throw(_http_error(429)))

    result = fetch_issue(tmp_path, "JR-12345")

    assert result.error_type == "rate_limited"


def test_jira_timeout_classifies_timeout(tmp_path, monkeypatch):
    _set_jira_env(monkeypatch)
    monkeypatch.setattr("bugpilot.core.jira.urllib.request.urlopen", lambda request, timeout: (_ for _ in ()).throw(socket.timeout()))

    result = fetch_issue(tmp_path, "JR-12345")

    assert result.error_type == "timeout"

    monkeypatch.setattr("bugpilot.core.jira.urllib.request.urlopen", lambda request, timeout: (_ for _ in ()).throw(TimeoutError()))

    result = fetch_issue(tmp_path, "JR-12345")

    assert result.error_type == "timeout"


def test_jira_network_error_classifies_network_error(tmp_path, monkeypatch):
    _set_jira_env(monkeypatch)
    monkeypatch.setattr("bugpilot.core.jira.urllib.request.urlopen", lambda request, timeout: (_ for _ in ()).throw(urllib.error.URLError("dns failed")))

    result = fetch_issue(tmp_path, "JR-12345")

    assert result.error_type == "network_error"


def test_jira_invalid_response_classifies_invalid_response(tmp_path, monkeypatch):
    _set_jira_env(monkeypatch)

    class BadResponse:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def read(self):
            return b"{not json"

    monkeypatch.setattr("bugpilot.core.jira.urllib.request.urlopen", lambda request, timeout: BadResponse())

    result = fetch_issue(tmp_path, "JR-12345")

    assert result.error_type == "invalid_response"


def test_jira_success_path_marks_real_source(tmp_path, monkeypatch):
    _set_jira_env(monkeypatch)

    class GoodResponse:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def read(self):
            return json.dumps(
                {
                    "key": "JR-12345",
                    "fields": {
                        "summary": "Real Jira summary",
                        "description": "Real description",
                        "issuetype": {"name": "Bug"},
                        "status": {"name": "Open"},
                        "priority": {"name": "High"},
                        "comment": {"comments": []},
                    },
                }
            ).encode("utf-8")

    monkeypatch.setattr("bugpilot.core.jira.urllib.request.urlopen", lambda request, timeout: GoodResponse())

    result = fetch_issue(tmp_path, "JR-12345")

    assert result.source == "jira"
    assert result.error_type is None
    assert result.data["source"] == "jira"
    assert result.data["mock"] is False


def test_adf_none_input_returns_empty_string():
    assert adf_to_markdown(None) == ""


def test_adf_plain_string_passthrough():
    assert adf_to_markdown("hello") == "hello"


def test_adf_simple_paragraph():
    adf = {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "hello world"}]}]}

    assert adf_to_markdown(adf) == "hello world"


def test_adf_text_marks():
    adf = {
        "type": "paragraph",
        "content": [
            {"type": "text", "text": "bold", "marks": [{"type": "strong"}]},
            {"type": "text", "text": " "},
            {"type": "text", "text": "italic", "marks": [{"type": "em"}]},
            {"type": "text", "text": " "},
            {"type": "text", "text": "value", "marks": [{"type": "code"}]},
        ],
    }

    assert adf_to_markdown(adf) == "**bold** *italic* `value`"


def test_adf_strike_mark():
    adf = {"type": "text", "text": "text", "marks": [{"type": "strike"}]}

    assert adf_to_markdown(adf) == "~~text~~"


def test_adf_null_text_renders_empty_string():
    adf = {"type": "text", "text": None, "marks": [{"type": "strong"}]}

    assert adf_to_markdown(adf) == ""


def test_adf_link_mark():
    adf = {
        "type": "paragraph",
        "content": [
            {
                "type": "text",
                "text": "OpenAI",
                "marks": [{"type": "link", "attrs": {"href": "https://example.com"}}],
            }
        ],
    }

    assert adf_to_markdown(adf) == "[OpenAI](https://example.com)"


def test_adf_bullet_list():
    adf = {
        "type": "bulletList",
        "content": [
            {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "first"}]}]},
            {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "second"}]}]},
        ],
    }

    assert adf_to_markdown(adf) == "- first\n- second"


def test_adf_ordered_list():
    adf = {
        "type": "orderedList",
        "content": [
            {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "first"}]}]},
            {"type": "listItem", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "second"}]}]},
        ],
    }

    assert adf_to_markdown(adf) == "1. first\n2. second"


def test_adf_code_block_with_language():
    adf = {
        "type": "codeBlock",
        "attrs": {"language": "python"},
        "content": [{"type": "text", "text": "print('hello')\n"}],
    }

    markdown = adf_to_markdown(adf)
    assert markdown.startswith("```python")
    assert "print('hello')" in markdown
    assert markdown.endswith("```")


def test_adf_heading_level_two():
    adf = {"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "Heading"}]}

    assert adf_to_markdown(adf) == "## Heading"


def test_adf_blockquote():
    adf = {"type": "blockquote", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "quoted"}]}]}

    assert adf_to_markdown(adf) == "> quoted"


def test_adf_unknown_node_with_text_child():
    adf = {"type": "mystery", "content": [{"type": "paragraph", "content": [{"type": "text", "text": "readable"}]}]}

    assert adf_to_markdown(adf) == "readable"


def test_adf_media_nodes_do_not_crash():
    assert adf_to_markdown({"type": "mediaSingle", "content": [{"type": "media"}]}) == "[media omitted]"


def test_jira_summary_uses_converted_adf_description():
    issue = {
        "key": "JR-12345",
        "fields": {
            "summary": "ADF issue",
            "description": {
                "type": "doc",
                "content": [
                    {"type": "heading", "attrs": {"level": 2}, "content": [{"type": "text", "text": "Steps"}]},
                    {"type": "paragraph", "content": [{"type": "text", "text": "Open search and filter."}]},
                ],
            },
            "issuetype": {"name": "Bug"},
            "status": {"name": "Open"},
            "priority": {"name": "High"},
            "labels": ["adf"],
            "components": [{"name": "Search"}],
            "comment": {"comments": []},
        },
    }

    summary = jira_summary_markdown(issue, "Fetched Jira data from configured Jira instance.")

    assert "## Steps" in summary
    assert "Open search and filter." in summary
    assert '"type": "doc"' not in summary
    assert "adf" in summary
    assert "Search" in summary


def test_jira_summary_uses_converted_adf_comments():
    issue = {
        "key": "JR-12345",
        "fields": {
            "summary": "ADF comments",
            "description": "Plain description",
            "issuetype": {"name": "Bug"},
            "status": {"name": "Open"},
            "priority": {"name": "High"},
            "comment": {
                "comments": [
                    {
                        "author": {"displayName": "Dev User"},
                        "created": "2026-05-30T12:00:00.000+0000",
                        "body": {
                            "type": "doc",
                            "content": [
                                {
                                    "type": "paragraph",
                                    "content": [
                                        {"type": "text", "text": "Please check "},
                                        {"type": "text", "text": "EmployeeSearch", "marks": [{"type": "strong"}]},
                                    ],
                                }
                            ],
                        },
                    }
                ]
            },
        },
    }

    summary = jira_summary_markdown(issue, "Fetched Jira data from configured Jira instance.")

    assert "### Comment 1" in summary
    assert "Author: Dev User" in summary
    assert "Created: 2026-05-30T12:00:00.000+0000" in summary
    assert "Please check **EmployeeSearch**" in summary
    assert '"content"' not in summary


def test_jira_comments_with_adf_body_include_author_and_created():
    issue = _jira_issue(
        comments=[
            _jira_comment("Dev One", "2026-05-30T10:00:00.000+0000", _adf_text("First **ignored literal**")),
            _jira_comment("Dev Two", "2026-05-30T11:00:00.000+0000", _adf_marked_text("Regression", "strong")),
        ]
    )

    summary = jira_summary_markdown(issue, "Fetched Jira data from configured Jira instance.")

    assert "### Comment 1" in summary
    assert "Author: Dev One" in summary
    assert "Created: 2026-05-30T10:00:00.000+0000" in summary
    assert "Author: Dev Two" in summary
    assert "**Regression**" in summary


def test_jira_comment_limit_renders_latest_ten():
    comments = [
        _jira_comment(f"Dev {index}", f"2026-05-{index:02d}T10:00:00.000+0000", _adf_text(f"Body {index:02d}"))
        for index in range(1, 13)
    ]
    issue = _jira_issue(comments=comments)

    summary = jira_summary_markdown(issue, "Fetched Jira data from configured Jira instance.")

    assert "Showing latest 10 of 12 comments." in summary
    assert "Body 01" not in summary
    assert "Body 02" not in summary
    assert "Body 03" in summary
    assert "Body 12" in summary


def test_jira_empty_comments_are_clear():
    summary = jira_summary_markdown(_jira_issue(comments=[]), "Fetched Jira data from configured Jira instance.")

    assert "## Comments" in summary
    assert "No comments found." in summary


def test_single_jira_comment_does_not_show_latest_note():
    issue = _jira_issue(comments=[_jira_comment("Dev", "2026-05-30T10:00:00.000+0000", _adf_text("Only comment"))])

    summary = jira_summary_markdown(issue, "Fetched Jira data from configured Jira instance.")

    assert "Only comment" in summary
    assert "Showing latest" not in summary


def test_attachment_metadata_is_rendered_without_download():
    issue = _jira_issue(
        attachments=[
            _jira_attachment("screenshot.png", "image/png", 2048, "QA"),
            _jira_attachment("crash.log", "text/plain", 12345, "Dev"),
            _jira_attachment("repro.zip", "application/zip", 4096, "User"),
        ]
    )

    summary = jira_summary_markdown(issue, "Fetched Jira data from configured Jira instance.")

    assert "Attachment content is not downloaded by bugpilot." in summary
    assert "| screenshot.png | screenshot | 2 KB" in summary
    assert "| crash.log | log | 12 KB" in summary
    assert "| repro.zip | repro_project | 4 KB" in summary
    assert "https://jira.example.test/secure/attachment/" not in summary


def test_attachment_kind_classification():
    assert classify_attachment("screenshot.png", "image/png") == "screenshot"
    assert classify_attachment("debug.log", "text/plain") == "log"
    assert classify_attachment("crash.mdmp", "application/octet-stream") == "crash_dump"
    assert classify_attachment("repro.zip", "application/zip") == "repro_project"
    assert classify_attachment("notes.pdf", "application/pdf") == "document"
    assert classify_attachment("data.bin", "application/octet-stream") == "unknown"


def test_jira_parsed_comment_signals():
    issue = _jira_issue(comments=[_jira_comment("Dev", "2026-05-30T10:00:00.000+0000", _adf_text("Stack trace shows regression"))])
    parsed = parse_issue(issue)

    markdown = parsed_markdown(parsed)

    assert "## Comment Signals" in markdown
    assert "- Number of comments: 1" in markdown
    assert "stack trace" in markdown
    assert "regression" in markdown


def test_jira_parsed_attachment_signals():
    issue = _jira_issue(
        attachments=[
            _jira_attachment("screenshot.jpg", "image/jpeg", 1024, "QA"),
            _jira_attachment("error.log", "text/plain", 1024, "QA"),
        ]
    )
    parsed = parse_issue(issue)

    markdown = parsed_markdown(parsed)

    assert "## Attachment Signals" in markdown
    assert "- Number of attachments: 2" in markdown
    assert "log" in markdown
    assert "screenshot" in markdown


def test_bug_context_includes_comment_and_attachment_signals(tmp_path):
    issue = _jira_issue(
        comments=[_jira_comment("Dev", "2026-05-30T10:00:00.000+0000", _adf_text("Regression in stack trace"))],
        attachments=[_jira_attachment("crash.log", "text/plain", 4096, "Dev")],
    )
    issue_dir = tmp_path / ".ai" / "JR-12345"
    issue_dir.mkdir(parents=True)
    (issue_dir / "jira.json").write_text(json.dumps(issue), encoding="utf-8")

    workflow.parse_step(tmp_path, "JR-12345")
    workflow.keywords_step(tmp_path, "JR-12345")
    workflow.memory_search_step(tmp_path, "JR-12345")
    workflow.code_search_step(tmp_path, "JR-12345")
    workflow.git_context_step(tmp_path, "JR-12345")
    workflow.context_step(tmp_path, "JR-12345")

    context = (issue_dir / "bug_context.md").read_text(encoding="utf-8")
    assert "## Comment Signals" in context
    assert "## Attachment Signals" in context
    assert "Use Jira comments as additional context" in context
    assert "Do not assume attachment content was read" in context


def test_copilot_task_includes_comment_attachment_guidance(tmp_path):
    run_bug_workflow(tmp_path, "JR-12345", allow_mock=True)
    task = (tmp_path / ".ai" / "JR-12345" / "agent_task.md").read_text(encoding="utf-8")

    assert "Read Jira comments in `bug_context.md`" in task
    assert "comments in `bug_context.md` as potentially newer than the original description" in task
    assert "Review Jira attachment metadata" in task
    assert "Do not claim to have inspected attachment contents unless the content is present" in task


def _jira_issue(comments=None, attachments=None):
    return {
        "key": "JR-12345",
        "source": "jira",
        "mock": False,
        "fields": {
            "summary": "Real Jira summary",
            "description": _adf_text("Real description"),
            "issuetype": {"name": "Bug"},
            "status": {"name": "Open"},
            "priority": {"name": "High"},
            "comment": {"comments": comments or []},
            "attachment": attachments or [],
        },
    }


def _jira_comment(author, created, body, updated=""):
    return {
        "author": {"displayName": author, "accountId": f"{author.lower().replace(' ', '-')}-id"},
        "created": created,
        "updated": updated,
        "body": body,
    }


def _jira_attachment(filename, mime_type, size, author):
    return {
        "filename": filename,
        "mimeType": mime_type,
        "size": size,
        "created": "2026-05-30T12:00:00.000+0000",
        "author": {"displayName": author},
        "content": f"https://jira.example.test/secure/attachment/{filename}?token=secret",
        "thumbnail": f"https://jira.example.test/secure/thumbnail/{filename}?token=secret",
    }


def _adf_text(text):
    return {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": text}]}]}


def _adf_marked_text(text, mark):
    return {"type": "doc", "content": [{"type": "paragraph", "content": [{"type": "text", "text": text, "marks": [{"type": mark}]}]}]}


# ---------------------------------------------------------------------------
# Phase 8.3 — Richer jira_parsed.md / Missing Information Extraction
# ---------------------------------------------------------------------------


def test_jira_parse_section_extraction_with_markdown_headings():
    description = (
        "## Steps to Reproduce\n\n"
        "1. Open the HR employee search\n"
        "2. Apply a department filter\n"
        "3. Observe stale results\n\n"
        "## Actual Result\n\n"
        "Prior results remain visible until page refresh.\n\n"
        "## Expected Result\n\n"
        "Results refresh immediately after filter changes.\n\n"
        "## Environment\n\n"
        "Windows 11\n"
    )

    result = extract_parsed_details(description, [], [])

    assert result["reproduction_steps"] == [
        "Open the HR employee search",
        "Apply a department filter",
        "Observe stale results",
    ]
    assert "Prior results remain" in result["actual_result"]
    assert "Results refresh immediately" in result["expected_result"]
    assert "Results refresh" not in result["actual_result"]
    assert "Windows" not in result["expected_result"]
    joined_steps = "\n".join(result["reproduction_steps"])
    assert "Prior results remain" not in joined_steps
    assert "Results refresh" not in joined_steps


def test_jira_parse_section_extraction_with_plain_labels():
    description = (
        "Steps to Reproduce:\n"
        "- Open search\n"
        "- Apply filter\n\n"
        "Actual:\n"
        "Stale data is shown.\n"
    )

    result = extract_parsed_details(description, [], [])

    assert len(result["reproduction_steps"]) >= 1
    assert any("filter" in s.lower() or "search" in s.lower() for s in result["reproduction_steps"])
    assert "Stale data" in result["actual_result"]


def test_jira_parse_missing_information_checklist():
    result = extract_parsed_details("", [], [])

    assert "Reproduction steps are missing." in result["missing_information"]
    assert "Actual result is missing." in result["missing_information"]
    assert "Expected result is missing." in result["missing_information"]
    assert "Environment/version information is missing." in result["missing_information"]
    assert "No error message or stack trace was found." in result["missing_information"]
    assert "No logs or relevant attachments were found." in result["missing_information"]
    assert len(result["missing_information"]) == 6


def test_jira_parse_environment_detection():
    description = "We are running Version: 2026.1 on OS: Windows 11 and Qt 6.5."

    result = extract_parsed_details(description, [], [])

    assert "2026.1" in result["environment"]
    assert "Windows" in result["environment"]


def test_jira_parse_error_message_extraction():
    description = (
        "When the filter is applied, the following happens:\n"
        "Error: filter cache failed to refresh\n"
        "The UI shows old data.\n"
    )

    result = extract_parsed_details(description, [], [])

    assert any("filter cache failed" in e for e in result["error_messages"])


def test_jira_parse_stack_trace_extraction():
    description = (
        "Crash report:\n"
        "```\n"
        "EmployeeSearchWidget.cpp:142 in void EmployeeSearchWidget::refresh()\n"
        "FilterManager.cpp:87 in bool FilterManager::apply()\n"
        "```\n"
    )

    result = extract_parsed_details(description, [], [])

    assert len(result["stack_traces"]) >= 1
    assert "EmployeeSearchWidget.cpp" in result["stack_traces"][0]


def test_jira_parse_regression_signals():
    description = "This used to work before 2025.4, regression was introduced in the last release."

    result = extract_parsed_details(description, [], [])

    assert len(result["regression_signals"]) >= 1
    assert any("used to work" in s.lower() or "regression" in s.lower() for s in result["regression_signals"])


def test_jira_parse_output_caps():
    long_actual = "A" * 2500
    long_expected = "E" * 2500
    trace_blocks = []
    for block_index in range(4):
        lines = [f"File \"module_{block_index}.py\", line {line}, in fn" for line in range(90)]
        trace_blocks.append("```\n" + "\n".join(lines) + "\n```")
    regression_lines = "\n".join(f"regression signal {index}" for index in range(12))
    description = (
        "## Actual Result\n\n"
        f"{long_actual}\n\n"
        "## Expected Result\n\n"
        f"{long_expected}\n\n"
        "## Stack Trace\n\n"
        + "\n\n".join(trace_blocks)
        + "\n\n"
        + regression_lines
    )

    result = extract_parsed_details(description, [], [])

    assert len(result["actual_result"]) == 2000
    assert len(result["expected_result"]) == 2000
    assert len(result["stack_traces"]) == 3
    assert all(len(trace.splitlines()) == 80 for trace in result["stack_traces"])
    assert len(result["regression_signals"]) == 10


def test_jira_parse_log_signals_from_attachments():
    issue = _jira_issue(attachments=[_jira_attachment("crash.log", "text/plain", 8192, "QA")])
    parsed = parse_issue(issue)

    assert any("crash.log" in s for s in parsed["log_signals"])


def test_jira_parsed_md_has_structured_sections():
    description = (
        "## Steps to Reproduce\n"
        "1. Open search\n"
        "2. Apply filter\n\n"
        "## Actual Result\n"
        "Stale results shown.\n\n"
        "## Expected Result\n"
        "Fresh results shown.\n"
    )
    issue = {
        "key": "JR-12345",
        "source": "jira",
        "mock": False,
        "fields": {
            "summary": "Test structured sections",
            "description": description,  # plain string — adf_to_markdown passes through
            "issuetype": {"name": "Bug"},
            "status": {"name": "Open"},
            "priority": {"name": "High"},
            "comment": {"comments": []},
            "attachment": [],
        },
    }
    parsed = parse_issue(issue)
    markdown = parsed_markdown(parsed)

    assert "## Reproduction Steps" in markdown
    assert "1. Open search" in markdown
    assert "## Actual Result" in markdown
    assert "## Expected Result" in markdown
    assert "## Missing Information Checklist" in markdown


def test_bug_context_includes_reproduction_and_missing_info(tmp_path):
    description = (
        "## Steps to Reproduce\n"
        "1. Open search\n"
        "2. Change filter\n\n"
        "## Actual Result\n"
        "Stale data.\n\n"
        "## Expected Result\n"
        "Fresh data.\n"
    )
    issue = _jira_issue()
    issue["fields"]["description"] = description  # plain string passthrough
    issue_dir = tmp_path / ".ai" / "JR-12345"
    issue_dir.mkdir(parents=True)
    (issue_dir / "jira.json").write_text(json.dumps(issue), encoding="utf-8")

    workflow.parse_step(tmp_path, "JR-12345")
    workflow.keywords_step(tmp_path, "JR-12345")
    workflow.memory_search_step(tmp_path, "JR-12345")
    workflow.code_search_step(tmp_path, "JR-12345")
    workflow.git_context_step(tmp_path, "JR-12345")
    workflow.context_step(tmp_path, "JR-12345")

    context = (issue_dir / "bug_context.md").read_text(encoding="utf-8")
    assert "## Reproduction Steps" in context
    assert "## Missing Information Checklist" in context


def test_copilot_task_includes_jira_parsed_guidance(tmp_path):
    run_bug_workflow(tmp_path, "JR-12345", allow_mock=True)
    task = (tmp_path / ".ai" / "JR-12345" / "agent_task.md").read_text(encoding="utf-8")

    assert "jira_parsed.md" in task
    assert "Do not invent reproduction steps" in task
    assert "missing information" in task.lower()


# ---------------------------------------------------------------------------
# Phase 8.4 — Real Jira Field Mapping Polish
# ---------------------------------------------------------------------------


def _full_jira_issue(issue_key: str = "JR-12345") -> dict:
    """A realistic Jira API response with all standard fields present."""
    return {
        "key": issue_key,
        "source": "jira",
        "mock": False,
        "fields": {
            "summary": "Employee search returns stale results after filter change",
            "description": "Steps to reproduce the issue.",
            "issuetype": {"name": "Bug"},
            "status": {"name": "In Progress"},
            "resolution": {"name": "Unresolved"},
            "priority": {"name": "High"},
            "labels": ["search", "performance"],
            "components": [{"name": "Search"}, {"name": "Filters"}],
            "fixVersions": [{"name": "2026.2"}, {"name": "2026.1-patch"}],
            "versions": [{"name": "2026.0"}],
            "assignee": {"displayName": "Jane Dev", "accountId": "jane-id"},
            "reporter": {"displayName": "QA User", "accountId": "qa-id"},
            "created": "2026-05-01T10:00:00.000+0000",
            "updated": "2026-05-30T12:00:00.000+0000",
            "project": {"key": "HR", "name": "HR System"},
            "comment": {
                "total": 3,
                "comments": [
                    {
                        "author": {"displayName": "QA User"},
                        "created": "2026-05-10T09:00:00.000+0000",
                        "updated": "2026-05-10T09:00:00.000+0000",
                        "body": "Reproduced on 2026.0.",
                    },
                ],
            },
            "attachment": [
                {
                    "filename": "screenshot.png",
                    "mimeType": "image/png",
                    "size": 1024,
                    "created": "2026-05-01T12:00:00.000+0000",
                    "author": {"displayName": "QA User"},
                    "content": "https://jira.example.test/secure/attachment/screenshot.png?token=secret",
                    "thumbnail": "https://jira.example.test/secure/thumbnail/screenshot.png?token=secret",
                },
            ],
        },
    }


def _good_jira_response(issue_key: str = "JR-12345") -> type:
    payload = _full_jira_issue(issue_key)

    class GoodResponse:
        def __enter__(self):
            return self

        def __exit__(self, exc_type, exc, tb):
            return False

        def read(self):
            return json.dumps({"key": issue_key, "fields": payload["fields"]}).encode("utf-8")

    return GoodResponse


# A. Normalized field mapping with complete Jira issue
def test_normalize_core_fields_extracts_all_standard_fields():
    issue = _full_jira_issue()
    from bugpilot.core.jira import enrich_issue

    enrich_issue(issue)
    normalized = issue["bugpilot_normalized"]

    assert normalized["issue_key"] == "JR-12345"
    assert normalized["summary"] == "Employee search returns stale results after filter change"
    assert normalized["issue_type"] == "Bug"
    assert normalized["status"] == "In Progress"
    assert normalized["resolution"] == "Unresolved"
    assert normalized["priority"] == "High"
    assert normalized["labels"] == ["search", "performance"]
    assert "Search" in normalized["components"]
    assert "2026.2" in normalized["fix_versions"]
    assert "2026.0" in normalized["affected_versions"]
    assert normalized["assignee"] == "Jane Dev"
    assert normalized["reporter"] == "QA User"
    assert normalized["created"] == "2026-05-01T10:00:00.000+0000"
    assert normalized["project_key"] == "HR"
    assert normalized["project_name"] == "HR System"
    assert normalized["comment_count_total"] == 3
    assert normalized["attachment_count"] == 1


# B. Missing/null field safety
def test_normalize_core_fields_handles_missing_and_null_fields():
    issue = {
        "key": "JR-99",
        "source": "jira",
        "mock": False,
        "fields": {
            "summary": "Minimal issue",
            "description": None,
            "issuetype": None,
            "status": None,
            "resolution": None,
            "priority": None,
            "labels": None,
            "components": None,
            "fixVersions": None,
            "versions": None,
            "assignee": None,
            "reporter": None,
            "created": None,
            "updated": None,
            "project": None,
            "comment": None,
            "attachment": None,
        },
    }
    from bugpilot.core.jira import enrich_issue

    enrich_issue(issue)
    normalized = issue["bugpilot_normalized"]

    # Should not crash and should have empty/safe defaults
    assert normalized["issue_key"] == "JR-99"
    assert normalized["issue_type"] == ""
    assert normalized["resolution"] == ""
    assert normalized["assignee"] == ""
    assert normalized["labels"] == []
    assert normalized["fix_versions"] == []
    assert normalized["affected_versions"] == []
    assert normalized["comment_count_total"] == 0
    assert normalized["attachment_count"] == 0


# C. jira_summary.md includes real Jira fields
def test_jira_summary_includes_real_jira_fields():
    issue = _full_jira_issue()
    summary = jira_summary_markdown(issue, "Fetched Jira data from configured Jira instance.")

    assert "## Issue Type" in summary
    assert "Bug" in summary
    assert "## Resolution" in summary
    assert "Unresolved" in summary
    assert "## Project" in summary
    assert "HR — HR System" in summary
    assert "## Assignee" in summary
    assert "Jane Dev" in summary
    assert "## Reporter" in summary
    assert "QA User" in summary
    assert "## Created / Updated" in summary
    assert "2026-05-01T10:00:00.000+0000" in summary
    assert "## Affected Versions" in summary
    assert "2026.0" in summary
    assert "## Fix Versions" in summary
    assert "2026.2" in summary


# D. jira_parsed.md uses summary / version fields for environment detection
def test_jira_parsed_uses_versions_for_environment():
    issue = _full_jira_issue()
    parsed = parse_issue(issue)

    # fix_versions and affected_versions should appear in environment
    environment = parsed.get("environment", "")
    assert "2026.2" in environment or "2026.0" in environment


# E. jira-validate success path
def test_jira_validate_success_generates_required_files(tmp_path, monkeypatch):
    _set_jira_env(monkeypatch)
    monkeypatch.setattr(
        "bugpilot.core.jira.urllib.request.urlopen",
        lambda request, timeout: _good_jira_response()(),
    )
    monkeypatch.chdir(tmp_path)

    assert main(["jira-validate", "JR-12345"]) == 0

    issue_dir = tmp_path / ".ai" / "JR-12345"
    assert (issue_dir / "jira.json").is_file()
    assert (issue_dir / "jira_summary.md").is_file()
    assert (issue_dir / "jira_parsed.md").is_file()
    assert (issue_dir / "jira_field_report.md").is_file()
    # Must NOT generate code search or copilot task
    assert not (issue_dir / "code_search.md").exists()
    assert not (issue_dir / "agent_task.md").exists()


# F. jira-validate failure path
def test_jira_validate_fails_without_credentials(tmp_path, monkeypatch, capsys):
    # clear_jira_env fixture already removed env vars
    monkeypatch.chdir(tmp_path)

    assert main(["jira-validate", "JR-12345"]) == 1

    err = capsys.readouterr().err
    assert "JIRA_BASE_URL" in err or "Jira environment variables" in err
    assert not (tmp_path / ".ai" / "JR-12345" / "jira.json").exists()


# G. jira_field_report.md content
def test_jira_field_report_includes_diagnostic_fields():
    issue = _full_jira_issue()
    from bugpilot.core.jira import enrich_issue

    enrich_issue(issue)
    report = jira_field_report_markdown(issue)

    assert "## Populated Normalized Fields" in report
    assert "issue_key: present" in report
    assert "## Missing Normalized Fields" in report
    assert "## Comments" in report
    assert "Total comments: 3" in report
    assert "## Attachments" in report
    assert "Total attachments: 1" in report
    assert "## Raw Jira Standard Field Keys" in report
    # No credential content
    assert "token=secret" not in report
    assert "jane-id" not in report


# H. bug --fresh --no-mock uses real Jira and real normalized fields
def test_bug_fresh_no_mock_uses_real_jira_normalized_fields(tmp_path, monkeypatch):
    _set_jira_env(monkeypatch)
    monkeypatch.setattr(
        "bugpilot.core.jira.urllib.request.urlopen",
        lambda request, timeout: _good_jira_response()(),
    )
    monkeypatch.chdir(tmp_path)

    assert main(["bug", "JR-12345", "--fresh", "--no-mock"]) == 0

    issue_dir = tmp_path / ".ai" / "JR-12345"
    jira = json.loads((issue_dir / "jira.json").read_text(encoding="utf-8"))
    summary_md = (issue_dir / "jira_summary.md").read_text(encoding="utf-8")

    assert jira.get("source") == "jira"
    assert jira.get("mock") is False
    assert "bugpilot_normalized" in jira
    assert "## Issue Type" in summary_md
    assert "## Fix Versions" in summary_md


# I. bug --fresh --no-mock fails if Jira is unavailable
def test_bug_fresh_no_mock_fails_when_jira_unavailable(tmp_path, monkeypatch, capsys):
    # clear_jira_env fixture already removed env vars
    monkeypatch.chdir(tmp_path)

    assert main(["bug", "JR-12345", "--fresh", "--no-mock"]) == 1

    err = capsys.readouterr().err
    assert "ERROR" in err
    assert not (tmp_path / ".ai" / "JR-12345" / "jira.json").exists()


# ---------------------------------------------------------------------------
# Phase 8.4 blocking fixes — attachment size safety + field report redaction
# ---------------------------------------------------------------------------


def _issue_with_attachments(*attachments: dict) -> dict:
    issue = _jira_issue()
    issue["fields"]["attachment"] = list(attachments)
    return issue


def _attachment_raw(**kwargs) -> dict:
    base = {
        "filename": "file.log",
        "mimeType": "text/plain",
        "size": 1024,
        "created": "2026-05-30T12:00:00.000+0000",
        "author": {"displayName": "Dev"},
        "content": "https://jira.example.test/secure/attachment/file.log",
        "thumbnail": "",
    }
    base.update(kwargs)
    return base


def test_malformed_attachment_size_string_does_not_crash():
    issue = _issue_with_attachments(_attachment_raw(size="abc"))
    attachments = normalize_attachments(issue)
    assert len(attachments) == 1
    assert attachments[0]["size"] == 0


def test_numeric_string_attachment_size_is_coerced():
    issue = _issue_with_attachments(_attachment_raw(size="12345"))
    attachments = normalize_attachments(issue)
    assert attachments[0]["size"] == 12345


def test_null_attachment_size_defaults_to_zero():
    issue = _issue_with_attachments(_attachment_raw(size=None))
    attachments = normalize_attachments(issue)
    assert attachments[0]["size"] == 0


def test_missing_attachment_size_defaults_to_zero():
    raw = _attachment_raw()
    del raw["size"]
    issue = _issue_with_attachments(raw)
    attachments = normalize_attachments(issue)
    assert attachments[0]["size"] == 0


def test_malformed_attachment_size_renders_in_summary_without_crash():
    issue = _issue_with_attachments(_attachment_raw(size="abc"))
    from bugpilot.core.jira import enrich_issue
    enrich_issue(issue)
    summary = jira_summary_markdown(issue, "Fetched Jira data from configured Jira instance.")
    assert "file.log" in summary
    assert "0 B" in summary


def test_field_report_redacts_token_in_url():
    issue = _jira_issue()
    issue["fields"]["customfield_token_url"] = "https://example.test/path?token=mysecret&x=1"
    from bugpilot.core.jira import enrich_issue
    enrich_issue(issue)
    report = jira_field_report_markdown(issue)
    assert "mysecret" not in report
    assert "<redacted>" in report


def test_field_report_redacts_secret_kv_pairs():
    issue = _jira_issue()
    issue["fields"]["customfield_creds"] = "password=abc123 api_key=xyz secret: hidden"
    from bugpilot.core.jira import enrich_issue
    enrich_issue(issue)
    report = jira_field_report_markdown(issue)
    assert "abc123" not in report
    assert "xyz" not in report
    assert "hidden" not in report
    assert "<redacted>" in report


# ---------------------------------------------------------------------------
# Phase 8.4 fix — key= / ?key= redaction
# ---------------------------------------------------------------------------


def test_field_report_redacts_plain_key_assignment():
    issue = _jira_issue()
    issue["fields"]["customfield_plain_key"] = "key=xyz"
    from bugpilot.core.jira import enrich_issue
    enrich_issue(issue)
    report = jira_field_report_markdown(issue)
    assert "xyz" not in report
    assert "key=<redacted>" in report


def test_field_report_redacts_url_query_key_param():
    issue = _jira_issue()
    issue["fields"]["customfield_url_key"] = "https://example.test/path?key=xyz&x=1"
    from bugpilot.core.jira import enrich_issue
    enrich_issue(issue)
    report = jira_field_report_markdown(issue)
    assert "xyz" not in report
    assert "key=<redacted>" in report


def test_field_report_does_not_redact_innocent_key_words():
    issue = _jira_issue()
    issue["fields"]["customfield_text"] = "keyboard monkey key field missing"
    from bugpilot.core.jira import enrich_issue
    enrich_issue(issue)
    report = jira_field_report_markdown(issue)
    assert "keyboard" in report
    assert "monkey" in report
    assert "<redacted>" not in report


# ---------------------------------------------------------------------------
# Phase 9.1 — Jira comment draft
# ---------------------------------------------------------------------------


def _write_comment_draft_package(tmp_path: Path, include_results: bool = True) -> Path:
    issue_dir = tmp_path / ".ai" / "JR-12345"
    issue_dir.mkdir(parents=True)
    (issue_dir / "bug_context.md").write_text("# Bug Context\n\nContext body", encoding="utf-8")
    (issue_dir / "jira_parsed.md").write_text(
        "# Jira Parsed Details\n\n"
        "## Missing Information Checklist\n\n"
        "- Environment/version information is missing.\n",
        encoding="utf-8",
    )
    if include_results:
        (issue_dir / "result_summary.md").write_text("Root cause and fix are summarized.", encoding="utf-8")
        (issue_dir / "bug_analysis.md").write_text("Cache invalidation failed.", encoding="utf-8")
        (issue_dir / "fix_summary.md").write_text("Updated cache invalidation.", encoding="utf-8")
        (issue_dir / "test_result.md").write_text("Focused tests passed.", encoding="utf-8")
        (issue_dir / "diff_summary.md").write_text("Changed src/search.cpp.", encoding="utf-8")
        (issue_dir / "review_notes.md").write_text("No blocking issues.", encoding="utf-8")
    return issue_dir


def test_jira_comment_draft_creates_draft_with_result_artifacts(tmp_path, monkeypatch):
    issue_dir = _write_comment_draft_package(tmp_path)
    monkeypatch.chdir(tmp_path)

    assert main(["jira-comment-draft", "JR-12345"]) == 0
    draft = (issue_dir / "jira_comment_draft.md").read_text(encoding="utf-8")

    for heading in ["# bugpilot Analysis Summary", "## Root Cause", "## Summary of Changes"]:
        assert heading in draft
    assert "Cache invalidation failed." in draft   # root cause (bug_analysis.md)
    assert "Updated cache invalidation." in draft   # change summary (fix_summary.md)
    # Trimmed: no full diff, validation, search-confidence, attachment, or status noise.
    for absent in [
        "## Changed Files / Diff Summary", "## Validation", "## Search Confidence",
        "## Attachment Note", "## Status", "Changed src/search.cpp.",
    ]:
        assert absent not in draft


def test_jira_comment_draft_works_with_missing_copilot_results(tmp_path, monkeypatch):
    issue_dir = _write_comment_draft_package(tmp_path, include_results=False)
    monkeypatch.chdir(tmp_path)

    assert main(["jira-comment-draft", "JR-12345"]) == 0
    draft = (issue_dir / "jira_comment_draft.md").read_text(encoding="utf-8")

    assert "No root cause analysis artifact found." in draft
    assert "No change summary artifact found." in draft


def test_jira_comment_draft_strict_fails_when_results_missing(tmp_path, monkeypatch, capsys):
    _write_comment_draft_package(tmp_path, include_results=False)
    monkeypatch.chdir(tmp_path)

    assert main(["jira-comment-draft", "JR-12345", "--strict"]) == 1
    err = capsys.readouterr().err

    assert "Missing required agent result files" in err
    assert not (tmp_path / ".ai" / "JR-12345" / "jira_comment_draft.md").exists()


def test_jira_comment_draft_strict_passes_when_results_exist(tmp_path, monkeypatch):
    issue_dir = _write_comment_draft_package(tmp_path)
    monkeypatch.chdir(tmp_path)

    assert main(["jira-comment-draft", "JR-12345", "--strict"]) == 0

    assert (issue_dir / "jira_comment_draft.md").is_file()


def test_jira_comment_draft_requires_workflow_package(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)

    assert main(["jira-comment-draft", "JR-12345"]) == 1
    err = capsys.readouterr().err

    assert "No workflow package found for JR-12345. Run: bugpilot bug JR-12345" in err


def test_jira_comment_draft_does_not_include_raw_jira_json(tmp_path, monkeypatch):
    issue_dir = _write_comment_draft_package(tmp_path, include_results=False)
    (issue_dir / "jira.json").write_text('{"raw_secret":"token=secret"}', encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    assert main(["jira-comment-draft", "JR-12345"]) == 0
    draft = (issue_dir / "jira_comment_draft.md").read_text(encoding="utf-8")

    assert "raw_secret" not in draft
    assert "token=secret" not in draft


def test_jira_comment_draft_redacts_sensitive_values(tmp_path, monkeypatch):
    issue_dir = _write_comment_draft_package(tmp_path)
    (issue_dir / "bug_analysis.md").write_text(
        "token=secret password=abc123 api_key=xyz key=hidden", encoding="utf-8"
    )
    monkeypatch.chdir(tmp_path)

    assert main(["jira-comment-draft", "JR-12345"]) == 0
    draft = (issue_dir / "jira_comment_draft.md").read_text(encoding="utf-8")

    assert "secret" not in draft
    assert "abc123" not in draft
    assert "xyz" not in draft
    assert "hidden" not in draft
    assert "<redacted>" in draft


def test_jira_comment_draft_omits_search_and_diff_detail(tmp_path, monkeypatch):
    issue_dir = _write_comment_draft_package(tmp_path)
    (issue_dir / "search_quality.json").write_text(
        json.dumps({"confidence": "low", "reasons": ["Only documentation matched"]}),
        encoding="utf-8",
    )
    monkeypatch.chdir(tmp_path)

    assert main(["jira-comment-draft", "JR-12345"]) == 0
    draft = (issue_dir / "jira_comment_draft.md").read_text(encoding="utf-8")

    # Search confidence and full diff detail are no longer posted to Jira.
    assert "Search Confidence" not in draft
    assert "Only documentation matched" not in draft
    assert "Changed src/search.cpp." not in draft


def test_jira_comment_draft_omits_missing_information_and_attachment_note(tmp_path, monkeypatch):
    issue_dir = _write_comment_draft_package(tmp_path, include_results=False)
    monkeypatch.chdir(tmp_path)

    assert main(["jira-comment-draft", "JR-12345"]) == 0
    draft = (issue_dir / "jira_comment_draft.md").read_text(encoding="utf-8")

    assert "Environment/version information is missing." not in draft
    assert "bugpilot did not download or inspect Jira attachment contents" not in draft


def test_markdown_to_adf_renders_headings_rule_and_bullets():
    from bugpilot.core.jira import _markdown_to_adf

    adf = _markdown_to_adf("# Title\n\n## Root Cause\n\nplain line\n\n- a\n- b\n\n---\nfooter")
    types = [n["type"] for n in adf["content"]]

    assert adf["type"] == "doc" and adf["version"] == 1
    assert types == ["heading", "heading", "paragraph", "bulletList", "rule", "paragraph"]
    assert adf["content"][0]["attrs"]["level"] == 2   # '#'  -> h2
    assert adf["content"][1]["attrs"]["level"] == 3   # '##' -> h3
    # No literal markdown markup leaks into any text node.
    for node in adf["content"]:
        for child in node.get("content", []):
            assert not child.get("text", "").startswith(("#", "-"))
    assert len(adf["content"][3]["content"]) == 2      # two bullet items


def test_jira_comment_draft_updates_status_and_log(tmp_path, monkeypatch):
    issue_dir = _write_comment_draft_package(tmp_path)
    monkeypatch.chdir(tmp_path)

    assert main(["jira-comment-draft", "JR-12345"]) == 0
    status = json.loads((issue_dir / "workflow_status.json").read_text(encoding="utf-8"))
    log_text = (issue_dir / "execution.log").read_text(encoding="utf-8")

    assert status["steps"]["jira_comment_draft"] == "pass"
    assert ".ai/JR-12345/jira_comment_draft.md" in status["generated_files"]
    assert "[START] jira_comment_draft" in log_text
    assert "[GENERATED] .ai/JR-12345/jira_comment_draft.md" in log_text
    assert "[END] jira_comment_draft: pass" in log_text


# ---------------------------------------------------------------------------
# Phase 9.2 — Jira comment write-back
# ---------------------------------------------------------------------------


def _write_jira_comment_draft(tmp_path: Path, text: str = "# bugpilot Analysis Summary\n\nIssue: JR-12345\n\nReady to post.") -> Path:
    issue_dir = tmp_path / ".ai" / "JR-12345"
    issue_dir.mkdir(parents=True, exist_ok=True)
    (issue_dir / "jira_comment_draft.md").write_text(text, encoding="utf-8")
    return issue_dir


class _JiraPostResponse:
    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, tb):
        return False

    def read(self):
        return json.dumps(
            {
                "id": "10001",
                "created": "2026-06-01T10:00:00.000+0000",
                "updated": "2026-06-01T10:00:00.000+0000",
                "self": "https://jira.example.test/rest/api/3/issue/JR-12345/comment/10001?token=secret",
            }
        ).encode("utf-8")


def test_jira_comment_preview_does_not_call_jira(tmp_path, monkeypatch, capsys):
    _write_jira_comment_draft(tmp_path)
    monkeypatch.chdir(tmp_path)
    called = {"value": False}

    def fake_urlopen(request, timeout):
        called["value"] = True
        return _JiraPostResponse()

    monkeypatch.setattr("bugpilot.core.jira.urllib.request.urlopen", fake_urlopen)

    assert main(["jira-comment", "JR-12345"]) == 0
    out = capsys.readouterr().out

    assert called["value"] is False
    assert "Preview Jira comment for JR-12345." in out
    assert "Use --execute" in out


def test_jira_comment_execute_posts_comment_and_writes_artifacts(tmp_path, monkeypatch, capsys):
    issue_dir = _write_jira_comment_draft(tmp_path)
    _set_jira_env(monkeypatch)
    monkeypatch.chdir(tmp_path)
    requests = []

    def fake_urlopen(request, timeout):
        requests.append(request)
        return _JiraPostResponse()

    monkeypatch.setattr("bugpilot.core.jira.urllib.request.urlopen", fake_urlopen)

    assert main(["jira-comment", "JR-12345", "--execute"]) == 0
    out = capsys.readouterr().out
    result = json.loads((issue_dir / "jira_comment_post_result.json").read_text(encoding="utf-8"))
    summary = (issue_dir / "jira_comment_post_summary.md").read_text(encoding="utf-8")

    assert len(requests) == 1
    assert requests[0].full_url == "https://jira.example.test/rest/api/3/issue/JR-12345/comment"
    assert requests[0].get_method() == "POST"
    assert "Posted Jira comment for JR-12345." in out
    assert result["posted"] is True
    assert result["comment_id"] == "10001"
    assert "token-value" not in json.dumps(result)
    assert "Only a Jira comment was added." in summary


def test_jira_comment_execute_missing_draft_fails(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)

    assert main(["jira-comment", "JR-12345", "--execute"]) == 1
    err = capsys.readouterr().err

    assert "Missing .ai/JR-12345/jira_comment_draft.md" in err or "No workflow package found" in err


def test_jira_comment_execute_missing_env_fails_without_post(tmp_path, monkeypatch, capsys):
    _write_jira_comment_draft(tmp_path)
    monkeypatch.chdir(tmp_path)
    called = {"value": False}

    def fake_urlopen(request, timeout):
        called["value"] = True
        return _JiraPostResponse()

    monkeypatch.setattr("bugpilot.core.jira.urllib.request.urlopen", fake_urlopen)

    assert main(["jira-comment", "JR-12345", "--execute"]) == 1
    err = capsys.readouterr().err

    assert called["value"] is False
    assert "Jira environment variables are missing" in err


def test_jira_comment_preview_does_not_require_env(tmp_path, monkeypatch):
    _write_jira_comment_draft(tmp_path)
    monkeypatch.chdir(tmp_path)

    assert main(["jira-comment", "JR-12345"]) == 0


def test_jira_comment_execute_redacts_before_post(tmp_path, monkeypatch):
    _write_jira_comment_draft(
        tmp_path,
        "# bugpilot Analysis Summary\n\nIssue: JR-12345\n\ntoken=secret password=abc123 key=hidden",
    )
    _set_jira_env(monkeypatch)
    monkeypatch.chdir(tmp_path)
    posted = {}

    def fake_urlopen(request, timeout):
        posted["body"] = request.data.decode("utf-8")
        return _JiraPostResponse()

    monkeypatch.setattr("bugpilot.core.jira.urllib.request.urlopen", fake_urlopen)

    assert main(["jira-comment", "JR-12345", "--execute"]) == 0

    assert "secret" not in posted["body"]
    assert "abc123" not in posted["body"]
    assert "hidden" not in posted["body"]
    assert "<redacted>" in posted["body"]


def test_jira_comment_execute_empty_draft_fails(tmp_path, monkeypatch, capsys):
    _write_jira_comment_draft(tmp_path, "   \n")
    _set_jira_env(monkeypatch)
    monkeypatch.chdir(tmp_path)

    assert main(["jira-comment", "JR-12345", "--execute"]) == 1
    err = capsys.readouterr().err

    assert "empty" in err.lower()


@pytest.mark.parametrize(
    ("status_code", "expected"),
    [
        (401, "authentication or permission"),
        (403, "authentication or permission"),
        (404, "not found"),
        (429, "rate limit"),
        (500, "unexpected jira error"),
    ],
)
def test_jira_comment_execute_http_errors_are_clear(tmp_path, monkeypatch, capsys, status_code, expected):
    _write_jira_comment_draft(tmp_path)
    _set_jira_env(monkeypatch)
    monkeypatch.chdir(tmp_path)

    def fake_urlopen(request, timeout):
        raise _http_error(status_code)

    monkeypatch.setattr("bugpilot.core.jira.urllib.request.urlopen", fake_urlopen)

    assert main(["jira-comment", "JR-12345", "--execute"]) == 1
    err = capsys.readouterr().err.lower()

    assert expected in err


def test_jira_comment_execute_status_includes_generated_files(tmp_path, monkeypatch):
    issue_dir = _write_jira_comment_draft(tmp_path)
    _set_jira_env(monkeypatch)
    monkeypatch.chdir(tmp_path)
    monkeypatch.setattr("bugpilot.core.jira.urllib.request.urlopen", lambda request, timeout: _JiraPostResponse())

    assert main(["jira-comment", "JR-12345", "--execute"]) == 0
    status = json.loads((issue_dir / "workflow_status.json").read_text(encoding="utf-8"))
    log_text = (issue_dir / "execution.log").read_text(encoding="utf-8")

    assert status["steps"]["jira_comment"] == "pass"
    assert ".ai/JR-12345/jira_comment_post_result.json" in status["generated_files"]
    assert ".ai/JR-12345/jira_comment_post_summary.md" in status["generated_files"]
    assert "[START] jira_comment execute" in log_text
    assert "[GENERATED] .ai/JR-12345/jira_comment_post_result.json" in log_text
    assert "[END] jira_comment: pass" in log_text


# ---------------------------------------------------------------------------
# Auto Jira comment after summarize-results (notify-on-fix-ready)
# ---------------------------------------------------------------------------


def test_summarize_results_auto_posts_jira_comment_with_flag(tmp_path, monkeypatch, capsys):
    issue_dir = _write_comment_draft_package(tmp_path)
    _set_jira_env(monkeypatch)
    monkeypatch.delenv("BUGPILOT_AUTO_JIRA_COMMENT", raising=False)
    monkeypatch.chdir(tmp_path)
    requests = []

    def fake_urlopen(request, timeout):
        requests.append(request)
        return _JiraPostResponse()

    monkeypatch.setattr("bugpilot.core.jira.urllib.request.urlopen", fake_urlopen)

    assert main(["summarize-results", "JR-12345", "--jira-comment"]) == 0
    out = capsys.readouterr().out

    assert len(requests) == 1
    assert requests[0].full_url == "https://jira.example.test/rest/api/3/issue/JR-12345/comment"
    assert requests[0].get_method() == "POST"
    assert "Posted Jira comment for JR-12345. Jira will notify watchers by email." in out
    assert (issue_dir / "result_summary.md").is_file()
    assert (issue_dir / "jira_comment_post_result.json").is_file()


def test_summarize_results_auto_posts_when_env_enabled(tmp_path, monkeypatch):
    _write_comment_draft_package(tmp_path)
    _set_jira_env(monkeypatch)
    monkeypatch.setenv("BUGPILOT_AUTO_JIRA_COMMENT", "true")
    monkeypatch.chdir(tmp_path)
    requests = []

    def fake_urlopen(request, timeout):
        requests.append(request)
        return _JiraPostResponse()

    monkeypatch.setattr("bugpilot.core.jira.urllib.request.urlopen", fake_urlopen)

    assert main(["summarize-results", "JR-12345"]) == 0
    assert len(requests) == 1


def test_summarize_results_no_jira_comment_overrides_env(tmp_path, monkeypatch):
    _write_comment_draft_package(tmp_path)
    _set_jira_env(monkeypatch)
    monkeypatch.setenv("BUGPILOT_AUTO_JIRA_COMMENT", "true")
    monkeypatch.chdir(tmp_path)
    called = {"value": False}

    def fake_urlopen(request, timeout):
        called["value"] = True
        return _JiraPostResponse()

    monkeypatch.setattr("bugpilot.core.jira.urllib.request.urlopen", fake_urlopen)

    assert main(["summarize-results", "JR-12345", "--no-jira-comment"]) == 0
    assert called["value"] is False


def test_summarize_results_default_does_not_post(tmp_path, monkeypatch):
    _write_comment_draft_package(tmp_path)
    _set_jira_env(monkeypatch)
    monkeypatch.delenv("BUGPILOT_AUTO_JIRA_COMMENT", raising=False)
    monkeypatch.chdir(tmp_path)
    called = {"value": False}

    def fake_urlopen(request, timeout):
        called["value"] = True
        return _JiraPostResponse()

    monkeypatch.setattr("bugpilot.core.jira.urllib.request.urlopen", fake_urlopen)

    assert main(["summarize-results", "JR-12345"]) == 0
    assert called["value"] is False


def test_summarize_results_auto_post_failure_is_non_fatal(tmp_path, monkeypatch, capsys):
    issue_dir = _write_comment_draft_package(tmp_path)
    _set_jira_env(monkeypatch)
    monkeypatch.chdir(tmp_path)

    def fake_urlopen(request, timeout):
        raise _http_error(500)

    monkeypatch.setattr("bugpilot.core.jira.urllib.request.urlopen", fake_urlopen)

    # summarize-results must still succeed even if the Jira post fails.
    assert main(["summarize-results", "JR-12345", "--jira-comment"]) == 0
    err = capsys.readouterr().err

    assert "auto Jira comment not posted" in err
    assert (issue_dir / "result_summary.md").is_file()


# ---------------------------------------------------------------------------
# Phase 9.4 — Retry prompts and manual result templates
# ---------------------------------------------------------------------------


def _write_retry_package(tmp_path: Path) -> Path:
    issue_dir = tmp_path / ".ai" / "JR-12345"
    issue_dir.mkdir(parents=True, exist_ok=True)
    (issue_dir / "bug_context.md").write_text("# Bug Context\n\nInvestigate stale results.", encoding="utf-8")
    return issue_dir


def test_retry_prompt_creates_user_feedback_template_if_missing(tmp_path, monkeypatch):
    issue_dir = _write_retry_package(tmp_path)
    monkeypatch.chdir(tmp_path)

    assert main(["retry-prompt", "JR-12345"]) == 0

    feedback = (issue_dir / "user_feedback.md").read_text(encoding="utf-8")
    prompt = (issue_dir / "agent_retry_prompt.md").read_text(encoding="utf-8")
    assert "# User Feedback: JR-12345" in feedback
    assert "Do not claim tests passed unless they were run." in feedback
    assert "# Agent Retry Prompt: JR-12345" in prompt
    assert ".ai/JR-12345/user_feedback.md" in prompt


def test_retry_prompt_includes_developer_feedback(tmp_path, monkeypatch):
    issue_dir = _write_retry_package(tmp_path)
    (issue_dir / "user_feedback.md").write_text("The retry must inspect EmployeeSearchModel.", encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    assert main(["retry-prompt", "JR-12345"]) == 0
    prompt = (issue_dir / "agent_retry_prompt.md").read_text(encoding="utf-8")

    assert "The retry must inspect EmployeeSearchModel." in prompt


def test_retry_prompt_includes_assisted_delivery_rules(tmp_path, monkeypatch):
    issue_dir = _write_retry_package(tmp_path)
    monkeypatch.chdir(tmp_path)

    assert main(["retry-prompt", "JR-12345"]) == 0
    prompt = (issue_dir / "agent_retry_prompt.md").read_text(encoding="utf-8")

    assert "Do you want me to commit and push this branch to origin?" in prompt
    assert "Only if the developer explicitly answers yes" in prompt
    assert "Do not push main/master" in prompt
    assert "Do not force push" in prompt
    assert "Do not add `.ai/`" in prompt
    assert "Do not add `.ai_memory/`" in prompt
    assert "Do not update Jira" in prompt


def test_retry_prompt_lists_present_and_missing_previous_attempt_files(tmp_path, monkeypatch):
    issue_dir = _write_retry_package(tmp_path)
    (issue_dir / "code_search.md").write_text("src/EmployeeSearch.cpp:42", encoding="utf-8")
    (issue_dir / "test_result.md").write_text("Tests failed.", encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    assert main(["retry-prompt", "JR-12345"]) == 0
    prompt = (issue_dir / "agent_retry_prompt.md").read_text(encoding="utf-8")

    assert "- .ai/JR-12345/code_search.md" in prompt
    assert "### test_result.md" in prompt
    assert "present" in prompt
    assert "### bug_analysis.md" in prompt
    assert "missing" in prompt


def test_retry_prompt_fails_helpfully_when_package_missing(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)

    assert main(["retry-prompt", "JR-12345"]) == 1
    err = capsys.readouterr().err

    assert "No workflow package found for JR-12345" in err


def test_manual_result_creates_missing_result_templates(tmp_path, monkeypatch):
    issue_dir = _write_retry_package(tmp_path)
    monkeypatch.chdir(tmp_path)

    assert main(["manual-result", "JR-12345"]) == 0

    for file_name in workflow.REQUIRED_COPILOT_RESULT_FILES:
        text = (issue_dir / file_name).read_text(encoding="utf-8")
        assert "## Fix Source" in text
        assert "Developer manual fix." in text


def test_manual_result_does_not_overwrite_existing_files_by_default(tmp_path, monkeypatch):
    issue_dir = _write_retry_package(tmp_path)
    (issue_dir / "bug_analysis.md").write_text("Custom analysis stays.", encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    assert main(["manual-result", "JR-12345"]) == 0

    assert (issue_dir / "bug_analysis.md").read_text(encoding="utf-8") == "Custom analysis stays."
    assert (issue_dir / "fix_summary.md").exists()


def test_manual_result_overwrite_replaces_existing_files(tmp_path, monkeypatch):
    issue_dir = _write_retry_package(tmp_path)
    (issue_dir / "bug_analysis.md").write_text("Custom analysis goes away.", encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    assert main(["manual-result", "JR-12345", "--overwrite"]) == 0
    text = (issue_dir / "bug_analysis.md").read_text(encoding="utf-8")

    assert "Custom analysis goes away." not in text
    assert "# Bug Analysis: JR-12345" in text
    assert "Developer manual fix." in text


def test_manual_result_updates_status_and_log(tmp_path, monkeypatch):
    issue_dir = _write_retry_package(tmp_path)
    monkeypatch.chdir(tmp_path)

    assert main(["manual-result", "JR-12345"]) == 0
    status = json.loads((issue_dir / "workflow_status.json").read_text(encoding="utf-8"))
    log_text = (issue_dir / "execution.log").read_text(encoding="utf-8")

    assert status["steps"]["manual_result"] == "pass"
    assert ".ai/JR-12345/bug_analysis.md" in status["generated_files"]
    assert "[START] manual_result" in log_text
    assert "[GENERATED] .ai/JR-12345/bug_analysis.md" in log_text
    assert "[END] manual_result: pass" in log_text


def test_retry_prompt_updates_status_and_log(tmp_path, monkeypatch):
    issue_dir = _write_retry_package(tmp_path)
    monkeypatch.chdir(tmp_path)

    assert main(["retry-prompt", "JR-12345"]) == 0
    status = json.loads((issue_dir / "workflow_status.json").read_text(encoding="utf-8"))
    log_text = (issue_dir / "execution.log").read_text(encoding="utf-8")

    assert status["steps"]["retry_prompt"] == "pass"
    assert ".ai/JR-12345/agent_retry_prompt.md" in status["generated_files"]
    assert ".ai/JR-12345/user_feedback.md" in status["generated_files"]
    assert "[START] retry_prompt" in log_text
    assert "[GENERATED] .ai/JR-12345/agent_retry_prompt.md" in log_text
    assert "[END] retry_prompt: pass" in log_text
