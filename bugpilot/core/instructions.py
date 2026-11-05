"""User Instructions and Project / Team Instructions.

Two optional Markdown files, each in one fixed place in BugPilot's data folder::

    ~/.bugpilot/config/instructions.md
        User Instructions: this developer's own, for every repository they work on
    ~/.bugpilot/repositories/<repository id>/settings/instructions.md
        Project / Team Instructions: this developer's own for this repository

The user file is in ``config/`` of BugPilot's data folder (``BUGPILOT_HOME`` when
set; 0.1.6, plan §14.3, Batch 2B-2), reached only through storage's checked
accessor: a data folder in a Git working tree, or a link on the way or at the
file, is refused for a read too (owner decision C-2). The 0.1.5
``~/.bugpilot/instructions.md`` is never read.

The project file is in the repository's namespace (Batch 2B-3a), reached only
through :mod:`repository_settings`, with the same refusals. It is not shared
through the repository (US-D9); the 0.1.5 ``<repo>/.bugpilot/instructions.md``
is never read, copied or deleted.

``task.md`` carries each as its own section, after the Repository Context and
before the Fix Mode, and the task's precedence section puts them there too:
BugPilot safety rules → Repository context → Project / team instructions → User
instructions → AI Fix Mode → Developer hint: the repository's rules beat one
developer's preference. Neither can loosen a BugPilot rule;
the task says so, and says that a conflicting instruction is ignored. BugPilot
does not try to read the instructions for meaning.

Every entry point reads the same two files the same way: the CLI, the MCP
prepare tools and the VS Code extension (through ``bugpilot instructions``).
Nothing else is searched for — no ``AGENTS.md`` merging, no per-folder files.

Rules for the files themselves:

- A missing file, or one with nothing but whitespace, is "no instructions":
  no section, no warning.
- A file that cannot be used — a link on the way, not a regular file, not
  UTF-8, unreadable, or longer than ``MAX_INSTRUCTION_CHARS`` — is left out
  whole, with a warning for the run and one line in the task saying so. It is
  never cut short: half an instruction can say the opposite of the whole one.
- The text is the developer's, kept as written except: line endings unified
  (U+2028 and U+2029 included), control characters other than tab removed,
  trailing spaces trimmed, and the containment of :func:`contained_markdown` —
  Markdown headings moved two levels down, the start of an HTML block and a
  fence it cannot keep given one backslash, a code fence left open at the end
  closed — so nothing in the file can pose as, or hide, one of the task's own
  sections.
- The content is never logged: a log says "loaded" and a length.
- Saving empty text removes the file.
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from dataclasses import dataclass, field
from pathlib import Path

from . import repository_settings, storage
from .artifact_io import atomic_write_text
from .errors import StorageAccessError
from .safe_paths import is_link_or_junction
from .user_config import user_config_dir

INSTRUCTION_SCOPES: tuple[str, ...] = ("user", "project")
INSTRUCTIONS_FILE_NAME = "instructions.md"
#: The most characters one file may hold. About 5,000 tokens: room for a team's
#: real conventions, small beside the context the task points at, and far below
#: anything that would crowd it out. Longer is refused, never cut.
MAX_INSTRUCTION_CHARS = 20_000

#: Bytes read at most: every character could be four bytes of UTF-8, plus a BOM.
_MAX_FILE_BYTES = MAX_INSTRUCTION_CHARS * 4 + 3

_SCOPE_LABELS = {"user": "User instructions", "project": "Project instructions"}
_SECTION_TITLES = {"user": "User Instructions", "project": "Project / Team Instructions"}
_SOURCES = {"user": "user configuration", "project": "repository configuration"}
_INTROS = {
    "user": "The developer's own instructions, for every repository they work on.",
    "project": "This repository's instructions for AI agents.",
}


class InstructionsError(ValueError):
    """Instructions that may not be saved, said in one sentence that names no absolute path."""


@dataclass(frozen=True)
class InstructionFile:
    """One scope's instructions as a task would carry them.

    ``text`` is what goes into the task, empty when there is none to include.
    ``problem`` says why a file that is there was left out. ``shown`` is the
    file as messages name it (US-D22), when known; it is not part of what the
    file is, so it never makes two files differ.
    """

    scope: str
    text: str = ""
    problem: str | None = None
    shown: str = field(default="", compare=False)

    @property
    def place(self) -> str:
        """The file as messages name it: ``shown``, or a description when it was built without one."""
        if self.shown:
            return self.shown
        return display_path("user") if self.scope == "user" else "this repository's settings"

    @property
    def configured(self) -> bool:
        return self.text != ""

    @property
    def characters(self) -> int:
        return len(self.text)

    @property
    def sha256(self) -> str:
        """What a prepared context depends on: the content, or the problem; empty for none."""
        if self.text:
            return hashlib.sha256(self.text.encode("utf-8")).hexdigest()
        if self.problem:
            return hashlib.sha256(f"problem:{self.problem}".encode("utf-8")).hexdigest()
        return ""

    @property
    def warning(self) -> str | None:
        if self.problem is None:
            return None
        return f"{_SCOPE_LABELS[self.scope]} ({self.place}) were not included: {self.problem}"

    @property
    def log_line(self) -> str:
        """For ``bugpilot.log``: never the content."""
        label = _SCOPE_LABELS[self.scope].lower()
        if self.configured:
            return f"[INFO] {label}: loaded ({self.characters} characters)"
        if self.problem:
            return f"[WARN] {self.warning}"
        return f"[INFO] {label}: none"


@dataclass(frozen=True)
class ResolvedInstructions:
    """Both scopes, read once for one task."""

    user: InstructionFile
    project: InstructionFile

    @property
    def files(self) -> tuple[InstructionFile, InstructionFile]:
        return (self.user, self.project)

    @property
    def warnings(self) -> tuple[str, ...]:
        return tuple(file.warning for file in self.files if file.warning)


# --- where they live -----------------------------------------------------------


def user_instructions_path(*, create: bool = False) -> Path:
    """``config/instructions.md``, from storage's checked accessor; ``create=True`` makes its folder ready to write."""
    return storage.global_storage().user_instructions_file(create=create)


