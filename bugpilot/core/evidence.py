"""Quoting text into a BugPilot document without letting it become the document's structure (0.1.5).

The building blocks the prompt-boundary hardening shares (plan §44.5):

- :func:`visible_escapes` writes the characters a reader cannot see, or that
  some readers take for a line break — control and format characters, U+2028
  and U+2029 — as ``<U+XXXX>``. Never deleted: the text keeps the fact that
  they were there (decision D2).
- :func:`evidence_block` quotes text verbatim inside a backtick fence longer
  than any backtick run in it (decision D3), so no line of the text can end
  the block, or be read as a heading, a fence, an HTML block or a setext
  underline while it is inside.
- :func:`section_starts` is the one reader of a document's own ``## `` sections:
  a line inside a fenced code block is never one, and a fence that never
  closes hides everything after it, as it does for a Markdown reader.

Containment is structural. It decides what a Markdown reader takes for the
document's sections; it cannot make a model disregard what quoted text says.
"""

from __future__ import annotations

import re
import unicodedata

from .instructions import code_fence

#: Unicode categories written as visible escapes: control, format, line and paragraph separators.
_INVISIBLE = frozenset({"Cc", "Cf", "Zl", "Zp"})
_BACKTICK_RUN = re.compile(r"`+")


def visible_escapes(text: str, *, keep: str = "\t\n") -> str:
    """``text`` with every control, format, line- or paragraph-separator character as ``<U+XXXX>``.

    The characters in ``keep`` stay as they are (by default tab and line feed,
    which a quoted block keeps). An escape reads the same in every editor and
    to every reader, so nothing in the text is invisible and nothing breaks a
    line for one reader that does not for another.
    """
    def escaped(segment: str) -> str:
        # Most lines are printable through and through (`str.isprintable` is false for every category
        # escaped here), so only the rest are read character by character.
        if segment.isprintable():
            return segment
        return "".join(
            character if character in keep or unicodedata.category(character) not in _INVISIBLE
            else f"<U+{ord(character):04X}>"
            for character in segment
        )

    return ("\n" if "\n" in keep else "<U+000A>").join(escaped(line) for line in text.split("\n"))


def fence_for(text: str) -> str:
    """A backtick fence no line of ``text`` can close: longer than any backtick run in it, and at least three."""
    longest = max((len(run) for run in _BACKTICK_RUN.findall(text)), default=0)
    return "`" * max(3, longest + 1)


def evidence_block(text: str, *, info: str = "text") -> str:
    """``text`` quoted verbatim in a fenced block that nothing in it can close (D2, D3).

    Line endings are unified (CRLF and a lone CR become LF) and invisible
    characters become :func:`visible_escapes`; nothing else changes — no
    paraphrase, no truncation. ``info`` names what the block holds; it is put
    on one line and loses any backtick, which a backtick fence's info string
    may not hold. Place the block at the top level of a document.
    """
    body = visible_escapes(text.replace("\r\n", "\n").replace("\r", "\n"))
    fence = fence_for(body)
    label = " ".join(visible_escapes(info, keep="").replace("`", "").split())
    opening = f"{fence}{label}"
    return f"{opening}\n{fence}" if body == "" else f"{opening}\n{body}\n{fence}"


def section_starts(lines: list[str], marker: str = "## ") -> list[int]:
    """Where a document's own sections start: lines beginning ``marker``, never inside a fenced code block.

    Fences are read as CommonMark reads them (``instructions.code_fence``): a
    closing fence uses the opening's character, is at least as long and carries
    no info string. One that never closes runs to the end of the document, so
    nothing after it is a section — what a Markdown reader sees, and what an
    agent's reader sees. BugPilot's own documents close every fence they hold.
    """
    starts: list[int] = []
    fence: str | None = None
    for index, line in enumerate(lines):
        mark = code_fence(line)
        if fence is None:
            if mark:
                fence = mark
            elif line.startswith(marker):
                starts.append(index)
        elif mark and mark[0] == fence[0] and len(mark) >= len(fence) and line.strip() == mark:
            fence = None
    return starts
