"""User Instructions and Project / Team Instructions.

Two optional Markdown files, each in one fixed place::

    ~/.bugpilot/instructions.md        User Instructions: this developer's own,
                                       for every repository they work on
    <repo>/.bugpilot/instructions.md   Project / Team Instructions: this
                                       repository's, meant to be committed

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
- The text is the developer's, kept as written except: line endings unified,
  control characters other than tab removed, trailing spaces trimmed, Markdown
  headings moved two levels down (so a heading in the file cannot pose as one
  of the task's own sections), and a code fence left open at the end closed.
- The content is never logged: a log says "loaded" and a length.
- Saving empty text removes the file.
"""

from __future__ import annotations

import hashlib
import os
import re
import unicodedata
from dataclasses import dataclass
from pathlib import Path

from .artifact_io import atomic_write_text
from .safe_paths import is_link_or_junction
from .user_config import CONFIG_DIR_ENV, user_config_dir

INSTRUCTION_SCOPES: tuple[str, ...] = ("user", "project")
INSTRUCTIONS_FILE_NAME = "instructions.md"
PROJECT_CONFIG_DIR = ".bugpilot"

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
    "project": "This repository's shared instructions for AI agents.",
}


class InstructionsError(ValueError):
    """Instructions that may not be saved, said in one sentence that names no absolute path."""


@dataclass(frozen=True)
class InstructionFile:
    """One scope's instructions as a task would carry them.

    ``text`` is what goes into the task, empty when there is none to include.
    ``problem`` says why a file that is there was left out.
    """

    scope: str
    text: str = ""
    problem: str | None = None

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
        return f"{_SCOPE_LABELS[self.scope]} ({display_path(self.scope)}) were not included: {self.problem}"

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


def user_instructions_path() -> Path:
    return user_config_dir() / INSTRUCTIONS_FILE_NAME


def project_instructions_path(repo_root: Path) -> Path:
    return repo_root / PROJECT_CONFIG_DIR / INSTRUCTIONS_FILE_NAME


def instructions_path(scope: str, repo_root: Path) -> Path:
    _check_scope(scope)
    return user_instructions_path() if scope == "user" else project_instructions_path(repo_root)


def display_path(scope: str) -> str:
    """The file as a person would name it, never with a user's own folder in it."""
    if scope == "project":
        return f"{PROJECT_CONFIG_DIR}/{INSTRUCTIONS_FILE_NAME}"
    override = os.getenv(CONFIG_DIR_ENV)
    if override and override.strip():
        return f"{CONFIG_DIR_ENV}/{INSTRUCTIONS_FILE_NAME}"
    return f"~/.bugpilot/{INSTRUCTIONS_FILE_NAME}"


def _check_scope(scope: str) -> None:
    if scope not in INSTRUCTION_SCOPES:
        raise InstructionsError(f"Unknown instructions scope {scope!r}. Choose one of: {', '.join(INSTRUCTION_SCOPES)}.")


def _link_problem(scope: str, path: Path) -> str | None:
    """A link at the file or at the folder holding it: read from somewhere else, so not at all."""
    shown = display_path(scope)
    for candidate, name in ((path.parent, shown.rsplit("/", 1)[0]), (path, shown)):
        if is_link_or_junction(candidate):
            return f"{name} is a symbolic link or junction, and instructions are read and written only as a real file"
    return None


# --- reading -------------------------------------------------------------------


def read_instructions(scope: str, repo_root: Path) -> InstructionFile:
    """One scope's file, as a task would carry it. Never raises for the file's own state."""
    path = instructions_path(scope, repo_root)
    problem = _link_problem(scope, path)
    if problem:
        return InstructionFile(scope, problem=problem + ".")
    try:
        if not path.exists():
            return InstructionFile(scope)
        if not path.is_file():
            return InstructionFile(scope, problem="it is not a regular file.")
        if path.stat().st_size > _MAX_FILE_BYTES:
            return InstructionFile(scope, problem=_too_long_problem(None))
        raw = path.read_bytes()
    except OSError as exc:
        return InstructionFile(scope, problem=f"it could not be read ({exc.strerror or type(exc).__name__}).")
    try:
        decoded = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        return InstructionFile(scope, problem="it is not UTF-8 text.")
    text = normalize_instructions(decoded)
    if len(text) > MAX_INSTRUCTION_CHARS:
        return InstructionFile(scope, problem=_too_long_problem(len(text)))
    return InstructionFile(scope, text=text)