def project_instructions_path(repo_root: Path) -> Path:
    """``settings/instructions.md`` in the repository's namespace, from storage's checked accessor; creates nothing."""
    return repository_settings.settings_file(repo_root, INSTRUCTIONS_FILE_NAME, create=False)


def instructions_path(scope: str, repo_root: Path) -> Path:
    _check_scope(scope)
    return user_instructions_path() if scope == "user" else project_instructions_path(repo_root)


def display_path(scope: str, repo_root: Path | None = None) -> str:
    """The file as a person would name it, never with a user's own folder in it (US-D22).

    The project's file is named by its repository's namespace, so it needs ``repo_root``.
    """
    if scope == "project":
        if repo_root is None:
            raise ValueError("The project's instructions file is named by its repository: repo_root is required.")
        return repository_settings.shown_path(repo_root, INSTRUCTIONS_FILE_NAME)
    return storage.display_path(user_config_dir() / INSTRUCTIONS_FILE_NAME)


def _check_scope(scope: str) -> None:
    if scope not in INSTRUCTION_SCOPES:
        raise InstructionsError(f"Unknown instructions scope {scope!r}. Choose one of: {', '.join(INSTRUCTION_SCOPES)}.")


def link_problem(path: Path, shown: str, rule: str) -> str | None:
    """A link at the file or at the folder holding it: read from somewhere else, so not at all.

    ``shown`` is the file as a person names it; ``rule`` finishes the sentence —
    "instructions are", "the Verification Policy is" — read and written only
    as a real file. Shared by every text document BugPilot reads from the
    repository's settings or the user's configuration, so all of them refuse alike.
    """
    for candidate, name in ((path.parent, shown.rsplit("/", 1)[0]), (path, shown)):
        if is_link_or_junction(candidate):
            return f"{name} is a symbolic link or junction, and {rule} read and written only as a real file"
    return None


def _link_problem(path: Path, shown: str) -> str | None:
    return link_problem(path, shown, "instructions are")


# --- reading -------------------------------------------------------------------


@dataclass(frozen=True)
class TextDocument:
    """A small UTF-8 document as read: its normalized text, or why it cannot be used.

    ``exists`` is whether something is at the path at all — a file that cannot
    be used still exists, and is still the developer's choice of source.
    """

    text: str = ""
    problem: str | None = None
    exists: bool = False


