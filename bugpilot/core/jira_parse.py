"""Deterministic extraction of structured bug details from parsed Jira text."""

from __future__ import annotations

import re

# ---------------------------------------------------------------------------
# Section alias map — canonical key → case-insensitive heading aliases
# Insertion order matters: the first matching key wins when aliases overlap.
# ---------------------------------------------------------------------------
_SECTION_ALIASES: dict[str, list[str]] = {
    "reproduction_steps": [
        "steps to reproduce",
        "repro steps",
        "reproduction steps",
        "reproduction",
        "how to reproduce",
        "steps",
        "repro",
    ],
    "actual_result": [
        "actual result",
        "actual results",
        "actual",
        "observed result",
        "observed behavior",
        "observed",
    ],
    "expected_result": [
        "expected result",
        "expected results",
        "expected",
        "expected behavior",
        "desired behavior",
    ],
    "environment": [
        "environment",
        "env",
        "version",
        "build",
        "platform",
        "os",
        "system",
        "system info",
        "system information",
    ],
    "error_section": [
        "error",
        "errors",
        "error message",
        "error messages",
    ],
    "stack_trace_section": [
        "stack trace",
        "stack traces",
        "call stack",
        "traceback",
        "crash",
    ],
    "log_section": [
        "logs",
        "log",
    ],
    "notes": [
        "notes",
        "note",
        "additional info",
        "additional information",
    ],
}

# Regex for markdown headings h1–h4
_HEADING_RE = re.compile(r"^#{1,4}\s+(.+)$")
# Regex for plain-text label at start of line, e.g. "Steps to Reproduce:"
_LABEL_RE = re.compile(r"^([A-Za-z][A-Za-z /()_-]{1,50}):\s*$")

# Patterns for inline environment/version detection
_ENV_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"\bVersion\s*[:\s]\s*([\w.\-]+)", re.IGNORECASE),
    re.compile(r"\bBuild\s*[:\s]\s*([\w.\-]+)", re.IGNORECASE),
    re.compile(r"\bOS\s*[:\s]\s*([^\n,;]{1,40})", re.IGNORECASE),
    re.compile(r"\b(Windows\s*\d+(?:\.\d+)*)", re.IGNORECASE),
    re.compile(r"\b(Linux)\b", re.IGNORECASE),
    re.compile(r"\b(macOS(?:\s*\d[\d.]*)?)\b", re.IGNORECASE),
    re.compile(r"\b(Ubuntu(?:\s*\d[\d.]*)?)\b", re.IGNORECASE),
    re.compile(r"\b(RHEL(?:\s*\d[\d.]*)?)\b", re.IGNORECASE),
    re.compile(r"\b(Qt\s*\d+\.\d+[\d.]*)\b", re.IGNORECASE),
    re.compile(r"\b(VS\s*20\d\d)\b", re.IGNORECASE),
    re.compile(r"\b(Visual Studio\s*20\d\d)\b", re.IGNORECASE),
    re.compile(r"\b(20\d\d\.\d+)\b"),  # year.minor e.g. 2026.1
]

# Lines matching these patterns are considered error indicators
_ERROR_LINE_RE = re.compile(
    r"\b(error|exception|failed|failure|crash|assert(?:ion)?|traceback|"
    r"segmentation fault|access violation)\b",
    re.IGNORECASE,
)
# Lines that are section headings — skip them during error scanning
_SECTION_HEADING_RE = re.compile(r"^#{1,4}\s+\S+|^[A-Za-z][A-Za-z /()_-]{1,50}:\s*$")

# Fenced code block pattern (```...```)
_FENCE_RE = re.compile(r"```[^\n]*\n(.*?)```", re.DOTALL)

# Lines that suggest a stack trace
_TRACE_LINE_RE = re.compile(
    r"(?:^\s+at\s+\S"
    r"|\.(cpp|h|hpp|c|py|java|cs|rs):\d+"
    r"|Traceback"
    r"|File \".*?\",\s*line \d+"
    r"|0x[0-9a-fA-F]{4,})",
    re.MULTILINE,
)

# Regression signal terms
_REGRESSION_RE = re.compile(
    r"\b(regression|used to work|worked before|after upgrade|after update|"
    r"after changing|introduced in|since version|since build|recent change|"
    r"broke in|broke after)\b",
    re.IGNORECASE,
)

# Log signal terms in comment bodies
_LOG_COMMENT_RE = re.compile(r"\blog\b|\.log\b|logfile", re.IGNORECASE)


# ---------------------------------------------------------------------------
# Public API
# ---------------------------------------------------------------------------


