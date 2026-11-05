"""The repository's AI Behavior: its ``ai_behavior.md`` setting (0.1.4; in BugPilot's data folder since 0.1.7).

How an AI agent is expected to make and report changes in this repository —
its conventions and minimum expectations, not safety rules. One document, in
three fixed sections whose names no Fix Mode section uses::

    ---
    schema_version: 1
    based_on_version: 1
    mode: append
    ---

    ## Code Change Conventions
    - Keep public signatures stable; this library is used by plugins.

    ## Evidence Standards
    - Quote the log line that shows the failure.

    ## Reporting Standards
    - Name the module owner in Review Notes.

Unlike the Verification Policy, which replaces BugPilot's default whole, AI
Behavior is **default + project additions**: BugPilot's defaults always apply,
and the file adds this repository's own conventions beneath them (``mode:
append``, the one mode). Without the file there is nothing to warn about — the
defaults apply. A file that cannot be used is left out whole, the defaults
apply, and the run and ``bugpilot ai-behavior show`` say why.

It is not the Safety Rules, the Verification Policy, Project or User
Instructions, or a Fix Mode. BugPilot's rules are emitted unchanged, earlier in
the task, and the precedence says a conflict resolves in their favor; what to
verify is the Verification Policy's; how one attempt works is the Fix Mode's,
within these conventions. The file is a repository's own text, read by the
same rules as the instructions and the Verification Policy (no links, UTF-8,
20,000 characters, normalized, never logged), with the Verification Policy's
front-matter parser and conflict lint. The lint never blocks and is not a
defense.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path

from . import repository_settings
from .instructions import (
    MAX_INSTRUCTION_CHARS,
    TextDocument,
    contained_markdown,
    link_problem,
    normalize_instructions,
    read_settings_document,
)
from .verification import lint_policy, parse_document

AI_BEHAVIOR_FILE_NAME = "ai_behavior.md"
SCHEMA_VERSION = 1
#: The version of BugPilot's default AI Behavior (`DEFAULT_TEXT`). Raised
#: whenever that text changes, so a file written against an older one can be told.
DEFAULT_AI_BEHAVIOR_VERSION = 1
MODES = ("append",)

SOURCE_DEFAULT = "bugpilot-default"
SOURCE_FILE = "ai-behavior-file"

_LINK_RULE = "AI Behavior is"
_SHOW_COMMAND = "bugpilot ai-behavior show"

#: The document's sections, in order. Named so no Fix Mode section — Objective,
#: Investigation, Implementation, Verification, Constraints, Completion — is
#: mistaken for one of them, and no Fix Mode for a project convention.
SECTIONS: tuple[str, ...] = ("Code Change Conventions", "Evidence Standards", "Reporting Standards")

#: Why a file that holds nothing is not used — in AI Behavior's words, not the
#: Verification Policy's ("policy text"): its front matter alone, or not even that.
_NO_SECTIONS = (
    "it has no AI Behavior sections after its front matter "
    f"({', '.join(SECTIONS[:-1])} or {SECTIONS[-1]})."
)
_EMPTY_FILE = f"it is empty: no front matter and no AI Behavior sections (see `{_SHOW_COMMAND}`)."

#: What a new file holds when the settings row's Edit creates one: the three
#: sections, empty. Until something is written under them it adds nothing —
#: the task is the same as without the file (see `has_additions`).
TEMPLATE_BODY = "\n\n".join(f"## {name}" for name in SECTIONS)


class AiBehaviorError(ValueError):
    """AI Behavior that may not be saved or removed, in one sentence naming no absolute path."""


# --- BugPilot's defaults --------------------------------------------------------------------

#: BugPilot's default AI Behavior: the Working Guidance of 0.1.3 (§42.2), which
#: was built in until this document could carry it. Two of its lines are one
#: here (the existing style is "followed" and "preserved" alike), and its
#: "ask for clarification or write a no-op analysis" is not repeated: the
#: Evidence Rules — BugPilot rules — already say both.
DEFAULT_CODE_CHANGE_CONVENTIONS: tuple[str, ...] = (
    "Prefer small, targeted fixes near the identified root cause.",
    "Read the surrounding code before editing; follow its naming, formatting and patterns, and preserve the "
    "existing architecture and coding style.",
    "Do not refactor or modernize unrelated code.",
    "Do not rename public APIs unless required.",
    "Do not replace existing frameworks or patterns, or change file organization, unless required.",
    "Do not change product behavior outside the issue's scope.",
)

DEFAULT_TEXT = "## Code Change Conventions\n\n" + "\n".join(f"- {item}" for item in DEFAULT_CODE_CHANGE_CONVENTIONS)


# --- the file -------------------------------------------------------------------------------


@dataclass(frozen=True)
class AiBehaviorFile:
    """``settings/ai_behavior.md`` as read: the repository's additions and front matter, or why it cannot be used."""

    exists: bool = False
    #: The additions — the body after the front matter — normalized.
    text: str = ""
    problem: str | None = None
    schema_version: int | None = None
    based_on_version: int | None = None
    mode: str | None = None
    #: The file's line number of the body's first line, so a warning can point at it.
    first_line: int = 1
    #: Where the file is, as messages name it (display form, E-2): ``~/.bugpilot/.../settings/ai_behavior.md``.
    #: Never compared, never hashed, never in the task (E-1).
    shown: str = field(default="", compare=False)

    @property
    def characters(self) -> int:
        return len(self.text)


