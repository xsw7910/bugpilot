"""Command line interface for bugpilot."""

from __future__ import annotations

import argparse
import json
import os
import sys
from pathlib import Path

from bugpilot import cli_json
from bugpilot.core import agent_runner, copilot, doctor, errors, setup, workflow
from bugpilot.core.branch_policy import BRANCH_POLICIES
from bugpilot.core.cleanup import clean_issue_artifacts
from bugpilot.core.context import build_context
from bugpilot.core.email_notify import EmailSendError
from bugpilot.core.git_history import render_git_context
from bugpilot.core.fix_mode_state import fix_mode_metadata
from bugpilot.core.fix_mode_store import FixModeCatalog, FixModeStore, scoped_modes
from bugpilot.core.fix_modes import FixMode, FixModeError
from bugpilot.core.jira import JiraCommentPostError, JiraFetchError, fetch_issue, parse_issue
from bugpilot.core.artifacts import CONTEXT_ARTIFACT, CORE_ARTIFACTS, FIX_REPORT_ARTIFACT, RUN_ARTIFACT
from bugpilot.core.artifacts import ISSUE_ARTIFACT, RETRIEVAL_ARTIFACT, TASK_ARTIFACT, WorkItemNotFoundError
from bugpilot.core.review_report import (
    MAX_SECTION_CHARS,
    REVIEW_SECTIONS,
    ReviewInput,
    ReviewReportExistsError,
    record_review,
)
from bugpilot.core.verification_report import (
    MAX_CHECKS,
    MAX_NAME_CHARS,
    MAX_TEXT_CHARS,
    VerificationCheck,
    VerificationReportExistsError,
    record_verification,
    summary_line,
)
from bugpilot.core.run import RunArtifactError, load_run, run_to_dict
from bugpilot.core.identity import is_work_item_id
from bugpilot.core.input_adapters import bug_spec_from_description
from bugpilot.core.issue import IssueArtifactError, read_issue_quietly
from bugpilot.core.keywords import extract_keywords
from bugpilot.core.models import (
    DEFAULT_MAX_SIMILAR_FIXES,
    GIT_HISTORY_DEPTHS,
    MAX_RELATED_COMMITS_LIMIT,
    MAX_SIMILAR_FIXES_LIMIT,
    SOURCE_MANUAL,
    GitHistoryOptions,
    InvestigationOptions,
    InvestigationPlan,
    InvestigationRequest,
    SimilarFixesOptions,
)
from bugpilot.core.memory import add_memory_entry, search_memory
from bugpilot.core.prompts import generate_task


