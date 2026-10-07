"""Shared markdown memory helpers."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from pathlib import Path

from .artifacts import RETRIEVAL_ARTIFACT
from .config import memory_dir
from .identity import is_known_work_item_id
from .issue import IssueArtifact
from .models import DEFAULT_MAX_SIMILAR_FIXES


def build_memory_entry(issue_key: str, issue: IssueArtifact, context_path: str) -> str:
    now = datetime.now(timezone.utc).isoformat()
    return (
        f"# {issue_key} AI Bug Workflow Memory\n\n"
        f"- Created: {now}\n"
        f"- Mode: prepare-only\n"
        f"- Summary: {issue.title}\n"
        f"- Mock/demo Jira data: {issue.details.mock}\n"
        f"- Context: {context_path}\n\n"
        "## Investigation State\n\n"
        "Prototype prepare-only workflow generated this memory entry during preparation. "
        "No code fix has been attempted by bugpilot.\n\n"
        "## Code Search Summary\n\n"
        f"See `.ai/{issue_key}/{RETRIEVAL_ARTIFACT}`.\n\n"
        "## Related Files\n\n"
        f"See `.ai/{issue_key}/{RETRIEVAL_ARTIFACT}`.\n"
    )


def add_memory_entry(repo_root: Path, issue_key: str, content: str) -> Path:
    memory_path = repo_root / ".ai_memory" / "bugs" / f"{issue_key}.md"
    memory_path.parent.mkdir(parents=True, exist_ok=True)
    memory_path.write_text(content, encoding="utf-8")
    return memory_path


def search_memory(
    repo_root: Path,
    query: str,
    extracted: dict[str, object] | None = None,
    *,
    terms: list[str] | None = None,
    max_results: int = DEFAULT_MAX_SIMILAR_FIXES,
) -> tuple[str | None, str, list[dict[str, object]]]:
    """Score stored memories against a query. Read-only: nothing is written.

    Returns the matched id (or ``None`` for free text), a Markdown report and
    the results. The pipeline renders the report into ``context.md`` from
    memory; it is never written beside it, and a caller merely answering a
    question cannot create a work item directory for an id never prepared.

    ``terms`` are the words to score, already composed by the caller — the
    Similar fixes step's issue terms, shared Keywords and Additional Keywords
    (``workflow.similar_fixes_terms``) — and used as given. Without them,
    ``extracted`` is the work item's keyword extraction, handed over by the
    caller that holds it; without that too, the query's own words are scored.

    ``max_results`` is how many of the best matches are kept: Max Similar
    Fixes. A count below one keeps the default rather than nothing.
    """
    # Only a Jira key or a local id counts as a work item lookup; everything
    # else is free text scored against stored memories. The permissive
    # directory-name check would misread terms like `utf-8` as an id.
    candidate = query.strip()
    issue_key = candidate if is_known_work_item_id(candidate) else None
    keywords = list(terms) if terms is not None else _query_keywords(query, issue_key, extracted)
    if isinstance(max_results, bool) or not isinstance(max_results, int) or max_results < 1:
        max_results = DEFAULT_MAX_SIMILAR_FIXES
    # No memory folder, or an empty one: nothing to read and nothing to say
    # beyond the report's own "none found" — no error, no file.
    memories = sorted(memory_dir(repo_root).glob("*.md")) if memory_dir(repo_root).exists() else []
    results = []

    for path in memories:
        if issue_key and path.stem == issue_key:
            continue
        text = path.read_text(encoding="utf-8", errors="replace")
        score = _score_memory(text, keywords)
        if score <= 0:
            continue
        results.append(
            {
                "file": f".ai_memory/bugs/{path.name}",
                "score": score,
                "matched_keywords": _matched_keywords(text, keywords),
                "title": _first_heading(text) or path.stem,
            }
        )

    results = sorted(results, key=lambda item: (-int(item["score"]), str(item["file"])))[:max_results]
    markdown = _render_memory_search(issue_key or query, keywords, results)
    return issue_key, markdown, results



def _query_keywords(query: str, issue_key: str | None, extracted: dict[str, object] | None) -> list[str]:
    if issue_key and extracted is not None:
        keywords = [
            *_as_list(extracted.get("high_value_keywords")),
            *_as_list(extracted.get("normal_keywords")),
        ]
        return [str(keyword) for keyword in keywords if str(keyword).strip()]
    return [word.lower() for word in re.findall(r"[A-Za-z][A-Za-z0-9_-]{2,}", query)]


def _as_list(value: object) -> list:
    return value if isinstance(value, list) else []


def _score_memory(text: str, keywords: list[str]) -> int:
    lower = text.lower()
    return sum(lower.count(keyword.lower()) for keyword in keywords)


def _matched_keywords(text: str, keywords: list[str]) -> list[str]:
    lower = text.lower()
    return sorted({keyword for keyword in keywords if keyword.lower() in lower})


def _first_heading(text: str) -> str | None:
    for line in text.splitlines():
        if line.startswith("# "):
            return line[2:].strip()
    return None


def _render_memory_search(query_label: str, keywords: list[str], results: list[dict[str, object]]) -> str:
    lines = [
        f"# Memory Search: {query_label}",
        "",
        "## Query Keywords",
        "",
        ", ".join(keywords) or "_No keywords available._",
        "",
        "## Similar Historical Issues",
        "",
    ]
    if not results:
        lines.append("No similar memory entries found.")
    else:
        for result in results:
            keywords_text = ", ".join(result["matched_keywords"])
            lines.append(f"- `{result['file']}` score={result['score']} keywords={keywords_text}")
            lines.append(f"  - {result['title']}")
    return "\n".join(lines).rstrip() + "\n"