def shown_path(repo_root: Path) -> str:
    """``settings/ai_behavior.md`` as messages name it: ``~/.bugpilot/repositories/<id>/settings/...`` (E-2)."""
    return repository_settings.shown_path(repo_root, AI_BEHAVIOR_FILE_NAME)


def ai_behavior_path(repo_root: Path) -> Path:
    """``settings/ai_behavior.md`` in the repository's namespace, from storage's checked accessor; creates nothing."""
    return repository_settings.settings_file(repo_root, AI_BEHAVIOR_FILE_NAME, create=False)


def read_ai_behavior_file(repo_root: Path) -> AiBehaviorFile:
    """The repository's file, as a task would use it. Never raises for the file's own state; never creates it."""
    document: TextDocument = read_settings_document(repo_root, AI_BEHAVIOR_FILE_NAME)
    shown = shown_path(repo_root)
    if not document.exists:
        return AiBehaviorFile(shown=shown)
    if document.problem:
        return AiBehaviorFile(exists=True, problem=document.problem, shown=shown)
    if document.text.strip() == "":
        return AiBehaviorFile(exists=True, problem=_EMPTY_FILE, shown=shown)
    meta, body, problem = parse_document(document.text, MODES, _SHOW_COMMAND, _NO_SECTIONS)
    if problem:
        return AiBehaviorFile(exists=True, problem=problem, shown=shown)
    first_line = document.text[: len(document.text) - len(body)].count("\n") + 1
    return AiBehaviorFile(
        exists=True,
        text=body,
        schema_version=int(meta["schema_version"]),  # type: ignore[arg-type]
        based_on_version=int(meta["based_on_version"]),  # type: ignore[arg-type]
        mode=str(meta["mode"]),
        first_line=first_line,
        shown=shown,
    )


def render_document(body: str, based_on_version: int = DEFAULT_AI_BEHAVIOR_VERSION) -> str:
    """The file's full text for the repository's additions."""
    return (
        f"---\nschema_version: {SCHEMA_VERSION}\nbased_on_version: {based_on_version}\nmode: append\n---\n\n"
        f"{body}\n"
    )


def save_ai_behavior(repo_root: Path, text: str) -> AiBehaviorFile:
    """Write ``settings/ai_behavior.md`` from the additions, or from a whole document with its front matter.

    Additions get front matter naming the current default's version; a whole
    document keeps its own, which must parse. Refuses through a link, over the
    size limit, or without any text; never removes the file (that is
    `remove_ai_behavior`, so an empty paste cannot quietly drop the additions).
    """
    normalized = normalize_instructions(text)
    if normalized.startswith("---\n") or normalized == "---":
        meta, body, problem = parse_document(normalized, MODES, _SHOW_COMMAND, _NO_SECTIONS)
        if problem:
            raise AiBehaviorError(f"AI Behavior was not saved: {problem}")
        document = render_document(body, int(meta["based_on_version"]))  # type: ignore[arg-type]
    else:
        if normalized.strip() == "":
            raise AiBehaviorError(
                "AI Behavior was not saved: it has no text. "
                "To go back to BugPilot's defaults alone, use `bugpilot ai-behavior reset`."
            )
        document = render_document(normalized)
    if len(document) > MAX_INSTRUCTION_CHARS:
        raise AiBehaviorError(
            f"AI Behavior was not saved: it is {len(document):,} characters, "
            f"more than the {MAX_INSTRUCTION_CHARS:,} BugPilot includes."
        )
    path = ai_behavior_path(repo_root)
    shown = shown_path(repo_root)
    _refuse_link(path, "saved", shown)
    if path.exists() and not path.is_file():
        raise AiBehaviorError(f"AI Behavior was not saved: {shown} is not a regular file.")
    # Storage makes the namespace ready (``0700``, its record) and refuses a link there; the write is atomic.
    repository_settings.write_text(repo_root, AI_BEHAVIOR_FILE_NAME, document)
    return read_ai_behavior_file(repo_root)


