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

# Patterns for inline environment/version detection. A version or build value
# has a digit in it: without that rule "Released build verified" made the
# environment "verified" (0.1.3, §42.3).
_ENV_PATTERNS: list[re.Pattern[str]] = [
    re.compile(r"\bVersion\s*[:\s]\s*([\w.\-]*\d[\w.\-]*)", re.IGNORECASE),
    re.compile(r"\bBuild\s*[:\s]\s*([\w.\-]*\d[\w.\-]*)", re.IGNORECASE),
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

# Fenced code blocks (```...```) are found by `_fenced_blocks` below, in one
# linear pass. They used to be a pattern, r"```[^\n]*\n(.*?)```" with DOTALL,
# which tried every position of a long run of backticks and scanned from each
# to the end of the text: quadratic, so a description of 100,000 backticks took
# about 20 seconds to parse (N10, 0.1.5). The blocks found are the same.
_FENCE = "```"

# Lines that suggest a stack trace: `_looks_like_trace` below. It answers what
# the pattern r'(?:^\s+at\s+\S|\.(cpp|h|hpp|c|py|java|cs|rs):\d+|Traceback|
# File ".*?",\s*line \d+|0x[0-9a-fA-F]{4,})' (MULTILINE) answered, in linear
# time (N11, 0.1.5). Two of its alternatives were quadratic: `File ".*?"` scanned
# to the end of the line from every `File "` on it, and `^\s+at` scanned to the
# end of the whitespace from every line start inside a run of blank lines.
#: The alternatives that were never slow, each a few characters at one place.
_TRACE_MARK_RE = re.compile(r"\.(?:cpp|h|hpp|c|py|java|cs|rs):\d|Traceback|0x[0-9a-fA-F]{4}")
#: What must follow a Python frame's file name and its `",`: any whitespace, `line`, a digit.
_FRAME_LINE_TAIL_RE = re.compile(r"\s*line \d")
#: A whole run of whitespace followed by `at`, more whitespace and something else — a
#: Java or .NET frame if a line starts inside the run. Matched once per run: it may start
#: only where the run starts.
_AT_FRAME_RUN_RE = re.compile(r"(?<!\s)\s+(?=at\s+\S)")

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
    environment_field: str = "",
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
        environment_field — Jira's Environment field, as Markdown
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
    # Jira's own Environment field and an Environment section of the
    # description are both the environment (§42.3); only without either is it
    # guessed from the text.
    stated = [part for part in (environment_field.strip(), env_section.strip()) if part]
    environment = "\n".join(dict.fromkeys(stated)) if stated else _detect_environment(combined_text)

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


#: The sections a parsed issue keeps as fields of their own.
_FIELD_SECTIONS = frozenset({"reproduction_steps", "actual_result", "expected_result", "environment"})


def free_description(description: str) -> str:
    """The description without the sections that are fields of their own.

    Reproduction steps, actual and expected result and environment are read
    out of the description into their own fields, and a search term's origin
    is the field it came from (§42.3): "Windows" in an Environment section is
    environment, not description. Every other line stays, headings and all.
    """
    if not description:
        return ""
    lines = description.splitlines()
    starts: list[tuple[str, int]] = []
    for index, line in enumerate(lines):
        stripped = line.strip()
        match = _HEADING_RE.match(stripped) or _LABEL_RE.match(stripped)
        if match is None:
            continue
        canonical = _match_alias(match.group(1).lower().strip().rstrip(":"))
        if canonical:
            starts.append((canonical, index))
    dropped: set[int] = set()
    for position, (canonical, start) in enumerate(starts):
        if canonical in _FIELD_SECTIONS:
            end = starts[position + 1][1] if position + 1 < len(starts) else len(lines)
            dropped.update(range(start, end))
    return "\n".join(line for index, line in enumerate(lines) if index not in dropped).strip()


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
            # A piece of a value already found is no value of its own: the
            # year.minor pattern finds "2027.0" inside build "2027.0.1" (§42.3).
            if val and not any(val in found for found in seen):
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
    blocks = _fenced_blocks(combined_text)

    # Strategy 1: fenced code blocks containing trace-like lines
    for _start, _end, content in blocks:
        if _looks_like_trace(content):
            traces.append(content.strip())

    # Strategy 2: consecutive non-fenced lines (min 2) matching trace patterns
    kept = [0, *(edge for start, end, _content in blocks for edge in (start, end)), len(combined_text)]
    cleaned = "".join(combined_text[kept[i] : kept[i + 1]] for i in range(0, len(kept), 2))
    current_block: list[str] = []
    for line in cleaned.splitlines():
        if _looks_like_trace(line):
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


def _fenced_blocks(text: str) -> list[tuple[int, int, str]]:
    """Every fenced block in ``text``, in order: ``(start, end, content)``, in one linear pass (N10).

    A block opens at ```, takes the rest of that line as its info string,
    and holds everything from the next line up to the next ``` (wherever it
    falls) — the blocks the pattern r"```[^\\n]*\\n(.*?)```" (DOTALL) found,
    with the same spans, so the text between them is the same too.

    Each `find` starts where the previous one stopped, so the text is read
    once. The search ends at the first opener with no line break after it, or
    no ``` after that line break: no later opener could then complete a block
    either, since its own line break and closing ``` would have to come later
    still.
    """
    blocks: list[tuple[int, int, str]] = []
    position = 0
    while True:
        start = text.find(_FENCE, position)
        if start < 0:
            break
        newline = text.find("\n", start + len(_FENCE))
        if newline < 0:
            break
        close = text.find(_FENCE, newline + 1)
        if close < 0:
            break
        blocks.append((start, close + len(_FENCE), text[newline + 1 : close]))
        position = close + len(_FENCE)
    return blocks


def _looks_like_trace(text: str) -> bool:
    """Whether ``text`` holds a stack-trace line, as the old trace-line pattern found one (N11).

    Any of: a source file and line (`.py:12`), `Traceback`, an address
    (`0x1f2e`), a Python frame (`File "…", line 12`), or a line that starts
    with whitespace, `at` and a frame (`    at Widget.run(…)`). Each test reads
    the text a bounded number of times, so the whole is linear.
    """
    return bool(_TRACE_MARK_RE.search(text)) or _has_python_frame(text) or _has_at_frame(text)


def _has_python_frame(text: str) -> bool:
    """`File "…",` then `line N`, the file name on one line (the old `File ".*?",\\s*line \\d+`).

    Only a line's first `File "` needs trying: anything after a later one on
    the same line also comes after the first. From it, each `",` further along
    the line is tried as the end of the file name, and whatever follows the
    `",` — whitespace, line breaks included, then `line` and a digit — is read
    once, since a run of whitespace follows at most one `",`.
    """
    position = 0
    while True:
        start = text.find('File "', position)
        if start < 0:
            return False
        line_end = text.find("\n", start)
        if line_end < 0:
            line_end = len(text)
        quote = text.find('",', start + 6, line_end)
        while quote >= 0:
            if _FRAME_LINE_TAIL_RE.match(text, quote + 2):
                return True
            quote = text.find('",', quote + 1, line_end)
        position = line_end + 1


def _has_at_frame(text: str) -> bool:
    """A line that starts with whitespace, then `at`, whitespace and more (the old `^\\s+at\\s+\\S`).

    Such a line's leading whitespace lies inside a run of whitespace that `at`
    follows directly. The run counts when a line starts inside it before its
    last character: at the very start of the text, or after a line feed that is
    not the run's last character.
    """
    for run in _AT_FRAME_RUN_RE.finditer(text):
        if run.start() == 0 or text.find("\n", run.start(), run.end() - 1) >= 0:
            return True
    return False


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
