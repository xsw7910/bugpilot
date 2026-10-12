"""Text for a terminal: nothing BugPilot prints is ever a terminal control sequence.

An issue's summary, description and comments, a hand-written bug, a developer
hint, a policy file or a memory note can hold characters a terminal acts on
rather than shows: an ESC sequence that recolours, moves the cursor, retitles
the window or — OSC 52 — writes the clipboard; a carriage return or a backspace
that overprints the line; a bidirectional override that makes a line read
other than it is. In text mode every character the CLI writes to stdout or
stderr passes through :func:`terminal_safe`, so such a character is shown,
escaped, and never obeyed.

Presentation only: the stored files (``context.md``, ``task.md``, the policies)
stay exactly as written, and JSON output, which programs read and which escapes
its own control characters, is not touched.
"""

from __future__ import annotations

import re
import sys
from collections.abc import Iterator
from contextlib import contextmanager
from typing import TextIO

#: C0 controls but tab and newline (carriage return included), DEL, the C1
#: controls (U+009B is a one-character CSI), and the bidirectional embeddings,
#: overrides and isolates. Everything else — letters of any script, accents,
#: emoji and their joiners — is ordinary text and passes through.
_CONTROL = re.compile("[\x00-\x08\x0b-\x1f\x7f-\x9f‪-‮⁦-⁩]")


def terminal_safe(text: str) -> str:
    """The text as a terminal should show it: each control character as a visible escape (``\\x1b``)."""
    return _CONTROL.sub(_escape, text.replace("\r\n", "\n"))


def _escape(match: re.Match[str]) -> str:
    code = ord(match.group(0))
    return f"\\x{code:02x}" if code < 0x100 else f"\\u{code:04x}"


class _TerminalSafeStream:
    """A text stream that escapes control characters on the way out; everything else is the stream's own."""

    def __init__(self, stream: TextIO) -> None:
        self._stream = stream

    def write(self, text: str) -> int:
        self._stream.write(terminal_safe(text))
        return len(text)

    def writelines(self, lines) -> None:  # noqa: ANN001 - the TextIO signature
        for line in lines:
            self.write(line)

    def __getattr__(self, name: str):  # noqa: ANN204 - encoding, flush, isatty, fileno, reconfigure, …
        return getattr(self._stream, name)


@contextmanager
def terminal_safe_output() -> Iterator[None]:
    """For one text-mode command: stdout and stderr escape control characters, then are put back."""
    stdout, stderr = sys.stdout, sys.stderr
    sys.stdout = _TerminalSafeStream(stdout)  # type: ignore[assignment]
    sys.stderr = _TerminalSafeStream(stderr)  # type: ignore[assignment]
    try:
        yield
    finally:
        sys.stdout, sys.stderr = stdout, stderr
