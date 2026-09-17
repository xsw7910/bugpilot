"""Deterministic prepare-only workflow orchestration."""

from __future__ import annotations

import json
import os
import re
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from .cleanup import clean_issue_artifacts, validate_issue_key
from .config import WORKFLOW_STEPS, EmailConfig, GraphConfig, issue_dir, load_email_config, load_graph_config
from .email_notify import EmailSendError, EmailSendResult, build_email_draft, render_eml, send_notification, send_via_graph
from .context import build_context
from .delivery_instructions import delivery_instructions_block
from .doctor import collect_doctor_report
from .handoff import handoff_prompt
from .git_ops import current_branch, generate_git_context, inside_git_repo, run_command, working_tree_status
from .jira import JiraCommentPostError, JiraCommentPostResult, JiraFetchError, JiraFetchResult, enrich_issue, fetch_issue, jira_field_report_markdown, jira_summary_markdown, parse_issue, parsed_markdown, post_jira_comment, prepare_jira_comment_text, sanitize_comment_text
from .keywords import extract_keywords, keywords_json
from .logging_utils import log
from .identity import is_known_work_item_id
from .input_adapters import bug_spec_from_jira, load_bug_spec, manual_issue_payload, save_bug_spec
from .memory import add_memory_entry, build_memory_entry, search_memory
from .models import SOURCE_MANUAL, BugSpec, InvestigationOptions, InvestigationPlan, InvestigationRequest
from .attachments import ATTACHMENTS_DIR, attachment_names, copy_attachments
from .prompts import copilot_team_instructions, generate_copilot_task_files, generate_prompts
from .search import related_files_json, run_code_search, search_quality_json


@dataclass
class WorkflowResult:
    issue_key: str
    issue_dir: Path
    generated_files: list[str]
    jira_result: JiraFetchResult | None = None
    clean_result: object | None = None
    fresh: bool = False
    allow_mock: bool = False
    # Things that went differently than asked, but not badly enough to fail the
    # run. An attachment that could not be copied is the first: the developer
    # chose three files and got two, and the log is not where they will look.
    warnings: list[str] = field(default_factory=list)


# How many developer-supplied keywords are searched. One ripgrep invocation each,
# with a 20 second timeout apiece, so an unbounded list is an unbounded run —
# and every entry point now lets a person type this list by hand.
MAX_SUPPLIED_KEYWORDS = 20

REQUIRED_COPILOT_RESULT_FILES = [
    "bug_analysis.md",
    "fix_summary.md",
    "test_result.md",
    "diff_summary.md",
    "review_notes.md",
]


def _persist_resolved_spec(repo_root: Path, request: InvestigationRequest) -> None:
    """Store the spec once its title and description are actually known.

    For a Jira work item those arrive with ``parse_step``; a manual one already
    has them. Failing to persist must not fail the run — the spec is a
    convenience for later commands, not an input any step depends on (manual
    input is saved earlier, before anything reads it).
    """
    spec = request.spec
    try:
        if spec.source != SOURCE_MANUAL:
            parsed = _parsed_issue(repo_root, spec.work_item_id)
            # Through the input adapter, not a second copy of its field mapping.
            # Core re-implemented `summary`/`description` here while
            # `bug_spec_from_jira` sat unused — two mappings that would drift the
            # first time Jira renamed a field, and only one of them validated.
            # Identity stays with the request: the adapter's job here is the
            # content that only exists after parse_step ran.
            fetched = bug_spec_from_jira(parsed)
            spec = BugSpec(
                work_item_id=spec.work_item_id,
                source=spec.source,
                title=fetched.title,
                description=fetched.description,
                source_ref=spec.source_ref,
            )
        save_bug_spec(repo_root, spec)
    except Exception as exc:  # noqa: BLE001 - never break preparation over a cache file
        log(issue_dir(repo_root, spec.work_item_id), f"[WARN] bug_spec not saved: {exc}")


def _context_and_fold(repo_root: Path, work_item_id: str) -> None:
    """Build the context, then drop the files it folded in."""
    context_step(repo_root, work_item_id)
    _remove_intermediate_files(repo_root, work_item_id)


def refine_investigation(
    repo_root: Path,
    work_item_id: str,
    options: InvestigationOptions | None = None,
    plan: InvestigationPlan | None = None,
    progress: Callable[[str], None] | None = None,
) -> WorkflowResult:
    """Re-run the retrieval half of an existing investigation with new options.

    This is the "I have a new clue" path: a fresh hint or keyword arrives and the
    search, history and context should be rebuilt around it.

    It deliberately does **not** go through :func:`run_investigation`. That would
    pull ``fetch`` back in as a prerequisite of ``parse`` and re-hit Jira on every
    refinement — slow, and impossible offline. The issue data already sits in
    ``jira.json`` or ``bug_spec.json``, so refinement starts at ``keywords``.

    Which steps run still comes from an :class:`InvestigationPlan`, so a caller
    toggles capabilities here exactly as it does for a full run.
    """
    target = issue_dir(repo_root, work_item_id)
    if not target.exists():
        raise FileNotFoundError(
            f"No workflow package found for {work_item_id}. Run: bugpilot bug {work_item_id}"
        )
    options = options or InvestigationOptions()
    plan = plan or InvestigationPlan(issue_details=False)
    spec = load_bug_spec(repo_root, work_item_id)
    source = spec.source if spec else "jira"
    # `fetch`/`parse` are the point of the exercise: their output is already on
    # disk. `doctor` re-checks an environment this run already passed.
    resolved = set(plan.resolve_steps(source)) - {"fetch", "parse", "doctor"}

    # A dispatch table rather than a chain of ifs, so a step that ends up in
    # `resolved` with no handler raises instead of being silently skipped. That is
    # how `memory_add` was dropped from refinement, leaving the memory entry
    # describing the pre-refinement context.
    handlers: dict[str, Callable[[], None]] = {
        "keywords": lambda: keywords_step(repo_root, work_item_id, options),
        "memory_search": lambda: memory_search_step(repo_root, work_item_id),
        "code_search": lambda: code_search_step(repo_root, work_item_id, options),
        "git_context": lambda: git_context_step(repo_root, work_item_id),
        "context": lambda: _context_and_fold(repo_root, work_item_id),
        "prompt": lambda: prompt_step(repo_root, work_item_id),
        "memory_add": lambda: memory_add_step(repo_root, work_item_id),
    }
    unhandled = resolved - handlers.keys()
    if unhandled:
        raise ValueError(
            f"refine_investigation has no handler for {sorted(unhandled)}; "
            "add one or exclude the step explicitly."
        )

    log(target, f"[START] refine: {work_item_id}")
    if options.hint and options.hint.strip():
        (target / "developer_hint.md").write_text(options.hint.strip() + "\n", encoding="utf-8")
    # Refining takes the same options as a first run, so it takes attachments
    # too. Accepting them and copying nothing would be the quietest kind of
    # bug: the caller passed files and the agent never hears of them.
    attachment_warnings = [
        f"Attachment not added ({reason}): {source}"
        for source, reason in copy_attachments(target, options.attachments).skipped
    ]
    for warning in attachment_warnings:
        log(target, f"[WARN] {warning}")
    try:
        for step in WORKFLOW_STEPS:
            if step in resolved:
                _progress(progress, step)
                handlers[step]()
    except Exception as exc:
        log(target, f"[ERROR] refine: {exc}")
        log(target, "[END] refine: fail")
        raise

    generated = _generated_files(repo_root, work_item_id)
    log(target, "[END] refine: pass")
    return WorkflowResult(
        issue_key=work_item_id,
        issue_dir=target,
        generated_files=generated,
        warnings=attachment_warnings,
        fresh=False,
    )


def _parsed_issue(repo_root: Path, work_item_id: str) -> dict[str, object]:
    """The normalized issue dict every downstream step reads.

    Jira work items parse the fetched ``jira.json``; manual ones are shaped from
    their persisted ``BugSpec`` in memory. Keeping the manual path out of
    ``jira.json`` means that file is always real fetched data, never a synthetic
    stand-in. With no ``bug_spec.json`` present this behaves exactly as before,
    which is what keeps existing work item directories readable.
    """
    spec = load_bug_spec(repo_root, work_item_id)
    if spec is not None and spec.source == SOURCE_MANUAL:
        return parse_issue(manual_issue_payload(spec))
    return parse_issue(_read_json(issue_dir(repo_root, work_item_id) / "jira.json"))


def looks_like_issue_key(value: str) -> bool:
    """Deprecated alias for :func:`identity.is_known_work_item_id`.

    Answers "did the user type a work item id?", which is what ``memory search``
    needs. Accepts local ids as well as Jira keys — the old copy rejected local
    ids, so a local id fell through to free-text scoring.
    """
    return is_known_work_item_id(value.strip())