def extract_parsed_details(
    description: str,
    comments: list[dict],
    attachments: list[dict],
    *,
    summary: str = "",
    fix_versions: list[str] | None = None,
    affected_versions: list[str] | None = None,
) -> dict:
    """Extract structured bug investigation fields from ADF-converted Jira text.

    Returns a dict with keys:
        reproduction_steps, actual_result, expected_result, environment,
        error_messages, stack_traces, log_signals, regression_signals,
        missing_information

    Optional keyword-only args enrich extraction:
        summary         — issue title, included in environment/error scans
        fix_versions    — Jira fixVersions list, merged into environment
        affected_versions — Jira versions list, merged into environment
    """
    description = description if isinstance(description, str) else ""
    summary = summary if isinstance(summary, str) else ""
    comments = comments if isinstance(comments, list) else []
    attachments = attachments if isinstance(attachments, list) else []

    comment_bodies: list[str] = [
        str(c.get("body_markdown", ""))
        for c in comments
        if isinstance(c, dict)
    ]
    combined_text = "\n".join(s for s in [summary, description] + comment_bodies if s)

    desc_sections = _extract_sections(description)
    combined_sections = _extract_sections(combined_text)

    def _get(key: str) -> str:
        return desc_sections.get(key) or combined_sections.get(key) or ""

    repro_section = _get("reproduction_steps")
    actual_section = _get("actual_result")
    expected_section = _get("expected_result")
    env_section = _get("environment")
    error_section_text = _get("error_section")
    stack_section_text = _get("stack_trace_section")

    reproduction_steps = _extract_reproduction_steps(repro_section)
    environment = env_section.strip() if env_section.strip() else _detect_environment(combined_text)

    # Augment environment with structured Jira version fields
    version_hints = [v for v in (fix_versions or []) + (affected_versions or []) if v]
    if version_hints:
        if environment:
            for v in version_hints:
                if v not in environment:
                    environment = f"{environment}, {v}"
        else:
            environment = ", ".join(version_hints)

    error_scan = (error_section_text + "\n" + combined_text) if error_section_text else combined_text
    error_messages = _extract_error_messages(error_scan)

    stack_scan = (stack_section_text + "\n" + combined_text) if stack_section_text else combined_text
    stack_traces = _extract_stack_traces(stack_scan)

    log_signals = _extract_log_signals(attachments, comments)
    regression_signals = _extract_regression_signals(combined_text)

    result: dict = {
        "reproduction_steps": reproduction_steps,
        "actual_result": _cap_text(actual_section, 2000),
        "expected_result": _cap_text(expected_section, 2000),
        "environment": environment,
        "error_messages": error_messages,
        "stack_traces": stack_traces,
        "log_signals": log_signals,
        "regression_signals": regression_signals,
        "missing_information": [],
    }
    result["missing_information"] = _build_missing_information(result)
    return result


# ---------------------------------------------------------------------------
# Section detection
# ---------------------------------------------------------------------------


def _extract_sections(text: str) -> dict[str, str]:
    """Parse markdown headings and plain-text colon labels into named sections."""
    if not text:
        return {}

    lines = text.splitlines()
    # List of (canonical_key, line_index)
    section_starts: list[tuple[str, int]] = []

    for i, line in enumerate(lines):
        stripped = line.strip()
        label: str | None = None

        m = _HEADING_RE.match(stripped)
        if m:
            label = m.group(1).lower().strip().rstrip(":")
        else:
            m2 = _LABEL_RE.match(stripped)
            if m2:
                label = m2.group(1).lower().strip()

        if label is None:
            continue

        canonical = _match_alias(label)
        if canonical:
            section_starts.append((canonical, i))

    if not section_starts:
        return {}

    sections: dict[str, str] = {}
    for idx, (canonical, start) in enumerate(section_starts):
        end = section_starts[idx + 1][1] if idx + 1 < len(section_starts) else len(lines)
        body_lines = lines[start + 1 : end]
        # Trim trailing blank lines
        while body_lines and not body_lines[-1].strip():
            body_lines.pop()
        content = "\n".join(body_lines).strip()
        if canonical not in sections:  # first occurrence wins
            sections[canonical] = content

    return sections


def _match_alias(label: str) -> str | None:
    """Return the canonical section key for a heading label, or None."""
    # Exact match first
    for canonical, aliases in _SECTION_ALIASES.items():
        if label in aliases:
            return canonical
    # Substring match (alias contained in label, or label contained in alias)
    for canonical, aliases in _SECTION_ALIASES.items():
        for alias in aliases:
            if alias in label or label in alias:
                return canonical
    return None


# ---------------------------------------------------------------------------
# Field extractors
# ---------------------------------------------------------------------------