def _document_from(raw: bytes) -> TextDocument:
    try:
        decoded = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return TextDocument(problem="it is not UTF-8 text.", exists=True)
    text = normalize_instructions(decoded)
    if len(text) > MAX_INSTRUCTION_CHARS:
        return TextDocument(problem=_too_long_problem(len(text)), exists=True)
    return TextDocument(text=text, exists=True)


def read_instructions(scope: str, repo_root: Path) -> InstructionFile:
    """One scope's file, as a task would carry it. Never raises for the file's own state.

    Reaching it may refuse (storage's checks: a link on the way or at the file,
    a data folder inside the repository, a record naming another repository):
    that is not the file's state, and fails the command (owner decisions C-2,
    G-6). So does a folder on the way that cannot be read (``StorageAccessError``).
    The file is read by storage without following a link (Option C, M2), and
    judged by :func:`_document_of`'s rules.
    """
    _check_scope(scope)
    try:
        found = _read_scope(scope, repo_root)
    except repository_settings.FileReadError as exc:
        document = TextDocument(problem=f"it could not be read ({exc.strerror or type(exc).__name__}).", exists=True)
    else:
        document = _document_of(found)
    return InstructionFile(scope, text=document.text, problem=document.problem, shown=display_path(scope, repo_root))


def _read_scope(scope: str, repo_root: Path) -> storage.SettingsContent:
    if scope == "user":
        return repository_settings.guarded(
            "read",
            lambda: display_path("user"),
            lambda: storage.global_storage().read_user_instructions(limit=_MAX_FILE_BYTES),
        )
    return repository_settings.read_settings(repo_root, INSTRUCTIONS_FILE_NAME, limit=_MAX_FILE_BYTES)


def read_settings_document(repo_root: Path, name: storage.SettingsName) -> TextDocument:
    """One of the repository's settings documents, as a task would use it (0.1.7: ``verification.md``,
    ``ai_behavior.md``). Never raises for the file's own state.

    Read by storage without following a link, from the repository's namespace
    (``settings/<name>``), and judged by :func:`_document_of`'s rules.
    Reaching it may refuse (a link on the way or at the file, a data folder
    inside the repository, a record naming another repository): that fails
    the command, as it does for the project's instructions.
    """
    try:
        found = repository_settings.read_settings(repo_root, name, limit=_MAX_FILE_BYTES)
    except repository_settings.FileReadError as exc:
        return TextDocument(problem=f"it could not be read ({exc.strerror or type(exc).__name__}).", exists=True)
    return _document_of(found)


def _document_of(found: storage.SettingsContent) -> TextDocument:
    """A held read's result, judged by the rules every BugPilot text document follows. Never raises for its own state.

    Not a link (storage refused one before), a regular file, at most
    `MAX_INSTRUCTION_CHARS` once normalized, UTF-8 (a BOM allowed): anything
    else is left out whole, never cut short.
    """
    if found.state == "absent":
        return TextDocument()
    if found.state == "not_a_file":
        return TextDocument(problem="it is not a regular file.", exists=True)
    if found.state == "too_large":
        return TextDocument(problem=_too_long_problem(None), exists=True)
    return _document_from(found.data)


def load_instructions(repo_root: Path) -> ResolvedInstructions:
    return ResolvedInstructions(user=read_instructions("user", repo_root), project=read_instructions("project", repo_root))


def _too_long_problem(characters: int | None) -> str:
    size = f"it is {characters:,} characters" if characters is not None else "it is too large"
    return f"{size}, more than the {MAX_INSTRUCTION_CHARS:,} BugPilot includes. Shorten it."


def normalize_instructions(text: str) -> str:
    """The text as stored and included: unified line endings, no control characters, trimmed.

    U+2028 and U+2029 are line breaks here too (0.1.5): a reader that honours
    them would otherwise meet a line — a heading, say — that the containment,
    which reads ``\\n`` lines, never judged.
    """
    text = text.replace("\r\n", "\n").replace("\r", "\n").lstrip("﻿")
    text = text.replace("\N{LINE SEPARATOR}", "\n").replace("\N{PARAGRAPH SEPARATOR}", "\n")
    text = "".join(
        character for character in text if character in "\n\t" or unicodedata.category(character) != "Cc"
    )
    lines = [line.rstrip() for line in text.split("\n")]
    return "\n".join(lines).strip("\n")


# --- writing -------------------------------------------------------------------