def _add_json_flag(parser: argparse.ArgumentParser) -> None:
    """Machine-readable output on stdout; human text is unchanged without it."""
    parser.add_argument(
        "--json",
        action="store_true",
        dest="json_output",
        help="Emit a single JSON object on stdout instead of human-readable text. Never launches an agent.",
    )


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="bugpilot")
    subparsers = parser.add_subparsers(dest="command", required=True)

    setup_parser = subparsers.add_parser("setup", help="Interactively configure BugPilot (Jira email + API token).")
    setup_parser.add_argument("--hide-token", action="store_true", help="Hide the API token while typing (default: shown so you can verify the paste).")
    doctor_parser = subparsers.add_parser("doctor", help="Check local environment readiness.")
    _add_json_flag(doctor_parser)
    subparsers.add_parser("agent-check", help="Check AI agent readiness.")

    for name in ("parse", "keywords", "search", "git-context", "context", "status", "agent-instructions", "review-package", "delivery-check", "push-plan", "retry-prompt"):
        command = subparsers.add_parser(name, help=f"Run the {name} step.")
        command.add_argument("issue_key")
        if name in {"status", "delivery-check", "search", "context", "review-package"}:
            _add_json_flag(command)

    for name in ("prompt", "agent-task"):
        command = subparsers.add_parser(name, help=f"Run the {name} step.")
        command.add_argument("issue_key")
        command.add_argument(
            "--jira-comment",
            action="store_true",
            help="Include the pre-commit Jira status comment instruction in the generated task.md (omitted by default).",
        )

    summarize_parser = subparsers.add_parser("summarize-results", help="Summarize agent results; optionally post a Jira comment so watchers are notified.")
    summarize_parser.add_argument("issue_key")
    summarize_jira = summarize_parser.add_mutually_exclusive_group()
    summarize_jira.add_argument("--jira-comment", action="store_true", help="Post the analysis summary as a Jira comment (Jira then notifies watchers by email).")
    summarize_jira.add_argument("--no-jira-comment", action="store_true", help="Do not post a Jira comment even if BUGPILOT_AUTO_JIRA_COMMENT is set.")
    _add_json_flag(summarize_parser)

    commit_plan_parser = subparsers.add_parser("commit-plan", help="Run the commit-plan step and notify by email at the commit gate.")
    commit_plan_parser.add_argument("issue_key")
    commit_plan_parser.add_argument("--no-email", action="store_true", help="Do not send the commit-gate notification email.")

    notify_parser = subparsers.add_parser("notify", help="Preview or send the post-fix notification email.")
    notify_parser.add_argument("issue_key")
    notify_parser.add_argument("--execute", action="store_true", help="Send the email over SMTP. Without this flag, only a local preview is written.")

    fetch_parser = subparsers.add_parser("fetch", help="Fetch Jira data.")
    fetch_parser.add_argument("issue_key")
    fetch_mock = fetch_parser.add_mutually_exclusive_group()
    fetch_mock.add_argument("--allow-mock", action="store_true", help="Allow mock/demo fallback when Jira fetch fails.")
    fetch_mock.add_argument("--no-mock", action="store_true", help="Require real Jira data. This is the default.")
    _add_json_flag(fetch_parser)

    issue_details_parser = subparsers.add_parser(
        "issue-details",
        help="Print one issue's title and description. Reads Jira; writes nothing.",
    )
    issue_details_parser.add_argument("issue_key")
    issue_details_mock = issue_details_parser.add_mutually_exclusive_group()
    issue_details_mock.add_argument("--allow-mock", action="store_true", help="Allow mock/demo fallback when Jira fetch fails.")
    issue_details_mock.add_argument("--no-mock", action="store_true", help="Require real Jira data. This is the default.")
    _add_json_flag(issue_details_parser)

    jira_validate_parser = subparsers.add_parser("jira-validate", help="Validate Jira issue fetch and field mapping (requires real Jira credentials).")
    jira_validate_parser.add_argument("issue_key")

    jira_comment_parser = subparsers.add_parser("jira-comment-draft", help="Generate a local Jira comment draft from existing bugpilot artifacts.")
    jira_comment_parser.add_argument("issue_key")
    jira_comment_parser.add_argument("--strict", action="store_true", help="Fail if agent result artifacts are missing.")

    jira_post_parser = subparsers.add_parser("jira-comment", help="Preview or explicitly post a Jira comment draft.")
    jira_post_parser.add_argument("issue_key")
    jira_post_parser.add_argument("--execute", action="store_true", help="Post the local Jira comment draft to Jira.")

    list_parser = subparsers.add_parser("list", help="List prepared work items under .ai/.")
    _add_json_flag(list_parser)

    clean_parser = subparsers.add_parser("clean", help="Remove generated workflow artifacts for an issue.")
    clean_parser.add_argument("issue_key")
    clean_parser.add_argument("--include-memory", action="store_true", help="Also remove that issue's memory entry.")

    commit_parser = subparsers.add_parser("commit", help="Says why bugpilot does not commit, and what to use instead.")
    commit_parser.add_argument("issue_key")
    commit_parser.add_argument("--execute", action="store_true", help="Accepted and ignored: this command never executes anything.")

    push_parser = subparsers.add_parser("push", help="Says why bugpilot does not push, and what to use instead.")
    push_parser.add_argument("issue_key")
    push_parser.add_argument("--execute", action="store_true", help="Accepted and ignored: this command never executes anything.")

    check_parser = subparsers.add_parser("check-results", help="Check whether the agent's fix report exists.")
    check_parser.add_argument("issue_key")
    check_parser.add_argument("--strict", action="store_true", help="Exit non-zero when the fix report is missing.")
    _add_json_flag(check_parser)

    manual_result_parser = subparsers.add_parser("manual-result", help="Generate the developer manual-fix report template.")
    manual_result_parser.add_argument("issue_key")
    manual_result_parser.add_argument("--overwrite", action="store_true", help="Overwrite an existing fix report with the template.")

    record_review_parser = subparsers.add_parser(
        "record-review",
        help="Record the result of a completed review in review_report.md. Records what the review said; checks nothing.",
    )
    record_review_parser.add_argument("issue_key")
    record_review_parser.add_argument("--summary", default=None, help="What the review concluded, in its own words.")
    record_review_parser.add_argument("--findings", default=None, help="The problems or observations the review reported.")
    record_review_parser.add_argument("--validation-notes", dest="validation_notes", default=None, help="What the reviewer checked or ran, as they reported it.")
    record_review_parser.add_argument("--recommendations", default=None, help="What the review recommends doing next.")
    record_review_parser.add_argument(
        "--from-file",
        dest="from_file",
        default=None,
        help="A JSON object with summary, findings, validation_notes and recommendations, instead of the text options.",
    )
    record_review_parser.add_argument("--replace", action="store_true", help="Overwrite a review result that is already recorded.")
    _add_json_flag(record_review_parser)

    record_verification_parser = subparsers.add_parser(
        "record-verification",
        help=(
            "Record verification evidence in verification_report.md: the checks you ran and the status you "
            "recorded for each. Runs nothing and verifies nothing."
        ),
    )
    record_verification_parser.add_argument("issue_key")
    record_verification_parser.add_argument(
        "--from-file",
        dest="from_file",
        default=None,
        help=(
            'A JSON object {"checks": [...]}; each check has a name and a status (passed, failed or not_run), '
            "and optionally a type (automated, manual or other), procedure, evidence and notes."
        ),
    )
    record_verification_parser.add_argument(
        "--replace", action="store_true", help="Overwrite verification evidence that is already recorded."
    )
    _add_json_flag(record_verification_parser)

    fix_mode_parser = subparsers.add_parser("fix-mode", help="List, show or customize the AI fixing workflows.")
    fix_mode_parser.add_argument(
        "action",
        choices=["list", "show", "duplicate", "create", "update", "delete"],
        help="list or show the modes, or duplicate/create/update/delete a custom one.",
    )
    fix_mode_parser.add_argument("mode_id", nargs="?", help="Mode id. Required by everything but `list`.")
    fix_mode_parser.add_argument("new_id", nargs="?", help="The copy's id, for `duplicate`.")
    fix_mode_parser.add_argument(
        "--scope",
        choices=["user", "project"],
        help="Where a custom mode lives: your home directory, or this repository. Required to write one.",
    )
    fix_mode_parser.add_argument(
        "--all-scopes",
        action="store_true",
        dest="all_scopes",
        help="List every definition on disk, including one shadowed by another scope.",
    )
    fix_mode_parser.add_argument(
        "--from-file",
        metavar="PATH",
        dest="from_file",
        help="JSON file holding the mode definition, for `create` and `update`.",
    )
    fix_mode_parser.add_argument(
        "--expected-version",
        type=int,
        metavar="N",
        dest="expected_version",
        help="The version you last saw. `update` and `delete` refuse if it has moved on since.",
    )
    fix_mode_parser.add_argument(
        "--name",
        metavar="TEXT",
        help="Display name for a duplicated mode.",
    )
    _add_json_flag(fix_mode_parser)

    memory_parser = subparsers.add_parser("memory", help="Manage shared AI memory.")
    memory_subparsers = memory_parser.add_subparsers(dest="memory_command", required=True)
    memory_add = memory_subparsers.add_parser("add", help="Add bug memory entry.")
    memory_add.add_argument("issue_key")
    memory_update = memory_subparsers.add_parser("update", help="Update bug memory from result summary.")
    memory_update.add_argument("issue_key")
    memory_search = memory_subparsers.add_parser("search", help="Search shared AI memory.")
    memory_search.add_argument("query")

    bug_parser = subparsers.add_parser("bug", help="Run prepare-only bug workflow.")
    # Optional so a bug can be described by hand instead: exactly one of an issue
    # key or a description is required, checked in main() for a clearer message
    # than argparse's mutually-exclusive-group wording gives for a positional.
    bug_parser.add_argument("issue_key", nargs="?")
    bug_input = bug_parser.add_mutually_exclusive_group()
    bug_input.add_argument(
        "--description",
        metavar="TEXT",
        help="Describe the bug directly instead of fetching a Jira issue.",
    )
    bug_input.add_argument(
        "--description-file",
        metavar="PATH",
        help="Read the bug description from a file instead of fetching a Jira issue.",
    )
    bug_parser.add_argument("--title", metavar="TEXT", help="Title for a hand-written bug (derived from the description otherwise).")
    bug_parser.add_argument("--keywords", metavar="WORD", action="append", default=[], help="Extra search keyword, shared: code search uses it, and git history and similar fixes unless told not to. Repeatable.")
    bug_parser.add_argument("--focus-file", metavar="PATH", action="append", default=[], dest="focus_files", help="Rank this file or directory higher. Repeatable.")
    bug_parser.add_argument("--ignore-path", metavar="PATH", action="append", default=[], dest="ignore_paths", help="Exclude this file or directory from code search. Repeatable.")
    bug_parser.add_argument("--attach", metavar="PATH", action="append", default=[], dest="attachments", help="Copy this file into the work item for the agent to read: a log, a screenshot, a config. Repeatable.")
    bug_parser.add_argument("--attach-description", metavar="TEXT", action="append", default=[], dest="attachment_descriptions", help="Why the matching --attach file matters, by position: the Nth describes the Nth --attach. Give one per --attach (an empty one for none), or none at all.")
    bug_parser.add_argument("--replace-attachments", action="store_true", help="Make the --attach files the work item's complete set: a file an earlier run attached that is not among them is removed from .ai/<id>/attachments/ and from the task file. Without it, --attach adds to what an earlier run attached.")
    bug_parser.add_argument("--max-files", type=int, metavar="N", help="How many related files to keep (default 10).")
    bug_parser.add_argument("--max-search-lines", type=int, metavar="N", help="Line budget for the matched-lines section (default 300).")
    bug_parser.add_argument("--skip-code-search", action="store_true", help="Skip the code search capability.")
    bug_parser.add_argument("--skip-git-history", action="store_true", help="Skip the git history capability.")
    # Git History Settings: Git history only — Code Search never reads them.
    # Off-switches rather than on-switches, so a command line that names none of
    # them runs exactly as before they existed.
    bug_parser.add_argument("--git-keyword", metavar="WORD", action="append", default=[], dest="git_keywords", help="Extra keyword for the git history commit search only. Repeatable.")
    bug_parser.add_argument("--git-file", metavar="PATH", action="append", default=[], dest="git_files", help="Extra file or directory whose git history is read; not used by code search. Repeatable.")
    bug_parser.add_argument("--git-no-shared-keywords", action="store_true", help="Git history ignores --keywords (code search still uses them).")
    bug_parser.add_argument("--git-no-shared-focus-files", action="store_true", help="Git history ignores --focus-file (code search still uses them).")
    bug_parser.add_argument("--git-no-commit-search", action="store_true", help="Git history does not search commit messages.")
    bug_parser.add_argument("--git-no-file-history", action="store_true", help="Git history does not read the history of related files.")
    bug_parser.add_argument("--git-history-depth", choices=GIT_HISTORY_DEPTHS, default="recent", help="How far back git history reads (default recent).")
    bug_parser.add_argument("--git-max-commits", type=int, metavar="N", help=f"How many related commits to keep, 1-{MAX_RELATED_COMMITS_LIMIT} (default 10).")
    bug_parser.add_argument("--skip-similar-fixes", action="store_true", help="Skip the memory search for similar past bugs.")
    # Similar Fixes Settings: the memory search only — neither code search nor
    # git history reads them. As above, a command line that names none of them
    # runs exactly as before they existed.
    bug_parser.add_argument("--similar-fixes-keyword", metavar="WORD", action="append", default=[], dest="similar_keywords", help="Extra keyword for the similar-fixes memory search only. Repeatable.")
    bug_parser.add_argument("--similar-fixes-no-shared-keywords", action="store_true", help="The similar-fixes memory search ignores --keywords (code search still uses them).")
    bug_parser.add_argument("--max-similar-fixes", type=int, metavar="N", help=f"How many similar past fixes to keep, 1-{MAX_SIMILAR_FIXES_LIMIT} (default {DEFAULT_MAX_SIMILAR_FIXES}).")
    bug_parser.add_argument("--only-issue-details", action="store_true", help="Only normalize the bug description; skip search, history and context.")
    _add_json_flag(bug_parser)
    bug_parser.add_argument(
        "--retry",
        action="store_true",
        help="Prepare a second attempt: generate the retry prompt and user_feedback.md, then hand off.",
    )
    bug_parser.add_argument(
        "--json-lines",
        action="store_true",
        dest="json_lines",
        help="Stream one JSON event per line while the workflow runs. Never launches an agent.",
    )
    bug_parser.add_argument(
        "--agent-fix",
        action="store_true",
        help="Print experimental agent invocation guidance after preparation.",
    )
    bug_run = bug_parser.add_mutually_exclusive_group()
    bug_run.add_argument(
        "--copilot",
        action="store_true",
        help="Use Copilot CLI instead of Claude to complete the workflow after preparation.",
    )
    bug_run.add_argument(
        "--prepare-only",
        action="store_true",
        help="Only prepare artifacts; do not launch an agent. By default Claude is launched after preparation.",
    )
    bug_mode = bug_parser.add_mutually_exclusive_group()
    bug_mode.add_argument(
        "--fresh",
        action="store_true",
        help="Remove existing .ai/<issue>/ artifacts before running the workflow. This is the default.",
    )
    bug_mode.add_argument(
        "--resume",
        action="store_true",
        help="Preserve existing .ai/<issue>/ artifacts and continue an existing workflow.",
    )
    bug_parser.add_argument(
        "--include-memory",
        action="store_true",
        help="With fresh mode, also remove that issue's memory entry before rerunning.",
    )
    bug_parser.add_argument(
        "--hint",
        metavar="TEXT",
        help="Developer hint (e.g. fix location) injected into task.md so the agent goes straight to it.",
    )
    bug_parser.add_argument(
        "--jira-comment",
        action="store_true",
        help="Include the pre-commit Jira status comment instruction in the generated task.md (omitted by default).",
    )
    # No argparse `choices=`: the list comes from the registry, which a later
    # phase widens with project and user modes, and argparse would both freeze
    # that list at parser-build time and word the rejection worse than core does.
    bug_parser.add_argument(
        "--fix-mode",
        metavar="ID",
        dest="fix_mode",
        help=(
            "Select the AI fixing workflow (see: bugpilot fix-mode list). "
            "Default: the work item's previous selection, otherwise Standard Fix."
        ),
    )
    bug_parser.add_argument(
        "--branch-policy",
        dest="branch_policy",
        choices=BRANCH_POLICIES,
        help=(
            "Which branch the agent works on: 'current' works on the checked-out branch and "
            "creates a feature branch only after asking, when on main/master or a detached HEAD; "
            "'per-issue' creates or reuses one branch for the work item; 'ask' asks the "
            "developer before editing. Preparing again never calls for a new branch, and "
            "main/master is never edited under any policy. "
            "Default: the work item's previous choice, otherwise 'current'."
        ),
    )
    bug_mock = bug_parser.add_mutually_exclusive_group()
    bug_mock.add_argument("--allow-mock", action="store_true", help="Allow mock/demo fallback when Jira fetch fails.")
    bug_mock.add_argument("--no-mock", action="store_true", help="Require real Jira data. This is the default.")

    return parser


def _subcommand_names(parser: argparse.ArgumentParser) -> set[str]:
    for action in parser._actions:
        if isinstance(action, argparse._SubParsersAction):
            return set(action.choices)
    return set()


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    argv = list(sys.argv[1:] if argv is None else argv)
    # `bug` is the default command: `bugpilot JR-12345` is treated as `bugpilot bug JR-12345`.
    # Only inject when the first token is neither a known subcommand nor an option.
    if argv and not argv[0].startswith("-") and argv[0] not in _subcommand_names(parser):
        argv = ["bug", *argv]
    args = parser.parse_args(argv)
    repo_root = Path.cwd()

    if not (getattr(args, "json_output", False) or getattr(args, "json_lines", False)):
        try:
            return _dispatch(args, repo_root)
        except RunArtifactError as exc:
            # Standalone steps read run.json to mark themselves; an unusable
            # file is an error, and this is its one sentence — a traceback
            # chained through the step's own handler is not.
            print(f"ERROR: {exc}", file=sys.stderr)
            print("A fresh run replaces it: bugpilot bug <work-item-id>", file=sys.stderr)
            return 1
    # Machine-readable modes promise exactly one object (or one closed stream) on
    # stdout for every outcome. An unhandled exception would otherwise print a
    # traceback to stderr and nothing at all to stdout, which a consumer reads as
    # a hang rather than a failure.
    try:
        return _dispatch(args, repo_root)
    except Exception as exc:  # noqa: BLE001 - deliberately the last resort
        code = errors.error_code_for(exc)
        if getattr(args, "json_lines", False):
            cli_json.emit_stream_failure(code, str(exc))
        else:
            cli_json.emit_failure(args.command, code, str(exc))
        return 1


