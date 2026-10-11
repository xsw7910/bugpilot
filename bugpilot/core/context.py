"""Build the context an agent reads first: ``context.md``.

One document from four inputs held in memory — the normalized issue, the
retrieval, and the git-history and similar-fixes results — so nothing is read
back from an intermediate file. It used to be assembled by pasting whole
sub-documents together, which left three `## Issue` headings and two
`## Status` headings in one file; each input now owns one section, and the
sub-documents' own headings sit one level below it.
"""

from __future__ import annotations

from dataclasses import dataclass

from .artifacts import RETRIEVAL_ARTIFACT, TASK_ARTIFACT
from .git_history import GitHistoryOutcome, render_git_context
from .issue import IssueArtifact
from .jira import COMMENT_SIGNAL_TERMS
from .retrieval import RelatedFile, RetrievalArtifact


def build_context(
    issue: IssueArtifact,
    keywords: dict[str, object],
    retrieval: RetrievalArtifact | None,
    git_history: GitHistoryOutcome | None = None,
    similar_fixes: str | None = None,
) -> str:
    """The context document.

    ``retrieval`` is ``None`` when the search did not run, ``git_history`` and
    ``similar_fixes`` when those steps did not; each dependent section then says
    so instead of guessing. The two text results are what
    Git history arrives as the structured outcome the Git history step
    produced — the same record it wrote into ``retrieval.json`` — and is rendered
    by ``git_history.render_git_context``, the one renderer of the commit list;
    similar fixes as the Markdown ``memory.search_memory`` returns.
    """
    quality = context_quality(issue, keywords, retrieval, similar_fixes or "", git_history)
    return (
        f"# Bug Context: {issue.id}\n\n"
        "## Scope\n\n"
        "BugPilot prepares context only. It does not modify source code, invoke an agent automatically, "
        "create commits, push branches, update Jira, or create pull requests.\n\n"
        "## Issue\n\n"
        f"- ID: {issue.id}\n"
        f"- Source: {'Jira issue' if issue.is_jira else 'Hand-written description'}\n"
        f"- Summary: {issue.title}\n"
        f"- Type: {issue.details.issue_type}\n"
        f"- Status: {issue.details.status}\n"
        f"- Priority: {issue.details.priority}\n"
        f"- Mock/demo data: {issue.details.mock}\n\n"
        + _caution_markdown(issue)
        + "## Guidance\n\n"
        f"{_guidance_markdown(issue)}\n\n"
        "## Context Quality\n\n"
        f"{_quality_markdown(quality)}\n\n"
        "## Issue Details\n\n"
        f"{_issue_details_markdown(issue)}\n\n"
        "## Code Search\n\n"
        "### Search Quality\n\n"
        f"{_search_quality_markdown(retrieval)}\n\n"
        "Agent instruction: If search confidence is Low, do not assume the matched files are the correct implementation. "
        "Treat them as candidates only and first verify whether the feature exists in the codebase.\n\n"
        "### Search Terms\n\n"
        f"{_search_terms_markdown(keywords)}\n\n"
        "### Relevant Files\n\n"
        f"See `.ai/{issue.id}/{RETRIEVAL_ARTIFACT}` for the ranked files, their matched lines "
        "and the search terms.\n\n"
        f"{_relevant_files_markdown(retrieval)}\n\n"
        "### Relevant Snippets\n\n"
        f"{_matched_lines_excerpt(retrieval)}\n\n"
        "## Similar Fixes\n\n"
        f"{_similar_fixes_markdown(similar_fixes)}\n\n"
        "## Git History\n\n"
        f"{_git_history_markdown(git_history)}\n"
    )