def save_instructions(scope: str, repo_root: Path, text: str) -> InstructionFile:
    """Write one scope's file, or remove it when ``text`` is empty. Refuses through a link."""
    path = instructions_path(scope, repo_root)
    shown = display_path(scope, repo_root)
    normalized = normalize_instructions(text)
    if len(normalized) > MAX_INSTRUCTION_CHARS:
        raise InstructionsError(
            f"{_SCOPE_LABELS[scope]} were not saved: they are {len(normalized):,} characters, "
            f"more than the {MAX_INSTRUCTION_CHARS:,} BugPilot includes."
        )
    problem = _link_problem(path, shown)
    if problem:
        raise InstructionsError(f"{_SCOPE_LABELS[scope]} were not saved: {problem}.")
    if path.exists() and not path.is_file():
        raise InstructionsError(f"{_SCOPE_LABELS[scope]} were not saved: {shown} is not a regular file.")
    try:
        if normalized == "":
            # Cleared: no file, rather than an empty one that looks configured.
            if path.exists():
                _ready_to_write(scope, repo_root).unlink()
            return InstructionFile(scope, shown=shown)
        path = _ready_to_write(scope, repo_root)
        # Checked again now that the folder exists: it may have been created as a link meanwhile.
        problem = _link_problem(path, shown)
        if problem:
            raise InstructionsError(f"{_SCOPE_LABELS[scope]} were not saved: {problem}.")
        atomic_write_text(path, normalized + "\n")
    except StorageAccessError:
        raise  # already one sentence (the repository's namespace could not be made ready)
    except OSError as error:
        # Storage unavailable (C-1, F2-S): one sentence in the display form, never the system error's text.
        raise StorageAccessError.during("write", shown, error) from None
    return InstructionFile(scope, text=normalized, shown=shown)


def _ready_to_write(scope: str, repo_root: Path) -> Path:
    """The file, with its folder made ready by storage (``0700``, link-checked): the user's, or the repository's."""
    if scope == "user":
        return storage.global_storage().user_instructions_file(create=True)
    return repository_settings.settings_file(repo_root, INSTRUCTIONS_FILE_NAME, create=True)


# --- the task's sections -------------------------------------------------------------


_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")
#: One block-quote or list-item marker, with the whitespace before it. Read one at a time
#: (`_container_prefix`), never as a repeated group: a pattern that let the space after one marker
#: belong to the next as well backtracked exponentially on a line of many `> ` (found in review).
_MARKER = re.compile(r"[ \t]*(?:>|(?:[-+*]|\d{1,9}[.)])(?=[ \t]|$))")
#: An ATX heading at the top level: up to three spaces before it, as CommonMark reads it.
_ATX_HEADING = re.compile(r"^( {0,3})(#{1,6})(?=[ \t]|$)")
#: An ATX heading behind container markers, at any indentation (the container decides the column).
_ATX_HEADING_INSIDE = re.compile(r"^([ \t]*)(#{1,6})(?=[ \t]|$)")
#: Behind container markers: a line that would underline the one above it into a (setext) heading.
_SETEXT_UNDERLINE_INSIDE = re.compile(r"^[ \t]*(?:=+|-+)[ \t]*$")
#: A run of backticks or tildes where some container could make it a fence: any indentation.
_FENCE_LIKE = re.compile(r"^([ \t]*)(`{3,}|~{3,})(.*)$")
#: The start of a CommonMark HTML block, types 1-7, at any indentation. Type 7 (one complete tag
#: alone on its line) is matched broadly — any line from `<` + letter or `/` to a final `>`: escaping
#: a line that is not one costs a backslash, missing one would cost the containment.
_HTML_BLOCK_TAGS = (
    "address|article|aside|base|basefont|blockquote|body|caption|center|col|colgroup|dd|details|dialog|dir|"
    "div|dl|dt|fieldset|figcaption|figure|footer|form|frame|frameset|h[1-6]|head|header|hr|html|iframe|"
    "legend|li|link|main|menu|menuitem|nav|noframes|ol|optgroup|option|p|param|search|section|summary|"
    "table|tbody|td|tfoot|th|thead|title|tr|track|ul|script|pre|style|textarea"
)
_HTML_START = re.compile(
    r"^([ \t]*)"
    rf"(?=<(?:!--|\?|![A-Za-z]|!\[CDATA\[|/?(?:{_HTML_BLOCK_TAGS})(?:[\s/>]|$)|/?[A-Za-z][^\n]*>[ \t]*$))",
    re.IGNORECASE,
)
#: How many lines, in all, the look-ahead for indented fences may read before it stops trusting any:
#: bounded, so a pathological layer is still contained in linear time (escaped, never kept open).
_LOOKAHEAD_BUDGET = 200_000


