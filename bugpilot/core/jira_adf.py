"""Deterministic Atlassian Document Format to Markdown conversion."""

from __future__ import annotations

import re
from typing import Any


def adf_to_markdown(value: Any) -> str:
    """Convert Jira ADF, plain strings, or partial structures to Markdown."""
    try:
        return _clean_markdown(_render(value))
    except Exception:
        return _clean_markdown(_extract_text(value))


def _render(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return _join_blocks(_render(item) for item in value)
    if not isinstance(value, dict):
        return str(value)

    node_type = value.get("type")
    content = value.get("content", [])
    attrs = value.get("attrs", {}) if isinstance(value.get("attrs"), dict) else {}

    if node_type == "doc":
        return _join_blocks(_render(child) for child in content)
    if node_type == "paragraph":
        return _render_inline_content(content)
    if node_type == "text":
        return _apply_marks(str(value.get("text") or ""), value.get("marks", []))
    if node_type == "hardBreak":
        return "\n"
    if node_type == "heading":
        level = _clamp_heading_level(attrs.get("level", 1))
        text = _render_inline_content(content)
        return f"{'#' * level} {text}".strip()
    if node_type == "bulletList":
        return _render_list(content, ordered=False)
    if node_type == "orderedList":
        return _render_list(content, ordered=True, start=int(attrs.get("order", 1) or 1))
    if node_type == "listItem":
        return _join_blocks(_render(child) for child in content)
    if node_type == "codeBlock":
        language = str(attrs.get("language", "") or "").strip()
        code = _render_code_content(content).rstrip("\n")
        return f"```{language}\n{code}\n```"
    if node_type == "blockquote":
        text = _join_blocks(_render(child) for child in content)
        return "\n".join(f"> {line}" if line else ">" for line in text.splitlines())
    if node_type == "panel":
        panel_type = str(attrs.get("panelType", "") or "").strip()
        label = f"Panel ({panel_type})" if panel_type else "Panel"
        text = _join_blocks(_render(child) for child in content)
        lines = [f"> **{label}:**"]
        lines.extend(f"> {line}" if line else ">" for line in text.splitlines())
        return "\n".join(lines)
    if node_type == "rule":
        return "---"
    if node_type == "inlineCard":
        return str(attrs.get("url", "") or "")
    if node_type in {"media", "mediaSingle"}:
        rendered = _join_blocks(_render(child) for child in content)
        return rendered or "[media omitted]"

    rendered = _join_blocks(_render(child) for child in content)
    return rendered or _extract_text(value)


def _render_inline_content(content: Any) -> str:
    if not isinstance(content, list):
        return _render(content)
    return "".join(_render(child) for child in content)


def _render_code_content(content: Any) -> str:
    if not isinstance(content, list):
        return _render(content)
    parts = []
    for child in content:
        if isinstance(child, dict) and child.get("type") == "text":
            parts.append(str(child.get("text", "")))
        elif isinstance(child, dict) and child.get("type") == "hardBreak":
            parts.append("\n")
        else:
            parts.append(_render(child))
    return "".join(parts)


def _render_list(content: Any, ordered: bool, start: int = 1) -> str:
    if not isinstance(content, list):
        return ""
    lines = []
    number = start
    for child in content:
        item = _render(child).strip()
        if not item:
            continue
        prefix = f"{number}. " if ordered else "- "
        item_lines = item.splitlines()
        lines.append(prefix + item_lines[0])
        continuation_indent = " " * len(prefix)
        lines.extend(f"{continuation_indent}{line}" if line else "" for line in item_lines[1:])
        number += 1
    return "\n".join(lines)


def _apply_marks(text: str, marks: Any) -> str:
    if not text:
        return ""
    if not isinstance(marks, list):
        return text
    rendered = text
    for mark in marks:
        if not isinstance(mark, dict):
            continue
        mark_type = mark.get("type")
        attrs = mark.get("attrs", {}) if isinstance(mark.get("attrs"), dict) else {}
        if mark_type == "strong":
            rendered = f"**{rendered}**"
        elif mark_type == "em":
            rendered = f"*{rendered}*"
        elif mark_type == "code":
            rendered = f"`{rendered}`"
        elif mark_type == "strike":
            rendered = f"~~{rendered}~~"
        elif mark_type == "link" and attrs.get("href"):
            rendered = f"[{rendered}]({attrs['href']})"
    return rendered


def _clamp_heading_level(value: Any) -> int:
    try:
        return max(1, min(6, int(value)))
    except (TypeError, ValueError):
        return 1


def _join_blocks(parts: Any) -> str:
    return "\n\n".join(str(part).strip() for part in parts if str(part).strip())


def _extract_text(value: Any) -> str:
    if value is None:
        return ""
    if isinstance(value, str):
        return value
    if isinstance(value, list):
        return " ".join(_extract_text(item) for item in value if _extract_text(item)).strip()
    if isinstance(value, dict):
        if isinstance(value.get("text"), str):
            return value["text"]
        if isinstance(value.get("attrs"), dict) and isinstance(value["attrs"].get("url"), str):
            return value["attrs"]["url"]
        return " ".join(_extract_text(item) for item in value.get("content", []) if _extract_text(item)).strip()
    return str(value)


def _clean_markdown(markdown: str) -> str:
    lines = [line.rstrip() for line in markdown.replace("\r\n", "\n").replace("\r", "\n").splitlines()]
    cleaned = "\n".join(lines).strip()
    return re.sub(r"\n{3,}", "\n\n", cleaned)