def _guidance_markdown(issue: IssueArtifact) -> str:
    """The hint and Fix Mode this work item runs under, from ``issue.json``.

    Only what they are: how the mode tells the agent to work is ``task.md``'s
    business, and repeating it here would be a second copy to drift.
    """
    # On one line: the hint comes from a textarea, and a raw newline here would
    # end the bullet — a line starting with `#` would even become a heading. The
    # full text, line breaks kept, is in `task.md`'s Developer Hint section.
    hint = " ".join((issue.guidance.hint or "").split()) or "_None._"
    record = issue.guidance.fix_mode or {}
    mode_id = record.get("id")
    mode = f"{record.get('name') or mode_id} (`{mode_id}`)" if mode_id else "_Not recorded._"
    return (
        f"- Developer hint: {hint}\n"
        f"- AI Fix Mode: {mode}. `{TASK_ARTIFACT}` carries what it asks of the agent."
    )


def _search_terms_markdown(keywords: dict[str, object]) -> str:
    def listed(key: str) -> str:
        values = keywords.get(key)
        return ", ".join(map(str, values)) if isinstance(values, list) and values else "_None_"

    lines = [
        f"- High value: {listed('high_value_keywords')}",
        f"- Normal: {listed('normal_keywords')}",
        f"- Phrases: {listed('phrase_keywords')}",
    ]
    # What was deliberately not searched (§42.3), so the reader knows it was
    # seen: it is still in the Issue Details above.
    origins = keywords.get("term_origins")
    environment = [
        str(value)
        for key in ("high_value_keywords", "normal_keywords")
        for value in (keywords.get(key) or [])
        if isinstance(origins, dict) and list(origins.get(str(value).lower(), [])) == ["environment"]
    ]
    if environment:
        lines.append(f"- Not searched, environment only: {', '.join(environment)}")
    noise = keywords.get("noise_keywords")
    if isinstance(noise, list) and noise:
        lines.append(f"- Not searched, host or machine names: {', '.join(map(str, noise))}")
    return "\n".join(lines)


def _demote(markdown: str) -> str:
    """A sub-document's headings, one level down and without its title.

    So a section's own `##` headings sit under the `##` it is placed in rather
    than beside it — the seam that used to leave two `## Status` headings in one
    document.
    """
    lines = []
    for line in markdown.splitlines():
        if line.startswith("# "):
            continue
        lines.append("#" + line if line.startswith("#") else line)
    return "\n".join(lines).strip()


_NOT_SPECIFIED = "Not specified."
# The newest comments are the ones most likely to change the picture.
COMMENT_RENDER_LIMIT = 10


def _jira_fields_markdown(issue: IssueArtifact) -> str:
    """The Jira fields no other section shows. People's names are not kept."""
    details = issue.details

    def joined(values: tuple[str, ...]) -> str:
        return ", ".join(values) or "None."

    return (
        f"- Data source: {'mock/demo fallback' if details.mock else 'jira'}\n"
        f"- Mock/demo Jira data: {'yes' if details.mock else 'no'}\n"
        f"- Resolution: {details.resolution or _NOT_SPECIFIED}\n"
        f"- Labels: {joined(details.labels)}\n"
        f"- Components: {joined(details.components)}\n"
        f"- Affected versions: {joined(details.affected_versions)}\n"
        f"- Fix versions: {joined(details.fix_versions)}"
    )


def _comments_markdown(issue: IssueArtifact) -> str:
    if not issue.comments:
        return "No comments found."
    total = len(issue.comments)
    visible = issue.comments[-COMMENT_RENDER_LIMIT:]
    note = f"Showing latest {len(visible)} of {total} comments.\n\n" if total > COMMENT_RENDER_LIMIT else ""
    sections = []
    for index, comment in enumerate(visible, start=1):
        meta = f"Created: {comment.created}\n\n" if comment.created else ""
        body = comment.body.strip() or "_No comment body available._"
        sections.append(f"#### Comment {index}\n\n{meta}{body}")
    return note + "\n\n".join(sections)


def _attachments_markdown(issue: IssueArtifact) -> str:
    attachments = issue.details.attachments
    if not attachments:
        return "No attachments found.\n\nAttachment content is not downloaded by bugpilot."
    lines = [
        "Attachment content is not downloaded by bugpilot.",
        "",
        "| Filename | Type | Size | Created |",
        "|---|---|---:|---|",
    ]
    for attachment in attachments:
        lines.append(
            f"| {_table_cell(attachment.filename)} | {_table_cell(attachment.kind)} "
            f"| {_format_size(attachment.size)} | {_table_cell(attachment.created)} |"
        )
    return "\n".join(lines)