def _dispatch(args, repo_root: Path) -> int:
    if args.command == "setup":
        return setup.run_setup(hide_token=args.hide_token)

    if args.command == "doctor":
        if args.json_output:
            cli_json.emit(cli_json.success("doctor", report=doctor.collect_doctor_report(repo_root)))
            return 0
        for line in doctor.doctor_report_lines(repo_root):
            print(line)
        return 0

    if args.command == "fix-mode":
        return _run_fix_mode_command(args, repo_root)

    if args.command == "agent-check":
        for line in copilot.agent_status_lines(repo_root):
            print(line)
        return 0

    if args.command == "clean":
        try:
            result = clean_issue_artifacts(repo_root, args.issue_key, include_memory=args.include_memory)
        except ValueError as exc:
            print(f"ERROR: {exc}", file=sys.stderr)
            return 1
        _print_clean_result(result, include_memory=args.include_memory)
        return 0

    if args.command == "jira-validate":
        refusal = _refuse_for_manual(repo_root, "jira-validate", args.issue_key, False)
        if refusal is not None:
            return refusal
        try:
            summary = workflow.jira_validate_step(repo_root, args.issue_key)
        except JiraFetchError as exc:
            _print_jira_validate_error(exc)
            return 1
        except Exception as exc:
            print(f"ERROR: {exc}", file=sys.stderr)
            return 1
        _print_jira_validate_summary(args.issue_key, summary)
        return 0

    if args.command == "jira-comment-draft":
        refusal = _refuse_without_jira_target(repo_root, "jira-comment-draft", args.issue_key, False)
        if refusal is not None:
            return refusal
        try:
            path = workflow.jira_comment_draft_step(repo_root, args.issue_key, strict=args.strict)
        except FileNotFoundError as exc:
            print(str(exc), file=sys.stderr)
            return 1
        except ValueError as exc:
            print(f"ERROR: {exc}", file=sys.stderr)
            return 1
        print(f"Generated Jira comment draft: {path}")
        return 0

    if args.command == "jira-comment":
        refusal = _refuse_without_jira_target(repo_root, "jira-comment", args.issue_key, False)
        if refusal is not None:
            return refusal
        try:
            result = workflow.jira_comment_step(repo_root, args.issue_key, execute=args.execute)
        except FileNotFoundError as exc:
            print(str(exc), file=sys.stderr)
            return 1
        except JiraCommentPostError as exc:
            print(f"ERROR: {exc.message}", file=sys.stderr)
            return 1
        except ValueError as exc:
            print(f"ERROR: {exc}", file=sys.stderr)
            return 1
        if args.execute:
            print(f"Posted Jira comment for {args.issue_key}.")
            print(f"Comment ID: {result.get('comment_id') or '(not returned)'}")
            print(f"Generated: .ai/{args.issue_key}/jira_comment_post_result.json")
        else:
            print(f"Preview Jira comment for {args.issue_key}.")
            print(f"Draft: .ai/{args.issue_key}/jira_comment_draft.md")
            print(f"Length: {result.get('length', 0)} characters")
            print("No Jira comment was posted. Use --execute to post exactly one Jira comment.")
            print()
            print(str(result.get("preview", "")))
        return 0

    if args.command == "fetch":
        refusal = _refuse_for_manual(repo_root, "fetch", args.issue_key, args.json_output)
        if refusal is not None:
            return refusal
        try:
            result = workflow.fetch_step(repo_root, args.issue_key, allow_mock=_allow_mock(args))
        except JiraFetchError as exc:
            if args.json_output:
                cli_json.emit_failure(
                    "fetch",
                    errors.code_for_jira_error_type(exc.result.error_type),
                    exc.result.error_message or str(exc),
                    work_item_id=args.issue_key,
                )
                return 1
            _print_jira_error(exc)
            return 1
        mock_warning = (
            f"{result.error_message} Using mock/demo Jira data." if result.source == "mock" else None
        )
        if args.json_output:
            cli_json.emit(
                cli_json.success(
                    "fetch",
                    work_item_id=args.issue_key,
                    source="jira",
                    issue_dir=f".ai/{args.issue_key}",
                    jira_source=result.source,
                    warnings=[mock_warning] if mock_warning else [],
                )
            )
            return 0
        if mock_warning:
            print(f"WARN: {mock_warning}")
        print(f"Fetched Jira data for {args.issue_key} into .ai/{args.issue_key}/")
        return 0

    if args.command == "issue-details":
        # Read-only, and deliberately not a step: `fetch` writes `.ai/<issue>/`
        # because a run needs those artifacts, and the editor's hint improver
        # needs two strings. Creating a work item as a side effect of improving
        # a sentence would be a surprise, so this reuses the same Jira client
        # and the same parser and writes nothing.
        refusal = _refuse_for_manual(repo_root, "issue-details", args.issue_key, args.json_output)
        if refusal is not None:
            return refusal
        try:
            result = fetch_issue(repo_root, args.issue_key, allow_mock=_allow_mock(args))
        except JiraFetchError as exc:
            if args.json_output:
                cli_json.emit_failure(
                    "issue-details",
                    errors.code_for_jira_error_type(exc.result.error_type),
                    exc.result.error_message or str(exc),
                    work_item_id=args.issue_key,
                )
                return 1
            _print_jira_error(exc)
            return 1
        parsed = parse_issue(result.data)
        title = str(parsed.get("summary") or "")
        description = str(parsed.get("description") or "")
        if args.json_output:
            cli_json.emit(
                cli_json.success(
                    "issue-details",
                    work_item_id=args.issue_key,
                    title=title,
                    description=description,
                    jira_source=result.source,
                )
            )
            return 0
        print(f"{args.issue_key}: {title}")
        if description:
            print()
            print(description)
        return 0

    if args.command == "parse":
        # parse works for both sources; it is fetch/jira-validate that are Jira-only.
        workflow.parse_step(repo_root, args.issue_key)
        print(f"Parsed Jira data for {args.issue_key}.")
        return 0

    if args.command == "keywords":
        # Nothing is written: the extraction is recomputed from issue.json by
        # whichever step needs it, so printing it is what this command is for.
        keywords = workflow.keywords_step(repo_root, args.issue_key)
        print(f"Extracted keywords for {args.issue_key}.")
        for label, key in (("High value", "high_value_keywords"), ("Normal", "normal_keywords"), ("Phrases", "phrase_keywords")):
            values = keywords.get(key)
            print(f"  {label}: {', '.join(map(str, values)) if isinstance(values, list) and values else '-'}")
        return 0

    if args.command == "search":
        workflow.code_search_step(repo_root, args.issue_key)
        if args.json_output:
            cli_json.emit(
                cli_json.success(
                    "search",
                    work_item_id=args.issue_key,
                    generated_files=[f".ai/{args.issue_key}/{RETRIEVAL_ARTIFACT}"],
                )
            )
            return 0
        print(f"Generated code search for {args.issue_key}.")
        return 0

    if args.command == "git-context":
        # Printed, not written: what Git history finds now, with the default
        # settings, through the renderer the context uses. The prepared run's
        # section in retrieval.json, its run.json step and its context.md are
        # left as they are, so the panel and the agent keep reading one run.
        print(render_git_context(workflow.git_context_step(repo_root, args.issue_key, record=False)), end="")
        return 0

    if args.command == "context":
        # A context rebuilt on its own gathers the two results it folds in, the
        # same way the pipeline does, rather than reading them from files.
        similar_fixes = workflow.memory_search_step(repo_root, args.issue_key)
        git_history = workflow.git_context_step(repo_root, args.issue_key)
        workflow.context_step(
            repo_root, args.issue_key, git_history=git_history, similar_fixes=similar_fixes
        )
        if args.json_output:
            cli_json.emit(
                cli_json.success(
                    "context",
                    work_item_id=args.issue_key,
                    generated_files=[f".ai/{args.issue_key}/{CONTEXT_ARTIFACT}"],
                )
            )
            return 0
        print(f"Generated context for {args.issue_key}.")
        return 0

    if args.command == "prompt":
        try:
            workflow.prompt_step(repo_root, args.issue_key, jira_comment=args.jira_comment)
        except FixModeError as exc:
            return _report_fix_mode_failure(exc)
        except IssueArtifactError as exc:
            return _report_issue_failure(args.issue_key, exc)
        print(f"Generated {TASK_ARTIFACT} for {args.issue_key}.")
        return 0

    if args.command == "agent-task":
        try:
            workflow.copilot_task_step(repo_root, args.issue_key, jira_comment=args.jira_comment)
        except FileNotFoundError as exc:
            if (repo_root / ".ai" / args.issue_key / CONTEXT_ARTIFACT).exists():
                # The context is there, so what is missing is issue.json.
                print(f"ERROR: {exc}", file=sys.stderr)
                return 1
            print(f"Missing .ai/{args.issue_key}/{CONTEXT_ARTIFACT}.", file=sys.stderr)
            print(f"Run: bugpilot bug {args.issue_key}", file=sys.stderr)
            return 1
        except FixModeError as exc:
            return _report_fix_mode_failure(exc)
        except IssueArtifactError as exc:
            return _report_issue_failure(args.issue_key, exc)
        print(f"Regenerated {TASK_ARTIFACT} for {args.issue_key}.")
        return 0

    if args.command == "agent-instructions":
        # Printed: the team instructions are a section of task.md, not a file of
        # their own in every work item.
        print(workflow.copilot_instructions_step(repo_root, args.issue_key), end="")
        return 0

    if args.command == "retry-prompt":
        try:
            result = workflow.retry_prompt_step(repo_root, args.issue_key)
        except FileNotFoundError as exc:
            print(str(exc), file=sys.stderr)
            return 1
        except FixModeError as exc:
            return _report_fix_mode_failure(exc)
        print(f"Generated retry prompt: {result['prompt']}")
        if "user_feedback" in result:
            print(f"Generated user feedback template: {result['user_feedback']}")
        print(f"Next manual agent instruction: Read .ai/{args.issue_key}/agent_retry_prompt.md and continue the workflow.")
        return 0

    if args.command == "check-results":
        missing = workflow.check_results_step(repo_root, args.issue_key, strict=args.strict)
        if args.json_output:
            if missing and args.strict:
                cli_json.emit_failure(
                    "check-results",
                    errors.MISSING_RESULTS,
                    f"missing {len(missing)} agent result file(s)",
                    work_item_id=args.issue_key,
                    missing=missing,
                )
                return 1
            cli_json.emit(
                cli_json.success(
                    "check-results",
                    work_item_id=args.issue_key,
                    missing=missing,
                    warnings=[f"missing {name}" for name in missing],
                )
            )
            return 0
        if missing:
            print(f"WARN: missing {len(missing)} agent result file(s).")
            for file_name in missing:
                print(f"  {file_name}")
            print(f"Not fixed yet? Run: bugpilot bug {args.issue_key} --retry")
            return 1 if args.strict else 0
        else:
            print(f"PASS: the fix report exists (.ai/{args.issue_key}/{FIX_REPORT_ARTIFACT}).")
        return 0

    if args.command == "manual-result":
        try:
            result = workflow.manual_result_step(repo_root, args.issue_key, overwrite=args.overwrite)
        except FileNotFoundError as exc:
            print(str(exc), file=sys.stderr)
            return 1
        if args.overwrite:
            print("WARN: overwrote the fix report with the developer manual-fix template.")
        print(f"Manual result template for {args.issue_key}:")
        for file_name in result["created"]:
            print(f"  created: {file_name}")
        for file_name in result["preserved"]:
            print(f"  preserved: {file_name}")
        return 0

    if args.command == "record-review":
        return _record_review(repo_root, args)

    if args.command == "record-verification":
        return _record_verification(repo_root, args)

    if args.command == "summarize-results":
        # The gate has to cover BUGPILOT_AUTO_JIRA_COMMENT too, not just the explicit
        # flag: an env var must not be able to post a comment for a work item that
        # has no Jira issue behind it.
        wants_comment = _auto_jira_comment_enabled(args)
        if wants_comment:
            refusal = _refuse_without_jira_target(repo_root, "summarize-results", args.issue_key, args.json_output)
            if refusal is not None:
                return refusal
        overview = workflow.summarize_results_step(repo_root, args.issue_key)
        if not args.json_output:
            # Rendered, not written: the report is the record and this is the
            # developer's next-steps view of it.
            print(overview, end="")
        if wants_comment:
            _post_jira_comment_auto(repo_root, args.issue_key, quiet=args.json_output)
        if args.json_output:
            report_path = repo_root / ".ai" / args.issue_key / FIX_REPORT_ARTIFACT
            cli_json.emit(
                cli_json.success(
                    "summarize-results",
                    work_item_id=args.issue_key,
                    fix_report=f".ai/{args.issue_key}/{FIX_REPORT_ARTIFACT}" if report_path.exists() else None,
                    overview=overview,
                    jira_comment_requested=wants_comment,
                )
            )
        return 0

    if args.command == "list":
        return _list_work_items(repo_root, args.json_output)

    if args.command == "review-package":
        if args.json_output:
            # A query, not a step: the prompt and the validation checklist, with
            # nothing created, marked or posted — what a panel button may run.
            try:
                prompt, checklist = workflow.review_package_projection(repo_root, args.issue_key)
            except workflow.WorkItemNotFoundError as exc:
                cli_json.emit_failure("review-package", errors.WORK_ITEM_NOT_FOUND, str(exc), work_item_id=args.issue_key)
                return 1
            except ValueError as exc:
                cli_json.emit_failure("review-package", errors.INVALID_INPUT, str(exc), work_item_id=args.issue_key)
                return 1
            except OSError as exc:
                # A report or retrieval file that vanished or cannot be read
                # mid-query — a Fresh run deleting it, say.
                cli_json.emit_failure("review-package", errors.error_code_for(exc), str(exc), work_item_id=args.issue_key)
                return 1
            cli_json.emit(
                cli_json.success(
                    "review-package",
                    work_item_id=args.issue_key,
                    prompt=prompt,
                    validation={
                        "steps": list(checklist.steps),
                        "regression_files": list(checklist.regression_files),
                        "review_risks": [line.strip() for line in checklist.review_risks],
                    },
                )
            )
            return 0
        # Printed, not written: the developer pastes it into a reviewer, and
        # nothing ever read the file this used to produce.
        print(workflow.review_package_step(repo_root, args.issue_key), end="")
        return 0

    if args.command == "delivery-check":
        warnings = workflow.delivery_check_step(repo_root, args.issue_key)
        if args.json_output:
            cli_json.emit(
                cli_json.success(
                    "delivery-check",
                    work_item_id=args.issue_key,
                    ready=not warnings,
                    warnings=warnings,
                )
            )
            return 0
        if warnings:
            print("WARN: delivery is not ready.")
            for warning in warnings:
                print(f"  {warning}")
            print(f"Not fixed yet? Run: bugpilot bug {args.issue_key} --retry")
        else:
            print("PASS: ready for manual commit/push.")
        return 0

    if args.command == "commit-plan":
        # Printed: the plan is regenerable from git state and the report, and
        # committing stays the developer's own action.
        print(workflow.commit_plan_step(repo_root, args.issue_key), end="")
        if not args.no_email:
            _notify_at_commit_gate(repo_root, args.issue_key)
        return 0

    if args.command == "notify":
        try:
            result = workflow.notify_step(repo_root, args.issue_key, execute=args.execute)
        except EmailSendError as exc:
            print(f"ERROR: {exc}", file=sys.stderr)
            _print_email_env_hint()
            return 1
        _print_notify_result(result)
        return 0

    if args.command == "push-plan":
        print(workflow.push_plan_step(repo_root, args.issue_key), end="")
        return 0

    if args.command in {"commit", "push"}:
        print("bugpilot never commits or pushes for you.")
        print("Use commit-plan or push-plan, review the plan, and run the commands yourself.")
        return 0

    if args.command == "memory":
        if args.memory_command == "add":
            workflow.memory_add_step(repo_root, args.issue_key)
            print(f"Added shared memory entry for {args.issue_key}.")
        elif args.memory_command == "update":
            updated = workflow.memory_update_step(repo_root, args.issue_key)
            if updated:
                print(f"Updated shared memory entry for {args.issue_key}.")
            else:
                print(
                    f"WARN: missing .ai/{args.issue_key}/{FIX_REPORT_ARTIFACT}. "
                    f"The agent writes it; for a manual fix run: bugpilot manual-result {args.issue_key}"
                )
        elif args.memory_command == "search":
            issue_key = args.query if workflow.looks_like_issue_key(args.query) else None
            if issue_key:
                print(workflow.memory_search_step(repo_root, issue_key), end="")
            else:
                _issue_key, markdown, _results = search_memory(repo_root, args.query)
                print(markdown, end="")
        else:
            return 1
        return 0

    if args.command == "status":
        if args.json_output:
            return _emit_status_json(repo_root, args.issue_key)
        return _print_status(repo_root, args.issue_key)

    if args.command == "bug" and args.retry:
        return _run_retry(repo_root, args)

    if args.command == "bug":
        fresh = not args.resume
        json_mode = args.json_output
        if args.include_memory and args.resume:
            message = "--include-memory requires fresh mode and cannot be used with --resume."
            _report_bug_preflight_failure(args, errors.INVALID_INPUT, message)
            return 1
        try:
            request = _build_bug_request(repo_root, args)
        except ValueError as exc:
            _report_bug_preflight_failure(args, errors.INVALID_INPUT, str(exc))
            return 1

        work_item_id = request.work_item_id
        stream = None
        if args.json_lines:
            stream = cli_json.JsonLinesEmitter(work_item_id, request.spec.source)
            stream.skipped(request.skipped_steps())
            progress = stream.progress
        elif json_mode:
            progress = None
        else:
            print(f"bugpilot bug {work_item_id}")
            progress = _bug_progress_printer(work_item_id, request.resolved_steps(), request.spec.source)
        try:
            result = workflow.run_investigation(
                repo_root,
                request,
                agent_fix=args.agent_fix,
                fresh=fresh,
                include_memory=args.include_memory,
                allow_mock=_allow_mock(args),
                progress=progress,
                hint=args.hint,
                jira_comment=args.jira_comment,
            )
        except JiraFetchError as exc:
            if stream is not None:
                stream.fail(
                    errors.code_for_jira_error_type(exc.result.error_type),
                    exc.result.error_message or str(exc),
                )
                return 1
            if json_mode:
                cli_json.emit_failure(
                    "bug",
                    errors.code_for_jira_error_type(exc.result.error_type),
                    exc.result.error_message or str(exc),
                    work_item_id=work_item_id,
                )
                return 1
            print(f"[ERROR] Fetching Jira issue failed: {exc.result.error_message}", file=sys.stderr)
            _print_log_hint(repo_root, work_item_id)
            _print_jira_error(exc)
            return 1
        # Before the ValueError arm below, which FixModeError also matches: a
        # rejected mode is a bad argument, not a failed run, so it points at
        # `fix-mode list` instead of at a log that may not exist yet.
        except FixModeError as exc:
            if stream is not None:
                stream.fail(errors.INVALID_INPUT, str(exc))
                return 1
            if json_mode:
                cli_json.emit_failure("bug", errors.INVALID_INPUT, str(exc), work_item_id=work_item_id)
                return 1
            print(f"ERROR: {exc}", file=sys.stderr)
            print("Run: bugpilot fix-mode list", file=sys.stderr)
            return 1
        except ValueError as exc:
            if stream is not None:
                stream.fail(errors.INVALID_INPUT, str(exc))
                return 1
            if json_mode:
                cli_json.emit_failure("bug", errors.INVALID_INPUT, str(exc), work_item_id=work_item_id)
                return 1
            print(f"ERROR: {exc}", file=sys.stderr)
            _print_log_hint(repo_root, work_item_id)
            return 1

        mock_warning = (
            f"{result.jira_result.error_message} Using mock/demo Jira data."
            if result.jira_result and result.jira_result.source == "mock"
            else None
        )
        # --only-issue-details skips the prompt step, so there is no task file to
        # point an agent at. Claiming one would send Claude at a missing path.
        agent_task = f".ai/{work_item_id}/{TASK_ARTIFACT}"
        agent_task_exists = (repo_root / ".ai" / work_item_id / TASK_ARTIFACT).exists()
        if stream is not None:
            stream.finish(result.generated_files, result.warnings)
            return 0
        if json_mode:
            # Re-read the issue: for a Jira item the title is only known after
            # the fetch, and request.spec is still the stub it started from.
            stored = read_issue_quietly(repo_root, work_item_id)
            cli_json.emit(
                cli_json.success(
                    "bug",
                    work_item_id=work_item_id,
                    source=stored.source if stored else request.spec.source,
                    source_ref=stored.source_ref if stored else request.spec.source_ref,
                    title=(stored.title if stored else request.spec.title) or None,
                    issue_dir=f".ai/{work_item_id}",
                    generated_files=result.generated_files,
                    skipped_steps=request.skipped_steps(),
                    fix_mode=fix_mode_metadata(result.fix_mode) if result.fix_mode else None,
                    agent_task=agent_task if agent_task_exists else None,
                    warnings=([mock_warning] if mock_warning else []) + list(result.warnings),
                )
            )
            return 0

        if mock_warning:
            print(f"WARN: {mock_warning}")
        for warning in result.warnings:
            print(f"WARN: {warning}")
        if not fresh:
            print(f"Resuming existing workflow package for {work_item_id}.")
            print("Previous artifacts were preserved.")
        _print_key_generated_artifacts(repo_root, work_item_id)
        print(f"Prepared bugpilot workflow package for {work_item_id}.")
        print(f"Artifacts: .ai/{work_item_id}")
        if result.fix_mode is not None:
            print(f"AI Fix Mode: {result.fix_mode.name} ({result.fix_mode.id})")
            if result.fix_mode.is_investigation:
                print("  Investigation only: the agent will not change source code in this pass.")
        # By default an agent (Claude) is launched after preparation. --prepare-only
        # stops here with artifacts only; --agent-fix prints legacy guidance instead.
        if not agent_task_exists:
            print(f"No {agent_task} was generated, so there is nothing to hand to an agent.")
            print("Re-run without --only-issue-details to build the full task package.")
            return 0
        if args.prepare_only or args.agent_fix:
            print("Next manual agent instruction:")
            print(f"  Read {agent_task} and complete the workflow.")
            if args.agent_fix:
                for line in copilot.agent_status_lines(repo_root):
                    print(line)
                for line in copilot.auto_invocation_guidance(work_item_id):
                    print(line)
            return 0
        agent = "copilot" if args.copilot else "claude"
        return _run_agent_after_prepare(repo_root, work_item_id, agent, fix_mode=result.fix_mode)

    return 1


