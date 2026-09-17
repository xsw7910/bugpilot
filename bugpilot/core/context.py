"""Build AI-ready bug context."""

from __future__ import annotations

import json
from pathlib import Path


def build_context(repo_root: Path, issue_key: str, parsed: dict[str, object], keywords: dict[str, object]) -> str:
    target = repo_root / ".ai" / issue_key
    related_files = _read_json(target / "related_files.json", [])
    search_quality = _read_json(target / "search_quality.json", {})
    code_search = _read_text(target / "code_search.md")
    memory_search = _read_text(target / "memory_search.md")
    git_context = _read_text(target / "git_context.md")
    jira_parsed = _read_text(target / "jira_parsed.md")
    jira_summary = _read_text(target / "jira_summary.md")
    quality, signals = _quality_score(
        parsed, keywords, related_files, search_quality, memory_search, git_context
    )
    high_value = keywords.get("high_value_keywords", [])
    normal = keywords.get("normal_keywords", [])
    return (
        f"# Bug Context: {issue_key}\n\n"
        "## Scope\n\n"
        "Phase 2 prepares context only. bugpilot does not modify source code, invoke an agent automatically, "
        "create commits, push branches, update Jira, or create pull requests.\n\n"
        "## Issue\n\n"
        f"- Summary: {parsed.get('summary', '')}\n"
        f"- Type: {parsed.get('issue_type', '')}\n"
        f"- Status: {parsed.get('status', '')}\n"
        f"- Priority: {parsed.get('priority', '')}\n"
        f"- Mock/demo data: {parsed.get('is_mock', False)}\n\n"
        + _caution_markdown(parsed)
        + "## Context Quality\n\n"
        f"Score: {quality}/100\n\n"
        + "\n".join(f"- {signal}" for signal in signals)
        + "\n\n"
        "## Jira Summary\n\n"
        f"{_strip_heading(jira_summary) or '_No Jira summary available._'}\n\n"
        "## Parsed Jira Information\n\n"
        f"{_strip_heading(jira_parsed) or '_No parsed Jira information available._'}\n\n"
        "## Jira Comment And Attachment Guidance\n\n"
        "- Use Jira comments as additional context; comments may be newer than the original description.\n"
        "- Review Attachment Signals and attachment metadata when present.\n"
        "- Do not assume attachment content was read unless the content appears in repository files or generated artifacts.\n"
        "- If a log or crash dump attachment exists but was not downloaded, note attachment review as a follow-up.\n\n"
        "## Extracted Keywords\n\n"
        f"- High value: {', '.join(map(str, high_value)) or '_None_'}\n"
        f"- Normal: {', '.join(map(str, normal)) or '_None_'}\n\n"
        "```json\n"
        f"{json.dumps(keywords, indent=2, sort_keys=True)}\n"
        "```\n\n"
        "## Code Search Summary\n\n"
        f"See `.ai/{issue_key}/code_search.md` for full matched lines and snippets.\n\n"
        f"{_code_search_summary(code_search)}\n\n"
        "## Code Search Quality\n\n"
        f"{_search_quality_markdown(search_quality)}\n\n"
        "Agent instruction: If search confidence is Low, do not assume the matched files are the correct implementation. "
        "Treat them as candidates only and first verify whether the feature exists in the codebase.\n\n"
        "## Top Related Files\n\n"
        f"{_related_files_markdown(related_files)}\n\n"
        "## Relevant Snippets\n\n"
        f"{_matched_lines_excerpt(code_search)}\n\n"
        "## Similar Historical Issues\n\n"
        f"{_memory_summary(memory_search)}\n\n"
        "## Git Context\n\n"
        f"{_git_summary(git_context)}\n"
    )


def _read_json(path: Path, default: object) -> object:
    if not path.exists():
        return default
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError:
        return default


def _read_text(path: Path) -> str:
    return path.read_text(encoding="utf-8") if path.exists() else ""


