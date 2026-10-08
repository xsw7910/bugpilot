"""Deterministic prepare-only workflow orchestration."""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass, field, replace
from datetime import datetime, timezone
from pathlib import Path

from .artifact_io import atomic_write_text
from .cleanup import clean_issue_artifacts, validate_issue_key
from .config import WORKFLOW_STEPS, EmailConfig, GraphConfig, issue_dir, load_email_config, load_graph_config
from .email_notify import EmailSendError, EmailSendResult, build_email_draft, render_eml, send_notification, send_via_graph
from .context import build_context
from .branch_policy import (
    PROTECTED_BRANCHES,
    records_branch_name,
    resolve_branch_policy,
    retry_branch_section,
)
from .delivery_instructions import delivery_instructions_block, delivery_safety_block
from .doctor import collect_doctor_report
from .handoff import handoff_prompt
from .git_history import (
    RANKED_HISTORY_FILES,
    GitHistoryOutcome,
    GitHistoryQuery,
    collect_git_history,
    focus_files_from_retrieval,
    select_extracted_terms,
)
from .git_ops import branch_name, current_branch, inside_git_repo, run_command, working_tree_status
from .jira import JiraCommentPostError, JiraCommentPostResult, JiraFetchError, JiraFetchResult, enrich_issue, fetch_issue, jira_field_report_markdown, post_jira_comment, prepare_jira_comment_text, sanitize_comment_text
from .keywords import extract_keywords
from .logging_utils import log
from .identity import is_jira_issue_key, is_known_work_item_id, validate_work_item_id
from .issue import (
    IssueArtifact,
    IssueGuidance,
    issue_from_jira,
    issue_from_spec,
    jira_stub,
    load_issue,
    read_issue_quietly,
    save_issue,
)
from .memory import add_memory_entry, build_memory_entry, search_memory
from .models import (
    SOURCE_MANUAL,
    BugSpec,
    GitHistoryOptions,
    InvestigationOptions,
    InvestigationPlan,
    InvestigationRequest,
    SimilarFixesOptions,
    effective_plan,
)
from .artifacts import (
    CONTEXT_ARTIFACT,
    FIX_REPORT_ARTIFACT,
    ISSUE_ARTIFACT,
    RETRIEVAL_ARTIFACT,
    TASK_ARTIFACT,
    WorkItemNotFoundError,
)
from .fix_report import FixReport, manual_fix_report_template, read_fix_report
from .run import RunArtifact, RunError, load_run, read_run_quietly, save_run
from .attachments import (
    ATTACHMENTS_DIR,
    AttachmentResult,
    attachment_names,
    copy_attachments,
    listed_attachments,
    merge_attachment_notes,
    remove_attachments,
)
from .fix_mode_state import (
    persist_fix_mode,
    select_fix_mode,
    stored_fix_mode_metadata,
)
from .fix_modes import FixMode
from .prompts import (
    copilot_team_instructions,
    generate_task,
    investigation_handoff_block,
)
from .repository_profile import RepositoryContext, resolve_repository_context
from .retrieval import RetrievalArtifact, read_retrieval_quietly, save_retrieval
from .search import run_code_search


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
    # The mode this run prepared the package under. Carried on the result so an
    # entry point can report it without re-reading the selection file it just
    # wrote — and so a caller cannot report a different mode than ran.
    fix_mode: FixMode | None = None


# How many developer-supplied keywords are searched. One ripgrep invocation each,
# with a 20 second timeout apiece, so an unbounded list is an unbounded run —
# and every entry point now lets a person type this list by hand.
MAX_SUPPLIED_KEYWORDS = 20

# What the agent must leave behind: one report (plan §37, Batch 5). The name
# and shape are the extension's `RESULT_FILES` mirror and the tests' contract.
REQUIRED_COPILOT_RESULT_FILES = [
    FIX_REPORT_ARTIFACT,
]


@dataclass
class _RetrievalState:
    """What refinement's investigation steps hand to the steps after them."""

    keywords: dict[str, object] | None = None
    retrieval: RetrievalArtifact | None = None
    similar_fixes: str | None = None
    git_history: GitHistoryOutcome | None = None


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
    refinement — slow, and impossible offline. The normalized issue already sits
    in ``issue.json``, so refinement starts at ``keywords``.

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
    issue = _require_issue(repo_root, work_item_id)
    # `fetch`/`parse` are the point of the exercise: their output is already on
    # disk. `doctor` re-checks an environment this run already passed.
    # Through `effective_plan`, as a full run is: Git History with both of its
    # search routes off is skipped, not run to an empty section.
    resolved = set(effective_plan(plan, options).resolve_steps(issue.source)) - {"fetch", "parse", "doctor"}

    # A new hint replaces the recorded one before anything reads it, so the task
    # file regenerated below carries the hint this refinement was asked for.
    if options.hint and options.hint.strip():
        issue = issue.with_guidance(replace(issue.guidance, hint=options.hint.strip()))
        save_issue(repo_root, issue)
    # And the search uses the same hint the task file will carry: the new one,
    # else the one issue.json records. Searching without the recorded hint
    # while the regenerated task still named it was the Batch 1 finding (§37.5).
    hint = _effective_hint(options.hint, issue.guidance.hint)
    search_options = replace(options, hint=hint) if hint else options
    # What the retrieval steps produce, handed to the steps after them in memory.
    found = _RetrievalState()

    def extract() -> None:
        found.keywords = keywords_step(repo_root, work_item_id, search_options, issue=issue)

    def search() -> None:
        found.retrieval = code_search_step(repo_root, work_item_id, search_options, keywords=found.keywords)

    def similar() -> None:
        found.similar_fixes = memory_search_step(
            repo_root, work_item_id, keywords=found.keywords, options=search_options
        )

    def history() -> None:
        found.git_history = git_context_step(
            repo_root,
            work_item_id,
            retrieval=found.retrieval,
            issue=issue,
            keywords=found.keywords,
            options=search_options,
        )

    # A dispatch table rather than a chain of ifs, so a step that ends up in
    # `resolved` with no handler raises instead of being silently skipped. That is
    # how `memory_add` was dropped from refinement, leaving the memory entry
    # describing the pre-refinement context.
    # The mode the task file is regenerated under: the persisted selection,
    # resolved once here and handed to prompt_step, exactly as run_investigation
    # does — so the result reports the mode that actually ran rather than
    # leaving a caller to re-read the selection. Resolved only when the prompt
    # step will run, since that is the only step that needs it and an
    # unresolvable selection should fail that step, not a refinement that never
    # touches the task file.
    mode = _selected_fix_mode(repo_root, work_item_id) if "prompt" in resolved else None
    handlers: dict[str, Callable[[], None]] = {
        "keywords": extract,
        "memory_search": similar,
        "code_search": search,
        "git_context": history,
        "context": lambda: context_step(
            repo_root,
            work_item_id,
            issue=issue,
            keywords=found.keywords,
            retrieval=found.retrieval,
            git_history=found.git_history,
            similar_fixes=found.similar_fixes,
        ),
        "prompt": lambda: prompt_step(repo_root, work_item_id, fix_mode=mode, issue=issue),
        "memory_add": lambda: memory_add_step(repo_root, work_item_id, issue=issue),
    }
    unhandled = resolved - handlers.keys()
    if unhandled:
        raise ValueError(
            f"refine_investigation has no handler for {sorted(unhandled)}; "
            "add one or exclude the step explicitly."
        )

    log(target, f"[START] refine: {work_item_id}")
    _set_run_status(repo_root, work_item_id, "running")
    # Refining takes the same options as a first run, so it takes attachments
    # too. Accepting them and copying nothing would be the quietest kind of
    # bug: the caller passed files and the agent never hears of them.
    copied = copy_attachments(target, options.attachments, options.attachment_descriptions)
    attachment_warnings = [
        f"Attachment not added ({reason}): {source}" for source, reason in copied.skipped
    ]
    for warning in attachment_warnings:
        log(target, f"[WARN] {warning}")
    # What the work item now has, and why each file matters, go where the hint
    # is recorded, so the regenerated task file names exactly them; `prompt`
    # reads `issue` when it runs, after this.
    if copied.copied or options.replace_attachments:
        issue = issue.with_guidance(
            _attachment_guidance(target, issue.guidance, copied, exact=options.replace_attachments)
        )
        save_issue(repo_root, issue)
    failing: str | None = None
    try:
        for step in WORKFLOW_STEPS:
            if step in resolved:
                failing = step
                _progress(progress, step)
                handlers[step]()
    except Exception as exc:
        log(target, f"[ERROR] refine: {exc}")
        log(target, "[END] refine: fail")
        # Named explicitly: a refine keeps the marks of earlier runs, so scanning
        # them could blame a step an old failure marked, not this one.
        _fail_run(repo_root, work_item_id, exc, step=failing)
        raise

    generated = _generated_files(repo_root, work_item_id)
    log(target, "[END] refine: pass")
    _set_run_status(repo_root, work_item_id, "prepared")
    return WorkflowResult(
        issue_key=work_item_id,
        issue_dir=target,
        generated_files=generated,
        warnings=attachment_warnings,
        fresh=False,
        fix_mode=mode,
    )