def _launch_expectation_lines(fix_mode: FixMode | None, *, retry: bool) -> list[str]:
    """What the developer is told the agent is about to do.

    Three sentences, chosen by the mode's execution kind rather than its id, so a
    custom investigate-kind mode reads the same as the built-in one. The task
    file is what actually instructs the agent; this only has to agree with it —
    telling the developer a fix is coming while the task says "do not modify
    source code" was the contradiction this replaces. A retry launch has no
    resolved mode in hand, so it describes the loop and lets the retry prompt
    say the rest.
    """
    if retry:
        return [
            "The agent will read your feedback and the previous attempt, then continue",
            "the workflow the retry prompt describes.",
            "It stops at the commit gate. Review its changes as third-party code before you commit.",
        ]
    if fix_mode is not None and fix_mode.is_investigation:
        return [
            "The agent will investigate the issue, document the evidence and hypotheses,",
            "and propose a fix plan without changing source code.",
            "It stops at the investigation handoff and asks before any implementation.",
        ]
    return [
        "The agent will analyze, implement the smallest safe fix, and write the fix report.",
        "It stops at the commit gate and asks before committing.",
        "Review its changes as third-party code before you commit.",
    ]


def _git_history_options(args: argparse.Namespace) -> GitHistoryOptions:
    """The Git History Settings a ``bug`` command line asks for.

    A count outside 1-25 is refused rather than clamped: a typo should say so,
    not quietly run with a different number.
    """
    max_commits = args.git_max_commits
    if max_commits is not None and not 1 <= max_commits <= MAX_RELATED_COMMITS_LIMIT:
        raise ValueError(f"--git-max-commits must be between 1 and {MAX_RELATED_COMMITS_LIMIT}.")
    defaults = GitHistoryOptions()
    return GitHistoryOptions(
        use_shared_keywords=not args.git_no_shared_keywords,
        use_shared_focus_files=not args.git_no_shared_focus_files,
        keywords=tuple(args.git_keywords),
        files=tuple(args.git_files),
        search_commit_messages=not args.git_no_commit_search,
        search_file_history=not args.git_no_file_history,
        history_depth=args.git_history_depth,
        max_related_commits=defaults.max_related_commits if max_commits is None else max_commits,
    )