def _bullets(values: tuple[str, ...], empty: str, quote: bool = False) -> str:
    if not values:
        return empty
    return "\n".join(f'- "{value}"' if quote else f"- {value}" for value in values)


def _issue_details_markdown(issue: IssueArtifact) -> str:
    """The report, then what the parser extracted from it: one section, both sources.

    The description is shown for a hand-written bug too; it used to reach the
    context only through the Jira summary, so a manual bug's own words were
    missing from the document written for the agent.
    """
    details = issue.details
    steps = details.reproduction_steps
    steps_text = "\n".join(f"{i}. {step}" for i, step in enumerate(steps, 1)) if steps else "Not found."
    traces = issue.signals.stack_traces
    traces_text = "\n\n".join(f"```\n{trace}\n```" for trace in traces) if traces else "None found."
    comment_text = "\n".join(comment.body for comment in issue.comments).lower()
    comment_signals = [term for term in COMMENT_SIGNAL_TERMS if term in comment_text]
    latest_comment = max((c.created for c in issue.comments if c.created), default="")
    attachment_kinds = sorted({attachment.kind for attachment in details.attachments})
    missing = _bullets(details.missing_information, "- No missing information identified.")
    jira = (
        "### Jira Fields\n\n"
        f"{_jira_fields_markdown(issue)}\n\n"
        "### Comments\n\n"
        f"{_comments_markdown(issue)}\n\n"
        "### Attachments\n\n"
        f"{_attachments_markdown(issue)}\n\n"
        if issue.is_jira
        else ""
    )
    reading = (
        "\n\n### Reading Comments and Attachments\n\n"
        "- Use Jira comments as additional context; comments may be newer than the original description.\n"
        "- Review Attachment Signals and attachment metadata when present.\n"
        "- Do not assume attachment content was read unless the content appears in repository files or generated artifacts.\n"
        "- If a log or crash dump attachment exists but was not downloaded, note attachment review as a follow-up."
        if issue.is_jira
        else ""
    )
    return (
        "### Description\n\n"
        f"{issue.description or _NOT_SPECIFIED}\n\n"
        f"{jira}"
        "### Reproduction Steps\n\n"
        f"{steps_text}\n\n"
        "### Actual Result\n\n"
        f"{details.actual_result.strip() or 'Not found.'}\n\n"
        "### Expected Result\n\n"
        f"{details.expected_result.strip() or 'Not found.'}\n\n"
        "### Environment / Version\n\n"
        f"{details.environment.strip() or 'Not found.'}\n\n"
        "### Error Messages\n\n"
        f"{_bullets(issue.signals.error_messages, 'None found.')}\n\n"
        "### Stack Traces\n\n"
        f"{traces_text}\n\n"
        "### Log Signals\n\n"
        f"{_bullets(issue.signals.log_signals, 'None found.')}\n\n"
        "### Regression Signals\n\n"
        f"{_bullets(details.regression_signals, 'None found.', quote=True)}\n\n"
        "### Comment Signals\n\n"
        f"- Number of comments: {len(issue.comments)}\n"
        f"- Latest comment timestamp: {latest_comment or '_None_'}\n"
        f"- Signals found: {', '.join(comment_signals) or '_None_'}\n\n"
        "### Attachment Signals\n\n"
        f"- Number of attachments: {len(details.attachments)}\n"
        f"- Attachment kinds found: {', '.join(attachment_kinds) or '_None_'}\n\n"
        "### Missing Information Checklist\n\n"
        f"{missing}"
        f"{reading}"
    )


def _format_size(size: int) -> str:
    if size >= 1024 * 1024:
        return f"{size / (1024 * 1024):.1f} MB"
    if size >= 1024:
        return f"{round(size / 1024)} KB"
    return f"{size} B"


def _table_cell(value: str) -> str:
    return value.replace("|", "\\|")


