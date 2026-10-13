"""An independent raw-line oracle for the prompt-boundary tests (0.1.5 Batch 0, plan §44).

Not a test module (no `test_` prefix). Where `oracle_commonmark` asks what a
Markdown parser builds, this one reads the text the way a person scanning the
raw file — or a model reading it token by token — meets it: line by line, with
no parser state. It reports every line that *looks* structural: ATX and setext
heading shapes (however indented, inside a list or quote marker or not), code
fences (indented or nested), HTML-looking lines, lines that imitate one of
BugPilot's own section names or provenance labels — and which line breaks the
text uses, including the ones only some readers honour (U+2028, U+2029, NEL,
VT, FF).

**Independent on purpose.** It imports nothing from `bugpilot` and shares none
of its patterns: its rules are deliberately looser than CommonMark's, so a line
the product's containment let through as "inside a fence" is still reported
here as a heading-shaped line. It is a test-side observer, never a sanitizer.

The BugPilot section names are written out below rather than imported, for the
same reason; `test_prompt_boundary_oracles.py` checks them against the product
so the two lists cannot drift apart unnoticed.
"""

from __future__ import annotations

import re
import unicodedata
from collections import Counter
from dataclasses import dataclass

#: Every line break a reader might honour, by name. CommonMark honours the first three only.
LINE_BREAKS: dict[str, str] = {
    "\r\n": "CRLF",
    "\n": "LF",
    "\r": "CR",
    "\u2028": "LS",
    "\u2029": "PS",
    "\x85": "NEL",
    "\x0b": "VT",
    "\x0c": "FF",
}
_COMMONMARK_SPLIT = re.compile(r"\r\n|\r|\n")
_LIBERAL_SPLIT = re.compile("\r\n|[\r\n\u2028\u2029\x85\x0b\x0c]")

#: The section headings BugPilot writes in task.md, context.md and the retry
#: prompt, lower-cased. A line imitating one of these is reported.
BUGPILOT_HEADINGS: frozenset[str] = frozenset({
    # task.md
    "bugpilot safety rules", "bugpilot rule precedence", "bugpilot evidence rules", "required output files",
    "bugpilot delivery safety", "verification policy", "ai behavior", "branch instructions",
    "execution location", "required input files", "ai fix mode", "repository context",
    "developer hint", "developer attachments", "project / team instructions", "user instructions",
    "investigation handoff", "assisted delivery", "optional assisted delivery", "report status to jira",
    "report status to jira (before commit)", "how to run", "task", "work item",
    # context.md
    "scope", "issue", "caution", "guidance", "context quality", "issue details", "code search",
    "similar fixes", "git history",
    # the retry prompt
    "purpose", "required reading", "developer feedback", "previous attempt summary", "retry instructions",
    "branch",
})
#: Title shapes of BugPilot's documents (`# BugPilot Task: JR-12345`, …).
_TITLE_SHAPES = re.compile(r"^(?:bugpilot task|bug context|agent retry prompt|user feedback)\b", re.IGNORECASE)

#: Text that imitates a BugPilot provenance or authority label rather than a heading.
PROVENANCE_PATTERNS: tuple[re.Pattern[str], ...] = (
    re.compile(r"\bevidence,? not instructions?\b", re.IGNORECASE),
    re.compile(r"\bnot (?:an? )?instructions?\b", re.IGNORECASE),
    re.compile(r"^\s*(?:source|provenance|quoted from)\s*:", re.IGNORECASE),
    re.compile(r"\bgenerated (?:from|by) (?:local )?bugpilot\b", re.IGNORECASE),
    re.compile(r"^\s*user hint\s*:", re.IGNORECASE),
    re.compile(r"\bbugpilot (?:protected rules?|safety rules?|says|approves?|allows?)\b", re.IGNORECASE),
)

_CONTAINER = re.compile(r"^(?P<prefix>(?:[ \t]*(?:>|[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t])))*)(?P<indent>[ \t]*)")
_ATX_LIKE = re.compile(r"^(?P<hashes>#{1,6})(?:[ \t]+(?P<text>.*?))?(?:[ \t]+#+)?[ \t]*$")
_SETEXT_LIKE = re.compile(r"^(?:=+|-+)[ \t]*$")
_FENCE_LIKE = re.compile(r"^(?P<run>`{3,}|~{3,})(?P<info>.*)$")
_HTML_LIKE = re.compile(r"^<(?:!--|/?[A-Za-z][A-Za-z0-9-]*)")