def _similar_fixes_options(args: argparse.Namespace) -> SimilarFixesOptions:
    """The Similar Fixes Settings a ``bug`` command line asks for.

    Like ``--git-max-commits``, a count outside 1-20 is refused rather than
    clamped.
    """
    max_fixes = args.max_similar_fixes
    if max_fixes is not None and not 1 <= max_fixes <= MAX_SIMILAR_FIXES_LIMIT:
        raise ValueError(f"--max-similar-fixes must be between 1 and {MAX_SIMILAR_FIXES_LIMIT}.")
    return SimilarFixesOptions(
        use_shared_keywords=not args.similar_fixes_no_shared_keywords,
        keywords=tuple(args.similar_keywords),
        max_results=DEFAULT_MAX_SIMILAR_FIXES if max_fixes is None else max_fixes,
    )


def _emit_status_json(repo_root: Path, issue_key: str) -> int:
    """Machine-readable `status`. Missing state is a failure, not an empty result."""
    try:
        run = load_run(repo_root, issue_key)
    except RunArtifactError as exc:
        cli_json.emit_failure(
            "status", errors.ARTIFACT_NOT_FOUND, str(exc), work_item_id=issue_key,
        )
        return 1
    if run is None:
        cli_json.emit_failure(
            "status",
            errors.WORK_ITEM_NOT_FOUND,
            f"No run state found for {issue_key}. Run: bugpilot bug {issue_key}",
            work_item_id=issue_key,
        )
        return 1
    issue = read_issue_quietly(repo_root, issue_key)
    record = run_to_dict(run)
    cli_json.emit(
        cli_json.success(
            "status",
            work_item_id=issue_key,
            source=issue.source if issue else None,
            title=issue.title if issue else None,
            # The one authoritative run state: running, prepared or failed.
            status=run.status,
            steps=record["steps"],
            generated_files=record["generated_files"],
            # The AI workflow the package was prepared under. Null for a
            # package prepared before Fix Modes existed.
            fix_mode=run.fix_mode,
            # Where a failed run failed, when it did. Additive.
            error=record.get("error"),
        )
    )
    return 0


def _print_status(repo_root: Path, issue_key: str) -> int:
    try:
        run = load_run(repo_root, issue_key)
    except RunArtifactError as exc:
        print(f"ERROR: {exc}", file=sys.stderr)
        print(f"Re-run: bugpilot bug {issue_key}", file=sys.stderr)
        return 1
    if run is None:
        print(f"No run state found for {issue_key}.", file=sys.stderr)
        print("Run:", file=sys.stderr)
        print(f"  bugpilot bug {issue_key}", file=sys.stderr)
        return 1

    record = run_to_dict(run)
    print(f"Work item: {run.work_item_id}")
    print(f"Status: {run.status}")
    if run.error is not None:
        where = f" at the {run.error.step} step" if run.error.step else ""
        print(f"Failed{where}: {run.error.message}")
    print("Steps:")
    for name, step_status in record["steps"].items():
        print(f"  {name}: {step_status}")
    print("Generated files:")
    for file_name in record["generated_files"]:
        print(f"  {file_name}")
    return 0


def _allow_mock(args) -> bool:
    return bool(getattr(args, "allow_mock", False))


def _run_agent_after_prepare(
    repo_root: Path,
    issue_key: str,
    agent: str,
    prompt_file: str | None = None,
    fix_mode: FixMode | None = None,
) -> int:
    handoff = (
        agent_runner.RETRY_HANDOFF_PROMPT.format(prompt_file=prompt_file) if prompt_file else None
    )
    instruction = prompt_file or f".ai/{issue_key}/{TASK_ARTIFACT}"
    print()
    print(f"Launching {agent} to complete the workflow for {issue_key}.")
    for line in _launch_expectation_lines(fix_mode, retry=prompt_file is not None):
        print(line)
    result = agent_runner.run_agent(repo_root, issue_key, agent, prompt=handoff)
    if not result.ran:
        print(f"WARN: could not launch {agent}: {result.skipped_reason}", file=sys.stderr)
        print(f"Open {agent} manually from the target repo root and run:", file=sys.stderr)
        print(f"  Read {instruction} and complete the workflow.", file=sys.stderr)
        return 1
    if result.returncode not in (0, None):
        print(f"WARN: {agent} exited with code {result.returncode}.", file=sys.stderr)
        return result.returncode
    return 0


def _report_bug_preflight_failure(args, code: str, message: str) -> None:
    """Report a failure that happens before the run, in whichever mode is active.

    --json-lines needs a terminal event even here: a consumer waiting for one
    cannot tell an aborted run from a slow one.
    """
    if getattr(args, "json_lines", False):
        cli_json.emit_stream_failure(code, message)
    elif getattr(args, "json_output", False):
        cli_json.emit_failure("bug", code, message)
    else:
        print(f"ERROR: {message}", file=sys.stderr)


def _record_review(repo_root: Path, args) -> int:
    """`bugpilot record-review <ID>`: write what a completed review said.

    The one writer of review_report.md. It records; it does not review, verify or
    judge — the report has no verdict field, and nothing here reads one into it.
    Text comes from the four options or, for the extension, from a JSON file, so
    a review never has to fit on a command line.
    """

    def fail(code: str, message: str) -> int:
        if args.json_output:
            cli_json.emit_failure("record-review", code, message, work_item_id=args.issue_key)
        else:
            print(f"ERROR: {message}", file=sys.stderr)
        return 1

    flags = {key: getattr(args, key) for key, _heading in REVIEW_SECTIONS}
    if args.from_file is not None:
        if any(value is not None for value in flags.values()):
            return fail(errors.INVALID_INPUT, "Give the review either as --from-file or as text options, not both.")
        try:
            review = _review_from_file(Path(args.from_file))
        except (OSError, ValueError) as exc:
            return fail(errors.INVALID_INPUT, str(exc))
    else:
        review = ReviewInput(**{key: value or "" for key, value in flags.items()})

    try:
        recorded = record_review(repo_root, args.issue_key, review, replace=args.replace)
    except WorkItemNotFoundError as exc:
        return fail(errors.WORK_ITEM_NOT_FOUND, str(exc))
    except ReviewReportExistsError as exc:
        return fail(errors.ARTIFACT_EXISTS, str(exc))
    except ValueError as exc:
        return fail(errors.INVALID_INPUT, str(exc))
    except OSError as exc:
        # The folder removed or unwritable mid-write — a clean or a Fresh run.
        return fail(errors.error_code_for(exc), f"The review result could not be written: {exc}")

    relative = f".ai/{args.issue_key}/{recorded.path.name}"
    if args.json_output:
        cli_json.emit(
            cli_json.success(
                "record-review",
                work_item_id=args.issue_key,
                review_report=relative,
                replaced=recorded.replaced,
            )
        )
        return 0
    print(f"{'Replaced' if recorded.replaced else 'Recorded'} the review result: {relative}")
    print("This records what the review said. It does not verify the fix or confirm that tests passed.")
    return 0