#: How many lines of matched-line evidence the context carries; the rest is in
#: retrieval.json.
_SNIPPET_EXCERPT_LINES = 25


def _related_file_line(item: RelatedFile) -> str:
    return (
        f"- `{item.file}` confidence={item.confidence} score={item.score} "
        f"matches={item.match_count} keywords={', '.join(item.matched_keywords)}"
    )


def _relevant_files_markdown(retrieval: RetrievalArtifact | None) -> str:
    """Every ranked file on one line each — all of them.

    This is the one list that names every file the search kept, and
    `--max-files` already bounds it at retrieval. A cap here would be a second,
    silent one: it used to be ten, the panel's row limit and the default, so a
    developer who asked for eleven files got a context naming ten (§37.12).
    It also replaces a separate top-five list that repeated its first lines.

    Search warnings are not repeated here: they are already listed under Search
    Quality, as reasons.
    """
    if retrieval is None:
        return "_Code search has not been generated yet._"
    if not retrieval.related_files:
        return "_No related files found._"
    return "\n".join(_related_file_line(item) for item in retrieval.related_files)


def _search_quality_markdown(retrieval: RetrievalArtifact | None) -> str:
    if retrieval is None:
        return "_Search quality has not been generated yet._"
    lines = [f"Confidence: {retrieval.confidence.title()}", "", "Reasons:"]
    if retrieval.reasons:
        lines.extend(f"- {reason}" for reason in retrieval.reasons)
    else:
        lines.append("- No search quality reasons available.")
    return "\n".join(lines)


def _matched_lines_excerpt(retrieval: RetrievalArtifact | None) -> str:
    """The first matched lines, file by file, in rank order."""
    if retrieval is None:
        return "_No matched snippets available._"
    lines: list[str] = []
    for item in retrieval.related_files:
        if not item.snippets:
            continue
        lines.extend([f"#### {item.file}", ""])
        lines.extend(f"- Line {snippet.line}: `{snippet.text}`" for snippet in item.snippets)
        lines.append("")
    # One line fewer than the budget: the old report's excerpt spent its first
    # line on the blank under the section heading.
    excerpt = "\n".join(lines[: _SNIPPET_EXCERPT_LINES - 1]).strip()
    return excerpt or "_No matched snippets available._"


def _similar_fixes_markdown(similar_fixes: str | None) -> str:
    if similar_fixes is None:
        return "_Memory search has not been generated yet._"
    return _section_excerpt(similar_fixes, "## Similar Historical Issues") or "No similar memory entries found."


def _git_history_markdown(git_history: GitHistoryOutcome | None) -> str:
    if git_history is None:
        return "_Git context has not been generated yet._"
    return _demote(render_git_context(git_history))


def _section_excerpt(markdown: str, heading: str, max_lines: int = 12) -> str:
    lines = markdown.splitlines()
    try:
        start = lines.index(heading) + 1
    except ValueError:
        return ""
    collected = []
    for line in lines[start:]:
        if line.startswith("## ") and collected:
            break
        collected.append(line)
        if len(collected) >= max_lines:
            break
    return "\n".join(collected).strip()


# Jira states that mean the issue is not open work. Deliberately a small,
# explicit set: an unfamiliar workflow falls through and says nothing, which is
# better than labelling a live issue as settled.
_SETTLED_STATUSES = {"closed", "done", "resolved", "cancelled", "canceled"}


def _caution_markdown(issue: IssueArtifact) -> str:
    """Facts about the issue that change what the reader should do.

    A real run prepared a complete fix package — branch name, fix workflow,
    twenty-three files — for an issue that was Closed, resolved "Won't Do", and
    typed Task rather than Bug. All three facts were *in* the package; none of
    them was pointed at. The agent that read it was careful enough to notice; a
    less careful one starts editing.

    This states the facts and stops. bugpilot prepares context; whether to work
    a resolved issue is the developer's call.
    """
    status = issue.details.status.strip()
    resolution = issue.details.resolution.strip()
    issue_type = issue.details.issue_type.strip()

    cautions: list[str] = []
    if status.lower() in _SETTLED_STATUSES:
        detail = f"{status} (resolution: {resolution})" if resolution else status
        cautions.append(
            f"This issue is already {detail}. Preparing this package did not reopen it — "
            "check with the reporter before working it."
        )
    if issue_type and issue_type.lower() not in {"bug", "defect"}:
        cautions.append(
            f"Jira types this as {issue_type}, not a Bug. Expect a request rather than a "
            "failure: there may be no reproduction steps to follow and nothing broken to fix."
        )
    if not cautions:
        return ""
    return "## Caution\n\n" + "\n".join(f"- {line}" for line in cautions) + "\n\n"