def looks_like_issue_key(value: str) -> bool:
    """Deprecated alias for :func:`identity.is_known_work_item_id`.

    Answers "did the user type a work item id?", which is what ``memory search``
    needs. Accepts local ids as well as Jira keys — the old copy rejected local
    ids, so a local id fell through to free-text scoring.
    """
    return is_known_work_item_id(value.strip())


def jira_request(issue_key: str, options: InvestigationOptions | None = None) -> InvestigationRequest:
    """A request for a Jira work item whose content is not fetched yet.

    ``title``/``description`` stay empty here: they are only known once
    ``fetch_step`` has normalized the fetched issue into ``issue.json``.
    """
    return InvestigationRequest(
        spec=BugSpec(work_item_id=issue_key, source="jira", title="", description="", source_ref=issue_key),
        options=options or InvestigationOptions(),
    )


def run_bug_workflow(
    repo_root: Path,
    issue_key: str,
    agent_fix: bool = False,
    fresh: bool = False,
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
    fresh: bool = False,
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

    Non-destructive unless asked: ``fresh=True`` is the only way a preparation
    deletes ``.ai/<id>/`` first, and every entry point has to say so.
    """
    issue_key = request.work_item_id
    resolved = set(request.resolved_steps())
    skipped = set(request.skipped_steps())
    jira_result = None
    clean_result = None
    # Resolved before anything is deleted, and before the persisted selection is
    # read: a fresh run is about to discard the package that recorded a mode, so
    # only an explicit choice can apply to it, and a mistyped one must cost the
    # developer nothing.
    selection = select_fix_mode(
        repo_root, issue_key, request.fix_mode_id, use_persisted=not fresh
    )
    if fresh:
        validate_issue_key(issue_key)
        _progress(progress, "clean_start")
        clean_result = clean_issue_artifacts(repo_root, issue_key, include_memory=include_memory)
        _progress(progress, "clean_done" if f".ai/{issue_key}/" in clean_result.deleted_paths else "clean_none")

    target = _prepare_issue_dir(repo_root, issue_key)
    # What an earlier run recorded, for --resume. A fresh run has just deleted it.
    previous = None if fresh else load_issue(repo_root, issue_key)
    # A developer hint steers the agent straight to the fix location. An explicit
    # hint= wins, then the request's own options, then the hint the previous run
    # recorded (so --resume keeps it). A hint accepted from the hint improver
    # arrives here as the request's hint, so it is the one recorded and reused.
    effective_hint = _effective_hint(
        hint, request.options.hint, previous.guidance.hint if previous is not None else None
    )
    # The steps below now search with the hint, so they must be given the one
    # actually in force (§33.5). On --resume the hint comes from issue.json
    # rather than from this invocation's options, and without this the retrieval
    # would quietly run without it while the agent's task file still carried it.
    search_options = (
        replace(request.options, hint=effective_hint) if effective_hint else request.options
    )
    # The issue this run works from, carried in memory from here on. A
    # hand-written bug is complete already; a Jira one is a stub until fetched,
    # or the previous run's copy on --resume until the fetch refreshes it.
    # The branch policy likewise: the request's, else what the work item
    # recorded (so --resume and every regeneration keep it), else the default —
    # and recorded, whichever it is. The branch an earlier task named is kept
    # with it: preparing the work item again never calls for a new one.
    branch_policy = resolve_branch_policy(
        request.branch_policy, previous.guidance.branch_policy if previous is not None else None
    )
    guidance = IssueGuidance(
        hint=effective_hint,
        branch_policy=branch_policy,
        branch_name=previous.guidance.branch_name if previous is not None else None,
    )
    if request.spec.source == SOURCE_MANUAL:
        issue = issue_from_spec(request.spec, guidance)
    elif previous is not None:
        issue = previous.with_guidance(guidance)
    else:
        issue = jira_stub(issue_key, guidance)

    # Attachments are copied here, before any step runs, because the task file
    # written later has to name them — and it may only name the ones that
    # actually arrived. A file that could not be copied is reported, never
    # listed: telling an agent to read something that is not there is worse
    # than not offering it at all.
    attachment_result = copy_attachments(
        target, request.options.attachments, request.options.attachment_descriptions
    )
    # Which files the work item now has and what each is for, recorded with the
    # hint in issue.json. With --replace-attachments the selection is the whole
    # set and what an earlier run copied outside it is removed; without, this
    # run adds to what is there (§37.99).
    attachments_now = _attachment_guidance(
        target,
        previous.guidance if previous is not None else IssueGuidance(),
        attachment_result,
        exact=request.options.replace_attachments,
    )
    issue = issue.with_guidance(
        replace(
            issue.guidance,
            attachment_notes=attachments_now.attachment_notes,
            attachment_files=attachments_now.attachment_files,
        )
    )
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
    # Recorded before the pipeline runs, together with the hint and whatever of
    # the issue is known, so that every later path — resume, refine, standalone
    # agent-task, retry — regenerates under the same guidance even if this run
    # fails halfway.
    issue = persist_fix_mode(repo_root, issue_key, selection.mode, issue)
    log(target, f"[INFO] fix mode: {selection.mode.id} ({selection.origin})")
    for warning in selection.warnings:
        log(target, f"[WARN] {warning}")
    log(target, f"[INFO] branch policy: {branch_policy}")
    # Resolved once, before any step runs, so an unusable profile file is
    # reported with this run's warnings rather than discovered by the task.
    repository = resolve_repository_context(repo_root, request.repository_profile)
    _log_repository_context(target, repository)
    command = f"bugpilot bug {issue_key}"
    if fresh:
        command += " --fresh"
    if include_memory:
        command += " --include-memory"
    if allow_mock:
        command += " --allow-mock"
    if jira_comment:
        command += " --jira-comment"
    if request.branch_policy is not None:
        command += f" --branch-policy {branch_policy}"
    log(target, f"[START] command: {command}")
    log(target, f"[INFO] effective mode: fresh={str(fresh).lower()}, allow_mock={str(allow_mock).lower()}")
    if allow_mock:
        log(target, "[INFO] mock/demo Jira fallback enabled by --allow-mock")
    else:
        log(target, "[INFO] real Jira required")
        log(target, "[INFO] mock fallback disabled")
    if fresh:
        log(target, "[INFO] fresh run requested")
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

    # A valid run.json exists from the first moment of the run: status
    # `running`, the plan's disabled steps already marked, nothing invented.
    _start_run(repo_root, issue_key, request.skipped_steps())
    for step in request.skipped_steps():
        log(target, f"[SKIP] {step}: not in investigation plan")

    # Produced by the investigation steps and handed to the ones after them in
    # memory. `None` when a step did not run this time; a later step then reads
    # what an earlier run persisted (the retrieval), or says it has nothing.
    keywords: dict[str, object] | None = None
    retrieval: RetrievalArtifact | None = None
    similar_fixes: str | None = None
    git_history: GitHistoryOutcome | None = None

    try:
        _progress(progress, "doctor")
        log(target, "[START] doctor")
        doctor_report = collect_doctor_report(repo_root)
        log(target, f"doctor report: {doctor_report}")
        _mark_step(repo_root, issue_key, "doctor", "pass")
        log(target, "[END] doctor: pass")

        if "fetch" in resolved:
            _progress(progress, "fetch")
            jira_result, issue = _fetch(repo_root, issue_key, allow_mock, issue.guidance)
        if "parse" in resolved:
            _progress(progress, "parse")
            issue = parse_step(repo_root, issue_key, issue=issue)
        if "keywords" in resolved:
            _progress(progress, "keywords")
            keywords = keywords_step(repo_root, issue_key, search_options, issue=issue)
        if "memory_search" in resolved:
            _progress(progress, "memory_search")
            similar_fixes = memory_search_step(repo_root, issue_key, keywords=keywords, options=search_options)
        if "code_search" in resolved:
            _progress(progress, "code_search")
            retrieval = code_search_step(repo_root, issue_key, search_options, keywords=keywords)
        if "git_context" in resolved:
            _progress(progress, "git_context")
            git_history = git_context_step(
                repo_root,
                issue_key,
                retrieval=retrieval,
                issue=issue,
                keywords=keywords,
                options=search_options,
            )
        if "context" in resolved:
            _progress(progress, "context")
            context_step(
                repo_root,
                issue_key,
                issue=issue,
                keywords=keywords,
                retrieval=retrieval,
                git_history=git_history,
                similar_fixes=similar_fixes,
            )
        if "prompt" in resolved:
            _progress(progress, "prompt")
            prompt_step(repo_root, issue_key, fix_mode=selection.mode, issue=issue, repository=repository)
        if "memory_add" in resolved:
            memory_add_step(repo_root, issue_key, issue=issue)
    except Exception as exc:
        log(target, f"[ERROR] workflow: {exc}")
        _fail_run(repo_root, issue_key, exc)
        raise

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
    _finish_run(repo_root, issue_key, statuses)
    return WorkflowResult(
        issue_key=issue_key,
        issue_dir=target,
        generated_files=generated,
        warnings=attachment_warnings + list(selection.warnings) + list(repository.warnings),
        jira_result=jira_result,
        clean_result=clean_result,
        fresh=fresh,
        allow_mock=allow_mock,
        fix_mode=selection.mode,
    )


def _progress(progress: Callable[[str], None] | None, event: str) -> None:
    if progress:
        progress(event)


def fetch_step(repo_root: Path, issue_key: str, allow_mock: bool = False) -> JiraFetchResult:
    """Fetch a Jira issue and record it, normalized, in ``issue.json``.

    Standalone use keeps whatever guidance the work item already records: a
    re-fetch refreshes the bug, not the hint or the Fix Mode it is worked under.
    """
    # Quietly: a corrupt issue.json must not block the re-fetch that replaces it.
    existing = read_issue_quietly(repo_root, issue_key)
    guidance = existing.guidance if existing is not None else IssueGuidance()
    result, _issue = _fetch(repo_root, issue_key, allow_mock, guidance)
    return result


def _fetch(
    repo_root: Path, issue_key: str, allow_mock: bool, guidance: IssueGuidance
) -> tuple[JiraFetchResult, IssueArtifact]:
    """The fetch step: Jira payload in, normalized issue out, raw payload discarded.

    The payload is normalized here and never written: every later step reads the
    normalized issue, and the raw form carried attachment URLs, account ids and
    custom fields nothing used.
    """
    target = _prepare_issue_dir(repo_root, issue_key)
    log(target, "[START] fetch")
    if allow_mock:
        log(target, "[INFO] mock/demo Jira fallback enabled by --allow-mock")
    else:
        log(target, "[INFO] real Jira required")
        log(target, "[INFO] mock fallback disabled")
    try:
        result = fetch_issue(repo_root, issue_key, allow_mock=allow_mock)
        issue = issue_from_jira(enrich_issue(result.data), issue_key, guidance)
        save_issue(repo_root, issue)
        if result.source == "mock":
            log(target, f"[WARN] Jira fetch failed: {result.error_type} - {result.error_message}")
            log(target, "[WARN] Using mock/demo Jira data")
        else:
            log(target, _fetch_message(result))
        _mark_step(repo_root, issue_key, "fetch", "pass")
        log(target, "[END] fetch: pass")
        return result, issue
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

    Writes the normalized ``issue.json`` — what a run would work from — and
    ``jira_field_report.md``, the field-mapping diagnostic this command exists
    for. Returns a validation summary dict.
    """
    target = _prepare_issue_dir(repo_root, issue_key)
    log(target, "[START] jira_validate")
    try:
        result = fetch_issue(repo_root, issue_key, allow_mock=False)
        issue = result.data
        enrich_issue(issue)
        existing = read_issue_quietly(repo_root, issue_key)
        guidance = existing.guidance if existing is not None else IssueGuidance()
        normalized = issue_from_jira(issue, issue_key, guidance)
        save_issue(repo_root, normalized)
        (target / "jira_field_report.md").write_text(jira_field_report_markdown(issue), encoding="utf-8")
        log(target, "[END] jira_validate: pass")
        details = normalized.details
        return {
            "source": "jira",
            "issue_type": details.issue_type,
            "status": details.status,
            "priority": details.priority,
            "comment_count": len(normalized.comments),
            "attachment_count": len(details.attachments),
            "has_description": bool(normalized.description),
            "has_reproduction_steps": bool(details.reproduction_steps),
            "missing_information_count": len(details.missing_information),
        }
    except JiraFetchError as exc:
        log(target, f"[ERROR] jira_validate Jira fetch failed: {exc.result.error_type} - {exc.result.error_message}")
        log(target, "[END] jira_validate: fail")
        raise
    except Exception as exc:
        log(target, f"[ERROR] jira_validate: {exc}")
        raise


def parse_step(repo_root: Path, issue_key: str, issue: IssueArtifact | None = None) -> IssueArtifact:
    """Confirm the normalized issue is complete enough for the steps after it.

    The normalizing itself happens where the content arrives — the fetch for a
    Jira issue, the request for a hand-written one — so this step writes nothing.
    What it catches is a Jira work item whose ``issue.json`` is still the stub
    written before a fetch that never completed.
    """
    target = _prepare_issue_dir(repo_root, issue_key)
    log(target, "[START] parse")
    try:
        issue = issue or _require_issue(repo_root, issue_key)
        if issue.is_jira and not (issue.title or issue.description):
            raise ValueError(
                f"{issue_key} has not been fetched yet. Run: bugpilot fetch {issue_key}"
            )
        log(
            target,
            f"[INFO] issue: {issue.source}, {len(issue.comments)} comment(s), "
            f"{len(issue.signals.stack_traces)} stack trace(s), "
            f"{len(issue.signals.error_messages)} error message(s)",
        )
        _mark_step(repo_root, issue_key, "parse", "pass")
        log(target, "[END] parse: pass")
        return issue
    except Exception as exc:
        _mark_step(repo_root, issue_key, "parse", "fail")
        log(target, f"[ERROR] parse: {exc}")
        raise


def extract_issue_keywords(issue: IssueArtifact, supplied: list[str] | None = None) -> dict[str, object]:
    """What the issue is searched for, before the repository has a say.

    A pure function of the issue text and the developer's own keywords, which
    is why it is not persisted: the pipeline hands it from step to step, and a
    step run on its own recomputes it from ``issue.json`` plus the user terms
    ``retrieval.json`` records (:func:`work_item_keywords`). What was actually
    searched, and what each term found, is ``retrieval.json.terms``.
    """
    # Boost keywords found in stack traces / error messages — the richest
    # source of real class/function/file names.
    keywords = extract_keywords(issue.combined_text, priority_text=issue.priority_text)
    # What the issue alone yields, before the developer's words are put at its
    # head: Similar fixes searches with these whatever its settings say, and
    # adds the shared Keywords only when told to (`similar_fixes_terms`).
    keywords["issue_terms"] = [
        *keywords.get("high_value_keywords", []),  # type: ignore[misc]
        *keywords.get("normal_keywords", []),  # type: ignore[misc]
    ]
    # Developer-supplied keywords lead: an explicit --keywords is a stronger
    # signal than anything mined from the bug text, and it is often the term
    # the report never spelled out.
    words = [word.strip() for word in (supplied or []) if word.strip()]
    # Capped, because every keyword is one ripgrep invocation with a 20 second
    # timeout of its own. The mined keywords are capped at five for the same
    # reason; a pasted list of sixty would spend twenty minutes searching and
    # then be abandoned by the caller's own timeout. What was dropped is
    # recorded rather than discarded silently.
    if len(words) > MAX_SUPPLIED_KEYWORDS:
        keywords["dropped_supplied_keywords"] = words[MAX_SUPPLIED_KEYWORDS:]
        words = words[:MAX_SUPPLIED_KEYWORDS]
    if words:
        existing = [word for word in keywords.get("high_value_keywords", []) if word not in words]  # type: ignore[union-attr]
        keywords["high_value_keywords"] = words + existing
    # The shared Keywords this extraction carries, as searched: what a step
    # that may leave them out (Similar fixes) leaves out.
    keywords["supplied_keywords"] = words
    return keywords


def work_item_keywords(repo_root: Path, work_item_id: str) -> dict[str, object] | None:
    """The keyword extraction for a prepared work item, or ``None`` without one.

    For callers outside a pipeline run — a standalone step, the MCP memory
    search. The developer's own ``--keywords`` are folded back in from the
    ``source: "user"`` terms ``retrieval.json`` records: they are not
    re-derivable from ``issue.json``, and a context or memory search rebuilt
    without them would disagree with the Relevant Files rendered from the very
    search they led. A fresh ``bugpilot search`` is different — new options
    replace the recording rather than replay it.
    """
    issue = read_issue_quietly(repo_root, work_item_id)
    if issue is None:
        return None
    return extract_issue_keywords(issue, _user_terms(read_retrieval_quietly(repo_root, work_item_id)))


def _user_terms(retrieval: RetrievalArtifact | None) -> list[str]:
    """The ``--keywords`` the recorded search ran with, replayed for a rebuild."""
    if retrieval is None:
        return []
    return [term.value for term in retrieval.terms if term.source == "user"]


def keywords_step(
    repo_root: Path,
    issue_key: str,
    options: InvestigationOptions | None = None,
    issue: IssueArtifact | None = None,
) -> dict[str, object]:
    target = _prepare_issue_dir(repo_root, issue_key)
    log(target, "[START] keywords")
    try:
        issue = issue or _require_issue(repo_root, issue_key)
        keywords = extract_issue_keywords(issue, options.keywords if options else None)
        dropped = keywords.get("dropped_supplied_keywords")
        if isinstance(dropped, list) and dropped:
            log(
                target,
                f"[WARN] keywords: {MAX_SUPPLIED_KEYWORDS + len(dropped)} keywords supplied; searching the "
                f"first {MAX_SUPPLIED_KEYWORDS} and dropping: {', '.join(map(str, dropped))}",
            )
        _mark_step(repo_root, issue_key, "keywords", "pass")
        log(target, "[END] keywords: pass")
        return keywords
    except Exception as exc:
        _mark_step(repo_root, issue_key, "keywords", "fail")
        log(target, f"[ERROR] keywords: {exc}")
        raise


def similar_fixes_terms(
    extracted: dict[str, object], settings: SimilarFixesOptions | None = None
) -> list[str]:
    """What Similar fixes scores past fixes with: its inputs, composed here and only here.

    The issue's own extracted terms, always; the shared Keywords, while *Use
    shared keywords* is on; Similar Fixes' own Additional Keywords, always.
    Nothing else reaches it — not the Focus Files, not Git History's keywords or
    files, not an Ignore Path or a Code Search limit — and nothing here changes
    what any other step was given: switching the shared Keywords off leaves
    them out of this list, not out of the extraction.

    One entry per term, compared without case as the score compares them, in a
    fixed order: the developer's words first, as in the extraction — shared,
    then additional — then the issue's. A term several inputs name is scored
    once and weighs what any other term weighs.

    An extraction without ``issue_terms`` (a caller's own dict) counts all of its
    high-value and normal keywords as the issue's, which is how the step read
    one before these settings existed.
    """
    settings = (settings or SimilarFixesOptions()).normalized()
    issue_terms = extracted.get("issue_terms")
    if not isinstance(issue_terms, list):
        issue_terms = [*_as_strings(extracted.get("high_value_keywords")), *_as_strings(extracted.get("normal_keywords"))]
    shared = _as_strings(extracted.get("supplied_keywords")) if settings.use_shared_keywords else []
    terms: list[str] = []
    seen: set[str] = set()
    for term in [*shared, *settings.keywords, *_as_strings(issue_terms)]:
        word = term.strip()
        if word and word.casefold() not in seen:
            seen.add(word.casefold())
            terms.append(word)
    return terms


def _as_strings(value: object) -> list[str]:
    return [str(item) for item in value] if isinstance(value, list) else []


def memory_search_step(
    repo_root: Path,
    issue_key: str,
    keywords: dict[str, object] | None = None,
    options: InvestigationOptions | None = None,
) -> str:
    """Similar past bugs, as the Markdown report the context renders. Writes nothing.

    How it searches is this run's Similar Fixes Settings
    (``options.similar_fixes``); a standalone run has none and uses the
    defaults — the issue's terms and the shared Keywords, five results — which
    is what the step did before they existed.
    """
    target = _prepare_issue_dir(repo_root, issue_key)
    log(target, "[START] memory_search")
    try:
        settings = (options.similar_fixes if options is not None else SimilarFixesOptions()).normalized()
        # The settings' shape only: never a keyword (§37.95).
        log(
            target,
            "[INFO] memory_search settings: "
            f"sharedKeywords={'on' if settings.use_shared_keywords else 'off'} "
            f"additionalKeywords={len(settings.keywords)} maxResults={settings.max_results}",
        )
        extracted = keywords if keywords is not None else work_item_keywords(repo_root, issue_key)
        # Without an extraction — no issue.json to read — the step scores the
        # id's own words, as it always has.
        terms = similar_fixes_terms(extracted, settings) if extracted is not None else None
        _matched, report, _results = search_memory(
            repo_root, issue_key, extracted=extracted, terms=terms, max_results=settings.max_results
        )
        _mark_step(repo_root, issue_key, "memory_search", "pass")
        log(target, "[END] memory_search: pass")
        return report
    except Exception as exc:
        _mark_step(repo_root, issue_key, "memory_search", "fail")
        log(target, f"[ERROR] memory_search: {exc}")
        raise


def code_search_step(
    repo_root: Path,
    issue_key: str,
    options: InvestigationOptions | None = None,
    keywords: dict[str, object] | None = None,
) -> RetrievalArtifact:
    """Search, rank, and write ``retrieval.json`` once, atomically."""
    target = _prepare_issue_dir(repo_root, issue_key)
    log(target, "[START] code_search")
    try:
        if keywords is None:
            keywords = extract_issue_keywords(
                _require_issue(repo_root, issue_key), options.keywords if options else None
            )
        retrieval = run_code_search(repo_root, keywords, options)
        save_retrieval(repo_root, issue_key, retrieval)
        _mark_step(repo_root, issue_key, "code_search", "pass")
        log(target, "[END] code_search: pass")
        return retrieval
    except Exception as exc:
        _mark_step(repo_root, issue_key, "code_search", "fail")
        log(target, f"[ERROR] code_search: {exc}")
        raise


def git_context_step(
    repo_root: Path,
    issue_key: str,
    retrieval: RetrievalArtifact | None = None,
    *,
    issue: IssueArtifact | None = None,
    keywords: dict[str, object] | None = None,
    options: InvestigationOptions | None = None,
    record: bool = True,
) -> GitHistoryOutcome:
    """The ranked related commits, as a structured record, and the checkout's state.

    The record is written into ``retrieval.json`` as its ``git_history``
    section — the one source the context and the panel render the commits
    from — and handed to the context step in memory as well. How it searches is
    this run's Git History Settings (``options.git_history``); a standalone run
    has none and uses the defaults, which are Batch 1's behaviour.

    ``record=False`` — ``bugpilot git-context`` — only returns the outcome to
    print: neither the section nor ``run.json`` changes, as before v2, so the
    panel and ``context.md`` go on showing the run that prepared them together.
    """
    target = _prepare_issue_dir(repo_root, issue_key)
    log(target, "[START] git_context")
    try:
        settings = (options.git_history if options is not None else GitHistoryOptions()).normalized()
        # The settings' shape only: never a keyword or a path (§37.95).
        log(
            target,
            "[INFO] git_context settings: "
            f"commitSearch={str(settings.search_commit_messages).lower()} "
            f"fileHistory={str(settings.search_file_history).lower()} "
            f"maxCommits={settings.max_related_commits} historyDepth={settings.history_depth} "
            f"sharedKeywords={'on' if settings.use_shared_keywords else 'off'} "
            f"sharedFocusFiles={'on' if settings.use_shared_focus_files else 'off'} "
            f"commitKeywords={len(settings.keywords)} additionalFiles={len(settings.files)}",
        )
        retrieval = retrieval or read_retrieval_quietly(repo_root, issue_key)
        query = _git_history_query(repo_root, issue_key, retrieval, issue, keywords, options, settings)
        outcome = collect_git_history(repo_root, issue_key, query, settings)
        if not record:
            log(target, "[END] git_context: printed, nothing recorded")
            return outcome
        _record_git_history(repo_root, issue_key, retrieval, outcome)
        _mark_step(repo_root, issue_key, "git_context", "pass")
        log(target, "[END] git_context: pass")
        return outcome
    except Exception as exc:
        if record:
            _forget_git_history(repo_root, issue_key)
            _mark_step(repo_root, issue_key, "git_context", "fail")
        log(target, f"[ERROR] git_context: {exc}")
        raise


def _record_git_history(
    repo_root: Path, issue_key: str, retrieval: RetrievalArtifact | None, outcome: GitHistoryOutcome
) -> None:
    """Write the record into the retrieval it belongs beside, atomically.

    Into the retrieval this run searched with — on disk already, written by
    Code Search moments ago or by an earlier run — and only that: with no
    retrieval there is no file to add a section to, and writing one would
    invent a search that never ran. The context still renders the record from
    memory; the panel then says only "Completed".
    """
    if retrieval is None:
        log(issue_dir(repo_root, issue_key), "[INFO] git_context: no retrieval.json to record the result in")
        return
    save_retrieval(repo_root, issue_key, replace(retrieval, git_history=outcome.record))
    record = outcome.record
    # Counts only: never a subject, a term or a path.
    log(
        issue_dir(repo_root, issue_key),
        f"[INFO] git_context recorded: status={record.status}, {record.candidate_count} candidate(s), "
        f"{len(record.commits)} retained{', incomplete' if record.incomplete else ''}",
    )


def _forget_git_history(repo_root: Path, issue_key: str) -> None:
    """After a failed step, take an earlier run's section out of ``retrieval.json``.

    Belt and braces: the panel only reads the section once ``run.json`` says
    the step passed. But a file that still claimed an earlier result after the
    step meant to replace it failed would be a stale answer waiting for a
    reader, so it goes — quietly, since the failure being reported is the
    step's, not this.
    """
    try:
        current = read_retrieval_quietly(repo_root, issue_key)
        if current is not None and current.git_history is not None:
            save_retrieval(repo_root, issue_key, replace(current, git_history=None))
    except Exception as exc:  # pragma: no cover - the step's own failure is the one reported
        log(issue_dir(repo_root, issue_key), f"[WARN] git_context: could not drop the earlier result ({type(exc).__name__})")


def _git_history_query(
    repo_root: Path,
    issue_key: str,
    retrieval: RetrievalArtifact | None,
    issue: IssueArtifact | None,
    keywords: dict[str, object] | None,
    options: InvestigationOptions | None,
    settings: GitHistoryOptions | None = None,
) -> GitHistoryQuery:
    """What Git History searches with: the shared guidance plus the issue's own signals.

    A pipeline run hands over this run's options, so its Keywords and Focus
    Files are the ones Code Search just used. A standalone ``git-context`` or
    ``context`` has no options and replays what ``retrieval.json`` recorded —
    the ``source: "user"`` terms and the files the search marked as focus —
    exactly as :func:`work_item_keywords` does for the keywords.

    The Git History Settings act here and only here: *Use shared Keywords* /
    *Use shared Focus Files* off leave those fields empty, and the Additional
    Commit Keywords and Additional Files arrive in fields of their own. Nothing
    here changes what Code Search was given.
    """
    settings = settings or GitHistoryOptions()
    issue = issue or read_issue_quietly(repo_root, issue_key)
    if options is not None:
        shared_keywords = [word.strip() for word in options.keywords if word.strip()]
        focus_files = tuple(options.focus_files)
    else:
        shared_keywords = _user_terms(retrieval)
        focus_files = focus_files_from_retrieval(retrieval)
    if keywords is None and issue is not None:
        keywords = extract_issue_keywords(issue, shared_keywords)
    # Only an external key is worth searching for: a hand-written bug's
    # `local_…` id was minted by this tool and no commit can carry it.
    reference = issue.source_ref if issue is not None else issue_key
    git_keywords = tuple(word.strip() for word in settings.keywords if word.strip())
    return GitHistoryQuery(
        issue_id=reference if reference and is_jira_issue_key(reference) else None,
        shared_keywords=tuple(shared_keywords) if settings.use_shared_keywords else (),
        git_keywords=git_keywords,
        # The shared Keywords are excluded even when Git History does not use
        # them: the extraction carries them at its head, and leaving them in
        # would let a switched-off Keyword back in as an "issue term".
        extracted_terms=select_extracted_terms(
            keywords, exclude=[*shared_keywords, *git_keywords], retrieval=retrieval
        ),
        focus_files=focus_files if settings.use_shared_focus_files else (),
        git_files=tuple(path for path in settings.files if path.strip()),
        ranked_files=tuple(retrieval.top_files(RANKED_HISTORY_FILES)) if retrieval is not None else (),
        # Every file Code Search returned: never searched, only never offered
        # again as a supporting file (Batch 4).
        known_files=tuple(item.file for item in retrieval.related_files) if retrieval is not None else (),
    )


def context_step(
    repo_root: Path,
    issue_key: str,
    issue: IssueArtifact | None = None,
    keywords: dict[str, object] | None = None,
    retrieval: RetrievalArtifact | None = None,
    git_history: GitHistoryOutcome | None = None,
    similar_fixes: str | None = None,
) -> None:
    """Write ``context.md`` from what the steps before it produced, in memory.

    ``git_history`` / ``similar_fixes`` are ``None`` when those steps did not run;
    the context then says so. Nothing is read back from an intermediate file.
    """
    target = _prepare_issue_dir(repo_root, issue_key)
    log(target, "[START] context")
    try:
        issue = issue or _require_issue(repo_root, issue_key)
        # The retrieval this run produced, else what an earlier one persisted.
        retrieval = retrieval or read_retrieval_quietly(repo_root, issue_key)
        if keywords is None:
            keywords = extract_issue_keywords(issue, _user_terms(retrieval))
        context = build_context(issue, keywords, retrieval, git_history, similar_fixes)
        atomic_write_text(target / CONTEXT_ARTIFACT, context)
        _mark_step(repo_root, issue_key, "context", "pass")
        log(target, "[END] context: pass")
    except Exception as exc:
        _mark_step(repo_root, issue_key, "context", "fail")
        log(target, f"[ERROR] context: {exc}")
        raise


def _selected_fix_mode(
    repo_root: Path,
    issue_key: str,
    requested_id: str | None = None,
    *,
    use_persisted: bool = True,
) -> FixMode:
    """The mode this work item runs under, with any drift reported to the log.

    Every regeneration path goes through here rather than reading the selection
    file itself: a path that forgot to would silently regenerate the package as
    Standard Fix, which is the failure this whole phase exists to prevent.
    """
    selection = select_fix_mode(
        repo_root, issue_key, requested_id, use_persisted=use_persisted
    )
    target = issue_dir(repo_root, issue_key)
    if target.exists():
        for warning in selection.warnings:
            log(target, f"[WARN] {warning}")
    return selection.mode


def _task_branch(repo_root: Path, issue: IssueArtifact) -> tuple[str, str]:
    """The branch policy a task is written under, and the branch it names.

    Under a policy that may have the agent create a branch, the first task's
    name is recorded and every later one reuses it — a rebuild, a resume, a
    retry and a regenerated task all name the branch the work item already has
    (§37.127). Under ``current`` the name is only the suggestion for main/master
    and is derived each time. The title names it; a hand-written bug's name
    comes from the title alone (see ``branch_name``).
    """
    policy = resolve_branch_policy(None, issue.guidance.branch_policy)
    branch = issue.guidance.branch_name or branch_name(issue.id, issue.title or None)
    if records_branch_name(policy) and issue.guidance.branch_name is None:
        save_issue(repo_root, issue.with_guidance(replace(issue.guidance, branch_name=branch)))
    return policy, branch


def _log_repository_context(target: Path, repository: RepositoryContext) -> None:
    facts = ", ".join(f"{name}: {value}" for name, value in repository.facts.items() if name != "Codebase notes")
    log(target, f"[INFO] repository profile: {repository.mode}" + (f" ({facts})" if facts else ""))
    for warning in repository.warnings:
        log(target, f"[WARN] {warning}")


def _task_repository(repo_root: Path, target: Path, repository: RepositoryContext | None) -> RepositoryContext:
    """The Repository Profile a task is written with: the caller's, else the file's."""
    if repository is not None:
        return repository
    resolved = resolve_repository_context(repo_root)
    _log_repository_context(target, resolved)
    return resolved


def prompt_step(
    repo_root: Path,
    issue_key: str,
    jira_comment: bool = False,
    fix_mode: FixMode | None = None,
    issue: IssueArtifact | None = None,
    repository: RepositoryContext | None = None,
) -> None:
    target = _prepare_issue_dir(repo_root, issue_key)
    if jira_comment:
        _set_jira_comment_on(target)
    log(target, "[START] prompt")
    try:
        issue = issue or _require_issue(repo_root, issue_key)
        hint = issue.guidance.hint
        jira_comment = _jira_comment_enabled(target)
        # The recorded selection, not whatever is in the folder (§37.99).
        attached = listed_attachments(target, issue.guidance.attachment_files)
        mode = fix_mode or _selected_fix_mode(repo_root, issue_key)
        branch_policy, branch = _task_branch(repo_root, issue)
        task = generate_task(
            issue_key,
            issue.title or None,
            hint=hint,
            jira_comment=jira_comment,
            attachments=attached,
            fix_mode=mode,
            attachment_notes=issue.guidance.attachment_notes,
            branch_policy=branch_policy,
            branch=branch,
            repository=_task_repository(repo_root, target, repository),
        )
        atomic_write_text(target / TASK_ARTIFACT, task)
        _mark_step(repo_root, issue_key, "prompt", "pass")
        log(target, "[END] prompt: pass")
    except Exception as exc:
        _mark_step(repo_root, issue_key, "prompt", "fail")
        log(target, f"[ERROR] prompt: {exc}")
        raise


def copilot_task_step(
    repo_root: Path,
    issue_key: str,
    jira_comment: bool = False,
    fix_mode: FixMode | None = None,
) -> None:
    target = _prepare_issue_dir(repo_root, issue_key)
    context = target / CONTEXT_ARTIFACT
    if not context.exists():
        raise FileNotFoundError(f"Missing {context}. Run: bugpilot {issue_key}")
    if jira_comment:
        _set_jira_comment_on(target)
    log(target, "[START] copilot_task")
    try:
        issue = _require_issue(repo_root, issue_key)
        hint = issue.guidance.hint
        jira_comment = _jira_comment_enabled(target)
        attached = listed_attachments(target, issue.guidance.attachment_files)
        mode = fix_mode or _selected_fix_mode(repo_root, issue_key)
        branch_policy, branch = _task_branch(repo_root, issue)
        task = generate_task(
            issue_key,
            issue.title or None,
            hint=hint,
            jira_comment=jira_comment,
            attachments=attached,
            fix_mode=mode,
            attachment_notes=issue.guidance.attachment_notes,
            branch_policy=branch_policy,
            branch=branch,
            repository=_task_repository(repo_root, target, None),
        )
        atomic_write_text(target / TASK_ARTIFACT, task)
        log(target, "[END] copilot_task: pass")
    except Exception as exc:
        log(target, f"[ERROR] copilot_task: {exc}")
        raise


def copilot_instructions_step(repo_root: Path, issue_key: str) -> str:
    """BugPilot's safety rules, returned rather than written.

    They are a section of ``task.md``; a per-work-item copy of a document that is
    the same for every work item was a file to keep in step, not information.
    """
    target = _prepare_issue_dir(repo_root, issue_key)
    log(target, "[START] copilot_instructions")
    try:
        instructions = copilot_team_instructions()
        _mark_step(repo_root, issue_key, "agent_instructions", "pass")
        log(target, "[END] copilot_instructions: pass")
        return instructions
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


def summarize_results_step(repo_root: Path, issue_key: str) -> str:
    """The report's status and the validation checklist, rendered in memory.

    The old aggregate file (`result_summary.md`) was a concatenation of the
    agent's five result files; with one `fix_report.md` the aggregate *is* the
    report, so nothing is written — this returns what a developer needs next.

    One step mark, `result_summary`: the overview was rendered, or could not
    be. Rendering the checklist is not a manual validation, so no mark claims
    one (§37.70).
    """
    target = _prepare_issue_dir(repo_root, issue_key)
    log(target, "[START] summarize_results")
    try:
        summary = _build_result_overview(repo_root, issue_key)
        _mark_step(repo_root, issue_key, "result_summary", "pass")
        log(target, "[END] summarize_results: pass")
        return summary
    except Exception as exc:
        _mark_step(repo_root, issue_key, "result_summary", "fail")
        log(target, f"[ERROR] summarize_results: {exc}")
        raise


def review_package_step(repo_root: Path, issue_key: str) -> str:
    """The final-review prompt, returned rather than written.

    A pure function of the work item id and the canonical files: the developer
    pastes it into a reviewer, and nothing ever read it back from disk.

    Records nothing in `run.json`. It used to mark `final_review_prompt: pass`,
    which `status` showed as though a review had passed; printing a prompt is
    not a review, so it is no longer a step (§37.70).
    """
    target = _prepare_issue_dir(repo_root, issue_key)
    log(target, "[START] review_package")
    try:
        prompt = _build_final_review_prompt(issue_key)
        log(target, "[END] review_package: pass")
        return prompt
    except Exception as exc:
        log(target, f"[ERROR] review_package: {exc}")
        raise


@dataclass(frozen=True)
class ValidationChecklist:
    """The manual validation guidance, as the lists its Markdown is rendered from.

    Guidance for the developer, never a result: nothing here says whether a step
    was done or passed. ``review_risks`` are the report's Review Notes lines as
    written.
    """

    steps: tuple[str, ...]
    regression_files: tuple[str, ...]
    review_risks: tuple[str, ...]


def validation_checklist(repo_root: Path, issue_key: str) -> ValidationChecklist:
    """What to validate by hand, from ``fix_report.md`` and ``retrieval.json``. Reads only."""
    report = read_fix_report(repo_root, issue_key)
    retrieval = read_retrieval_quietly(repo_root, issue_key)
    review_notes = report.review_notes if report is not None else ""
    return ValidationChecklist(
        steps=(
            "Reproduce the original issue if possible.",
            "Confirm the failure no longer occurs.",
            "If source changes were made, confirm they do not affect unrelated behavior.",
            f"Run the focused tests named in {FIX_REPORT_ARTIFACT}'s Tests section, if any.",
            f"Check regression areas mentioned in {CONTEXT_ARTIFACT} and {RETRIEVAL_ARTIFACT}.",
        ),
        regression_files=tuple(retrieval.top_files(10)) if retrieval is not None else (),
        review_risks=tuple(line for line in review_notes.splitlines() if line.strip()),
    )


def review_package_projection(repo_root: Path, issue_key: str) -> tuple[str, ValidationChecklist]:
    """The final-review prompt and the validation checklist, as a query.

    For callers that ask rather than run a step — the extension's Copy Review
    Prompt and Validation checklist. Unlike ``review_package_step`` and
    ``summarize_results_step`` it creates no directory, records no step mark in
    ``run.json`` and posts nothing: it is safe while a run of the same work item
    is writing ``run.json``, and a failure here can never turn a work item
    "failed". The content is built by the same functions the human outputs use.
    """
    validate_work_item_id(issue_key)
    if not issue_dir(repo_root, issue_key).is_dir():
        raise WorkItemNotFoundError(f"Work item not found: .ai/{issue_key}/")
    return _build_final_review_prompt(issue_key), validation_checklist(repo_root, issue_key)


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


def commit_plan_step(repo_root: Path, issue_key: str) -> str:
    """The manual commit plan, returned for the terminal. Nothing read the file.

    The plan is regenerable from git state and the report at any moment, and
    the safety rules it carries are the same ones `task.md` embeds. Committing
    stays the developer's own action.
    """
    target = _prepare_issue_dir(repo_root, issue_key)
    log(target, "[START] commit_plan")
    try:
        plan = _build_commit_plan(repo_root, issue_key)
        _mark_step(repo_root, issue_key, "commit_plan", "pass")
        log(target, "[END] commit_plan: pass")
        return plan
    except Exception as exc:
        _mark_step(repo_root, issue_key, "commit_plan", "fail")
        log(target, f"[ERROR] commit_plan: {exc}")
        raise


def push_plan_step(repo_root: Path, issue_key: str) -> str:
    """The manual push plan, returned for the terminal. Pushing stays manual."""
    target = _prepare_issue_dir(repo_root, issue_key)
    log(target, "[START] push_plan")
    try:
        plan = _build_push_plan(repo_root, issue_key)
        _mark_step(repo_root, issue_key, "push_plan", "pass")
        log(target, "[END] push_plan: pass")
        return plan
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
    report = read_fix_report(repo_root, issue_key)
    memory_path = repo_root / ".ai_memory" / "bugs" / f"{issue_key}.md"
    if report is None:
        log(target, f"[WARN] memory_update: missing .ai/{issue_key}/{FIX_REPORT_ARTIFACT}; the agent writes it, or run bugpilot manual-result {issue_key}")
        _mark_step(repo_root, issue_key, "memory_update", "skipped")
        return False

    memory_path.parent.mkdir(parents=True, exist_ok=True)
    existing = memory_path.read_text(encoding="utf-8") if memory_path.exists() else f"# {issue_key} AI Bug Workflow Memory\n"
    final_result = _build_final_result_section(report)
    updated = _replace_section(existing, "## Final Result", final_result)
    memory_path.write_text(updated, encoding="utf-8")
    _mark_step(repo_root, issue_key, "memory_update", "pass")
    log(target, f"[UPDATED] .ai_memory/bugs/{issue_key}.md")
    log(target, "[END] memory_update: pass")
    return True


def memory_add_step(repo_root: Path, issue_key: str, issue: IssueArtifact | None = None) -> None:
    target = _prepare_issue_dir(repo_root, issue_key)
    log(target, "[START] memory_add")
    try:
        issue = issue or _require_issue(repo_root, issue_key)
        entry = build_memory_entry(issue_key, issue, f".ai/{issue_key}/{CONTEXT_ARTIFACT}")
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
    if not (target / CONTEXT_ARTIFACT).exists() and not (target / ISSUE_ARTIFACT).exists():
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
        # The one audit record of the POST that happened. The prose summary it
        # used to sit beside was a duplicate nothing read.
        (target / "jira_comment_post_result.json").write_text(json.dumps(result_json, indent=2) + "\n", encoding="utf-8")
        _mark_step(repo_root, issue_key, "jira_comment", "pass")
        log(target, f"[GENERATED] .ai/{issue_key}/jira_comment_post_result.json")
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
        mode = _selected_fix_mode(repo_root, issue_key)
        prompt_path.write_text(
            _build_retry_prompt(repo_root, issue_key, mode), encoding="utf-8"
        )
        log(target, f"[INFO] retry fix mode: {mode.id} ({mode.execution_kind})")
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


def _effective_hint(*candidates: str | None) -> str | None:
    """The first non-blank hint, stripped — the one precedence every search uses.

    Callers pass, strongest first: a hint supplied for this operation, the
    request's own option (how an accepted improved hint arrives), and the hint
    ``issue.json`` records.
    """
    for candidate in candidates:
        if candidate and candidate.strip():
            return candidate.strip()
    return None


def _require_issue(repo_root: Path, issue_key: str) -> IssueArtifact:
    """The persisted issue, for a step run outside a full pipeline."""
    issue = load_issue(repo_root, issue_key)
    if issue is None:
        raise FileNotFoundError(
            f"Missing .ai/{issue_key}/{ISSUE_ARTIFACT}. Run: bugpilot bug {issue_key}"
        )
    return issue


def _build_jira_comment_draft(repo_root: Path, issue_key: str, missing_results: list[str]) -> str:
    # Keep the comment short: root cause + a summary of the changes — not the full
    # diff or the internal search/validation/attachment detail.
    del missing_results  # strict-mode gating happens in the caller; not shown here
    report = read_fix_report(repo_root, issue_key)
    root_cause = (report.analysis if report else "") or "No root cause analysis found in the fix report."
    changes = (report.changes if report else "") or "No change summary found in the fix report."
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


def _build_retry_prompt(repo_root: Path, issue_key: str, fix_mode: FixMode | None = None) -> str:
    """A second attempt at whatever the selected Fix Mode asked for the first time.

    This is the package's other task-shaped renderer, and it used to assume the
    first pass had produced a fix: it asked the agent to re-check "the
    implementation location", to decide whether to revert a previous change, and
    it ended with the commit/push offer. Under an investigation-only mode all
    three describe work that never happened, and the offer invites the agent to
    invent a fix so that the question makes sense. So the middle of this prompt
    follows `execution_kind`, while the reading list, the feedback, the required
    files and BugPilot Delivery Safety are the same either way.
    """
    mode = fix_mode or _selected_fix_mode(repo_root, issue_key)
    target = issue_dir(repo_root, issue_key)
    # The branch rules the first pass was given, and the branch it named: a
    # retry is the same work item. An unreadable record falls back to the
    # default, which is the safe one.
    recorded_issue = read_issue_quietly(repo_root, issue_key)
    recorded = recorded_issue.guidance if recorded_issue is not None else IssueGuidance()
    branch_policy = resolve_branch_policy(None, recorded.branch_policy)
    branch = recorded.branch_name
    reading_files = [
        CONTEXT_ARTIFACT,
        RETRIEVAL_ARTIFACT,
        FIX_REPORT_ARTIFACT,
        "user_feedback.md",
    ]
    reading = [f"- .ai/{issue_key}/{name}" for name in reading_files if (target / name).exists()]
    if f"- .ai/{issue_key}/user_feedback.md" not in reading:
        reading.append(f"- .ai/{issue_key}/user_feedback.md")
    reading.append("- current git diff")
    feedback = _cap_text(_read_artifact(target, "user_feedback.md") or "No user feedback file found.", 3000)
    previous = _previous_attempt_summary(target)
    investigating = mode.is_investigation
    purpose = (
        "The previous investigation did not answer the question, or the developer wants a "
        "second, more focused investigation pass. No source changes have been applied, and "
        "none are to be applied in this pass.\n\n"
        if investigating
        else "The previous attempt did not fully resolve the issue, or the developer wants a second focused attempt.\n\n"
    )
    if investigating:
        retry_instructions = (
            "- First explain why the previous investigation did not settle the root cause.\n"
            "- Use user_feedback.md as the main correction for this retry.\n"
            "- Name the evidence that is still missing, and what would confirm or rule out each hypothesis.\n"
            "- Revise the ranked hypotheses against the supplied evidence; drop the ones it contradicts.\n"
            "- Inspect only the additional locations this evidence points at.\n"
            "- Update the proposed fix plan and the proposed verification.\n"
            "- Do not modify source code, and do not describe the bug as fixed, resolved, or verified.\n"
            "- If a current git diff exists, review it and report it as an unexpected change rather than continuing from it.\n"
            "- Do not commit or push.\n"
            "- Do not update Jira.\n"
            "- Do not claim tests passed: implementation has not started.\n"
            f"- Update {FIX_REPORT_ARTIFACT}, still describing investigation state.\n\n"
        )
    else:
        retry_instructions = (
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
            f"- Update {FIX_REPORT_ARTIFACT}.\n\n"
        )
    closing = (
        delivery_safety_block(issue_key, branch, branch_policy=branch_policy)
        + investigation_handoff_block(issue_key)
        if investigating
        else delivery_instructions_block(
            issue_key,
            branch,
            intro="After completing the retry and updating the fix report",
            branch_policy=branch_policy,
        )
    )
    return (
        f"# Agent Retry Prompt: {issue_key}\n\n"
        "## AI Fix Mode\n\n"
        f"- Mode: {mode.name}\n"
        f"- Mode ID: `{mode.id}`\n"
        f"- Execution: {mode.execution_kind}\n\n"
        f"This retry runs under the same Fix Mode as `.ai/{issue_key}/{TASK_ARTIFACT}`. "
        "Follow the mode as written there. BugPilot's safety, evidence and delivery rules "
        "still win any conflict with it.\n\n"
        "## Purpose\n\n"
        f"{purpose}"
        "## Required Reading\n\n"
        f"{chr(10).join(reading)}\n\n"
        "## Developer Feedback\n\n"
        f"{feedback}\n\n"
        "## Previous Attempt Summary\n\n"
        f"{previous}\n\n"
        "## Retry Instructions\n\n"
        f"{retry_instructions}"
        f"{retry_branch_section(branch_policy, branch)}"
        f"{closing}"
        "## Required Output Files\n\n"
        f"- .ai/{issue_key}/{FIX_REPORT_ARTIFACT} — update every section for this attempt: "
        "Summary, Analysis, Changes, Tests, Review Notes. Do not leave a previous "
        "attempt's claims standing where this attempt learned otherwise.\n\n"
        "## How to Run\n\n"
        "Run your AI agent manually from the target repo root and paste:\n\n"
        f"Read .ai/{issue_key}/agent_retry_prompt.md and continue the workflow.\n"
    )


def _previous_attempt_summary(target: Path) -> str:
    text = _read_artifact(target, FIX_REPORT_ARTIFACT)
    if not text:
        return f"### {FIX_REPORT_ARTIFACT}\n\nmissing — the previous attempt left no report."
    return f"### {FIX_REPORT_ARTIFACT}\n\npresent\n\n{_cap_text(text, 2400)}"


def _manual_result_templates(issue_key: str) -> dict[str, str]:
    """The developer-manual-fix skeleton: one report, agent-shaped."""
    return {FIX_REPORT_ARTIFACT: manual_fix_report_template(issue_key)}

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


def _read_artifact(target: Path, file_name: str) -> str:
    path = target / file_name
    if not path.exists():
        return ""
    return path.read_text(encoding="utf-8", errors="replace").strip()


# Presence of this marker enables the "Report Status to Jira (before commit)"
# instruction in the generated task.md. The default is
# to omit that instruction; the marker is written once (by --jira-comment) and read
# back by prompt_step / copilot_task_step so the opt-in survives --resume and
# standalone regeneration.
_JIRA_COMMENT_ON_MARKER = "jira_comment_on.flag"


def _set_jira_comment_on(target: Path) -> None:
    (target / _JIRA_COMMENT_ON_MARKER).write_text("", encoding="utf-8")


def _jira_comment_enabled(target: Path) -> bool:
    return (target / _JIRA_COMMENT_ON_MARKER).exists()


def _cap_text(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[:limit].rstrip() + "\n\n[truncated by bugpilot]"


def _fetch_message(result: JiraFetchResult) -> str:
    if result.source == "mock":
        return f"{result.error_message} Using mock/demo Jira data."
    return "Fetched Jira data from configured Jira instance."


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


def _save_run(repo_root: Path, issue_key: str, run: RunArtifact) -> None:
    """Every ``run.json`` write goes through here, refreshed and atomic.

    The two snapshots — what exists on disk, and the Fix Mode the package is
    recorded under — are recomputed on each write so the file never claims a
    file that was deleted or a mode that was reselected. Atomically, because
    this file is read from *other processes* while a run is in progress: the
    VS Code extension restores its checklist from it and the MCP server's
    ``get_status`` reads it. A torn read parses as nothing, which the panel
    shows as "no progress" for a run that is going fine.
    """
    _prepare_issue_dir(repo_root, issue_key)
    run = replace(
        run,
        generated_files=tuple(_generated_files(repo_root, issue_key)),
        fix_mode=stored_fix_mode_metadata(repo_root, issue_key),
    )
    save_run(repo_root, issue_key, run)


def _start_run(repo_root: Path, issue_key: str, skipped_steps: list[str]) -> None:
    """The run's first write: status ``running``, the disabled steps marked."""
    _save_run(
        repo_root,
        issue_key,
        RunArtifact(work_item_id=issue_key, steps={step: "skipped" for step in skipped_steps}),
    )


def _mark_step(repo_root: Path, issue_key: str, step: str, status: str) -> None:
    run = load_run(repo_root, issue_key) or RunArtifact(work_item_id=issue_key)
    _save_run(repo_root, issue_key, run.with_step(step, status))


def _set_run_status(repo_root: Path, issue_key: str, status: str) -> None:
    """A run-level lifecycle transition. Step marks stay as they are."""
    run = load_run(repo_root, issue_key) or RunArtifact(work_item_id=issue_key)
    _save_run(repo_root, issue_key, replace(run, status=status, error=None))


def _finish_run(repo_root: Path, issue_key: str, steps: dict[str, str]) -> None:
    """The terminal write of a successful prepare: the whole map, restated."""
    _save_run(repo_root, issue_key, RunArtifact(work_item_id=issue_key, status="prepared", steps=steps))


def _fail_run(repo_root: Path, issue_key: str, exc: Exception, step: str | None = None) -> None:
    """Record where a run-level failure happened, in the words the CLI prints.

    Read quietly: this runs inside an exception handler, and a second error
    here would mask the one the caller is about to see. ``step`` is the step
    the caller knows was executing; without one, the fail mark of this run
    names it (a fresh or resumed run starts from a reset map, so the mark is
    this run's own).
    """
    run = read_run_quietly(repo_root, issue_key) or RunArtifact(work_item_id=issue_key)
    failed = step or next((name for name in WORKFLOW_STEPS if run.steps.get(name) == "fail"), None)
    _save_run(
        repo_root,
        issue_key,
        replace(run, status="failed", error=RunError(message=_cap_text(str(exc), 2000), step=failed)),
    )


def _build_result_overview(repo_root: Path, issue_key: str) -> str:
    """What a developer needs after the agent ran: report status + validation.

    Rendered, never persisted: everything here derives from `fix_report.md`,
    `retrieval.json` and the issue, and a second persisted copy of the report
    was exactly the redundancy Batch 5 removed.
    """
    report = read_fix_report(repo_root, issue_key)
    if report is None:
        status_lines = [
            f"- .ai/{issue_key}/{FIX_REPORT_ARTIFACT}: missing",
            "",
            "The agent writes the report; for a developer manual fix run: "
            f"bugpilot manual-result {issue_key}",
        ]
    else:
        missing = report.missing_sections
        status_lines = [f"- .ai/{issue_key}/{FIX_REPORT_ARTIFACT}: present"]
        if missing:
            status_lines.append(f"- Sections still empty: {', '.join(missing)}")
        summary = report.summary or "_The report has no Summary section yet._"
        status_lines += ["", "## Reported Summary", "", _cap_text(summary, 1200)]
    validation = _build_manual_validation(repo_root, issue_key)
    return (
        f"# Result Overview: {issue_key}\n\n"
        "## Fix Report\n\n"
        + "\n".join(status_lines)
        + "\n\n"
        + validation
    )


def _build_manual_validation(repo_root: Path, issue_key: str) -> str:
    checklist = validation_checklist(repo_root, issue_key)
    related_lines = [f"- {path}" for path in checklist.regression_files]
    if checklist.review_risks:
        related_lines.append("- Risks from the report's Review Notes:")
        related_lines.extend(f"  {line}" for line in checklist.review_risks)
    steps = "\n".join(f"{number}. {step}" for number, step in enumerate(checklist.steps, 1))
    return (
        "## Suggested Validation Steps\n\n"
        f"{steps}\n\n"
        "## Regression Areas\n\n"
        f"{chr(10).join(related_lines) if related_lines else '- No related files or review risks available yet.'}\n"
    )


def _build_final_review_prompt(issue_key: str) -> str:
    # Source-, outcome- and provider-neutral: the work item may be a Jira issue
    # or a hand-written bug, and the result an applied fix, an attempt, a no-op
    # or an investigation only — the reviewer reads fix_report.md to learn which.
    #
    # The answer is asked for in review_report.md's four sections, so the
    # extension's Paste Review Output can fill the Review Result form from it.
    # No verdict is asked for: BugPilot records what a reviewer said and never
    # reads a pass, an approval or "verified" out of it.
    return (
        "# Final Review Request\n\n"
        f"Review the BugPilot result for work item {issue_key}.\n\n"
        "Use:\n"
        f"- .ai/{issue_key}/{CONTEXT_ARTIFACT}\n"
        f"- .ai/{issue_key}/{RETRIEVAL_ARTIFACT} if present\n"
        f"- .ai/{issue_key}/{FIX_REPORT_ARTIFACT} if present\n"
        "- current git diff\n\n"
        "Review focus:\n"
        "1. Correctness\n"
        "2. Regression risk\n"
        "3. Whether the result matches the reported issue\n"
        "4. Whether any source change is minimal and safe\n"
        "5. Whether tests are sufficient\n"
        "6. Missing edge cases\n"
        "7. Whether the change touches unrelated code\n"
        "8. Whether memory entry should be updated\n"
        "9. Any follow-up work\n\n"
        "Rules:\n"
        "- Say which conclusions come from reading the code and which from commands you actually ran.\n"
        "- Do not claim that a test or check ran unless you ran it and saw its result.\n"
        "- Do not describe the result as verified unless you name the evidence.\n"
        "- Do not approve the change or call it safe to merge. Report what you found.\n"
        "- If a section has nothing to report, write: Nothing to report.\n\n"
        "Return exactly these four sections, in this order:\n\n"
        "## Summary\n"
        "Your overall review conclusion, in your own words.\n\n"
        "## Findings\n"
        "Specific problems, risks, omissions or observations.\n\n"
        "## Validation Notes\n"
        "What you inspected, and anything you actually ran, with what you observed.\n\n"
        "## Recommendations\n"
        "Suggested next actions.\n"
    )


def _build_final_result_section(report: FixReport) -> str:
    marker = (
        "\n\nReport sections incomplete. Manual update required."
        if report.missing_sections
        else ""
    )
    return (
        "## Final Result\n\n"
        "### Root Cause\n"
        f"{report.analysis or 'TBD'}\n\n"
        "### Fix\n"
        f"{report.changes or 'TBD'}\n\n"
        "### Tests\n"
        f"{report.tests or 'TBD'}\n\n"
        "### Review Notes\n"
        f"{report.review_notes or 'TBD'}{marker}\n\n"
        "### Updated At\n"
        f"{datetime.now(timezone.utc).isoformat()}\n"
    )


def _replace_section(markdown: str, heading: str, replacement: str) -> str:
    start = markdown.find(heading)
    if start == -1:
        return markdown.rstrip() + "\n\n" + replacement
    next_start = markdown.find("\n## ", start + len(heading))
    if next_start == -1:
        return markdown[:start].rstrip() + "\n\n" + replacement
    return markdown[:start].rstrip() + "\n\n" + replacement.rstrip() + "\n" + markdown[next_start:]


def _delivery_warnings(repo_root: Path, issue_key: str) -> list[str]:
    warnings = []
    if not inside_git_repo(repo_root):
        warnings.append("Current directory is not inside a git repository.")
    branch = current_branch(repo_root)
    if not branch:
        warnings.append("Current branch is unavailable.")
    elif branch in PROTECTED_BRANCHES:
        warnings.append(f"Current branch is {branch}; do not deliver directly from main/master.")
    status = working_tree_status(repo_root)
    if status in {None, "clean"}:
        warnings.append("Working tree has no uncommitted changes visible for delivery.")

    warnings.extend(f"Missing required result file: {file_name}" for file_name in check_result_files(repo_root, issue_key))
    report = read_fix_report(repo_root, issue_key)
    if report is not None and report.missing_sections:
        warnings.append(
            "Fix report sections still empty: " + ", ".join(report.missing_sections)
        )
    memory_file = f".ai_memory/bugs/{issue_key}.md"
    if not (repo_root / memory_file).exists():
        warnings.append(f"Missing delivery artifact: {memory_file}")
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
        f"- Confirm {FIX_REPORT_ARTIFACT} is complete.\n"
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
        f"- {FIX_REPORT_ARTIFACT} complete\n"
        "- Final review done\n"
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
    report = read_fix_report(repo_root, issue_key)
    if report is None:
        return "complete AI-assisted bug fix"
    source = report.summary or report.changes
    first_line = next((line.strip("- ").strip() for line in source.splitlines() if line.strip() and line.strip() != "TBD"), "")
    return first_line[:72] or "complete AI-assisted bug fix"


def _attachment_guidance(
    target: Path, previous: IssueGuidance, result: AttachmentResult, *, exact: bool
) -> IssueGuidance:
    """The attachment record after this run's copy: which files, and why each matters.

    ``exact`` (``--replace-attachments``, which the extension always sends): the
    files this run copied are the whole set. A file the previous record named
    and this run did not copy is deleted from ``attachments/`` — only a recorded
    name, through ``remove_attachments``' checks, never anything else in the
    folder — and its description goes with it. A work item with no record yet
    (prepared before §37.99) gets one now; its older files are left on disk but
    are no longer named.

    Not ``exact``: the run adds to what is there, as ``--attach`` always did. A
    record, once kept, grows by what was copied; with none, there still is none
    and the task file reads the folder.
    """
    if exact:
        recorded = previous.attachment_files or ()
        stale = [name for name in recorded if name not in result.copied]
        removed = remove_attachments(target, stale)
        if removed:
            log(target, f"[INFO] removed {len(removed)} attachment(s) no longer selected")
        return replace(previous, attachment_files=tuple(result.copied), attachment_notes=dict(result.notes))
    files = previous.attachment_files
    if files is not None:
        files = tuple(files) + tuple(name for name in result.copied if name not in files)
    return replace(
        previous,
        attachment_files=files,
        attachment_notes=merge_attachment_notes(previous.attachment_notes, result),
    )