@dataclass(frozen=True)
class Line:
    number: int
    text: str
    #: The break that ended it (`LF`, `CR`, `LS`, …), or `""` for the last line.
    ended_by: str
    #: Leading container markers (`>`, `-`, `1.`) before the content.
    container: str
    #: Leading spaces and tabs after the container markers, tabs counted as 4.
    indent: int
    #: `atx`, `setext-underline`, `fence`, `html`, `blank` or `text`.
    shape: str
    #: For `atx`: the number of `#`; for a setext underline: 1 (`=`) or 2 (`-`); for `fence`: the run length.
    size: int = 0
    #: For `atx`: the heading text; for a setext underline: the line it underlines; for `fence`: the info string.
    detail: str = ""


@dataclass(frozen=True)
class Report:
    lines: tuple[Line, ...]
    breaks: dict[str, int]

    def headings(self, max_level: int = 6) -> list[Line]:
        """Every heading-shaped line: ATX of up to ``max_level`` and setext underlines (level 1 or 2)."""
        return [line for line in self.lines if line.shape in ("atx", "setext-underline") and line.size <= max_level]

    def imitations(self, max_level: int = 2) -> list[Line]:
        """Heading-shaped lines, indented 0–3 columns, whose title is one of BugPilot's own."""
        return [line for line in self.headings(max_level) if line.indent <= 3 and imitates_bugpilot(line.detail)]

    def fences(self) -> list[Line]:
        return [line for line in self.lines if line.shape == "fence"]

    def provenance_like(self) -> list[Line]:
        return [line for line in self.lines if any(pattern.search(line.text) for pattern in PROVENANCE_PATTERNS)]


def split_lines(text: str, *, liberal: bool = True) -> list[tuple[str, str]]:
    """``(line, break name)`` pairs. ``liberal`` honours every break in :data:`LINE_BREAKS`, else CommonMark's."""
    pattern = _LIBERAL_SPLIT if liberal else _COMMONMARK_SPLIT
    out: list[tuple[str, str]] = []
    position = 0
    for match in pattern.finditer(text):
        out.append((text[position : match.start()], LINE_BREAKS[match.group(0)]))
        position = match.end()
    out.append((text[position:], ""))
    return out


def normalized_title(text: str) -> str:
    """A heading title as compared with BugPilot's: no format characters, emphasis or extra space; lower case."""
    text = "".join(character for character in text if unicodedata.category(character) != "Cf")
    text = re.sub(r"[*_`]+", "", text)
    return " ".join(text.split()).strip().lower()


def imitates_bugpilot(title: str) -> bool:
    name = normalized_title(title)
    return bool(name) and (name in BUGPILOT_HEADINGS or name.startswith("bugpilot ") or bool(_TITLE_SHAPES.match(name)))


def _columns(whitespace: str) -> int:
    return sum(4 if character == "\t" else 1 for character in whitespace)


def scan(text: str, *, liberal: bool = True) -> Report:
    """Classify every line of ``text``."""
    pairs = split_lines(text, liberal=liberal)
    lines: list[Line] = []
    previous_content = ""
    for number, (raw, ended_by) in enumerate(pairs):
        container = _CONTAINER.match(raw)
        prefix, indent = container.group("prefix"), container.group("indent")
        content = raw[container.end() :]
        shape, size, detail = "text", 0, ""
        if not content.strip():
            shape = "blank"
        elif match := _ATX_LIKE.match(content):
            shape, size, detail = "atx", len(match.group("hashes")), (match.group("text") or "").strip()
        elif match := _FENCE_LIKE.match(content):
            shape, size, detail = "fence", len(match.group("run")), match.group("info").strip()
        elif _SETEXT_LIKE.match(content) and previous_content.strip():
            shape, size, detail = "setext-underline", 1 if content.strip()[0] == "=" else 2, previous_content.strip()
        elif _HTML_LIKE.match(content):
            shape = "html"
        lines.append(Line(number, raw, ended_by, prefix.strip(), _columns(indent), shape, size, detail))
        previous_content = content if shape == "text" else ""
    breaks = Counter(ended_by for _line, ended_by in pairs if ended_by)
    return Report(tuple(lines), dict(sorted(breaks.items())))


def liberal_only_headings(text: str, max_level: int = 2) -> list[str]:
    """Heading-shaped titles a liberal reader sees that a CommonMark-line reader does not.

    They exist only because a break CommonMark ignores (U+2028, U+2029, NEL,
    VT, FF) starts a new line for a reader that honours it.
    """
    def titles(report: Report) -> Counter[str]:
        return Counter(normalized_title(line.detail) for line in report.headings(max_level) if line.indent <= 3)

    return sorted((titles(scan(text, liberal=True)) - titles(scan(text, liberal=False))).elements())