def code_fence(line: str) -> str | None:
    """The fence a line opens or closes (its backticks or tildes), or None — as CommonMark reads it.

    A backtick fence's info string may not hold a backtick: ```` ``` x`y ```` is
    a line of text, not a fence, so a heading after it is a heading.
    """
    mark = _FENCE.match(line)
    if mark is None or (mark.group(1)[0] == "`" and "`" in line[mark.end():]):
        return None
    return mark.group(1)


def contained_markdown(text: str) -> str:
    """An editable layer's text, held inside the task section that quotes it.

    The task's own sections are ``##``. A Markdown reader must see none of the
    layer's lines as one of them, nothing the layer leaves open may run on over
    the sections after it, and BugPilot's own section reader must agree. Without
    a Markdown parser, the layer is made unambiguous instead (0.1.5, N1):

    - **Kept as written:** a code fence that opens at column 0 — always the
      document's own fence, since a fence never continues a list item lazily —
      and an indented one (1–3 spaces) that closes inside its own indentation,
      which reads the same whether or not a list item holds it. A column-0 fence
      left open is closed where the layer ends.
    - **Everywhere else:** an ATX heading — at the top level or behind a quote or
      list marker — is held two levels down; a ``---`` or ``===`` line never
      underlines the line above it into a heading; the start of an HTML block
      (an unclosed ``<!--`` included) and any other run of backticks or tildes
      get one backslash before them, so neither can open a block that hides or
      reshapes what follows.

    Line endings are unified first: CRLF, a lone CR, U+2028 and U+2029 all end
    a line. Nothing is dropped. The cost of being certain: a heading-shaped
    line inside a code block that sits in a list item or a quote is held down
    too, and that block's fence line gets its backslash.
    """
    for ending in ("\r\n", "\r", "\N{LINE SEPARATOR}", "\N{PARAGRAPH SEPARATOR}"):
        text = text.replace(ending, "\n")
    lines = text.split("\n")
    out: list[str] = []
    fence: str | None = None
    closes_at: int | None = None
    budget = [_LOOKAHEAD_BUDGET + 4 * len(lines)]
    for index, line in enumerate(lines):
        if fence is not None:
            out.append(line)
            if closes_at is not None:
                if index == closes_at:
                    fence = closes_at = None
            elif _closes(line, fence):
                fence = None
            continue
        mark = code_fence(line)
        if mark and line[0] in "`~":
            fence, closes_at = mark, None
            out.append(line)
            continue
        if mark:
            end = _indented_fence_end(lines, index, mark, budget)
            if end is not None:
                fence, closes_at = mark, end
                out.append(line)
                continue
        _append_contained(out, line)
    if fence is not None and closes_at is None:
        out.append(fence)
    return "\n".join(out)


def _closes(line: str, fence: str) -> bool:
    """Whether ``line`` closes ``fence``: its character, at least as long, nothing after it."""
    mark = code_fence(line)
    return bool(mark) and mark[0] == fence[0] and len(mark) >= len(fence) and line.strip() == mark


def _columns(line: str) -> int:
    """The line's indentation in columns, a tab reaching the next multiple of four."""
    column = 0
    for character in line:
        if character == " ":
            column += 1
        elif character == "\t":
            column += 4 - column % 4
        else:
            break
    return column


def _indented_fence_end(lines: list[str], start: int, fence: str, budget: list[int]) -> int | None:
    """Where a fence indented 1–3 spaces closes, when it closes the same however it is read; else None.

    Read as the document's own fence, it closes at its first closing line
    indented up to three spaces. Read as a fence inside a list item whose text
    starts at or before its indentation, it closes at a closing line inside that
    item — or ends with the item, at the first line indented less. The two agree
    only when a closing line comes, within the fence's own indentation, before
    any line indented less and before any closing line indented four to six
    columns (a closer inside some list item, not at the top level). Then the
    lines between are code to every reader.
    """
    indent = _columns(lines[start])
    for index in range(start + 1, len(lines)):
        budget[0] -= 1
        if budget[0] < 0:
            return None
        line = lines[index]
        stripped = line.strip()
        if not stripped:
            continue
        column = _columns(line)
        if column < indent:
            return None
        if set(stripped) == {fence[0]} and len(stripped) >= len(fence):
            if column <= 3:
                return index
            if column <= 6:
                return None
    return None


