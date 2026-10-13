"""An independent CommonMark oracle for the prompt-boundary tests (0.1.5 Batch 0, plan §44).

Not a test module (no `test_` prefix). It answers structural questions about a
document BugPilot rendered — which headings a Markdown reader sees, in what
order, at what level, and which code fences never close — by parsing it with
markdown-it-py in CommonMark mode.

**Independent on purpose.** It imports nothing from `bugpilot`, and nothing in
`bugpilot` calls the parser it uses. The 0.1.4 containment tests judged fences
with the product's own `instructions.code_fence`, so a document both of them
misread passed both (§44.2, N1). An oracle that shares the product's model can
only confirm it; this one can contradict it. `test_prompt_boundary_oracles.py`
holds that independence as a test.

It is an observer, not a renderer and not a sanitizer: it never changes text.
markdown-it-py is a test-only dependency (the `test` extra); the package keeps
no runtime dependency.
"""

from __future__ import annotations

import re
from collections import Counter
from dataclasses import dataclass

from markdown_it import MarkdownIt

_PARSER = MarkdownIt("commonmark")

#: What a container line starts with before its content: blockquote markers,
#: list markers and indentation. Used only to read a fence's closing line.
_CONTAINER_PREFIX = re.compile(r"^(?:[ \t]*(?:>|[-*+](?=[ \t])|\d{1,9}[.)](?=[ \t]))?[ \t]*)*")


@dataclass(frozen=True)
class Heading:
    """One heading as a CommonMark reader sees it."""

    level: int
    text: str
    #: 0-based line of the CommonMark line view (CRLF, CR and LF each end a line).
    line: int
    #: Inside a container — a list item or a blockquote — rather than the document itself.
    nested: bool
    #: `atx` (`## …`) or `setext` (a `---`/`===` underline).
    kind: str


@dataclass(frozen=True)
class Fence:
    """One fenced code block."""

    marker: str
    info: str
    start: int
    #: Exclusive end line.
    end: int
    #: False when the fence runs to the end of the document (or of its container) unclosed.
    closed: bool
    nested: bool


@dataclass(frozen=True)
class Structure:
    headings: tuple[Heading, ...]
    fences: tuple[Fence, ...]
    #: Start lines of raw HTML blocks.
    html_blocks: tuple[int, ...]
    line_count: int

    def top_level(self, max_level: int = 2) -> list[tuple[int, str]]:
        """``(level, text)`` of every heading of the document itself, up to ``max_level``, in order."""
        return [(item.level, item.text) for item in self.headings if not item.nested and item.level <= max_level]

    def unclosed_fences(self) -> list[Fence]:
        return [fence for fence in self.fences if not fence.closed]


def commonmark_lines(text: str) -> list[str]:
    """The lines a CommonMark reader sees: CRLF, a lone CR and LF each end one (spec §2.1)."""
    return re.split(r"\r\n|\r|\n", text)


def structure(text: str) -> Structure:
    """Parse ``text`` as CommonMark and report its headings, fences and HTML blocks."""
    tokens = _PARSER.parse(text)
    lines = commonmark_lines(text)
    headings: list[Heading] = []
    fences: list[Fence] = []
    html: list[int] = []
    for index, token in enumerate(tokens):
        if token.type == "heading_open":
            inline = tokens[index + 1]
            start = token.map[0] if token.map else -1
            headings.append(
                Heading(
                    level=int(token.tag[1]),
                    text=inline.content.strip(),
                    line=start,
                    nested=token.level > 0,
                    kind="atx" if token.markup.startswith("#") else "setext",
                )
            )
        elif token.type == "fence":
            start, end = token.map if token.map else (-1, -1)
            fences.append(
                Fence(
                    marker=token.markup,
                    info=token.info,
                    start=start,
                    end=end,
                    closed=_closes(lines, start, end, token.markup),
                    nested=token.level > 0,
                )
            )
        elif token.type == "html_block":
            html.append(token.map[0] if token.map else -1)
    return Structure(tuple(headings), tuple(fences), tuple(html), len(lines))


def _closes(lines: list[str], start: int, end: int, marker: str) -> bool:
    """Whether the fence's last line is its closing fence: the same character, at least as long, nothing else."""
    if end - start < 2 or end > len(lines):
        return False
    last = _CONTAINER_PREFIX.sub("", lines[end - 1], count=1).strip()
    return bool(last) and set(last) == {marker[0]} and len(last) >= len(marker)


def top_level_headings(text: str, max_level: int = 2) -> list[tuple[int, str]]:
    return structure(text).top_level(max_level)


def is_subsequence(expected: list[tuple[int, str]], actual: list[tuple[int, str]]) -> bool:
    """Whether every expected heading is still there, in the same order (others may be between)."""
    remaining = iter(actual)
    return all(any(item == candidate for candidate in remaining) for item in expected)


@dataclass(frozen=True)
class Difference:
    """How a document's structure differs from a clean render of the same template."""

    #: Top-level headings the injected document has and the clean one does not.
    added: tuple[tuple[int, str], ...]
    #: Top-level headings of the clean document that are gone.
    missing: tuple[tuple[int, str], ...]
    #: Every clean heading still present, in its order.
    in_order: bool
    #: Fences that never close, beyond the clean document's.
    new_unclosed_fences: int
    #: Sub-headings (below ``max_level``, or nested) added — not structure of the document, but read as it.
    added_sub_headings: tuple[tuple[int, str], ...]

    @property
    def structural(self) -> bool:
        """The injected text changed the document's own sections, or hid some of them."""
        return bool(self.added or self.missing or not self.in_order or self.new_unclosed_fences)


def compare(clean: str, injected: str, max_level: int = 2) -> Difference:
    """The structural difference an injected text made, judged against the clean render."""
    before, after = structure(clean), structure(injected)
    clean_top, injected_top = before.top_level(max_level), after.top_level(max_level)
    added = Counter(injected_top) - Counter(clean_top)
    missing = Counter(clean_top) - Counter(injected_top)

    def subs(item: Structure) -> Counter[tuple[int, str]]:
        return Counter((h.level, h.text) for h in item.headings if h.nested or h.level > max_level)

    return Difference(
        added=tuple(sorted(added.elements())),
        missing=tuple(sorted(missing.elements())),
        in_order=is_subsequence(clean_top, injected_top),
        new_unclosed_fences=max(0, len(after.unclosed_fences()) - len(before.unclosed_fences())),
        added_sub_headings=tuple(sorted((subs(after) - subs(before)).elements())),
    )


def protected_visible(text: str, names: list[str]) -> dict[str, int]:
    """How many top-level `##` headings carry each name: 1 is visible once, 0 hidden, 2+ forged."""
    found = Counter(heading for level, heading in top_level_headings(text) if level == 2)
    return {name: found.get(name, 0) for name in names}