def _strip_heading(markdown: str) -> str:
    return "\n".join(line for line in markdown.splitlines() if not line.startswith("# ")).strip()


def _code_search_summary(code_search: str) -> str:
    if not code_search:
        return "_Code search has not been generated yet._"
    related = _section_excerpt(code_search, "## Top Related Files")
    warnings = _section_excerpt(code_search, "## Warnings")
    if related and "_No related files found._" not in related:
        if warnings:
            return f"{related}\n\nWarnings:\n{warnings}"
        return related
    return warnings or related


def _related_files_markdown(related_files: object) -> str:
    if not isinstance(related_files, list) or not related_files:
        return "_No related files found._"
    lines = []
    for item in related_files[:5]:
        if not isinstance(item, dict):
            continue
        lines.append(
            f"- `{item.get('file')}` confidence={item.get('confidence', 'unknown')} score={item.get('score')} "
            f"matches={item.get('match_count')} keywords={', '.join(item.get('matched_keywords', []))}"
        )
    return "\n".join(lines) or "_No related files found._"


def _search_quality_markdown(search_quality: object) -> str:
    if not isinstance(search_quality, dict) or not search_quality:
        return "_Search quality has not been generated yet._"
    confidence = str(search_quality.get("confidence", "low")).title()
    reasons = search_quality.get("reasons", [])
    lines = [f"Confidence: {confidence}", "", "Reasons:"]
    if isinstance(reasons, list) and reasons:
        lines.extend(f"- {reason}" for reason in reasons)
    else:
        lines.append("- No search quality reasons available.")
    return "\n".join(lines)


def _matched_lines_excerpt(code_search: str) -> str:
    excerpt = _section_excerpt(code_search, "## Matched Lines", max_lines=25)
    return excerpt or "_No matched snippets available._"


def _memory_summary(memory_search: str) -> str:
    if not memory_search:
        return "_Memory search has not been generated yet._"
    return _section_excerpt(memory_search, "## Similar Historical Issues") or "No similar memory entries found."


def _git_summary(git_context: str) -> str:
    if not git_context:
        return "_Git context has not been generated yet._"
    return _strip_heading(git_context)


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


def _caution_markdown(parsed: dict[str, object]) -> str:
    """Facts about the issue that change what the reader should do.

    A real run prepared a complete fix package — branch name, fix workflow,
    twenty-three files — for an issue that was Closed, resolved "Won't Do", and
    typed Task rather than Bug. All three facts were *in* the package; none of
    them was pointed at. The agent that read it was careful enough to notice; a
    less careful one starts editing.

    This states the facts and stops. bugpilot prepares context; whether to work
    a resolved issue is the developer's call.
    """
    status = str(parsed.get("status") or "").strip()
    resolution = str(parsed.get("resolution") or "").strip()
    issue_type = str(parsed.get("issue_type") or "").strip()

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
    parsed: dict[str, object],
    keywords: dict[str, object],
    related_files: object,
    search_quality: object,
    memory_search: str,
    git_context: str,
) -> tuple[int, list[str]]:
    confidence = "low"
    if isinstance(search_quality, dict):
        confidence = str(search_quality.get("confidence", "low")).lower()
    file_count = len(related_files) if isinstance(related_files, list) else 0
    signals = [
        f"Jira description found: {'yes' if parsed.get('description') else 'no'}",
        f"High-value keywords found: {len(keywords.get('high_value_keywords', []))}",
        # The confidence rides with the count, because the count alone reads as
        # good news even when every file on the list is a generic-word match.
        f"Related files found: {file_count} (search confidence: {confidence})",
        f"Memory search results found: {'yes' if memory_search and 'No similar memory entries found.' not in memory_search else 'no'}",
        f"Git context available: {'yes' if git_context and '## Warning' not in git_context else 'no'}",
    ]
    score = 20
    if parsed.get("description"):
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