def _container_prefix(line: str) -> int:
    """Where the line's leading block-quote and list-item markers end, read one marker at a time (linear)."""
    position = 0
    while (marker := _MARKER.match(line, position)) is not None:
        position = marker.end()
    return position


def _append_contained(out: list[str], line: str) -> None:
    """One line outside every kept fence: escaped where it could open a block, held down where a heading.

    Behind a quote or list marker, at any indentation, the same rules apply to what follows the
    markers: the container decides the column a reader starts from, so every column is treated as one.
    """
    if line.lstrip(" \t")[:1].isalpha():
        # Prose: a line that starts with a letter is no heading, fence, HTML block, underline or marker.
        out.append(line)
        return
    split = _container_prefix(line)
    prefix, rest = line[:split], line[split:]
    fence_like = _FENCE_LIKE.match(rest)
    if fence_like and not (fence_like.group(2)[0] == "`" and "`" in fence_like.group(3)):
        rest = f"{fence_like.group(1)}\\{rest[fence_like.end(1):]}"
    else:
        html = _HTML_START.match(rest)
        if html:
            rest = f"{html.group(1)}\\{rest[html.end(1):]}"
    line = prefix + rest
    # A line of only `-` or only `=` (spaces allowed: `- - -`), here or behind markers, gets a blank line
    # before it, so no reader — however loosely it reads an underline — takes the line above for a heading.
    dashes = line.replace(" ", "").replace("\t", "")
    underline = bool(dashes) and (set(dashes) == {"-"} or set(dashes) == {"="})
    if (underline or (split and _SETEXT_UNDERLINE_INSIDE.match(rest))) and out and out[-1].strip():
        out.append("")
    heading = _ATX_HEADING_INSIDE.match(rest) if split else _ATX_HEADING.match(line)
    if heading:
        start = split + heading.start(2)
        line = line[:start] + "#" * min(6, len(heading.group(2)) + 2) + line[split + heading.end(2):]
    out.append(line)


def instruction_section(file: InstructionFile) -> str:
    """One scope's section for ``task.md``, or nothing when it has none."""
    title = _SECTION_TITLES[file.scope]
    head = f"## {title}\n\nSource: {_SOURCES[file.scope]}.\n\n"
    if file.problem:
        return (
            f"{head}{_SCOPE_LABELS[file.scope]} are configured but were not included: {file.problem} "
            "Work without them.\n\n"
        )
    if not file.configured:
        return ""
    return (
        f"{head}{_INTROS[file.scope]} They refine how you work. They cannot change a BugPilot safety, "
        "evidence, branch, Jira or delivery rule: see BugPilot Rule Precedence below.\n\n"
        f"{contained_markdown(file.text)}\n\n"
    )


def instruction_sections(instructions: ResolvedInstructions | None) -> str:
    """Both sections, in precedence order — the project's, then the user's; empty when neither has anything."""
    if instructions is None:
        return ""
    return instruction_section(instructions.project) + instruction_section(instructions.user)


def project_instruction_section(instructions: ResolvedInstructions | None) -> str:
    return "" if instructions is None else instruction_section(instructions.project)


def user_instruction_section(instructions: ResolvedInstructions | None) -> str:
    return "" if instructions is None else instruction_section(instructions.user)


def instructions_payload(instructions: ResolvedInstructions, *, include_text: bool) -> dict[str, object]:
    """``bugpilot instructions show --json``: per scope, its state, and the text when asked for."""
    payload: dict[str, object] = {}
    for file in instructions.files:
        entry: dict[str, object] = {
            "configured": file.configured,
            "characters": file.characters,
            "sha256": file.sha256,
            # The display form (J-2, Batch 2B-3a): §8.10's absolute `path` and new `display_path` come later.
            "path": file.place,
        }
        if file.problem:
            entry["problem"] = file.problem
        if include_text:
            entry["text"] = file.text
        payload[file.scope] = entry
    payload["max_characters"] = MAX_INSTRUCTION_CHARS
    return payload