def remove_ai_behavior(repo_root: Path) -> bool:
    """Remove the repository's additions, so BugPilot's defaults apply alone. True when a file was removed."""
    path = ai_behavior_path(repo_root)
    shown = shown_path(repo_root)
    _refuse_link(path, "removed", shown)
    if not path.exists():
        return False
    if not path.is_file():
        raise AiBehaviorError(f"AI Behavior was not removed: {shown} is not a regular file.")
    # Storage locates it again and removes it; an OSError is one sentence (E-5).
    return repository_settings.remove_file(repo_root, AI_BEHAVIOR_FILE_NAME)


def _refuse_link(path: Path, verb: str, shown: str) -> None:
    problem = link_problem(path, shown, _LINK_RULE)
    if problem:
        raise AiBehaviorError(f"AI Behavior was not {verb}: {problem}.")


_HTML_COMMENT = re.compile(r"<!--.*?-->", re.DOTALL)


def has_additions(body: str) -> bool:
    """Whether a file's body says anything: headings, blank lines and HTML comments alone add nothing.

    So the template Edit creates (`TEMPLATE_BODY`), or a file emptied back to
    its headings, leaves every task as it is without the file.
    """
    text = _HTML_COMMENT.sub("", body)
    return any(line.strip() and not _HEADING.match(line.strip()) for line in text.split("\n"))


# --- the lint -------------------------------------------------------------------------------

#: Headings that belong to a Fix Mode — its sections and the built-in modes'
#: names. A project convention filed under one reads as if it were the mode's.
_FIX_MODE_HEADINGS = frozenset(
    {
        "objective", "investigation", "implementation", "verification", "constraints", "completion",
        "completion requirements", "standard fix", "conservative fix", "investigate first",
        "test-driven fix", "deep analysis", "fix strategy",
    }
)
_HEADING = re.compile(r"^#{1,6}\s+(.*?)\s*#*\s*$")
#: A line about running tests or checks: the Verification Policy's business.
_VERIFICATION_LINE = re.compile(
    r"\b(?:run|runs|running|execute|rerun|re-run)\b[^\n]*\b(?:tests?|test suites?|static checks?|linters?|type checks?)\b",
    re.IGNORECASE,
)


def lint_ai_behavior(text: str, first_line: int = 1, shown: str = f"settings/{AI_BEHAVIOR_FILE_NAME}") -> tuple[str, ...]:
    """Lines worth a second look. Warnings only — the text is kept as written; never quotes it.

    The Verification Policy's conflict lint (a line that seems to ask for what a
    BugPilot rule forbids), plus two that are AI Behavior's own: a heading named
    like a Fix Mode section, and a line about running tests or checks, which
    the Verification Policy owns. Like that lint, it cannot understand the text
    and is not a defense. ``shown`` names the file in the warnings: a repository's display path (E-2).
    """
    warnings = list(lint_policy(text, first_line, shown))
    for number, line in enumerate(text.split("\n"), start=first_line):
        heading = _HEADING.match(line)
        if heading and heading.group(1).strip().lower() in _FIX_MODE_HEADINGS:
            warnings.append(
                f"Line {number} of {shown} is a heading named like a Fix Mode section. AI Behavior holds "
                f"this repository's conventions; use {', '.join(SECTIONS[:-1])} or {SECTIONS[-1]}."
            )
        elif not heading and _VERIFICATION_LINE.search(line):
            warnings.append(
                f"Line {number} of {shown} looks like a verification expectation. What to verify belongs "
                "in the Verification Policy, which the task states on its own."
            )
    return tuple(warnings)


# --- the effective behavior -----------------------------------------------------------------


@dataclass(frozen=True)
class ResolvedAiBehavior:
    """The AI Behavior one task is written with: BugPilot's defaults, the repository's additions, what was wrong."""

    source: str = SOURCE_DEFAULT
    file: AiBehaviorFile = field(default_factory=AiBehaviorFile)
    lint: tuple[str, ...] = ()

    @property
    def problem(self) -> str | None:
        """Why the repository's file is not used, when it exists and cannot be."""
        return self.file.problem if self.source == SOURCE_FILE else None

    @property
    def default_text(self) -> str:
        return DEFAULT_TEXT

    @property
    def project_text(self) -> str:
        """The repository's additions as the task carries them; empty without a usable file."""
        if self.source != SOURCE_FILE or self.problem or not has_additions(self.file.text):
            return ""
        return self.file.text

    @property
    def has_project_additions(self) -> bool:
        return self.project_text != ""

    @property
    def text(self) -> str:
        """Defaults, then additions: what a task's AI Behavior section says."""
        return f"{DEFAULT_TEXT}\n\n{self.project_text}" if self.has_project_additions else DEFAULT_TEXT

    @property
    def based_on_version(self) -> int | None:
        return self.file.based_on_version if self.has_project_additions else None

    @property
    def default_changed(self) -> bool:
        """The additions were written against an older default than BugPilot's current one."""
        return self.based_on_version is not None and self.based_on_version < DEFAULT_AI_BEHAVIOR_VERSION

    @property
    def sha256(self) -> str:
        """What a prepared context depends on: source, problem, version and text together."""
        # A file that adds nothing hashes as no file: the task is the same (0.1.4).
        source = self.source if self.has_project_additions or self.problem else SOURCE_DEFAULT
        material = f"{source}\n{self.problem or ''}\n{self.based_on_version or ''}\n{self.text}"
        return hashlib.sha256(material.encode("utf-8")).hexdigest()

    @property
    def warnings(self) -> tuple[str, ...]:
        found = []
        if self.problem:
            found.append(f"AI Behavior ({self.file.shown}) was not used: {self.problem} BugPilot's defaults apply.")
        return (*found, *self.lint)

    @property
    def log_line(self) -> str:
        """For ``bugpilot.log``: the source and a length, never the text."""
        if self.problem:
            return f"[WARN] ai behavior: {self.file.shown} not used ({self.problem}); the defaults apply"
        if self.has_project_additions:
            return f"[INFO] ai behavior: defaults + {self.file.shown} ({self.file.characters} characters)"
        if self.source == SOURCE_FILE:
            return f"[INFO] ai behavior: bugpilot-default ({self.file.shown} adds nothing yet)"
        return "[INFO] ai behavior: bugpilot-default"