def _extract_reproduction_steps(section_text: str) -> list[str]:
    """Extract bullet or numbered list items from a reproduction steps section."""
    if not section_text:
        return []

    lines = section_text.splitlines()
    _BULLET_RE = re.compile(r"^\s*[-*]\s+(.+)")
    _NUMBERED_RE = re.compile(r"^\s*\d+[.)]\s+(.+)")

    structured: list[str] = []
    for line in lines:
        m = _BULLET_RE.match(line) or _NUMBERED_RE.match(line)
        if m:
            structured.append(m.group(1).strip())

    if structured:
        return structured[:20]

    # Fallback: all non-empty, non-heading lines
    fallback = [
        line.strip()
        for line in lines
        if line.strip() and not _HEADING_RE.match(line.strip())
    ]
    return fallback[:20]


def _detect_environment(text: str) -> str:
    """Scan text for environment/version/OS/platform mentions."""
    if not text:
        return ""
    seen: list[str] = []
    for pattern in _ENV_PATTERNS:
        for m in pattern.finditer(text):
            # group(1) if the pattern has a capture group, else group(0)
            val = (m.group(1) if m.lastindex else m.group(0)).strip()
            if val and val not in seen:
                seen.append(val)
    return ", ".join(seen)


def _extract_error_messages(combined_text: str) -> list[str]:
    """Return lines containing error-like terms, capped at 10."""
    if not combined_text:
        return []
    seen: list[str] = []
    for line in combined_text.splitlines():
        stripped = line.strip()
        if not stripped:
            continue
        if _SECTION_HEADING_RE.match(stripped):
            continue
        if _ERROR_LINE_RE.search(stripped) and stripped not in seen:
            seen.append(stripped)
        if len(seen) >= 10:
            break
    return seen


def _extract_stack_traces(combined_text: str) -> list[str]:
    """Extract fenced code blocks and consecutive lines that look like stack traces."""
    if not combined_text:
        return []
    traces: list[str] = []

    # Strategy 1: fenced code blocks containing trace-like lines
    for m in _FENCE_RE.finditer(combined_text):
        content = m.group(1)
        if _TRACE_LINE_RE.search(content):
            traces.append(content.strip())

    # Strategy 2: consecutive non-fenced lines (min 2) matching trace patterns
    cleaned = _FENCE_RE.sub("", combined_text)
    current_block: list[str] = []
    for line in cleaned.splitlines():
        if _TRACE_LINE_RE.search(line):
            current_block.append(line)
        else:
            if len(current_block) >= 2:
                traces.append("\n".join(current_block).strip())
            current_block = []
    if len(current_block) >= 2:
        traces.append("\n".join(current_block).strip())

    return _cap_stack_traces(traces)


def _extract_log_signals(attachments: list[dict], comment_details: list[dict]) -> list[str]:
    """Return descriptive strings for log-related attachment and comment signals."""
    signals: list[str] = []

    for att in attachments:
        if not isinstance(att, dict):
            continue
        kind = str(att.get("kind", ""))
        filename = str(att.get("filename", ""))
        if kind == "log" or ".log" in filename.lower():
            signals.append(f"Attachment: {filename}")

    # One signal per comment-body scan is sufficient to avoid noise
    for comment in comment_details:
        if not isinstance(comment, dict):
            continue
        body = str(comment.get("body_markdown", ""))
        if _LOG_COMMENT_RE.search(body):
            signals.append("Comment mentions log")
            break

    return signals


def _extract_regression_signals(combined_text: str) -> list[str]:
    """Return lines containing regression-related terms, deduplicated."""
    if not combined_text:
        return []
    seen: list[str] = []
    for line in combined_text.splitlines():
        stripped = line.strip()
        if stripped and _REGRESSION_RE.search(stripped) and stripped not in seen:
            seen.append(stripped)
        if len(seen) >= 10:
            break
    return seen


def _cap_text(text: str, limit: int) -> str:
    if len(text) <= limit:
        return text
    return text[:limit].rstrip()


def _cap_stack_traces(traces: list[str]) -> list[str]:
    capped = []
    for trace in traces[:3]:
        capped.append("\n".join(trace.splitlines()[:80]).rstrip())
    return capped


# ---------------------------------------------------------------------------
# Missing information checklist
# ---------------------------------------------------------------------------


def _build_missing_information(result: dict) -> list[str]:
    """Generate a deterministic checklist of missing bug investigation fields."""
    missing: list[str] = []
    if not result.get("reproduction_steps"):
        missing.append("Reproduction steps are missing.")
    if not result.get("actual_result"):
        missing.append("Actual result is missing.")
    if not result.get("expected_result"):
        missing.append("Expected result is missing.")
    if not result.get("environment"):
        missing.append("Environment/version information is missing.")
    if not result.get("error_messages") and not result.get("stack_traces"):
        missing.append("No error message or stack trace was found.")
    if not result.get("log_signals"):
        missing.append("No logs or relevant attachments were found.")
    return missing