def _review_from_file(path: Path) -> ReviewInput:
    """A review from a JSON object: the four sections, each a string or null."""
    # Bounded before it is read: four capped sections, generously escaped.
    if path.stat().st_size > 8 * len(REVIEW_SECTIONS) * MAX_SECTION_CHARS:
        raise ValueError("--from-file is far larger than any review record-review accepts.")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"--from-file is not valid JSON: {exc.msg}.") from exc
    if not isinstance(data, dict):
        raise ValueError("--from-file must hold one JSON object.")
    allowed = {key for key, _heading in REVIEW_SECTIONS}
    unknown = sorted(set(data) - allowed)
    if unknown:
        raise ValueError(f"--from-file has fields record-review does not know: {', '.join(unknown)}.")
    for key, value in data.items():
        if value is not None and not isinstance(value, str):
            raise ValueError(f"--from-file field {key} must be text.")
    return ReviewInput(**{key: data.get(key) or "" for key in allowed})


def _record_verification(repo_root: Path, args) -> int:
    """`bugpilot record-verification <ID> --from-file <json>`: write recorded evidence.

    The one writer of verification_report.md. It records the checks the developer
    gathered and the status they gave each; it runs no command and observes no
    result, so every status in the report is the user's. The checks come as a JSON
    file — transport only, never stored — so evidence never has to fit on a
    command line or pass through a shell.
    """

    def fail(code: str, message: str) -> int:
        if args.json_output:
            cli_json.emit_failure("record-verification", code, message, work_item_id=args.issue_key)
        else:
            print(f"ERROR: {message}", file=sys.stderr)
        return 1

    if args.from_file is None:
        return fail(errors.INVALID_INPUT, "Give the checks as --from-file <json>.")
    try:
        checks = _checks_from_file(Path(args.from_file))
    except (OSError, ValueError) as exc:
        return fail(errors.INVALID_INPUT, str(exc))
    except RecursionError:
        return fail(errors.INVALID_INPUT, "--from-file is nested too deeply to be the checks record-verification takes.")

    try:
        recorded = record_verification(repo_root, args.issue_key, checks, replace=args.replace)
    except WorkItemNotFoundError as exc:
        return fail(errors.WORK_ITEM_NOT_FOUND, str(exc))
    except VerificationReportExistsError as exc:
        return fail(errors.ARTIFACT_EXISTS, str(exc))
    except ValueError as exc:
        return fail(errors.INVALID_INPUT, str(exc))
    except OSError as exc:
        # The folder removed or unwritable mid-write — a clean or a Fresh run.
        return fail(errors.error_code_for(exc), f"The verification evidence could not be written: {exc}")

    counts = {status: sum(check.status == status for check in checks) for status in ("passed", "failed", "not_run")}
    relative = f".ai/{args.issue_key}/{recorded.path.name}"
    if args.json_output:
        cli_json.emit(
            cli_json.success(
                "record-verification",
                work_item_id=args.issue_key,
                verification_report=relative,
                replaced=recorded.replaced,
                checks=counts,
            )
        )
        return 0
    print(f"{'Replaced' if recorded.replaced else 'Recorded'} the verification evidence: {relative}")
    print(summary_line(counts["passed"], counts["failed"], counts["not_run"]))
    print("BugPilot ran none of these checks: each status is the one you recorded.")
    return 0


_CHECK_FIELDS = ("name", "status", "type", "procedure", "evidence", "notes")


def _checks_from_file(path: Path) -> list[VerificationCheck]:
    """The checks from ``{"checks": [...]}``: name and status required, the rest optional."""
    # Bounded before it is read: capped checks of capped fields, generously escaped.
    if path.stat().st_size > 8 * MAX_CHECKS * (MAX_NAME_CHARS + 3 * MAX_TEXT_CHARS + 200):
        raise ValueError("--from-file is far larger than any evidence record-verification accepts.")
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(f"--from-file is not valid JSON: {exc.msg}.") from exc
    if not isinstance(data, dict) or set(data) != {"checks"} or not isinstance(data["checks"], list):
        raise ValueError('--from-file must hold one JSON object, {"checks": [...]}.')
    checks: list[VerificationCheck] = []
    for number, item in enumerate(data["checks"], start=1):
        if not isinstance(item, dict):
            raise ValueError(f"Check {number} must be a JSON object.")
        unknown = sorted(set(item) - set(_CHECK_FIELDS))
        if unknown:
            raise ValueError(f"Check {number} has fields record-verification does not know: {', '.join(unknown)}.")
        for key in ("name", "status"):
            if not isinstance(item.get(key), str):
                raise ValueError(f"Check {number}: {key} is required and must be text.")
        for key in ("type", "procedure", "evidence", "notes"):
            if item.get(key) is not None and not isinstance(item[key], str):
                raise ValueError(f"Check {number}: {key} must be text.")
        checks.append(
            VerificationCheck(
                name=item["name"],
                status=item["status"],
                type=item.get("type") or "other",
                procedure=item.get("procedure") or "",
                evidence=item.get("evidence") or "",
                notes=item.get("notes") or "",
            )
        )
    return checks


def _run_retry(repo_root: Path, args) -> int:
    """`bugpilot bug <ID> --retry`: the three manual steps of a second attempt, as one.

    Previously this meant running retry-prompt, editing user_feedback.md, then
    pasting the handoff into an agent. The retry loop is deliberately
    human-triggered — its input is the developer's feedback, not the model's own
    judgement (design 5.6).
    """
    if not args.issue_key:
        message = "--retry needs the work item to retry, e.g. bugpilot bug JR-12345 --retry."
        if args.json_output:
            cli_json.emit_failure("bug", errors.INVALID_INPUT, message)
        else:
            print(f"ERROR: {message}", file=sys.stderr)
        return 1
    try:
        generated = workflow.retry_prompt_step(repo_root, args.issue_key)
    except FileNotFoundError as exc:
        if args.json_output:
            cli_json.emit_failure("bug", errors.WORK_ITEM_NOT_FOUND, str(exc), work_item_id=args.issue_key)
        else:
            print(f"ERROR: {exc}", file=sys.stderr)
        return 1

    feedback = f".ai/{args.issue_key}/user_feedback.md"
    prompt = f".ai/{args.issue_key}/agent_retry_prompt.md"
    if args.json_output:
        cli_json.emit(
            cli_json.success(
                "bug",
                work_item_id=args.issue_key,
                retry=True,
                feedback_file=feedback,
                retry_prompt=prompt,
                feedback_created="user_feedback" in generated,
            )
        )
        return 0

    print(f"Generated {prompt}")
    if "user_feedback" in generated:
        # The template was just created, so it holds placeholders rather than the
        # developer's account of what went wrong. Retrying now would hand the agent
        # an empty correction — the one input this loop exists to carry.
        print(f"Created {feedback} — describe what the previous attempt got wrong,")
        print(f"then run:  bugpilot bug {args.issue_key} --retry")
        return 0
    print(f"Using your existing {feedback}.")
    if args.prepare_only:
        print("Next manual agent instruction:")
        print(f"  Read {prompt} and continue the workflow.")
        return 0
    agent = "copilot" if args.copilot else "claude"
    return _run_agent_after_prepare(repo_root, args.issue_key, agent, prompt_file=prompt)


def _refuse_for_manual(repo_root: Path, command: str, work_item_id: str, json_output: bool) -> int | None:
    """Refuse a Jira-only command for a hand-written work item (design 5.1).

    Returns an exit code to return, or ``None`` to carry on. Without this the
    command would fail later with a confusing artifact error instead of saying
    the operation does not apply.
    """
    issue = read_issue_quietly(repo_root, work_item_id)
    if issue is None or issue.source != SOURCE_MANUAL:
        return None
    message = (
        f"{command} only applies to a Jira work item; {work_item_id} was described by hand."
    )
    if json_output:
        cli_json.emit_failure(command, errors.JIRA_ONLY_COMMAND, message, work_item_id=work_item_id)
    else:
        print(f"ERROR: {message}", file=sys.stderr)
    return 1


def _refuse_without_jira_target(repo_root: Path, command: str, work_item_id: str, json_output: bool) -> int | None:
    """Refuse a Jira write when there is no issue to write back to (design 5.1)."""
    issue = read_issue_quietly(repo_root, work_item_id)
    if issue is None or issue.can_write_back:
        return None
    message = (
        f"{work_item_id} has no Jira issue to comment on; it was described by hand."
    )
    if json_output:
        cli_json.emit_failure(command, errors.NO_JIRA_TARGET, message, work_item_id=work_item_id)
    else:
        print(f"ERROR: {message}", file=sys.stderr)
    return 1


def _list_work_items(repo_root: Path, json_output: bool) -> int:
    """List prepared work items. Unreadable entries degrade, they do not fail.

    A local id carries no readable slug on purpose (design 3.4), so this command
    is where the title becomes visible in a terminal.
    """
    ai_root = repo_root / ".ai"
    entries: list[dict[str, object]] = []
    # Only folders named like a work item. Anything else under .ai/ is not one
    # this tool made, and listing it would hand its name to every consumer of
    # this list — the extension's History, and from there a handoff's command
    # line (§37.70). Skipped, not touched: nothing here deletes or renames.
    directories = (
        sorted(path for path in ai_root.iterdir() if path.is_dir() and is_work_item_id(path.name))
        if ai_root.is_dir()
        else []
    )
    for path in directories:
        issue = read_issue_quietly(repo_root, path.name)
        prepared = (path / RUN_ARTIFACT).exists()
        entries.append(
            {
                "work_item_id": path.name,
                "source": issue.source if issue else None,
                "title": issue.title if issue else None,
                "prepared": prepared,
            }
        )
    if json_output:
        cli_json.emit(cli_json.success("list", work_items=entries))
        return 0
    if not entries:
        print("No work items found under .ai/.")
        return 0
    width = max(len(str(entry["work_item_id"])) for entry in entries)
    for entry in entries:
        source = entry["source"] or "-"
        title = entry["title"] or ""
        state = "prepared" if entry["prepared"] else "incomplete"
        print(f"{str(entry['work_item_id']).ljust(width)}  {source:<7} {state:<10} {title}")
    return 0


def _report_fix_mode_failure(exc: FixModeError) -> int:
    """A regeneration path whose stored selection no longer works.

    It says what to do next rather than falling back to Standard Fix: quietly
    regenerating a Conservative package as Standard is exactly the substitution
    the persisted selection exists to prevent.
    """
    print(f"ERROR: {exc}", file=sys.stderr)
    print("Run: bugpilot fix-mode list", file=sys.stderr)
    return 1


def _report_issue_failure(issue_key: str, exc: IssueArtifactError) -> int:
    """A regeneration path whose issue.json cannot be used.

    There is no older layout to fall back to, so the answer is to re-prepare.
    """
    print(f"ERROR: {exc}", file=sys.stderr)
    print(f"Run: bugpilot bug {issue_key}", file=sys.stderr)
    return 1