# --- Context Quality v2 (0.1.3, §42.3) ---------------------------------------------------
#
# v1 was one sum — a description, any high-value keyword, files weighted by the
# search's confidence, similar fixes, git — and a report with no reproduction
# steps, no actual and no expected result still scored 90/100. v2 scores three
# things apart and shows each: how complete the report is, how good the search
# was, how much repository history came with it. The overall is their weighted
# sum, capped when the report says nothing about how to see the bug or what
# should have happened. Deterministic, from fields the issue already has.

#: What each part of the report is worth to Issue completeness; they add up to 100.
ISSUE_COMPLETENESS_POINTS = (
    ("description", 25),
    ("reproduction steps", 20),
    ("actual result", 15),
    ("expected result", 15),
    ("environment", 10),
    ("errors, stack traces or logs", 10),
    ("attachments", 5),
)
#: Retrieval quality: by Search Confidence, then for how much of the issue the
#: best-ranked file holds, and for a strong or phrase match in it.
RETRIEVAL_CONFIDENCE_POINTS = {"high": 60, "medium": 35, "low": 10}
RETRIEVAL_COVERAGE_POINTS = 25
RETRIEVAL_STRONG_POINTS = 15
#: Repository context: the history step ran in a repository, it found related
#: commits, similar past fixes were found.
REPOSITORY_GIT_POINTS = 40
REPOSITORY_COMMIT_POINTS = 30
REPOSITORY_SIMILAR_FIX_POINTS = 30
#: How the overall weighs the three parts, in percent.
OVERALL_WEIGHTS = (("issue", 40), ("retrieval", 40), ("repository", 20))
#: The most the overall can be when the report has none of reproduction steps,
#: actual result and expected result. Materially below the 90 v1 gave such a
#: report: an agent reading it has to find out how to see the bug first.
MISSING_CORE_EVIDENCE_CAP = 75
#: The three whose absence caps the overall.
CORE_EVIDENCE = ("reproduction steps", "actual result", "expected result")


@dataclass(frozen=True)
class ContextQuality:
    """The context's quality, by part, and the lines that explain it."""

    overall: int
    issue_completeness: int
    retrieval_quality: int
    repository_context: int
    #: The cap that applied, when the report lacks all of ``CORE_EVIDENCE``.
    cap: int | None
    signals: tuple[str, ...]