def resolve_ai_behavior(repo_root: Path) -> ResolvedAiBehavior:
    """The effective AI Behavior: BugPilot's defaults, plus the repository's additions when its file is usable."""
    file = read_ai_behavior_file(repo_root)
    if not file.exists:
        return ResolvedAiBehavior(file=file)  # where the file would be, for show --json's path (E-9)
    if file.problem:
        return ResolvedAiBehavior(source=SOURCE_FILE, file=file)
    return ResolvedAiBehavior(source=SOURCE_FILE, file=file, lint=lint_ai_behavior(file.text, file.first_line, file.shown))


# --- task.md --------------------------------------------------------------------------------


def ai_behavior_section(resolved: ResolvedAiBehavior | None = None) -> str:
    """``## AI Behavior`` for ``task.md``: always present, exactly once — defaults, then any additions.

    The framing is BugPilot's whatever the file says: these are conventions,
    beneath BugPilot's rules; the Fix Mode works within them; BugPilot's
    defaults may be refined by any later layer, the additions belong to the
    project / team layer.
    """
    resolved = resolved or ResolvedAiBehavior()
    notice = ""
    if resolved.problem:
        source = "BugPilot defaults, because the repository's AI Behavior could not be used"
        notice = (
            f"The repository's AI Behavior was not included: {resolved.problem} "
            "Until it is fixed, BugPilot's defaults apply.\n\n"
        )
    elif resolved.has_project_additions:
        source = "BugPilot defaults, with this repository's additions"
    else:
        source = "BugPilot defaults"
    additions = (
        f"### Repository Additions\n\n{contained_markdown(resolved.project_text)}\n\n"
        if resolved.has_project_additions
        else ""
    )
    defaults = DEFAULT_TEXT.replace("## Code Change Conventions", "### Code Change Conventions", 1)
    return (
        "## AI Behavior\n\n"
        f"Source: {source}.\n\n"
        f"{notice}"
        "Conventions and minimum expectations for how you make and report changes in this repository: "
        "guidance, not safety rules. The selected AI Fix Mode decides how this attempt works within them. "
        "Any later layer may refine BugPilot's defaults; this repository's additions belong to the "
        "project / team layer.\n\n"
        f"{defaults}\n\n"
        f"{additions}"
    )


def ai_behavior_payload(resolved: ResolvedAiBehavior) -> dict[str, object]:
    """``bugpilot ai-behavior show --json``: the effective behavior, its parts, and its file's state."""
    file = resolved.file
    return {
        "source": resolved.source,
        "path": file.shown,
        "text": resolved.text,
        "default_text": DEFAULT_TEXT,
        "project_text": resolved.project_text,
        "sha256": resolved.sha256,
        "file": {
            "exists": file.exists,
            "characters": file.characters,
            "schema_version": file.schema_version,
            "based_on_version": file.based_on_version,
            "mode": file.mode,
            "problem": file.problem,
        },
        "based_on_version": resolved.based_on_version,
        "default_version": DEFAULT_AI_BEHAVIOR_VERSION,
        "default_changed": resolved.default_changed,
        "has_project_additions": resolved.has_project_additions,
        "differs_from_default": resolved.has_project_additions,
        "sections": list(SECTIONS),
        "problem": resolved.problem,
        "lint": list(resolved.lint),
        "max_characters": MAX_INSTRUCTION_CHARS,
        # What `set --stdin` is given to create the file with its sections, empty.
        "template": TEMPLATE_BODY,
    }