def _run_fix_mode_command(args, repo_root: Path) -> int:
    """`bugpilot fix-mode …`: read the catalog, or change a custom mode in it.

    `repo_root` is threaded in rather than taken from the process directory,
    because a project's modes belong to the repository being worked on — which
    is not always the directory a command was typed in, and is never the one a
    test runs from.
    """
    store = FixModeStore(repo_root)
    try:
        catalog = store.load_catalog()
    except FixModeError as exc:
        return _fix_mode_error(args, exc)
    handlers = {
        "list": _fix_mode_list,
        "show": _fix_mode_show,
        "duplicate": _fix_mode_duplicate,
        "create": _fix_mode_create,
        "update": _fix_mode_update,
        "delete": _fix_mode_delete,
    }
    try:
        return handlers[args.action](args, store, catalog)
    except FixModeError as exc:
        return _fix_mode_error(args, exc)
    except OSError as exc:
        # A read-only checkout, a permission denied, a directory that vanished.
        # A user's environment problem, not a BugPilot defect, so it reads as a
        # message rather than a traceback.
        return _fix_mode_error(args, FixModeError(f"Fix Mode storage is not writable: {exc}"))


def _fix_mode_error(args, exc: FixModeError) -> int:
    if getattr(args, "json_output", False):
        cli_json.emit_failure("fix-mode", errors.INVALID_INPUT, str(exc))
        return 1
    print(f"ERROR: {exc}", file=sys.stderr)
    return 1


def _fix_mode_summary(mode: FixMode) -> dict[str, object]:
    """One mode as a picker needs it: metadata plus the line that describes it."""
    return {**fix_mode_metadata(mode), "description": mode.description}


def _fix_mode_definition(mode: FixMode) -> dict[str, object]:
    """The whole mode, including the six sections an editor edits."""
    definition = _fix_mode_summary(mode)
    definition.update({name: text for name, text in mode.instruction_sections()})
    return definition


def _fix_mode_issues(catalog: FixModeCatalog) -> list[dict[str, object]]:
    return [
        {"scope": issue.scope, "path": issue.path, "message": issue.message}
        for issue in catalog.issues
    ]


def _fix_mode_list(args, store: FixModeStore, catalog: FixModeCatalog) -> int:
    """The effective list, or every physical definition with `--all-scopes`.

    Two different questions. The selector asks which definition an id runs, and
    gets one mode per id. Management asks what exists on disk, and has to see
    both `user/my-safe` and `project/my-safe` — resolving that through the
    effective registry would make the shadowed one unaddressable.
    """
    if args.mode_id:
        # `fix-mode list standard` used to print the whole table and drop the
        # id. Accepting an argument and ignoring it is the CLI equivalent of a
        # silent fallback, so it is refused with the command that was meant.
        raise FixModeError(
            f"bugpilot fix-mode list takes no mode id. To see one mode, run: "
            f"bugpilot fix-mode show {args.mode_id}"
        )
    effective = catalog.effective_modes()
    if args.json_output:
        payload: dict[str, object] = {
            "default_mode_id": catalog.effective_registry().default.id,
            "issues": _fix_mode_issues(catalog),
        }
        if args.all_scopes:
            for scope in ("builtin", "user", "project"):
                payload[scope] = [
                    {
                        **_fix_mode_summary(mode),
                        "scope": scope,
                        "effective": catalog.is_effective(mode),
                    }
                    for mode in catalog.scoped(scope)
                ]
        else:
            payload["modes"] = [_fix_mode_summary(mode) for mode in effective]
        cli_json.emit(cli_json.success("fix-mode", **payload))
        return 0

    rows = (
        [(scope, mode) for scope, mode in scoped_modes(catalog)]
        if args.all_scopes
        else [(mode.source, mode) for mode in effective]
    )
    width = max(len(mode.id) for _, mode in rows)
    name_width = max(len(mode.name) for _, mode in rows)
    print(f"{'ID'.ljust(width)}  {'Name'.ljust(name_width)}  Kind          Source")
    for scope, mode in rows:
        note = "" if not args.all_scopes or catalog.is_effective(mode) else "  (overridden)"
        print(
            f"{mode.id.ljust(width)}  {mode.name.ljust(name_width)}  "
            f"{mode.execution_kind.ljust(12)}  {scope}{note}"
        )
    for issue in catalog.issues:
        print(f"WARN: {issue.scope} Fix Mode {issue.path}: {issue.message}", file=sys.stderr)
    print()
    print("Select one with: bugpilot bug <work item> --fix-mode <id>")
    return 0


def _fix_mode_show(args, store: FixModeStore, catalog: FixModeCatalog) -> int:
    mode_id = _require_mode_id(args, "show")
    mode = (
        store.read(args.scope, mode_id)
        if args.scope
        else catalog.effective_registry().resolve(mode_id)
    )
    if args.json_output:
        cli_json.emit(cli_json.success("fix-mode", mode=_fix_mode_definition(mode)))
        return 0
    for line in _fix_mode_show_lines(mode):
        print(line)
    return 0


def _fix_mode_duplicate(args, store: FixModeStore, catalog: FixModeCatalog) -> int:
    """Copy any mode into a writable scope. The way a custom mode starts."""
    source_id = _require_mode_id(args, "duplicate")
    if not args.new_id:
        raise FixModeError("bugpilot fix-mode duplicate needs a new id for the copy.")
    mode = store.duplicate(
        source_id,
        args.new_id,
        _require_write_scope(args),
        name=args.name,
        registry=catalog.effective_registry(),
    )
    return _fix_mode_written(args, mode, f"Duplicated {source_id} as {mode.id} ({mode.source}).")


def _fix_mode_create(args, store: FixModeStore, catalog: FixModeCatalog) -> int:
    mode_id = _require_mode_id(args, "create")
    mode = store.create(_require_write_scope(args), mode_id, _fix_mode_payload(args))
    return _fix_mode_written(args, mode, f"Created {mode.id} ({mode.source}).")


def _fix_mode_update(args, store: FixModeStore, catalog: FixModeCatalog) -> int:
    mode_id = _require_mode_id(args, "update")
    scope = _require_write_scope(args)
    # The concurrency guard is checked before the payload is even read: a save
    # that cannot be safe is not worth loading a file for, and "which version did
    # you last see" is the more useful thing to be told first.
    expected = _require_expected_version(args)
    mode = store.update(scope, mode_id, _fix_mode_payload(args), expected)
    return _fix_mode_written(args, mode, f"Updated {mode.id} to version {mode.version}.")


def _fix_mode_delete(args, store: FixModeStore, catalog: FixModeCatalog) -> int:
    mode_id = _require_mode_id(args, "delete")
    mode = store.delete(
        _require_write_scope(args), mode_id, _require_expected_version(args)
    )
    if args.json_output:
        cli_json.emit(cli_json.success("fix-mode", deleted=_fix_mode_summary(mode)))
        return 0
    print(f"Deleted {mode.id} ({mode.source}).")
    print("Prepared work items that recorded it will ask for another mode before regenerating.")
    return 0


def _fix_mode_written(args, mode: FixMode, message: str) -> int:
    if args.json_output:
        cli_json.emit(cli_json.success("fix-mode", mode=_fix_mode_definition(mode)))
        return 0
    print(message)
    return 0


def _require_mode_id(args, action: str) -> str:
    if not args.mode_id:
        raise FixModeError(f"bugpilot fix-mode {action} needs a mode id.")
    return args.mode_id


def _require_write_scope(args) -> str:
    """Which directory a mutation writes to, always stated rather than guessed.

    There is no default: `user` and `project` mean different things to a team,
    and choosing one silently would put a personal workflow in a repository or a
    team's in one developer's home directory.
    """
    if not args.scope:
        raise FixModeError("This command needs --scope user or --scope project.")
    return args.scope


def _require_expected_version(args) -> int:
    if args.expected_version is None:
        raise FixModeError(
            "This command needs --expected-version, the version you last saw. It is "
            "what stops one save from overwriting another."
        )
    return args.expected_version


def _fix_mode_payload(args) -> object:
    """The definition, read from a file rather than the command line.

    Six multiline sections do not belong in argv: a command line has a length
    limit, and quoting rules that differ per shell. A file has neither problem,
    and keeps the mode's text data rather than something a shell might read.
    """
    if not args.from_file:
        raise FixModeError("This command needs --from-file <json> with the mode definition.")
    path = Path(args.from_file)
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise FixModeError(f"{path} is not valid JSON: {exc}.") from exc
    except OSError as exc:
        raise FixModeError(f"{path} could not be read: {exc}.") from exc


def _fix_mode_show_lines(mode: FixMode) -> list[str]:
    """One mode in full, as a person reads it rather than as Python spells it."""
    lines = [
        f"{mode.name} ({mode.id})",
        "",
        mode.description,
        "",
        f"Version:        {mode.version}",
        f"Source:         {mode.source}",
        f"Execution kind: {mode.execution_kind}",
    ]
    if mode.based_on:
        lines.append(f"Based on:       {mode.based_on}")
        if mode.based_on_version is not None:
            lines.append(f"Based on version: {mode.based_on_version}")
    if mode.is_investigation:
        lines += [
            "",
            "This mode does not change source code in its first pass: it produces a",
            "diagnosis and a proposed fix plan, then asks before implementing.",
        ]
    headings = {
        "objective": "Objective",
        "investigation": "Investigation",
        "implementation": "Implementation",
        "verification": "Verification",
        "constraints": "Constraints",
        "completion": "Completion Requirements",
    }
    for name, text in mode.instruction_sections():
        lines += ["", headings.get(name, name.title()), "", f"  {text.strip()}"]
    return lines