def jira_request(issue_key: str, options: InvestigationOptions | None = None) -> InvestigationRequest:
    """A request for a Jira work item whose content is not fetched yet.

    ``title``/``description`` stay empty here: they are only known after
    ``parse_step`` runs, at which point :func:`run_investigation` rewrites the
    persisted spec with the real values.
    """
    return InvestigationRequest(
        spec=BugSpec(work_item_id=issue_key, source="jira", title="", description="", source_ref=issue_key),
        options=options or InvestigationOptions(),
    )


def run_bug_workflow(
    repo_root: Path,
    issue_key: str,
    agent_fix: bool = False,
    fresh: bool = True,
    include_memory: bool = False,
    allow_mock: bool = False,
    progress: Callable[[str], None] | None = None,
    hint: str | None = None,
    jira_comment: bool = False,
) -> WorkflowResult:
    """Prepare a Jira work item. Thin wrapper over :func:`run_investigation`."""
    return run_investigation(
        repo_root,
        jira_request(issue_key),
        agent_fix=agent_fix,
        fresh=fresh,
        include_memory=include_memory,
        allow_mock=allow_mock,
        progress=progress,
        hint=hint,
        jira_comment=jira_comment,
    )


def run_investigation(
    repo_root: Path,
    request: InvestigationRequest,
    agent_fix: bool = False,
    fresh: bool = True,
    include_memory: bool = False,
    allow_mock: bool = False,
    progress: Callable[[str], None] | None = None,
    hint: str | None = None,
    jira_comment: bool = False,
) -> WorkflowResult:
    """Run the prepare pipeline for any work item, Jira-sourced or hand-written.

    Which steps run comes from ``request.plan``; core owns that expansion so the
    CLI, the MCP server and the extension cannot drift into different notions of
    what a partial run means.
    """
    issue_key = request.work_item_id
    resolved = set(request.resolved_steps())
    skipped = set(request.skipped_steps())
    jira_result = None
    clean_result = None
    if fresh:
        validate_issue_key(issue_key)
        _progress(progress, "clean_start")
        clean_result = clean_issue_artifacts(repo_root, issue_key, include_memory=include_memory)
        _progress(progress, "clean_done" if f".ai/{issue_key}/" in clean_result.deleted_paths else "clean_none")

    target = _prepare_issue_dir(repo_root, issue_key)
    # A developer hint steers the agent straight to the fix location. An explicit
    # --hint wins; otherwise a hint from a prior run is reused (survives --resume).
    hint_path = target / "developer_hint.md"
    # An explicit hint= wins, then the request's own options, then a hint left by
    # a previous run (so --resume keeps it).
    supplied_hint = hint if hint and hint.strip() else request.options.hint
    # errors="replace" like every other read of this file (`_read_artifact`): a
    # developer edits developer_hint.md by hand, and an editor that saves it as
    # cp1252 or GB2312 would otherwise abort the whole run with a decode error.
    effective_hint = (
        supplied_hint
        if supplied_hint and supplied_hint.strip()
        else (
            hint_path.read_text(encoding="utf-8", errors="replace")
            if not fresh and hint_path.exists()
            else None
        )
    )
    if effective_hint and effective_hint.strip():
        hint_path.write_text(effective_hint.strip() + "\n", encoding="utf-8")

    # Attachments are copied here, before any step runs, because the task file
    # written later has to name them — and it may only name the ones that
    # actually arrived. A file that could not be copied is reported, never
    # listed: telling an agent to read something that is not there is worse
    # than not offering it at all.
    attachment_result = copy_attachments(target, request.options.attachments)
    attachment_warnings = [
        f"Attachment not added ({reason}): {source}"
        for source, reason in attachment_result.skipped
    ]
    # The task file is what names an attachment, and the `prompt` step is what
    # writes the task file. A plan without it — `--only-issue-details` — copies
    # the files and tells nobody, which is the same silent loss this module
    # exists to prevent, arriving from the other direction.
    if attachment_result.copied and "prompt" not in resolved:
        attachment_warnings.append(
            f"{len(attachment_result.copied)} attachment(s) were copied to "
            f".ai/{issue_key}/{ATTACHMENTS_DIR}/, but this run writes no agent task "
            "file, so no agent will be told about them."
        )
    for warning in attachment_warnings:
        log(target, f"[WARN] {warning}")
    # Opt in to the pre-commit Jira status comment for this issue. Written once and
    # honored by prompt_step below; the marker survives --resume (fresh clears it).
    if jira_comment:
        _set_jira_comment_on(target)
    command = f"bugpilot bug {issue_key}"
    if not fresh:
        command += " --resume"
    if include_memory:
        command += " --include-memory"
    if allow_mock:
        command += " --allow-mock"
    if jira_comment:
        command += " --jira-comment"
    log(target, f"[START] command: {command}")
    log(target, f"[INFO] effective mode: fresh={str(fresh).lower()}, allow_mock={str(allow_mock).lower()}")
    if allow_mock:
        log(target, "[INFO] mock/demo Jira fallback enabled by --allow-mock")
    else:
        log(target, "[INFO] real Jira required")
        log(target, "[INFO] mock fallback disabled")
    if fresh:
        log(target, "[INFO] fresh run requested/defaulted")
        log(target, "[INFO] previous workflow artifacts were removed before this run")
        if include_memory:
            log(target, "[INFO] memory entry removed due to --include-memory")
        else:
            log(target, "[INFO] memory entry preserved")
        if clean_result:
            for path in clean_result.deleted_paths:
                log(target, f"[INFO] fresh deleted: {path}")
            for path in clean_result.preserved_paths:
                log(target, f"[INFO] fresh preserved: {path}")
            for path in clean_result.missing_paths:
                log(target, f"[INFO] fresh missing: {path}")
    else:
        log(target, "[INFO] resume requested")
        log(target, "[INFO] previous workflow artifacts were preserved")

    # A hand-written bug must be on disk before any step runs: _parsed_issue reads
    # it back in place of the jira.json a Jira work item would have.
    if request.spec.source == SOURCE_MANUAL:
        save_bug_spec(repo_root, request.spec)

    for step in request.skipped_steps():
        _mark_step(repo_root, issue_key, step, "skipped")
        log(target, f"[SKIP] {step}: not in investigation plan")

    try:
        _progress(progress, "doctor")
        log(target, "[START] doctor")
        doctor_report = collect_doctor_report(repo_root)
        log(target, f"doctor report: {doctor_report}")
        _mark_step(repo_root, issue_key, "doctor", "pass")
        log(target, "[END] doctor: pass")

        if "fetch" in resolved:
            _progress(progress, "fetch")
            jira_result = fetch_step(repo_root, issue_key, allow_mock=allow_mock)
        if "parse" in resolved:
            _progress(progress, "parse")
            parse_step(repo_root, issue_key)
            # Jira content is only known now; rewrite the spec so later commands
            # and `bugpilot list` see the real title instead of the empty stub.
            _persist_resolved_spec(repo_root, request)
        if "keywords" in resolved:
            _progress(progress, "keywords")
            keywords_step(repo_root, issue_key, request.options)
        if "memory_search" in resolved:
            _progress(progress, "memory_search")
            memory_search_step(repo_root, issue_key)
        if "code_search" in resolved:
            _progress(progress, "code_search")
            code_search_step(repo_root, issue_key, request.options)
        if "git_context" in resolved:
            _progress(progress, "git_context")
            git_context_step(repo_root, issue_key)
        if "context" in resolved:
            _progress(progress, "context")
            context_step(repo_root, issue_key)
            # memory_search.md and git_context.md are intermediate: their content
            # is folded into bug_context.md. Only drop them once that fold has
            # actually happened — without `context` they are the run's only output.
            _remove_intermediate_files(repo_root, issue_key)
        if "prompt" in resolved:
            _progress(progress, "prompt")
            prompt_step(repo_root, issue_key)
        if "memory_add" in resolved:
            memory_add_step(repo_root, issue_key)
    except Exception as exc:
        log(target, f"[ERROR] workflow: {exc}")
        _write_status(
            repo_root,
            issue_key,
            _read_step_status(repo_root, issue_key),
            _generated_files(repo_root, issue_key),
            fresh=fresh,
            allow_mock=allow_mock,
        )
        raise

    _mark_step(repo_root, issue_key, "agent_fix", "skipped")
    log(target, "[SKIP] agent_fix: prepare-only mode")
    if agent_fix:
        log(target, "[INFO] Agent automatic invocation is not enabled, using manual handoff")
        log(target, f"[INFO] Next agent instruction: {handoff_prompt(issue_key)}")
    generated = _generated_files(repo_root, issue_key)
    for file_name in generated:
        log(target, f"[GENERATED] {file_name}")
    log(target, "[END] workflow: pass")
    statuses: dict[str, str] = {}
    for step in WORKFLOW_STEPS:
        if step == "agent_fix":
            continue
        if step in resolved:
            statuses[step] = "pass"
        elif step in skipped:
            statuses[step] = "skipped"
    statuses["agent_fix"] = "skipped"
    _write_status(
        repo_root,
        issue_key,
        statuses,
        generated,
        fresh=fresh,
        allow_mock=allow_mock,
    )
    return WorkflowResult(
        issue_key=issue_key,
        issue_dir=target,
        generated_files=generated,
        warnings=attachment_warnings,
        jira_result=jira_result,
        clean_result=clean_result,
        fresh=fresh,
        allow_mock=allow_mock,
    )


