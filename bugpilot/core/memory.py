"""Shared markdown memory helpers."""

from __future__ import annotations

import json
import re
from datetime import datetime, timezone
from pathlib import Path

from .config import issue_dir, memory_dir
from .identity import is_known_work_item_id


def build_memory_entry(issue_key: str, parsed: dict[str, object], context_path: str) -> str:
    now = datetime.now(timezone.utc).isoformat()
    return (
        f"# {issue_key} AI Bug Workflow Memory\n\n"
        f"- Created: {now}\n"
        f"- Mode: prepare-only\n"
        f"- Summary: {parsed.get('summary', '')}\n"
        f"- Mock/demo Jira data: {parsed.get('is_mock', False)}\n"
        f"- Context: {context_path}\n\n"
        "## Investigation State\n\n"
        "Prototype prepare-only workflow generated this memory entry during preparation. "
        "No code fix has been attempted by bugpilot.\n\n"
        "## Code Search Summary\n\n"
        f"See `.ai/{issue_key}/code_search.md`.\n\n"
        "## Related Files\n\n"
        f"See `.ai/{issue_key}/related_files.json`.\n"
    )


def add_memory_entry(repo_root: Path, issue_key: str, content: str) -> Path:
    memory_path = repo_root / ".ai_memory" / "bugs" / f"{issue_key}.md"
    memory_path.parent.mkdir(parents=True, exist_ok=True)
    memory_path.write_text(content, encoding="utf-8")
    return memory_path


def search_memory(
    repo_root: Path, query: str, write_report: bool = True
) -> tuple[str | None, str, list[dict[str, object]]]:
    """Score stored memories against a query.

    ``write_report=False`` makes it strictly read-only. The pipeline wants the
    ``memory_search.md`` artifact; a caller merely answering a question does not,
    and writing it would create a work item directory for an id that was never
    prepared.
    """
    # Only a Jira key or a local id counts as a work item lookup; everything
    # else is free text scored against stored memories. The permissive
    # directory-name check would misread terms like `utf-8` as an id.
    candidate = query.strip()
    issue_key = candidate if is_known_work_item_id(candidate) else None
    keywords = _query_keywords(repo_root, query, issue_key)
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

    results = sorted(results, key=lambda item: (-int(item["score"]), str(item["file"])))[:5]
    markdown = _render_memory_search(issue_key or query, keywords, results)

    if issue_key and write_report:
        target = issue_dir(repo_root, issue_key)
        target.mkdir(parents=True, exist_ok=True)
        (target / "memory_search.md").write_text(markdown, encoding="utf-8")

    return issue_key, markdown, results



def _query_keywords(repo_root: Path, query: str, issue_key: str | None) -> list[str]:
    if issue_key:
        path = issue_dir(repo_root, issue_key) / "extracted_keywords.json"
        if path.exists():
            data = json.loads(path.read_text(encoding="utf-8"))
            keywords = data.get("high_value_keywords", []) + data.get("normal_keywords", [])
            return [str(keyword) for keyword in keywords if str(keyword).strip()]
    return [word.lower() for word in re.findall(r"[A-Za-z][A-Za-z0-9_-]{2,}", query)]


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