def _build_bug_request(repo_root: Path, args) -> InvestigationRequest:
    """Turn `bugpilot bug` arguments into an InvestigationRequest.

    Exactly one input is required. Checked here rather than with an argparse
    mutually-exclusive group because the Jira side is a positional, and argparse
    words that combination badly.
    """
    description = args.description
    if args.description_file:
        path = Path(args.description_file)
        try:
            description = path.read_text(encoding="utf-8")
        except OSError as exc:
            raise ValueError(f"Could not read --description-file {path}: {exc}") from exc

    if args.issue_key and description:
        raise ValueError("Give either an issue key or a description, not both.")
    if not args.issue_key and not description:
        raise ValueError(
            "Nothing to investigate. Pass a Jira issue key (bugpilot bug JR-12345) "
            "or describe the bug (bugpilot bug --description \"...\")."
        )

    # Paired by position, so a count that does not match would describe the
    # wrong file: refused rather than guessed at.
    if args.attachment_descriptions and len(args.attachment_descriptions) != len(args.attachments):
        raise ValueError(
            "Give one --attach-description per --attach, in the same order "
            "(an empty one for a file without a description), or none at all."
        )
    options = InvestigationOptions(
        hint=args.hint,
        keywords=list(args.keywords),
        focus_files=list(args.focus_files),
        ignore_paths=list(args.ignore_paths),
        attachments=list(args.attachments),
        attachment_descriptions=list(args.attachment_descriptions),
        replace_attachments=bool(args.replace_attachments),
    )
    # A zero empties the results and a negative slices from the end; both look
    # like a broken search rather than a rejected argument.
    if args.max_files is not None:
        if args.max_files < 1:
            raise ValueError("--max-files must be at least 1.")
        options.max_files = args.max_files
    if args.max_search_lines is not None:
        if args.max_search_lines < 1:
            raise ValueError("--max-search-lines must be at least 1.")
        options.max_search_lines = args.max_search_lines
    options.git_history = _git_history_options(args)
    options.similar_fixes = _similar_fixes_options(args)

    plan = InvestigationPlan(
        code_search=not (args.skip_code_search or args.only_issue_details),
        git_history=not (args.skip_git_history or args.only_issue_details),
        similar_fixes=not (args.skip_similar_fixes or args.only_issue_details),
        build_context=not args.only_issue_details,
    )

    if description and getattr(args, "jira_comment", False):
        raise ValueError(
            "--jira-comment asks the agent to post to Jira, which a hand-written bug has no target for."
        )

    # The id only: core resolves it, once per run, so the CLI never becomes a
    # second place that knows which modes exist or which scope wins.
    fix_mode_id = getattr(args, "fix_mode", None)
    # Likewise the branch policy: argparse has checked it is one of the three.
    branch_policy = getattr(args, "branch_policy", None)

    if args.issue_key:
        request = workflow.jira_request(args.issue_key, options)
        request.plan = plan
        request.fix_mode_id = fix_mode_id
        request.branch_policy = branch_policy
        return request
    # repo_root makes the local id collision-safe: ids have one-second
    # granularity and a fresh run would wipe a same-second neighbour.
    spec = bug_spec_from_description(description, title=args.title, repo_root=repo_root)
    return InvestigationRequest(
        spec=spec, options=options, plan=plan, fix_mode_id=fix_mode_id, branch_policy=branch_policy
    )


def _bug_progress_printer(issue_key: str, resolved_steps: list[str] | None = None, source: str = "jira"):
    """Progress lines numbered over the steps this run will actually take.

    A partial plan or a manual bug runs fewer steps, and counting to a total that
    never arrives reads like the run stalled. With the default Jira plan the
    numbering is unchanged.
    """
    labels = {
        "doctor": "Checking environment...",
        "fetch": f"Fetching Jira issue {issue_key}...",
        "parse": "Parsing Jira details..." if source == "jira" else "Parsing bug details...",
        "keywords": "Extracting keywords...",
        "memory_search": "Searching memory...",
        "code_search": "Searching codebase...",
        "git_context": "Collecting git context...",
        "context": "Building bug context...",
        "prompt": "Generating agent task package...",
    }
    running = [step for step in labels if resolved_steps is None or step in resolved_steps]
    total = len(running)
    messages = {
        step: f"[{index}/{total}] {labels[step]}" for index, step in enumerate(running, start=1)
    }

    def print_progress(event: str) -> None:
        if event == "clean_start":
            print(f"Cleaning previous workflow artifacts for {issue_key}...")
        elif event == "clean_done":
            print(f"Cleaned previous workflow artifacts for {issue_key}.")
        elif event == "clean_none":
            print(f"No previous workflow artifacts found for {issue_key}.")
        elif event in messages:
            print(messages[event])

    return print_progress


def _print_key_generated_artifacts(repo_root: Path, issue_key: str) -> None:
    key_files = list(CORE_ARTIFACTS)
    existing = [f".ai/{issue_key}/{file_name}" for file_name in key_files if (repo_root / ".ai" / issue_key / file_name).exists()]
    if not existing:
        return
    print("Generated:")
    for file_name in existing:
        print(f"  {file_name}")


def _print_log_hint(repo_root: Path, issue_key: str) -> None:
    if (repo_root / ".ai" / issue_key / RUN_ARTIFACT).exists():
        print(f"Run: bugpilot status {issue_key} for step status.", file=sys.stderr)


def _auto_jira_comment_enabled(args) -> bool:
    if getattr(args, "no_jira_comment", False):
        return False
    if getattr(args, "jira_comment", False):
        return True
    return os.getenv("BUGPILOT_AUTO_JIRA_COMMENT", "").strip().lower() in {"1", "true", "yes", "on"}


def _post_jira_comment_auto(repo_root: Path, issue_key: str, quiet: bool = False) -> None:
    """Post the analysis summary as a Jira comment (best-effort, non-fatal).

    Runs right after the fix results are summarized so Jira notifies watchers by
    email before the developer decides whether to commit. A failure here never
    fails summarize-results.
    """
    try:
        workflow.jira_comment_draft_step(repo_root, issue_key, strict=False)
        result = workflow.jira_comment_step(repo_root, issue_key, execute=True)
    except (JiraCommentPostError, JiraFetchError) as exc:
        message = getattr(exc, "message", None) or getattr(getattr(exc, "result", None), "error_message", None) or str(exc)
        print(f"WARN: auto Jira comment not posted: {message}", file=sys.stderr)
        print("Post manually when ready:  bugpilot jira-comment-draft "
              f"{issue_key}  then  bugpilot jira-comment {issue_key} --execute", file=sys.stderr)
        return
    except (FileNotFoundError, ValueError) as exc:
        print(f"WARN: auto Jira comment not posted: {exc}", file=sys.stderr)
        return
    if not quiet:
        print(f"Posted Jira comment for {issue_key}. Jira will notify watchers by email.")
    print(f"  Comment ID: {result.get('comment_id') or '(not returned)'}")


def _notify_at_commit_gate(repo_root: Path, issue_key: str) -> None:
    """Send the notification email at the commit decision point (best-effort)."""
    try:
        result = workflow.notify_step(repo_root, issue_key, execute=True)
    except EmailSendError as exc:
        print(f"WARN: commit-gate email not sent: {exc}", file=sys.stderr)
        _print_email_env_hint()
        return
    _print_notify_result(result)


def _print_notify_result(result: dict) -> None:
    issue_key = result.get("issue_key")
    if result.get("draft_path"):
        print(f"Email draft: .ai/{issue_key}/email_draft.md")
    if result.get("eml_path"):
        print(f"Outlook-ready file: .ai/{issue_key}/notification.eml")
    if not result.get("execute"):
        print("Preview only. No email was sent.")
        print(f"  To send automatically:  bugpilot notify {issue_key} --execute   (needs SMTP or Graph configured)")
        print(f"  To send via Outlook:    .\\scripts\\send-via-outlook.ps1 {issue_key}")
        return
    if result.get("sent"):
        recipients = result.get("recipients") or ()
        print(f"Sent notification email via {result.get('transport', 'smtp')} to: {', '.join(recipients)}")
    else:
        print(f"WARN: email not sent. {result.get('skipped_reason', '')}".rstrip())
        _print_email_env_hint()


def _print_email_env_hint() -> None:
    print("To enable automatic email, configure one transport:", file=sys.stderr)
    print(
        "  Graph (recommended for Microsoft 365): GRAPH_TENANT_ID, GRAPH_CLIENT_ID, "
        "GRAPH_CLIENT_SECRET, BUGPILOT_EMAIL_FROM, BUGPILOT_EMAIL_TO.",
        file=sys.stderr,
    )
    print(
        "  SMTP: SMTP_HOST, BUGPILOT_EMAIL_FROM, BUGPILOT_EMAIL_TO "
        "(and SMTP_USERNAME/SMTP_PASSWORD if the relay needs auth).",
        file=sys.stderr,
    )
    print("Store secrets in a secrets manager; do not hardcode them.", file=sys.stderr)
    print("No transport configured? Send via Outlook: .\\scripts\\send-via-outlook.ps1 <ISSUE>", file=sys.stderr)


def _print_jira_error(exc: JiraFetchError) -> None:
    print(f"ERROR: {exc.result.error_message}", file=sys.stderr)
    print("Mock fallback is disabled by default.", file=sys.stderr)
    print("Use --allow-mock only for demo/testing fallback.", file=sys.stderr)
    print("No mock Jira artifacts were generated.", file=sys.stderr)


def _print_jira_validate_error(exc: JiraFetchError) -> None:
    print(f"ERROR: {exc.result.error_message}", file=sys.stderr)
    print("jira-validate requires real Jira credentials (JIRA_BASE_URL, JIRA_EMAIL, JIRA_TOKEN).", file=sys.stderr)
    print("No Jira artifacts were generated.", file=sys.stderr)


def _print_jira_validate_summary(issue_key: str, summary: dict) -> None:
    print(f"Jira validation: {issue_key}")
    print(f"  source: {summary.get('source', '')}")
    print(f"  issue type: {summary.get('issue_type', '') or '(not specified)'}")
    print(f"  status: {summary.get('status', '') or '(not specified)'}")
    print(f"  priority: {summary.get('priority', '') or '(not specified)'}")
    print(f"  comments: {summary.get('comment_count', 0)}")
    print(f"  attachments: {summary.get('attachment_count', 0)}")
    print(f"  description: {'yes' if summary.get('has_description') else 'no'}")
    print(f"  reproduction steps found: {'yes' if summary.get('has_reproduction_steps') else 'no'}")
    count = summary.get("missing_information_count", 0)
    print(f"  missing information: {count} item(s)")
    print(f"Generated: .ai/{issue_key}/{ISSUE_ARTIFACT}")
    print(f"Generated: .ai/{issue_key}/jira_field_report.md")


def _print_clean_result(result, include_memory: bool) -> None:
    if f".ai/{result.issue_key}/" in result.deleted_paths:
        print(f"Cleaned workflow artifacts for {result.issue_key}:")
        print(f"  deleted: .ai/{result.issue_key}/")
    else:
        print(f"No workflow artifacts found for {result.issue_key}.")

    memory_path = f".ai_memory/bugs/{result.issue_key}.md"
    if include_memory:
        if memory_path in result.deleted_paths:
            print(f"  deleted memory: {memory_path}")
        else:
            print(f"  memory not found: {memory_path}")
    else:
        print(f"Preserved memory entry: {memory_path}")


__all__ = [
    "build_context",
    "extract_keywords",
    "fetch_issue",
    "generate_task",
    "main",
    "parse_issue",
    "add_memory_entry",
    "search_memory",
]


if __name__ == "__main__":
    # `python -m bugpilot` is the documented form, but `python -m bugpilot.cli`
    # is the one people try when debugging an import problem — and without this
    # it printed nothing and exited 0, which reads as "it worked".
    raise SystemExit(main())
