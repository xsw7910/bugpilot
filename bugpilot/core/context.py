"""Build the context an agent reads first: ``context.md``.

One document from four inputs held in memory — the normalized issue, the
retrieval, and the git-history and similar-fixes results — so nothing is read
back from an intermediate file. It used to be assembled by pasting whole
sub-documents together, which left three `## Issue` headings and two
`## Status` headings in one file; each input now owns one section, and the
sub-documents' own headings sit one level below it.
"""

from __future__ import annotations

from .artifacts import RETRIEVAL_ARTIFACT, TASK_ARTIFACT
from .issue import IssueArtifact
from .jira import COMMENT_SIGNAL_TERMS
from .retrieval import RelatedFile, RetrievalArtifact


def build_context(
    issue: IssueArtifact,
    keywords: dict[str, object],
    retrieval: RetrievalArtifact | None,
    git_history: str | None = None,
    similar_fixes: str | None = None,
) -> str:
    """The context document.

    ``retrieval`` is ``None`` when the search did not run, ``git_history`` and
    ``similar_fixes`` when those steps did not; each dependent section then says
    so instead of guessing. The two text results are what
    ``git_ops.generate_git_context`` and ``memory.search_memory`` return.
    """
    quality, signals = _quality_score(issue, keywords, retrieval, similar_fixes or "", git_history or "")
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
        f"Score: {quality}/100\n\n"
        + "\n".join(f"- {signal}" for signal in signals)
        + "\n\n"
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

    return (
        f"- High value: {listed('high_value_keywords')}\n"
        f"- Normal: {listed('normal_keywords')}\n"
        f"- Phrases: {listed('phrase_keywords')}"
    )


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


def _git_history_markdown(git_history: str | None) -> str:
    if git_history is None:
        return "_Git context has not been generated yet._"
    return _demote(git_history)


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


# What a file list is worth, by how much the search believes in it. Counting
# files without regard to confidence is how a run whose own search reported
# "low, zero high-confidence files" still announced 90/100 — a headline that
# contradicted the section printed directly beneath it, and the first thing an
# agent reads.
_RELATED_FILE_POINTS = {"high": 25, "medium": 12, "low": 4}


def _quality_score(
    issue: IssueArtifact,
    keywords: dict[str, object],
    retrieval: RetrievalArtifact | None,
    memory_search: str,
    git_context: str,
) -> tuple[int, list[str]]:
    confidence = retrieval.confidence.lower() if retrieval is not None else "low"
    file_count = len(retrieval.related_files) if retrieval is not None else 0
    signals = [
        f"Jira description found: {'yes' if issue.description else 'no'}",
        f"High-value keywords found: {len(keywords.get('high_value_keywords', []))}",
        # The confidence rides with the count, because the count alone reads as
        # good news even when every file on the list is a generic-word match.
        f"Related files found: {file_count} (search confidence: {confidence})",
        f"Memory search results found: {'yes' if memory_search and 'No similar memory entries found.' not in memory_search else 'no'}",
        f"Git context available: {'yes' if git_context and '## Warning' not in git_context else 'no'}",
    ]
    score = 20
    if issue.description:
        score += 20
    if keywords.get("high_value_keywords"):
        score += 20
    if file_count:
        score += _RELATED_FILE_POINTS.get(confidence, 4)
    if memory_search and "No similar memory entries found." not in memory_search:
        score += 10
    if git_context and "## Warning" not in git_context:
        score += 5
    return min(score, 100), signals