def load_instructions(repo_root: Path) -> ResolvedInstructions:
    return ResolvedInstructions(user=read_instructions("user", repo_root), project=read_instructions("project", repo_root))


def _too_long_problem(characters: int | None) -> str:
    size = f"it is {characters:,} characters" if characters is not None else "it is too large"
    return f"{size}, more than the {MAX_INSTRUCTION_CHARS:,} BugPilot includes. Shorten it."


def normalize_instructions(text: str) -> str:
    """The text as stored and included: unified line endings, no control characters, trimmed."""
    text = text.replace("\r\n", "\n").replace("\r", "\n").lstrip("﻿")
    text = "".join(
        character for character in text if character in "\n\t" or unicodedata.category(character) != "Cc"
    )
    lines = [line.rstrip() for line in text.split("\n")]
    return "\n".join(lines).strip("\n")


# --- writing -------------------------------------------------------------------


def save_instructions(scope: str, repo_root: Path, text: str) -> InstructionFile:
    """Write one scope's file, or remove it when ``text`` is empty. Refuses through a link."""
    path = instructions_path(scope, repo_root)
    shown = display_path(scope)
    normalized = normalize_instructions(text)
    if len(normalized) > MAX_INSTRUCTION_CHARS:
        raise InstructionsError(
            f"{_SCOPE_LABELS[scope]} were not saved: they are {len(normalized):,} characters, "
            f"more than the {MAX_INSTRUCTION_CHARS:,} BugPilot includes."
        )
    problem = _link_problem(scope, path)
    if problem:
        raise InstructionsError(f"{_SCOPE_LABELS[scope]} were not saved: {problem}.")
    if path.exists() and not path.is_file():
        raise InstructionsError(f"{_SCOPE_LABELS[scope]} were not saved: {shown} is not a regular file.")
    if normalized == "":
        # Cleared: no file, rather than an empty one that looks configured.
        if path.exists():
            path.unlink()
        return InstructionFile(scope)
    path.parent.mkdir(parents=True, exist_ok=True)
    # Checked again now that the folder exists: it may have been created as a link meanwhile.
    problem = _link_problem(scope, path)
    if problem:
        raise InstructionsError(f"{_SCOPE_LABELS[scope]} were not saved: {problem}.")
    atomic_write_text(path, normalized + "\n")
    return InstructionFile(scope, text=normalized)


# --- the task's sections -------------------------------------------------------------


_ATX_HEADING = re.compile(r"^( {0,3})(#{1,6})(?=[ \t]|$)")
_FENCE = re.compile(r"^ {0,3}(`{3,}|~{3,})")


def _contained(text: str) -> str:
    """The text with its headings two levels down, and any open code fence closed.

    The task's own sections are ``##``; inside one, the file's ``#`` and ``##``
    become ``###`` and ``####``, so nothing in it reads as a section of the task.
    """
    lines = []
    fence: str | None = None
    for line in text.split("\n"):
        opening = _FENCE.match(line)
        if fence is None:
            if opening:
                fence = opening.group(1)
            else:
                line = _ATX_HEADING.sub(lambda match: match.group(1) + "#" * min(6, len(match.group(2)) + 2), line)
        elif opening and opening.group(1)[0] == fence[0] and len(opening.group(1)) >= len(fence) and line.strip() == opening.group(1):
            fence = None
        lines.append(line)
    if fence is not None:
        lines.append(fence)
    return "\n".join(lines)


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
        f"{_contained(file.text)}\n\n"
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
            "path": display_path(file.scope),
        }
        if file.problem:
            entry["problem"] = file.problem
        if include_text:
            entry["text"] = file.text
        payload[file.scope] = entry
    payload["max_characters"] = MAX_INSTRUCTION_CHARS
    return payload
