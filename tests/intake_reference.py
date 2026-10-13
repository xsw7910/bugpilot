"""The 0.1.4 intake patterns, kept as the reference for N10, N11 and N12 (0.1.5, plan §44.19–§44.20).

Not a test module (no `test_` prefix). The product no longer holds these patterns:
each was quadratic on some input, and was replaced by code that gives the same
answers in linear time. Here they are the reference those replacements are held
to, copied exactly as 0.1.4 had them, with the 0.1.4 functions that used them.

**Run them only on small inputs.** They are quadratic: tens of thousands of
characters of the wrong shape take seconds, a megabyte takes minutes or hours.
"""

from __future__ import annotations

import re

from bugpilot.core import jira_parse

# --- jira_parse.py (0.1.4) ---------------------------------------------------------------------

#: N10: the fenced-block pattern.
FENCE_RE = re.compile(r"```[^\n]*\n(.*?)```", re.DOTALL)

#: N11: the trace-line pattern.
TRACE_LINE_RE = re.compile(
    r"(?:^\s+at\s+\S"
    r"|\.(cpp|h|hpp|c|py|java|cs|rs):\d+"
    r"|Traceback"
    r"|File \".*?\",\s*line \d+"
    r"|0x[0-9a-fA-F]{4,})",
    re.MULTILINE,
)


def fenced_blocks(text: str) -> list[tuple[int, int, str]]:
    return [(match.start(), match.end(), match.group(1)) for match in FENCE_RE.finditer(text)]


def looks_like_trace(text: str) -> bool:
    return TRACE_LINE_RE.search(text) is not None


def stack_traces(text: str) -> list[str]:
    """0.1.4's `_extract_stack_traces`, line for line, on the two reference patterns."""
    if not text:
        return []
    traces: list[str] = []
    for match in FENCE_RE.finditer(text):
        content = match.group(1)
        if TRACE_LINE_RE.search(content):
            traces.append(content.strip())
    cleaned = FENCE_RE.sub("", text)
    current: list[str] = []
    for line in cleaned.splitlines():
        if TRACE_LINE_RE.search(line):
            current.append(line)
        else:
            if len(current) >= 2:
                traces.append("\n".join(current).strip())
            current = []
    if len(current) >= 2:
        traces.append("\n".join(current).strip())
    return jira_parse._cap_stack_traces(traces)


# --- keywords.py (0.1.4) ------------------------------------------------------------------------

#: N12: the token pattern, read with `findall`.
TOKEN_RE = re.compile(
    r"[A-Za-z_][A-Za-z0-9_]*(?:(?:::|\.)[A-Za-z_][A-Za-z0-9_]*)+"
    r"|[A-Za-z][A-Za-z0-9_-]{2,}"
)
#: N12: the e-mail pattern, replaced by a space with `sub`.
EMAIL_RE = re.compile(r"\b[\w.+-]+@[\w-]+(?:\.[\w-]+)+\b")


def tokens(text: str) -> list[str]:
    return TOKEN_RE.findall(text)


def without_emails(text: str) -> str:
    return EMAIL_RE.sub(" ", text)