def _progress(progress: Callable[[str], None] | None, event: str) -> None:
    if progress:
        progress(event)


# Intermediate artifacts whose content is folded into bug_context.md and are not
# kept in the final .ai/<issue>/ output.
_INTERMEDIATE_FILES = ("memory_search.md", "git_context.md")


def _remove_intermediate_files(repo_root: Path, issue_key: str) -> None:
    target = issue_dir(repo_root, issue_key)
    for file_name in _INTERMEDIATE_FILES:
        path = target / file_name
        if path.exists():
            path.unlink()
            log(target, f"[INFO] folded into bug_context.md and removed: .ai/{issue_key}/{file_name}")


def fetch_step(repo_root: Path, issue_key: str, allow_mock: bool = False) -> JiraFetchResult:
    target = _prepare_issue_dir(repo_root, issue_key)
    log(target, "[START] fetch")
    if allow_mock:
        log(target, "[INFO] mock/demo Jira fallback enabled by --allow-mock")
    else:
        log(target, "[INFO] real Jira required")
        log(target, "[INFO] mock fallback disabled")
    try:
        result = fetch_issue(repo_root, issue_key, allow_mock=allow_mock)
        issue = result.data
        enrich_issue(issue)
        message = _fetch_message(result)
        (target / "jira.json").write_text(json.dumps(issue, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        (target / "jira_summary.md").write_text(jira_summary_markdown(issue, message), encoding="utf-8")
        if result.source == "mock":
            log(target, f"[WARN] Jira fetch failed: {result.error_type} - {result.error_message}")
            log(target, "[WARN] Using mock/demo Jira data")
        else:
            log(target, message)
        _mark_step(repo_root, issue_key, "fetch", "pass")
        log(target, "[END] fetch: pass")
        return result
    except JiraFetchError as exc:
        _mark_step(repo_root, issue_key, "fetch", "fail")
        log(target, f"[ERROR] Jira fetch failed: {exc.result.error_type} - {exc.result.error_message}")
        log(target, "[ERROR] Mock fallback disabled")
        log(target, "[END] fetch: fail")
        raise
    except Exception as exc:
        _mark_step(repo_root, issue_key, "fetch", "fail")
        log(target, f"[ERROR] fetch: {exc}")
        raise


def jira_validate_step(repo_root: Path, issue_key: str) -> dict:
    """Fetch and validate a real Jira issue. No mock fallback.

    Writes jira.json, jira_summary.md, jira_parsed.md, jira_field_report.md.
    Returns a validation summary dict.
    """
    target = _prepare_issue_dir(repo_root, issue_key)
    log(target, "[START] jira_validate")
    try:
        result = fetch_issue(repo_root, issue_key, allow_mock=False)
        issue = result.data
        enrich_issue(issue)
        message = "Fetched Jira data from configured Jira instance."
        (target / "jira.json").write_text(json.dumps(issue, indent=2, sort_keys=True) + "\n", encoding="utf-8")
        (target / "jira_summary.md").write_text(jira_summary_markdown(issue, message), encoding="utf-8")
        parsed = parse_issue(issue)
        (target / "jira_parsed.md").write_text(parsed_markdown(parsed), encoding="utf-8")
        (target / "jira_field_report.md").write_text(jira_field_report_markdown(issue), encoding="utf-8")
        log(target, "[END] jira_validate: pass")
        return {
            "source": "jira",
            "issue_type": str(parsed.get("issue_type", "") or ""),
            "status": str(parsed.get("status", "") or ""),
            "priority": str(parsed.get("priority", "") or ""),
            "comment_count": int(parsed.get("comment_total", 0)),
            "attachment_count": len(parsed.get("attachments", []) or []),
            "has_description": bool(parsed.get("description")),
            "has_reproduction_steps": bool(parsed.get("reproduction_steps")),
            "missing_information_count": len(parsed.get("missing_information", []) or []),
        }
    except JiraFetchError as exc:
        log(target, f"[ERROR] jira_validate Jira fetch failed: {exc.result.error_type} - {exc.result.error_message}")
        log(target, "[END] jira_validate: fail")
        raise
    except Exception as exc:
        log(target, f"[ERROR] jira_validate: {exc}")
        raise


def parse_step(repo_root: Path, issue_key: str) -> None:
    target = _prepare_issue_dir(repo_root, issue_key)
    log(target, "[START] parse")
    try:
        parsed = _parsed_issue(repo_root, issue_key)
        (target / "jira_parsed.md").write_text(parsed_markdown(parsed), encoding="utf-8")
        _mark_step(repo_root, issue_key, "parse", "pass")
        log(target, "[END] parse: pass")
    except Exception as exc:
        _mark_step(repo_root, issue_key, "parse", "fail")
        log(target, f"[ERROR] parse: {exc}")
        raise


def keywords_step(repo_root: Path, issue_key: str, options: InvestigationOptions | None = None) -> None:
    target = _prepare_issue_dir(repo_root, issue_key)
    log(target, "[START] keywords")
    try:
        parsed = _parsed_issue(repo_root, issue_key)
        # Boost keywords found in stack traces / error messages — the richest
        # source of real class/function/file names.
        priority_parts: list[str] = []
        for field in ("stack_traces", "error_messages", "log_signals"):
            value = parsed.get(field)
            if isinstance(value, list):
                priority_parts.extend(str(item) for item in value)
            elif value:
                priority_parts.append(str(value))
        keywords = extract_keywords(
            str(parsed.get("combined_text", "")),
            priority_text="\n".join(priority_parts),
        )
        # Developer-supplied keywords lead: an explicit --keywords is a stronger
        # signal than anything mined from the bug text, and it is often the term
        # the report never spelled out.
        supplied = [word.strip() for word in (options.keywords if options else []) if word.strip()]
        # Capped, because every keyword is one ripgrep invocation with a 20 second
        # timeout of its own. The mined keywords are capped at five for the same
        # reason; a pasted list of sixty would spend twenty minutes searching and
        # then be abandoned by the caller's own timeout. What was dropped is
        # recorded rather than discarded silently.
        if len(supplied) > MAX_SUPPLIED_KEYWORDS:
            keywords["dropped_supplied_keywords"] = supplied[MAX_SUPPLIED_KEYWORDS:]
            log(
                target,
                f"[WARN] keywords: {len(supplied)} keywords supplied; searching the first "
                f"{MAX_SUPPLIED_KEYWORDS} and recording the rest as dropped.",
            )
            supplied = supplied[:MAX_SUPPLIED_KEYWORDS]
        if supplied:
            existing = [word for word in keywords.get("high_value_keywords", []) if word not in supplied]
            keywords["high_value_keywords"] = supplied + existing
        (target / "extracted_keywords.json").write_text(keywords_json(keywords), encoding="utf-8")
        _mark_step(repo_root, issue_key, "keywords", "pass")
        log(target, "[END] keywords: pass")
    except Exception as exc:
        _mark_step(repo_root, issue_key, "keywords", "fail")
        log(target, f"[ERROR] keywords: {exc}")
        raise


def memory_search_step(repo_root: Path, issue_key: str) -> None:
    target = _prepare_issue_dir(repo_root, issue_key)
    log(target, "[START] memory_search")
    try:
        search_memory(repo_root, issue_key)
        _mark_step(repo_root, issue_key, "memory_search", "pass")
        log(target, "[END] memory_search: pass")
    except Exception as exc:
        _mark_step(repo_root, issue_key, "memory_search", "fail")
        log(target, f"[ERROR] memory_search: {exc}")
        raise


def code_search_step(repo_root: Path, issue_key: str, options: InvestigationOptions | None = None) -> None:
    target = _prepare_issue_dir(repo_root, issue_key)
    log(target, "[START] code_search")
    try:
        keywords = _read_json(target / "extracted_keywords.json")
        markdown, related_files, search_quality = run_code_search(repo_root, issue_key, keywords, options)
        (target / "code_search.md").write_text(markdown, encoding="utf-8")
        (target / "related_files.json").write_text(related_files_json(related_files), encoding="utf-8")
        (target / "search_quality.json").write_text(search_quality_json(search_quality), encoding="utf-8")
        _mark_step(repo_root, issue_key, "code_search", "pass")
        log(target, "[END] code_search: pass")
    except Exception as exc:
        _mark_step(repo_root, issue_key, "code_search", "fail")
        log(target, f"[ERROR] code_search: {exc}")
        raise


def git_context_step(repo_root: Path, issue_key: str) -> None:
    target = _prepare_issue_dir(repo_root, issue_key)
    log(target, "[START] git_context")
    try:
        context = generate_git_context(repo_root, issue_key)
        (target / "git_context.md").write_text(context, encoding="utf-8")
        _mark_step(repo_root, issue_key, "git_context", "pass")
        log(target, "[END] git_context: pass")
    except Exception as exc:
        _mark_step(repo_root, issue_key, "git_context", "fail")
        log(target, f"[ERROR] git_context: {exc}")
        raise


def context_step(repo_root: Path, issue_key: str) -> None:
    target = _prepare_issue_dir(repo_root, issue_key)
    log(target, "[START] context")
    try:
        parsed = _parsed_issue(repo_root, issue_key)
        keywords = _read_json(target / "extracted_keywords.json")
        context = build_context(repo_root, issue_key, parsed, keywords)
        (target / "bug_context.md").write_text(context, encoding="utf-8")
        _mark_step(repo_root, issue_key, "context", "pass")
        log(target, "[END] context: pass")
    except Exception as exc:
        _mark_step(repo_root, issue_key, "context", "fail")
        log(target, f"[ERROR] context: {exc}")
        raise


def prompt_step(repo_root: Path, issue_key: str, jira_comment: bool = False) -> None:
    target = _prepare_issue_dir(repo_root, issue_key)
    if jira_comment:
        _set_jira_comment_on(target)
    log(target, "[START] prompt")
    try:
        summary = _issue_summary(target)
        hint = _read_artifact(target, "developer_hint.md") or None
        jira_comment = _jira_comment_enabled(target)
        attached = attachment_names(target)
        for file_name, content in generate_prompts(
            issue_key, summary, hint=hint, jira_comment=jira_comment, attachments=attached
        ).items():
            (target / file_name).write_text(content, encoding="utf-8")
        _mark_step(repo_root, issue_key, "prompt", "pass")
        log(target, "[END] prompt: pass")
    except Exception as exc:
        _mark_step(repo_root, issue_key, "prompt", "fail")
        log(target, f"[ERROR] prompt: {exc}")
        raise


def copilot_task_step(repo_root: Path, issue_key: str, jira_comment: bool = False) -> None:
    target = _prepare_issue_dir(repo_root, issue_key)
    bug_context = target / "bug_context.md"
    if not bug_context.exists():
        raise FileNotFoundError(f"Missing {bug_context}. Run: bugpilot {issue_key}")
    if jira_comment:
        _set_jira_comment_on(target)
    log(target, "[START] copilot_task")
    try:
        summary = _issue_summary(target)
        hint = _read_artifact(target, "developer_hint.md") or None
        jira_comment = _jira_comment_enabled(target)
        attached = attachment_names(target)
        for file_name, content in generate_copilot_task_files(
            issue_key, summary, hint=hint, jira_comment=jira_comment, attachments=attached
        ).items():
            (target / file_name).write_text(content, encoding="utf-8")
        log(target, "[END] copilot_task: pass")
    except Exception as exc:
        log(target, f"[ERROR] copilot_task: {exc}")
        raise


def copilot_instructions_step(repo_root: Path, issue_key: str) -> Path:
    target = _prepare_issue_dir(repo_root, issue_key)
    log(target, "[START] copilot_instructions")
    try:
        path = target / "agent_team_instructions.md"
        path.write_text(copilot_team_instructions(), encoding="utf-8")
        _mark_step(repo_root, issue_key, "agent_instructions", "pass")
        log(target, f"[GENERATED] .ai/{issue_key}/agent_team_instructions.md")
        log(target, "[END] copilot_instructions: pass")
        return path
    except Exception as exc:
        _mark_step(repo_root, issue_key, "agent_instructions", "fail")
        log(target, f"[ERROR] copilot_instructions: {exc}")
        raise


def check_result_files(repo_root: Path, issue_key: str) -> list[str]:
    target = issue_dir(repo_root, issue_key)
    return [
        f".ai/{issue_key}/{file_name}"
        for file_name in REQUIRED_COPILOT_RESULT_FILES
        if not (target / file_name).exists()
    ]


def check_results_step(repo_root: Path, issue_key: str, strict: bool = False) -> list[str]:
    target = _prepare_issue_dir(repo_root, issue_key)
    log(target, f"[START] check_results{' --strict' if strict else ''}")
    missing = check_result_files(repo_root, issue_key)
    if missing:
        log(target, f"[WARN] check_results: missing {len(missing)} agent result file(s).")
        for file_name in missing:
            log(target, f"[WARN] missing result file: {file_name}")
    else:
        log(target, "[END] check_results: pass")
    if missing:
        log(target, "[END] check_results: warn")
    return missing


def summarize_results_step(repo_root: Path, issue_key: str) -> None:
    target = _prepare_issue_dir(repo_root, issue_key)
    log(target, "[START] summarize_results")
    try:
        result_summary = _build_result_summary(repo_root, issue_key)
        manual_validation = _build_manual_validation(repo_root, issue_key)
        (target / "result_summary.md").write_text(result_summary, encoding="utf-8")
        (target / "manual_validation.md").write_text(manual_validation, encoding="utf-8")
        _mark_step(repo_root, issue_key, "result_summary", "pass")
        _mark_step(repo_root, issue_key, "manual_validation", "pass")
        log(target, f"[GENERATED] .ai/{issue_key}/result_summary.md")
        log(target, f"[GENERATED] .ai/{issue_key}/manual_validation.md")
        log(target, "[END] summarize_results: pass")
    except Exception as exc:
        _mark_step(repo_root, issue_key, "result_summary", "fail")
        _mark_step(repo_root, issue_key, "manual_validation", "fail")
        log(target, f"[ERROR] summarize_results: {exc}")
        raise


def review_package_step(repo_root: Path, issue_key: str) -> None:
    target = _prepare_issue_dir(repo_root, issue_key)
    log(target, "[START] review_package")
    try:
        (target / "final_review_prompt.md").write_text(_build_final_review_prompt(issue_key), encoding="utf-8")
        _mark_step(repo_root, issue_key, "final_review_prompt", "pass")
        log(target, f"[GENERATED] .ai/{issue_key}/final_review_prompt.md")
        log(target, "[END] review_package: pass")
    except Exception as exc:
        _mark_step(repo_root, issue_key, "final_review_prompt", "fail")
        log(target, f"[ERROR] review_package: {exc}")
        raise


def delivery_check_step(repo_root: Path, issue_key: str) -> list[str]:
    target = _prepare_issue_dir(repo_root, issue_key)
    log(target, "[START] delivery_check")
    warnings = _delivery_warnings(repo_root, issue_key)
    if warnings:
        for warning in warnings:
            log(target, f"[WARN] delivery_check: {warning}")
        _mark_step(repo_root, issue_key, "delivery_check", "fail")
        log(target, "[END] delivery_check: warn")
    else:
        _mark_step(repo_root, issue_key, "delivery_check", "pass")
        log(target, "[END] delivery_check: pass")
    return warnings


def commit_plan_step(repo_root: Path, issue_key: str) -> Path:
    target = _prepare_issue_dir(repo_root, issue_key)
    log(target, "[START] commit_plan")
    try:
        plan = _build_commit_plan(repo_root, issue_key)
        path = target / "commit_plan.md"
        path.write_text(plan, encoding="utf-8")
        _mark_step(repo_root, issue_key, "commit_plan", "pass")
        log(target, f"[GENERATED] .ai/{issue_key}/commit_plan.md")
        log(target, "[END] commit_plan: pass")
        return path
    except Exception as exc:
        _mark_step(repo_root, issue_key, "commit_plan", "fail")
        log(target, f"[ERROR] commit_plan: {exc}")
        raise


def push_plan_step(repo_root: Path, issue_key: str) -> Path:
    target = _prepare_issue_dir(repo_root, issue_key)
    log(target, "[START] push_plan")
    try:
        plan = _build_push_plan(repo_root, issue_key)
        path = target / "push_plan.md"
        path.write_text(plan, encoding="utf-8")
        _mark_step(repo_root, issue_key, "push_plan", "pass")
        log(target, f"[GENERATED] .ai/{issue_key}/push_plan.md")
        log(target, "[END] push_plan: pass")
        return path
    except Exception as exc:
        _mark_step(repo_root, issue_key, "push_plan", "fail")
        log(target, f"[ERROR] push_plan: {exc}")
        raise


def notify_step(
    repo_root: Path,
    issue_key: str,
    execute: bool = False,
    config: EmailConfig | None = None,
    graph_config: GraphConfig | None = None,
) -> dict[str, object]:
    """Build the post-fix notification email and, when execute is set, send it.

    A local preview (email_draft.md) and a portable notification.eml are always
    written. Sending is an explicit, opt-in outward action (mirrors jira-comment):
    it happens only when execute is True and a transport is configured. Microsoft
    Graph is preferred when configured (works when SMTP client auth / port 25 are
    blocked); otherwise SMTP is used.
    """
    target = _prepare_issue_dir(repo_root, issue_key)
    log(target, f"[START] notify {'execute' if execute else 'preview'}")
    try:
        email_config = config if config is not None else load_email_config()
        graph_config = graph_config if graph_config is not None else load_graph_config()
        draft = build_email_draft(repo_root, issue_key)
        draft_path = target / "email_draft.md"
        draft_path.write_text(f"Subject: {draft.subject}\n\n{draft.body}", encoding="utf-8")
        log(target, f"[GENERATED] .ai/{issue_key}/email_draft.md")

        eml_path = target / "notification.eml"
        eml_path.write_bytes(render_eml(draft, email_config.sender, email_config.recipients))
        log(target, f"[GENERATED] .ai/{issue_key}/notification.eml")

        if not execute:
            _mark_step(repo_root, issue_key, "notify", "skipped")
            log(target, "[INFO] notify preview only; no email was sent")
            log(target, "[END] notify: skipped")
            return {
                "issue_key": issue_key,
                "execute": False,
                "sent": False,
                "draft_path": draft_path,
                "eml_path": eml_path,
                "subject": draft.subject,
            }

        if graph_config.is_configured:
            transport = "graph"
            result = send_via_graph(graph_config, draft, email_config.sender, email_config.recipients)
        else:
            transport = "smtp"
            result = send_notification(email_config, draft)
        if result.sent:
            _mark_step(repo_root, issue_key, "notify", "pass")
            log(target, f"[INFO] notification email sent via {transport} to {len(result.recipients)} recipient(s)")
            log(target, "[END] notify: pass")
        else:
            _mark_step(repo_root, issue_key, "notify", "skipped")
            log(target, f"[WARN] notify skipped ({transport}): {result.skipped_reason}")
            log(target, "[END] notify: skipped")
        return {
            "issue_key": issue_key,
            "execute": True,
            "sent": result.sent,
            "transport": transport,
            "draft_path": draft_path,
            "eml_path": eml_path,
            "subject": draft.subject,
            "recipients": result.recipients,
            "skipped_reason": result.skipped_reason,
        }
    except EmailSendError as exc:
        _mark_step(repo_root, issue_key, "notify", "fail")
        log(target, f"[ERROR] notify: {exc}")
        log(target, "[END] notify: fail")
        raise
    except Exception as exc:
        _mark_step(repo_root, issue_key, "notify", "fail")
        log(target, f"[ERROR] notify: {exc}")
        log(target, "[END] notify: fail")
        raise


def memory_update_step(repo_root: Path, issue_key: str) -> bool:
    target = _prepare_issue_dir(repo_root, issue_key)
    log(target, "[START] memory_update")
    summary_path = target / "result_summary.md"
    memory_path = repo_root / ".ai_memory" / "bugs" / f"{issue_key}.md"
    if not summary_path.exists():
        log(target, f"[WARN] memory_update: missing .ai/{issue_key}/result_summary.md; run bugpilot summarize-results {issue_key}")
        _mark_step(repo_root, issue_key, "memory_update", "skipped")
        return False

    memory_path.parent.mkdir(parents=True, exist_ok=True)
    existing = memory_path.read_text(encoding="utf-8") if memory_path.exists() else f"# {issue_key} AI Bug Workflow Memory\n"
    final_result = _build_final_result_section(summary_path.read_text(encoding="utf-8"), bool(check_result_files(repo_root, issue_key)))
    updated = _replace_section(existing, "## Final Result", final_result)
    memory_path.write_text(updated, encoding="utf-8")
    _mark_step(repo_root, issue_key, "memory_update", "pass")
    log(target, f"[UPDATED] .ai_memory/bugs/{issue_key}.md")
    log(target, "[END] memory_update: pass")
    return True


def memory_add_step(repo_root: Path, issue_key: str) -> None:
    target = _prepare_issue_dir(repo_root, issue_key)
    log(target, "[START] memory_add")
    try:
        parsed = _parsed_issue(repo_root, issue_key)
        entry = build_memory_entry(issue_key, parsed, f".ai/{issue_key}/bug_context.md")
        # The shared memory file under .ai_memory/ is the source of truth; no local
        # per-issue copy is written to keep the .ai/<issue>/ output lean.
        add_memory_entry(repo_root, issue_key, entry)
        _mark_step(repo_root, issue_key, "memory_add", "pass")
        log(target, "[END] memory_add: pass")
    except Exception as exc:
        _mark_step(repo_root, issue_key, "memory_add", "fail")
        log(target, f"[ERROR] memory_add: {exc}")
        raise


def jira_comment_draft_step(repo_root: Path, issue_key: str, strict: bool = False) -> Path:
    target = issue_dir(repo_root, issue_key)
    if not target.exists():
        raise FileNotFoundError(f"No workflow package found for {issue_key}. Run: bugpilot bug {issue_key}")
    if not (target / "bug_context.md").exists() and not (target / "jira_parsed.md").exists():
        raise FileNotFoundError(f"No core context found for {issue_key}. Run: bugpilot bug {issue_key}")

    log(target, "[START] jira_comment_draft")
    missing = check_result_files(repo_root, issue_key)
    if strict and missing:
        for file_name in missing:
            log(target, f"[ERROR] jira_comment_draft missing required result file: {file_name}")
        _mark_step(repo_root, issue_key, "jira_comment_draft", "fail")
        log(target, "[END] jira_comment_draft: fail")
        raise ValueError("Missing required agent result files: " + ", ".join(missing))

    draft = _build_jira_comment_draft(repo_root, issue_key, missing)
    path = target / "jira_comment_draft.md"
    path.write_text(draft, encoding="utf-8")
    _mark_step(repo_root, issue_key, "jira_comment_draft", "pass")
    log(target, f"[GENERATED] .ai/{issue_key}/jira_comment_draft.md")
    log(target, "[END] jira_comment_draft: pass")
    return path


def jira_comment_step(repo_root: Path, issue_key: str, execute: bool = False) -> dict[str, object]:
    target = issue_dir(repo_root, issue_key)
    if not target.exists():
        raise FileNotFoundError(f"No workflow package found for {issue_key}. Run: bugpilot bug {issue_key}")
    draft_path = target / "jira_comment_draft.md"
    if not draft_path.exists():
        raise FileNotFoundError(f"Missing .ai/{issue_key}/jira_comment_draft.md. Run: bugpilot jira-comment-draft {issue_key}")

    mode = "execute" if execute else "preview"
    log(target, f"[START] jira_comment {mode}")
    try:
        comment_text = _prepared_jira_comment_text(draft_path, issue_key)
        if not execute:
            _mark_step(repo_root, issue_key, "jira_comment", "skipped")
            log(target, "[INFO] jira_comment preview only; no Jira POST was made")
            log(target, "[END] jira_comment: skipped")
            return {
                "issue_key": issue_key,
                "execute": False,
                "posted": False,
                "path": draft_path,
                "preview": _comment_preview(comment_text),
                "length": len(comment_text),
            }

        result = post_jira_comment(repo_root, issue_key, comment_text)
        result_json = _jira_comment_result_json(result)
        (target / "jira_comment_post_result.json").write_text(json.dumps(result_json, indent=2) + "\n", encoding="utf-8")
        (target / "jira_comment_post_summary.md").write_text(_jira_comment_post_summary(result), encoding="utf-8")
        _mark_step(repo_root, issue_key, "jira_comment", "pass")
        log(target, f"[GENERATED] .ai/{issue_key}/jira_comment_post_result.json")
        log(target, f"[GENERATED] .ai/{issue_key}/jira_comment_post_summary.md")
        log(target, "[END] jira_comment: pass")
        return {
            "issue_key": issue_key,
            "execute": True,
            "posted": True,
            "comment_id": result.comment_id,
            "timestamp": result.timestamp,
        }
    except Exception as exc:
        _mark_step(repo_root, issue_key, "jira_comment", "fail")
        log(target, f"[ERROR] jira_comment: {exc}")
        log(target, "[END] jira_comment: fail")
        raise


def retry_prompt_step(repo_root: Path, issue_key: str) -> dict[str, Path]:
    target = issue_dir(repo_root, issue_key)
    if not target.exists():
        raise FileNotFoundError(f"No workflow package found for {issue_key}. Run: bugpilot bug {issue_key}")
    log(target, "[START] retry_prompt")
    try:
        feedback_path = target / "user_feedback.md"
        created_feedback = False
        if not feedback_path.exists():
            feedback_path.write_text(_user_feedback_template(issue_key), encoding="utf-8")
            created_feedback = True
            log(target, f"[GENERATED] .ai/{issue_key}/user_feedback.md")
        prompt_path = target / "agent_retry_prompt.md"
        prompt_path.write_text(_build_retry_prompt(repo_root, issue_key), encoding="utf-8")
        _mark_step(repo_root, issue_key, "retry_prompt", "pass")
        log(target, f"[GENERATED] .ai/{issue_key}/agent_retry_prompt.md")
        log(target, "[END] retry_prompt: pass")
        result = {"prompt": prompt_path}
        if created_feedback:
            result["user_feedback"] = feedback_path
        return result
    except Exception as exc:
        _mark_step(repo_root, issue_key, "retry_prompt", "fail")
        log(target, f"[ERROR] retry_prompt: {exc}")
        log(target, "[END] retry_prompt: fail")
        raise


def manual_result_step(repo_root: Path, issue_key: str, overwrite: bool = False) -> dict[str, list[str]]:
    target = issue_dir(repo_root, issue_key)
    if not target.exists():
        raise FileNotFoundError(f"No workflow package found for {issue_key}. Run: bugpilot bug {issue_key}")
    log(target, "[START] manual_result")
    created: list[str] = []
    preserved: list[str] = []
    try:
        for file_name, content in _manual_result_templates(issue_key).items():
            path = target / file_name
            rel = f".ai/{issue_key}/{file_name}"
            if path.exists() and not overwrite:
                preserved.append(rel)
                log(target, f"[INFO] manual_result preserved existing file: {rel}")
                continue
            if path.exists() and overwrite:
                log(target, f"[WARN] manual_result overwriting existing file: {rel}")
            path.write_text(content, encoding="utf-8")
            created.append(rel)
            log(target, f"[GENERATED] {rel}")
        _mark_step(repo_root, issue_key, "manual_result", "pass")
        log(target, "[END] manual_result: pass")
        return {"created": created, "preserved": preserved}
    except Exception as exc:
        _mark_step(repo_root, issue_key, "manual_result", "fail")
        log(target, f"[ERROR] manual_result: {exc}")
        log(target, "[END] manual_result: fail")
        raise


def _prepare_issue_dir(repo_root: Path, issue_key: str) -> Path:
    target = issue_dir(repo_root, issue_key)
    target.mkdir(parents=True, exist_ok=True)
    return target


def _build_jira_comment_draft(repo_root: Path, issue_key: str, missing_results: list[str]) -> str:
    # Keep the comment short: root cause + a summary of the changes — not the full
    # diff or the internal search/validation/attachment detail.
    del missing_results  # strict-mode gating happens in the caller; not shown here
    target = issue_dir(repo_root, issue_key)
    root_cause = _artifact_or_missing(target, "bug_analysis.md", "No root cause analysis artifact found.")
    changes = _artifact_or_missing(target, "fix_summary.md", "No change summary artifact found.")
    draft = (
        "# bugpilot Analysis Summary\n\n"
        f"Issue: {issue_key}\n\n"
        "## Root Cause\n\n"
        f"{root_cause}\n\n"
        "## Summary of Changes\n\n"
        f"{changes}\n\n"
        "---\n"
        "Generated from local bugpilot artifacts; review before relying on it.\n"
    )
    return _cap_text(sanitize_comment_text(draft), 12000)


def _user_feedback_template(issue_key: str) -> str:
    return (
        f"# User Feedback: {issue_key}\n\n"
        "## Review of Previous Attempt\n\n"
        "Describe what did not work.\n\n"
        "## My Observations\n\n"
        "- ...\n\n"
        "## Required Next Attempt\n\n"
        "- ...\n\n"
        "## Do Not Do\n\n"
        "- Do not commit or push unless the developer explicitly approves after a delivery summary.\n"
        "- Do not update Jira.\n"
        "- Do not make broad unrelated refactors.\n"
        "- Do not claim tests passed unless they were run.\n"
    )


def _build_retry_prompt(repo_root: Path, issue_key: str) -> str:
    target = issue_dir(repo_root, issue_key)
    reading_files = [
        "bug_context.md",
        "code_search.md",
        "search_quality.json",
        "related_files.json",
        "git_context.md",
        "review_notes.md",
        "test_result.md",
        "diff_summary.md",
        "user_feedback.md",
    ]
    reading = [f"- .ai/{issue_key}/{name}" for name in reading_files if (target / name).exists()]
    if f"- .ai/{issue_key}/user_feedback.md" not in reading:
        reading.append(f"- .ai/{issue_key}/user_feedback.md")
    reading.append("- current git diff")
    feedback = _cap_text(_read_artifact(target, "user_feedback.md") or "No user feedback file found.", 3000)
    previous = _previous_attempt_summary(target)
    return (
        f"# Agent Retry Prompt: {issue_key}\n\n"
        "## Purpose\n\n"
        "The previous attempt did not fully resolve the issue, or the developer wants a second focused attempt.\n\n"
        "## Required Reading\n\n"
        f"{chr(10).join(reading)}\n\n"
        "## Developer Feedback\n\n"
        f"{feedback}\n\n"
        "## Previous Attempt Summary\n\n"
        f"{previous}\n\n"
        "## Retry Instructions\n\n"
        "- First explain why the previous attempt did not fully resolve the issue.\n"
        "- Re-check the implementation location.\n"
        "- Use user_feedback.md as the main correction for this retry.\n"
        "- If current git diff exists, review it before editing.\n"
        "- If the previous change is wrong, explain whether to revert or adjust it.\n"
        "- Do not make broad refactors.\n"
        "- Do not modify unrelated files.\n"
        "- Do not commit or push automatically.\n"
        "- Do not update Jira.\n"
        "- Do not claim tests passed unless they were run.\n"
        "- Update the required result files.\n\n"
        f"{delivery_instructions_block(issue_key, intro='After completing the retry and updating required result files')}"
        "## Required Output Files\n\n"
        f"- .ai/{issue_key}/bug_analysis.md\n"
        f"- .ai/{issue_key}/fix_summary.md\n"
        f"- .ai/{issue_key}/test_result.md\n"
        f"- .ai/{issue_key}/diff_summary.md\n"
        f"- .ai/{issue_key}/review_notes.md\n\n"
        "## How to Run\n\n"
        "Run your AI agent manually from the target repo root and paste:\n\n"
        f"Read .ai/{issue_key}/agent_retry_prompt.md and continue the workflow.\n"
    )


def _previous_attempt_summary(target: Path) -> str:
    lines = []
    for file_name in REQUIRED_COPILOT_RESULT_FILES:
        text = _read_artifact(target, file_name)
        if text:
            lines.append(f"### {file_name}\n\npresent\n\n{_cap_text(text, 800)}")
        else:
            lines.append(f"### {file_name}\n\nmissing")
    return "\n\n".join(lines)


def _manual_result_templates(issue_key: str) -> dict[str, str]:
    return {
        "bug_analysis.md": (
            f"# Bug Analysis: {issue_key}\n\n"
            "## Fix Source\n\n"
            "Developer manual fix.\n\n"
            "## Root Cause\n\n"
            "TODO: Describe the root cause.\n\n"
            "## Relevant Files\n\n"
            "- TODO\n\n"
            "## Notes\n\n"
            "TODO\n"
        ),
        "fix_summary.md": (
            f"# Fix Summary: {issue_key}\n\n"
            "## Fix Source\n\n"
            "Developer manual fix.\n\n"
            "## Changes Made\n\n"
            "- TODO\n\n"
            "## Scope\n\n"
            "Small targeted fix. No unrelated refactor.\n"
        ),
        "test_result.md": (
            f"# Test Result: {issue_key}\n\n"
            "## Fix Source\n\n"
            "Developer manual fix.\n\n"
            "## Commands Run\n\n"
            "```text\n"
            "TODO\n"
            "```\n\n"
            "## Result\n\n"
            "TODO: PASS / FAIL / PARTIAL / NOT RUN\n\n"
            "## Notes\n\n"
            "TODO\n\n"
            "Important: Do not claim tests passed unless they were run.\n"
        ),
        "diff_summary.md": (
            f"# Diff Summary: {issue_key}\n\n"
            "## Fix Source\n\n"
            "Developer manual fix.\n\n"
            "## Changed Files\n\n"
            "- TODO\n\n"
            "## Summary\n\n"
            "- TODO\n\n"
            "## Risk\n\n"
            "- TODO\n"
        ),
        "review_notes.md": (
            f"# Review Notes: {issue_key}\n\n"
            "## Fix Source\n\n"
            "Developer manual fix.\n\n"
            "## Review Focus\n\n"
            "- TODO\n\n"
            "## Known Limitations\n\n"
            "- TODO\n"
        ),
    }


def _prepared_jira_comment_text(draft_path: Path, issue_key: str) -> str:
    raw = draft_path.read_text(encoding="utf-8", errors="replace")
    _validate_comment_issue_key(raw, issue_key)
    prepared = prepare_jira_comment_text(raw)
    if not prepared:
        raise ValueError("Jira comment draft is empty.")
    return prepared


def _validate_comment_issue_key(comment_text: str, issue_key: str) -> None:
    match = re.search(r"(?im)^Issue:\s*(\S+)\s*$", comment_text)
    if match and match.group(1) != issue_key:
        raise ValueError(f"Jira comment draft issue key mismatch: found {match.group(1)}, expected {issue_key}.")


def _comment_preview(comment_text: str, limit: int = 800) -> str:
    compact = comment_text.strip()
    if len(compact) <= limit:
        return compact
    return compact[:limit].rstrip() + "\n\n[preview truncated by bugpilot]"


def _jira_comment_result_json(result: JiraCommentPostResult) -> dict[str, object]:
    return {
        "issue_key": result.issue_key,
        "posted": result.posted,
        "comment_id": result.comment_id,
        "created": result.created,
        "updated": result.updated,
        "self": result.self_url,
        "timestamp": result.timestamp,
    }


def _jira_comment_post_summary(result: JiraCommentPostResult) -> str:
    return (
        "# Jira Comment Post Summary\n\n"
        "## Issue\n\n"
        f"{result.issue_key}\n\n"
        "## Posted\n\n"
        f"{'yes' if result.posted else 'no'}\n\n"
        "## Comment ID\n\n"
        f"{result.comment_id or 'Not returned.'}\n\n"
        "## Timestamp\n\n"
        f"{result.timestamp}\n\n"
        "## Safety Note\n\n"
        "Only a Jira comment was added. bugpilot did not update Jira fields, transition status, assign the issue, upload attachments, download attachments, modify source code, commit, push, merge, create a PR, or invoke an agent.\n"
    )


def _artifact_or_missing(target: Path, file_name: str, missing_message: str) -> str:
    text = _read_artifact(target, file_name)
    return _cap_artifact(text) if text else missing_message


def _read_artifact(target: Path, file_name: str) -> str:
    path = target / file_name
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8", errors="replace").strip()


# Presence of this marker enables the "Report Status to Jira (before commit)"
# instruction in the generated agent_task.md / agent_handoff.md. The default is
# to omit that instruction; the marker is written once (by --jira-comment) and read
# back by prompt_step / copilot_task_step so the opt-in survives --resume and
# standalone regeneration.
_JIRA_COMMENT_ON_MARKER = "jira_comment_on.flag"


def _set_jira_comment_on(target: Path) -> None:
    (target / _JIRA_COMMENT_ON_MARKER).write_text("", encoding="utf-8")


def _jira_comment_enabled(target: Path) -> bool:
    return (target / _JIRA_COMMENT_ON_MARKER).exists()


def _cap_artifact(text: str) -> str:
    return _cap_text(text.strip(), 2000)


def _cap_text(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + "\n\n[truncated by bugpilot]"


def _read_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def _fetch_message(result: JiraFetchResult) -> str:
    if result.source == "mock":
        return f"{result.error_message} Using mock/demo Jira data."
    return "Fetched Jira data from configured Jira instance."


def _issue_summary(target: Path) -> str | None:
    # A manual work item has no jira.json; its title lives in the persisted spec.
    # Without this the branch name degrades to `feature/<id>-jira-workflow`.
    spec = load_bug_spec(target.parent.parent, target.name)
    if spec is not None and spec.source == SOURCE_MANUAL:
        return spec.title or None
    jira_path = target / "jira.json"
    if not jira_path.exists():
        return None
    try:
        issue = _read_json(jira_path)
    except Exception:
        return None
    fields = issue.get("fields", {}) if isinstance(issue.get("fields"), dict) else {}
    summary = fields.get("summary")
    if isinstance(summary, str) and summary.strip():
        return summary
    normalized = issue.get("bugpilot_normalized", {}) if isinstance(issue.get("bugpilot_normalized"), dict) else {}
    normalized_summary = normalized.get("summary")
    if isinstance(normalized_summary, str) and normalized_summary.strip():
        return normalized_summary
    return None


def _generated_files(repo_root: Path, issue_key: str) -> list[str]:
    target = issue_dir(repo_root, issue_key)
    generated = [
        f".ai/{issue_key}/{path.name}"
        for path in target.iterdir()
        if path.is_file()
    ]
    # One level into `attachments/`, because this listing was files-only and a
    # developer's screenshot would otherwise be absent from the status file and
    # from every view built on it.
    generated += [
        f".ai/{issue_key}/{ATTACHMENTS_DIR}/{name}" for name in attachment_names(target)
    ]
    memory_path = repo_root / ".ai_memory" / "bugs" / f"{issue_key}.md"
    if memory_path.exists():
        generated.append(f".ai_memory/bugs/{issue_key}.md")
    return sorted(generated)


def _write_status(
    repo_root: Path,
    issue_key: str,
    step_status: dict[str, str],
    generated: list[str],
    fresh: bool | None = None,
    allow_mock: bool | None = None,
) -> None:
    target = _prepare_issue_dir(repo_root, issue_key)
    status = {
        "issue_key": issue_key,
        "mode": "prepare-only",
        "steps": {step: step_status.get(step, "skipped") for step in WORKFLOW_STEPS},
        "generated_files": sorted(generated),
    }
    if fresh is not None:
        status["fresh"] = fresh
    if allow_mock is not None:
        status["allow_mock"] = allow_mock
    # Atomically, because this file is read from *other processes* while a run is
    # in progress: the VS Code extension restores its checklist from it and the
    # MCP server's get_status reads it. A torn read parses as nothing, which the
    # panel shows as "no progress" for a run that is going fine.
    _atomic_write_text(target / "workflow_status.json", json.dumps(status, indent=2) + "\n")


def _atomic_write_text(path: Path, text: str) -> None:
    """Write via a temp file and one rename, so a reader never sees half a file.

    The retry is for Windows: ``os.replace`` onto a path another process has open
    fails with ``PermissionError`` there, and the readers of this file are exactly
    that — an extension restoring its checklist, an MCP ``get_status`` call.
    Those reads last microseconds, so a couple of retries clear it.

    If it still fails, write in place rather than raising: a torn read costs one
    stale checklist, while a raised exception costs the whole step.
    """
    temp = path.with_name(path.name + f".tmp{os.getpid()}")
    temp.write_text(text, encoding="utf-8")
    for attempt in range(4):
        try:
            os.replace(temp, path)
            return
        except PermissionError:
            if attempt == 3:
                break
            time.sleep(0.05)
    try:
        path.write_text(text, encoding="utf-8")
    finally:
        temp.unlink(missing_ok=True)


def _mark_step(repo_root: Path, issue_key: str, step: str, status: str) -> None:
    status = _normalize_status(status)
    step_status = _read_step_status(repo_root, issue_key)
    step_status[step] = status
    generated = _generated_files(repo_root, issue_key)
    _write_status(repo_root, issue_key, step_status, generated)


def _read_step_status(repo_root: Path, issue_key: str) -> dict[str, str]:
    target = _prepare_issue_dir(repo_root, issue_key)
    status_path = target / "workflow_status.json"
    if not status_path.exists():
        return {}
    current = json.loads(status_path.read_text(encoding="utf-8"))
    steps = current.get("steps", {})
    if isinstance(steps, dict):
        return {name: _normalize_status(status) for name, status in steps.items()}
    return {item["name"]: _normalize_status(item["status"]) for item in steps}


def _normalize_status(status: str) -> str:
    if status in {"pass", "fail", "skipped"}:
        return status
    if status == "completed":
        return "pass"
    if status in {"manual-only", "not-run", "pending", "running"}:
        return "skipped"
    if status in {"exception", "error"}:
        return "fail"
    return "skipped"


def _build_result_summary(repo_root: Path, issue_key: str) -> str:
    target = issue_dir(repo_root, issue_key)
    status_lines = []
    sections = {}
    for file_name in REQUIRED_COPILOT_RESULT_FILES:
        path = target / file_name
        present = path.exists()
        status_lines.append(f"- {file_name}: {'present' if present else 'missing'}")
        sections[file_name] = path.read_text(encoding="utf-8", errors="replace").strip() if present else "TBD"
    all_present = all((target / file_name).exists() for file_name in REQUIRED_COPILOT_RESULT_FILES)
    next_step = (
        "All result files exist. Recommended next step: run final review."
        if all_present
        else "Some result files are missing. Recommended next step: complete the missing files."
    )
    return (
        "# Result Summary\n\n"
        "## Issue\n"
        f"{issue_key}\n\n"
        "## Result File Status\n"
        + "\n".join(status_lines)
        + "\n\n"
        "## Root Cause Summary\n"
        f"{sections['bug_analysis.md']}\n\n"
        "## Fix Summary\n"
        f"{sections['fix_summary.md']}\n\n"
        "## Test Summary\n"
        f"{sections['test_result.md']}\n\n"
        "## Diff Summary\n"
        f"{sections['diff_summary.md']}\n\n"
        "## Review Notes\n"
        f"{sections['review_notes.md']}\n\n"
        "## Next Step\n"
        f"{next_step}\n"
    )


def _build_manual_validation(repo_root: Path, issue_key: str) -> str:
    target = issue_dir(repo_root, issue_key)
    related = _read_json_default(target / "related_files.json", [])
    review_notes = (target / "review_notes.md").read_text(encoding="utf-8", errors="replace").strip() if (target / "review_notes.md").exists() else ""
    related_lines = []
    if isinstance(related, list) and related:
        for item in related[:10]:
            if isinstance(item, dict) and item.get("file"):
                related_lines.append(f"- {item['file']}")
    if review_notes:
        related_lines.append("- Risks from review_notes.md:")
        related_lines.extend(f"  {line}" for line in review_notes.splitlines() if line.strip())
    return (
        "# Manual Validation\n\n"
        "## Issue\n"
        f"{issue_key}\n\n"
        "## Original Context\n"
        "Reference:\n"
        f".ai/{issue_key}/bug_context.md\n\n"
        "## Suggested Validation Steps\n"
        "1. Reproduce the original issue if possible.\n"
        "2. Confirm the failure no longer occurs.\n"
        "3. Confirm the fix does not change unrelated behavior.\n"
        "4. Run focused tests listed in test_result.md if present.\n"
        "5. Check regression areas mentioned in bug_context.md and code_search.md.\n\n"
        "## Regression Areas\n"
        f"{chr(10).join(related_lines) if related_lines else '- No related files or review risks available yet.'}\n"
    )


def _build_final_review_prompt(issue_key: str) -> str:
    return (
        "# Final Review Request\n\n"
        f"Please review the completed fix for Jira issue {issue_key}.\n\n"
        "Use:\n"
        f"- .ai/{issue_key}/bug_context.md\n"
        f"- .ai/{issue_key}/code_search.md if present\n"
        f"- .ai/{issue_key}/result_summary.md if present\n"
        "- current git diff\n\n"
        "Review focus:\n"
        "1. Correctness\n"
        "2. Regression risk\n"
        "3. Whether the fix matches the Jira issue\n"
        "4. Whether the fix is minimal and safe\n"
        "5. Whether tests are sufficient\n"
        "6. Whether memory entry should be updated\n"
        "7. Any follow-up work\n\n"
        "Expected output:\n"
        "Verdict:\n"
        "PASS / PASS WITH MINOR COMMENTS / NEEDS CHANGES\n\n"
        "Blocking issues:\n"
        "Non-blocking suggestions:\n"
        "Test concerns:\n"
        "Memory update suggestions:\n"
        "Recommended next step:\n"
    )


def _build_final_result_section(result_summary: str, incomplete: bool) -> str:
    marker = "\n\nResult files incomplete. Manual update required." if incomplete else ""
    return (
        "## Final Result\n\n"
        "### Root Cause\n"
        f"{_section(result_summary, '## Root Cause Summary')}\n\n"
        "### Fix\n"
        f"{_section(result_summary, '## Fix Summary')}\n\n"
        "### Tests\n"
        f"{_section(result_summary, '## Test Summary')}\n\n"
        "### Review Notes\n"
        f"{_section(result_summary, '## Review Notes')}{marker}\n\n"
        "### Updated At\n"
        f"{datetime.now(timezone.utc).isoformat()}\n"
    )


def _section(markdown: str, heading: str) -> str:
    lines = markdown.splitlines()
    try:
        start = lines.index(heading) + 1
    except ValueError:
        return "TBD"
    collected = []
    for line in lines[start:]:
        if line.startswith("## ") and collected:
            break
        collected.append(line)
    text = "\n".join(collected).strip()
    return text or "TBD"


def _replace_section(markdown: str, heading: str, replacement: str) -> str:
    start = markdown.find(heading)
    if start == -1:
        return markdown.rstrip() + "\n\n" + replacement
    next_start = markdown.find("\n## ", start + len(heading))
    if next_start == -1:
        return markdown[:start].rstrip() + "\n\n" + replacement
    return markdown[:start].rstrip() + "\n\n" + replacement.rstrip() + "\n" + markdown[next_start:]


def _read_json_default(path: Path, default: object) -> object:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return default


def _delivery_warnings(repo_root: Path, issue_key: str) -> list[str]:
    warnings = []
    if not inside_git_repo(repo_root):
        warnings.append("Current directory is not inside a git repository.")
    branch = current_branch(repo_root)
    if not branch:
        warnings.append("Current branch is unavailable.")
    elif branch in {"main", "master"}:
        warnings.append(f"Current branch is {branch}; do not deliver directly from main/master.")
    status = working_tree_status(repo_root)
    if status in {None, "clean"}:
        warnings.append("Working tree has no uncommitted changes visible for delivery.")

    warnings.extend(f"Missing required result file: {file_name}" for file_name in check_result_files(repo_root, issue_key))
    for file_name in [
        f".ai/{issue_key}/result_summary.md",
        f".ai/{issue_key}/final_review_prompt.md",
        f".ai_memory/bugs/{issue_key}.md",
    ]:
        if not (repo_root / file_name).exists():
            warnings.append(f"Missing delivery artifact: {file_name}")
    return warnings


def _build_commit_plan(repo_root: Path, issue_key: str) -> str:
    branch = _git_output(repo_root, ["git", "branch", "--show-current"], "unknown")
    status = _git_output(repo_root, ["git", "status", "--porcelain"], "_No status available._")
    changed_files = _git_output(repo_root, ["git", "diff", "--name-only"], "_No git diff files found._")
    diff_stat = _git_output(repo_root, ["git", "diff", "--stat"], "_No diff stat available._")
    short_summary = _result_summary_line(repo_root, issue_key)
    return (
        "# Commit Plan\n\n"
        "## Issue\n"
        f"{issue_key}\n\n"
        "## Current Branch\n"
        f"{branch}\n\n"
        "## Working Tree Status\n"
        "```text\n"
        f"{status or 'clean'}\n"
        "```\n\n"
        "## Changed Files\n"
        "```text\n"
        f"{changed_files}\n"
        "```\n\n"
        "## Diff Stat\n"
        "```text\n"
        f"{diff_stat}\n"
        "```\n\n"
        "## Suggested Commit Message\n"
        f"Fix {issue_key}: {short_summary}\n\n"
        "## Suggested Commit Body\n"
        "- Root cause:\n"
        "- Fix:\n"
        "- Tests:\n"
        "- Risk:\n\n"
        "## Safety Notes\n"
        "- Confirm branch is not main/master.\n"
        "- Confirm result files are complete.\n"
        "- Confirm tests are complete.\n\n"
        "## Manual Commands\n"
        "```bash\n"
        "git status\n"
        "git add <files>\n"
        f"git commit -m \"Fix {issue_key}: {short_summary}\"\n"
        "```\n"
    )


def _build_push_plan(repo_root: Path, issue_key: str) -> str:
    branch = _git_output(repo_root, ["git", "branch", "--show-current"], "unknown")
    remote = _git_output(repo_root, ["git", "remote", "-v"], "_No remotes configured._")
    recent = _git_output(repo_root, ["git", "log", "--oneline", "-n", "5"], "_No recent commits available._")
    status = _git_output(repo_root, ["git", "status", "--porcelain"], "_No status available._")
    return (
        "# Push Plan\n\n"
        "## Issue\n"
        f"{issue_key}\n\n"
        "## Current Branch\n"
        f"{branch}\n\n"
        "## Remote\n"
        "```text\n"
        f"{remote}\n"
        "```\n\n"
        "## Working Tree Status\n"
        "```text\n"
        f"{status or 'clean'}\n"
        "```\n\n"
        "## Recent Commits\n"
        "```text\n"
        f"{recent}\n"
        "```\n\n"
        "## Safety Checklist\n"
        "- Not on main/master\n"
        "- Result files complete\n"
        "- Review package generated\n"
        "- Memory updated\n\n"
        "## Manual Push Command\n"
        "```bash\n"
        f"git push -u origin {branch or '<current-branch>'}\n"
        "```\n"
    )


def _git_output(repo_root: Path, args: list[str], fallback: str) -> str:
    code, output = run_command(args, repo_root)
    if code != 0:
        return fallback
    cleaned = "\n".join(
        line for line in output.splitlines()
        if not line.startswith("warning:")
    ).strip()
    return cleaned or fallback


def _result_summary_line(repo_root: Path, issue_key: str) -> str:
    path = issue_dir(repo_root, issue_key) / "result_summary.md"
    if not path.exists():
        return "complete AI-assisted bug fix"
    fix = _section(path.read_text(encoding="utf-8", errors="replace"), "## Fix Summary")
    first_line = next((line.strip("- ").strip() for line in fix.splitlines() if line.strip() and line.strip() != "TBD"), "")
    return first_line[:72] or "complete AI-assisted bug fix"