def context_quality(
    issue: IssueArtifact,
    keywords: dict[str, object],
    retrieval: RetrievalArtifact | None,
    memory_search: str,
    git_context: GitHistoryOutcome | None,
) -> ContextQuality:
    present = _issue_parts(issue)
    issue_score = sum(points for part, points in ISSUE_COMPLETENESS_POINTS if present[part])

    confidence = retrieval.confidence.lower() if retrieval is not None else "low"
    file_count = len(retrieval.related_files) if retrieval is not None else 0
    details = retrieval.confidence_details if retrieval is not None else None
    retrieval_score = 0
    if file_count:
        retrieval_score = RETRIEVAL_CONFIDENCE_POINTS.get(confidence, 0)
        if details is not None and details.core_terms_matched:
            retrieval_score += _half_up(RETRIEVAL_COVERAGE_POINTS * details.core_terms_in_top_file, details.core_terms_matched)
            if details.strong_terms_in_top_file or details.phrase_in_top_file:
                retrieval_score += RETRIEVAL_STRONG_POINTS
        elif details is None and confidence == "high":
            # A retrieval written before 0.1.3 says only its level.
            retrieval_score += RETRIEVAL_COVERAGE_POINTS + RETRIEVAL_STRONG_POINTS
    retrieval_score = min(retrieval_score, 100)

    similar = bool(memory_search) and "No similar memory entries found." not in memory_search
    commits = len(git_context.record.commits) if _git_available(git_context) else 0
    repository_score = (
        (REPOSITORY_GIT_POINTS if _git_available(git_context) else 0)
        + (REPOSITORY_COMMIT_POINTS if commits else 0)
        + (REPOSITORY_SIMILAR_FIX_POINTS if similar else 0)
    )

    parts = {"issue": issue_score, "retrieval": retrieval_score, "repository": repository_score}
    overall = _half_up(sum(parts[name] * weight for name, weight in OVERALL_WEIGHTS), 100)
    missing_core = [part for part in CORE_EVIDENCE if not present[part]]
    cap = MISSING_CORE_EVIDENCE_CAP if len(missing_core) == len(CORE_EVIDENCE) else None
    if cap is not None:
        overall = min(overall, cap)

    signals = [
        *(f"{part.capitalize()} found: {'yes' if present[part] else 'no'}" for part, _points in ISSUE_COMPLETENESS_POINTS),
        f"High-value keywords found: {len(keywords.get('high_value_keywords', []))}",
        # The confidence rides with the count, because the count alone reads as
        # good news even when every file on the list is a generic-word match.
        f"Related files found: {file_count} (search confidence: {confidence})",
    ]
    if details is not None and details.core_terms_matched:
        signals.append(
            f"Issue concepts in the best-ranked file: {details.core_terms_in_top_file} of {details.core_terms_matched}"
        )
    signals += [
        f"Memory search results found: {'yes' if similar else 'no'}",
        f"Git context available: {'yes' if _git_available(git_context) else 'no'}",
        f"Related commits found: {commits}",
    ]
    if cap is not None:
        signals.append(
            f"Overall at most {cap}: the report has no reproduction steps, actual result or expected result."
        )
    return ContextQuality(
        overall=overall,
        issue_completeness=issue_score,
        retrieval_quality=retrieval_score,
        repository_context=repository_score,
        cap=cap,
        signals=tuple(signals),
    )


def _half_up(numerator: int, denominator: int) -> int:
    """``numerator / denominator`` rounded half up: 12.5 is 13, as a reader expects."""
    return (2 * numerator + denominator) // (2 * denominator)


def _issue_parts(issue: IssueArtifact) -> dict[str, bool]:
    """Which parts of the report are there, read from the fields the parser filled."""
    details = issue.details
    signals = issue.signals
    return {
        "description": bool(issue.description.strip()),
        "reproduction steps": bool(details.reproduction_steps),
        "actual result": bool(details.actual_result.strip()),
        "expected result": bool(details.expected_result.strip()),
        "environment": bool(details.environment.strip()),
        "errors, stack traces or logs": bool(signals.error_messages or signals.stack_traces or signals.log_signals),
        # The report's own attachments, or files the developer attached to this work item.
        "attachments": bool(details.attachments or issue.guidance.attachment_files or issue.guidance.attachment_notes),
    }


def _quality_markdown(quality: ContextQuality) -> str:
    weights = ", ".join(f"{weight}% {_PART_NAMES[name]}" for name, weight in OVERALL_WEIGHTS)
    return (
        f"Overall: {quality.overall}/100\n"
        f"Issue completeness: {quality.issue_completeness}/100\n"
        f"Retrieval quality: {quality.retrieval_quality}/100\n"
        f"Repository context: {quality.repository_context}/100\n\n"
        f"Overall is {weights}.\n\n"
        + "\n".join(f"- {signal}" for signal in quality.signals)
    )


_PART_NAMES = {"issue": "issue completeness", "retrieval": "retrieval quality", "repository": "repository context"}


def _git_available(git_context: GitHistoryOutcome | None) -> bool:
    """The step ran in a repository git could read — whatever it then found."""
    return git_context is not None and git_context.record.status != "unavailable"
