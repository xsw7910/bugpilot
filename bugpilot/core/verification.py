"""The repository's Verification Policy as text: ``<repo>/.bugpilot/verification.md``.

What a pass that changes source code is expected to verify, written in the
words the task carries — not four switches. The file replaces BugPilot's
default policy whole (replacement, never append: the policy says what is and
what is not required, and an appended line cannot take a default one back)::

    ---
    schema_version: 1
    based_on_version: 1
    mode: replace
    ---

    - Run the tests relevant to the changed behavior.
    - The repository's full test suite is not required.

Front matter, between two ``---`` lines, holds exactly three keys:
``schema_version`` (this format; 1), ``based_on_version`` (the version of
BugPilot's default policy the text was written from, so a later default can be
pointed out) and ``mode`` (``replace``, the one mode). No YAML library: one
``key: value`` per line, integers as digits, nothing else accepted. A file whose
front matter is missing or malformed is not guessed at — it is not used, the
default applies, and the run and ``bugpilot verification show`` say why.

Where the effective policy comes from, in order (``verification_source``):

1. ``verification-file`` — ``.bugpilot/verification.md`` exists. It wins, even
   over saved switches; a file that cannot be used still wins, and the default
   applies until it is fixed.
2. ``legacy-project-settings`` — no file, and ``.bugpilot/project_settings.json``
   is saved: its four switches (BugPilot 0.1.2 and earlier), rendered as text.
3. ``bugpilot-default`` — neither: BugPilot's default text.

The switches stay readable and writable (``project-settings set``) for older
BugPilot versions, but once the file exists they no longer decide anything for
this one — a teammate on 0.1.2 can change them, and 0.1.3 does not follow.

The file is a repository's own text, so it is untrusted input to the task. It
is read by the instructions' rules (`instructions.read_text_document`: no links,
UTF-8, 20,000 characters, normalized, never logged), its headings are kept
below the task's own, and `lint_policy` points out lines that look like they
contradict a BugPilot rule. The lint never blocks and is not a defense: the
protection is that BugPilot's rules are emitted unchanged, earlier in the task,
with the precedence saying a conflict resolves in their favor.
"""

from __future__ import annotations

import hashlib
import re
from dataclasses import dataclass, field
from pathlib import Path

from .artifact_io import atomic_write_text
from .instructions import (
    MAX_INSTRUCTION_CHARS,
    PROJECT_CONFIG_DIR,
    TextDocument,
    contained_markdown,
    link_problem,
    normalize_instructions,
    read_text_document,
)

VERIFICATION_FILE_NAME = "verification.md"
SHOWN_PATH = f"{PROJECT_CONFIG_DIR}/{VERIFICATION_FILE_NAME}"
SCHEMA_VERSION = 1
#: The version of BugPilot's default policy text (`DEFAULT_TEXT`). Raised
#: whenever that text changes, so a file written from an older one can be told.
DEFAULT_POLICY_VERSION = 1
MODES = ("replace",)

SOURCE_DEFAULT = "bugpilot-default"
SOURCE_LEGACY = "legacy-project-settings"
SOURCE_FILE = "verification-file"

_LINK_RULE = "the Verification Policy is"
_FRONT_MATTER_KEYS = ("schema_version", "based_on_version", "mode")
_INTEGER = re.compile(r"[1-9][0-9]{0,5}")


class VerificationError(ValueError):
    """A Verification Policy that may not be saved or removed, in one sentence naming no absolute path."""


# --- BugPilot's own text --------------------------------------------------------------------

#: What every policy BugPilot writes says beyond the four switches. These came
#: from the Testing Expectations of BugPilot's Safety Rules (0.1.3, §42.2): they
#: are what to verify, which is the project's to decide, so they belong to the
#: Verification Policy and not to a rule nothing may relax. The one part that is
#: a rule — never claim a test or check ran unless it did — stayed a rule.
ALWAYS_LINES: tuple[str, ...] = (
    "- Not every test suite is available or runnable here; when automated tests are unavailable, "
    "describe the manual validation you did instead.",
    "- Report the regression risk of the change, and the commands you attempted with their results.",
)


def switch_lines(relevant_tests: bool, static_checks: bool, full_suite: bool, report_not_run: bool) -> list[str]:
    """The four switches' lines, worded as BugPilot 0.1.2 worded them."""
    return [
        "- Run the tests relevant to the changed behavior."
        if relevant_tests
        else "- Running tests for the changed behavior is not required by this project.",
        "- Run the repository's existing static checks (linters, type checks, compiler warnings) when they are available."
        if static_checks
        else "- Static checks are not required by this project.",
        "- Run the repository's full test suite before reporting, if it can run in this environment."
        if full_suite
        else "- The repository's full test suite is not required.",
        "- Report the relevant verification you did not run, and why."
        if report_not_run
        else "- Listing verification you did not run is optional; never claim a check ran unless it did.",
    ]


def text_for_switches(relevant_tests: bool, static_checks: bool, full_suite: bool, report_not_run: bool) -> str:
    """The policy text a set of switches stands for."""
    return "\n".join([*switch_lines(relevant_tests, static_checks, full_suite, report_not_run), *ALWAYS_LINES])


#: BugPilot's default Verification Policy: the default switches, as text.
DEFAULT_TEXT = text_for_switches(True, True, False, True)


# --- the file -------------------------------------------------------------------------------


@dataclass(frozen=True)
class VerificationFile:
    """``.bugpilot/verification.md`` as read: its policy text and front matter, or why it cannot be used."""

    exists: bool = False
    #: The policy itself — the body after the front matter — normalized.
    text: str = ""
    problem: str | None = None
    schema_version: int | None = None
    based_on_version: int | None = None
    mode: str | None = None
    #: The file's line number of the body's first line, so a warning can point at it.
    first_line: int = 1

    @property
    def characters(self) -> int:
        return len(self.text)


def verification_path(repo_root: Path) -> Path:
    return repo_root / PROJECT_CONFIG_DIR / VERIFICATION_FILE_NAME


def parse_document(
    text: str,
    modes: tuple[str, ...] = MODES,
    command: str = "bugpilot verification show",
    empty: str = "it has no policy text after its front matter.",
) -> tuple[dict[str, object], str, str | None]:
    """(front matter, body, problem) of a normalized document. Deterministic; never raises.

    The problem, when there is one, says exactly what is wrong — the file is
    then not used, so the sentence has to be enough to fix it. ``modes``,
    ``command`` and ``empty`` (the sentence for nothing after the front matter)
    let the repository's AI Behavior document (`ai_behavior.py`), which has the
    same front matter with another mode, share this parser in its own words.
    """
    lines = text.split("\n")
    if not lines or lines[0] != "---":
        return {}, "", f"it has no front matter: its first line must be --- (see `{command}`)."
    try:
        closing = lines.index("---", 1)
    except ValueError:
        return {}, "", "its front matter is not closed by a --- line."
    meta: dict[str, object] = {}
    for number, line in enumerate(lines[1:closing], start=2):
        if line.strip() == "":
            continue
        key, separator, value = line.partition(":")
        key, value = key.strip(), value.strip()
        if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
            value = value[1:-1]
        if not separator or key not in _FRONT_MATTER_KEYS:
            return {}, "", (
                f"line {number} of its front matter is not one of {', '.join(_FRONT_MATTER_KEYS)} as `key: value`."
            )
        if key in meta:
            return {}, "", f"its front matter sets {key} twice."
        if key == "mode":
            meta[key] = value
        elif _INTEGER.fullmatch(value):
            meta[key] = int(value)
        else:
            return {}, "", f"its front matter's {key} must be a whole number, not {value[:20]!r}."
    for key in _FRONT_MATTER_KEYS:
        if key not in meta:
            return {}, "", f"its front matter has no {key}."
    if meta["schema_version"] != SCHEMA_VERSION:
        newer = isinstance(meta["schema_version"], int) and meta["schema_version"] > SCHEMA_VERSION
        reason = "a newer BugPilot wrote it" if newer else "this BugPilot reads schema_version 1"
        return {}, "", f"its front matter's schema_version is {meta['schema_version']}, and {reason}."
    if meta["mode"] not in modes:
        return {}, "", f"its front matter's mode is {str(meta['mode'])[:20]!r}; the only mode is {' or '.join(modes)}."
    body = "\n".join(lines[closing + 1:]).strip("\n")
    if body.strip() == "":
        return {}, "", empty
    return meta, body, None


def read_verification_file(repo_root: Path) -> VerificationFile:
    """The repository's file, as a task would use it. Never raises for the file's own state."""
    path = verification_path(repo_root)
    document: TextDocument = read_text_document(path, link_problem(path, SHOWN_PATH, _LINK_RULE))
    if not document.exists:
        return VerificationFile()
    if document.problem:
        return VerificationFile(exists=True, problem=document.problem)
    meta, body, problem = parse_document(document.text)
    if problem:
        return VerificationFile(exists=True, problem=problem)
    # The body is the end of the normalized document, so what precedes it is
    # the front matter and the blank lines after it.
    first_line = document.text[: len(document.text) - len(body)].count("\n") + 1
    return VerificationFile(
        exists=True,
        text=body,
        schema_version=int(meta["schema_version"]),  # type: ignore[arg-type]
        based_on_version=int(meta["based_on_version"]),  # type: ignore[arg-type]
        mode=str(meta["mode"]),
        first_line=first_line,
    )


def render_document(body: str, based_on_version: int = DEFAULT_POLICY_VERSION) -> str:
    """The file's full text for a policy body."""
    return (
        f"---\nschema_version: {SCHEMA_VERSION}\nbased_on_version: {based_on_version}\nmode: replace\n---\n\n"
        f"{body}\n"
    )


def save_verification(repo_root: Path, text: str) -> VerificationFile:
    """Write ``.bugpilot/verification.md`` from a policy body, or from a whole document with its front matter.

    A body gets front matter naming the current default's version. A whole
    document keeps its own, which must parse. Refuses through a link, over the
    size limit, or without any policy text; never removes the file (that is
    `remove_verification`, so an empty paste cannot quietly reset a policy).
    """
    normalized = normalize_instructions(text)
    if normalized.startswith("---\n") or normalized == "---":
        meta, body, problem = parse_document(normalized)
        if problem:
            raise VerificationError(f"The Verification Policy was not saved: {problem}")
        document = render_document(body, int(meta["based_on_version"]))  # type: ignore[arg-type]
    else:
        body = normalized
        if body.strip() == "":
            raise VerificationError(
                "The Verification Policy was not saved: it has no policy text. "
                "To go back to BugPilot's default, use `bugpilot verification reset`."
            )
        document = render_document(body)
    if len(document) > MAX_INSTRUCTION_CHARS:
        raise VerificationError(
            f"The Verification Policy was not saved: it is {len(document):,} characters, "
            f"more than the {MAX_INSTRUCTION_CHARS:,} BugPilot includes."
        )
    path = verification_path(repo_root)
    _refuse_link(path, "saved")
    if path.exists() and not path.is_file():
        raise VerificationError(f"The Verification Policy was not saved: {SHOWN_PATH} is not a regular file.")
    path.parent.mkdir(parents=True, exist_ok=True)
    # Checked again now that the folder exists: it may have been created as a link meanwhile.
    _refuse_link(path, "saved")
    atomic_write_text(path, document)
    return read_verification_file(repo_root)


def remove_verification(repo_root: Path) -> bool:
    """Remove the repository's override, so the switches or BugPilot's default apply. True when a file was removed."""
    path = verification_path(repo_root)
    _refuse_link(path, "removed")
    if not path.exists():
        return False
    if not path.is_file():
        raise VerificationError(f"The Verification Policy was not removed: {SHOWN_PATH} is not a regular file.")
    path.unlink()
    return True


def _refuse_link(path: Path, verb: str) -> None:
    problem = link_problem(path, SHOWN_PATH, _LINK_RULE)
    if problem:
        raise VerificationError(f"The Verification Policy was not {verb}: {problem}.")


# --- the lint -------------------------------------------------------------------------------

#: A line saying one of these is fine: it is the rule, not its opposite.
_NEGATED = re.compile(
    r"\b(?:never|not|no|avoid|forbid(?:den)?|prohibit(?:ed)?|cannot|must\s+not|do\s+not|don't|doesn't|isn't|can't)\b",
    re.IGNORECASE,
)

#: (what the line seems to ask for, its pattern, whether a negated line is fine).
_LINT_RULES: tuple[tuple[str, re.Pattern[str], bool], ...] = (
    ("force push", re.compile(r"\bforce[- ]?push|\bpush\b[^\n]*\s(?:--force(?:-with-lease)?|-f)\b", re.IGNORECASE), True),
    (
        "commit or push without the developer's approval",
        re.compile(
            r"\b(?:commit|push)\w*\b[^\n]*\bwithout\b[^\n]*\b(?:approv\w*|ask\w*|confirm\w*|permission)"
            r"|\bauto(?:matically)?[- ]?(?:commit|push)",
            re.IGNORECASE,
        ),
        True,
    ),
    (
        "commit or push without the developer's approval",
        re.compile(r"\bno\s+need\s+(?:to|for)\b[^\n]*\b(?:approv\w*|ask\w*|confirm\w*|permission)", re.IGNORECASE),
        False,
    ),
    ("staging .ai/ or .ai_memory/", re.compile(r"\b(?:git\s+add|stage|commit)\b[^\n]*\.ai(?:_memory)?/", re.IGNORECASE), True),
    (
        "ignoring BugPilot's safety rules",
        re.compile(r"\b(?:ignore|disregard|override|bypass)\b[^\n]*\b(?:safety|bugpilot|protected)\b[^\n]*\brules?\b", re.IGNORECASE),
        True,
    ),
    (
        "claiming tests or checks passed that did not run",
        re.compile(
            r"\b(?:claim|report|say|state|mark)\w*\b[^\n]*\b(?:pass\w*|green|succe\w*)\b[^\n]*"
            r"\b(?:even\s+if|without\s+running|whether\s+or\s+not|regardless)\b",
            re.IGNORECASE,
        ),
        True,
    ),
    (
        "leaving out verification that did not run",
        re.compile(
            r"\b(?:do\s+not|don't|never|no\s+need\s+to)\s+(?:report|mention|list|say)\b[^\n]*"
            r"\b(?:not\s+run|did\s+not\s+run|didn't\s+run|skipped|failed|failures?|unverified)\b",
            re.IGNORECASE,
        ),
        False,
    ),
)


def lint_policy(text: str, first_line: int = 1, shown_path: str = SHOWN_PATH) -> tuple[str, ...]:
    """Lines that look like they contradict a BugPilot rule. Warnings only — the text is kept as written.

    Deliberately narrow: a policy that says "never force push" is the rule, not
    its opposite, so a negated line passes where that makes sense. It cannot
    understand the text, and it is not a defense against a hostile repository:
    BugPilot's rules come first in the task and win a conflict either way. Says
    which line of the file (the body starts at ``first_line``), never what the
    line says.
    """
    warnings: list[str] = []
    for number, line in enumerate(text.split("\n"), start=first_line):
        seen: set[str] = set()
        for label, pattern, negation_is_fine in _LINT_RULES:
            match = pattern.search(line)
            if label in seen or match is None:
                continue
            # Negated before what it asks for ("never force push", "do not
            # commit without approval"), the line is the rule. A "not" after it
            # is part of the condition: "report tests as passed even if they did
            # not run" is the opposite of the rule.
            if negation_is_fine and _NEGATED.search(line[: match.start()]):
                continue
            seen.add(label)
            warnings.append(
                f"Line {number} of {shown_path} may conflict with a BugPilot rule ({label}). "
                "The BugPilot rule still applies; the policy is kept as written."
            )
    return tuple(warnings)


# --- the effective policy -------------------------------------------------------------------


@dataclass(frozen=True)
class ResolvedVerification:
    """The policy one task is written with: where it came from, its text, and what was wrong."""

    source: str = SOURCE_DEFAULT
    #: The policy the task carries: the file's body, the switches' text, or the default.
    text: str = DEFAULT_TEXT
    file: VerificationFile = field(default_factory=VerificationFile)
    lint: tuple[str, ...] = ()

    @property
    def problem(self) -> str | None:
        """Why the repository's file is not used, when it exists and cannot be."""
        return self.file.problem if self.source == SOURCE_FILE else None

    @property
    def differs_from_default(self) -> bool:
        return self.text != DEFAULT_TEXT

    @property
    def based_on_version(self) -> int | None:
        return self.file.based_on_version if self.source == SOURCE_FILE else None

    @property
    def default_changed(self) -> bool:
        """The file was written from an older default than BugPilot's current one."""
        return self.based_on_version is not None and self.based_on_version < DEFAULT_POLICY_VERSION

    @property
    def sha256(self) -> str:
        """What a prepared context depends on: source, problem, version and text together."""
        material = f"{self.source}\n{self.problem or ''}\n{self.based_on_version or ''}\n{self.text}"
        return hashlib.sha256(material.encode("utf-8")).hexdigest()

    @property
    def warnings(self) -> tuple[str, ...]:
        found = []
        if self.problem:
            found.append(f"The Verification Policy ({SHOWN_PATH}) was not used: {self.problem} BugPilot's default applies.")
        return (*found, *self.lint)

    @property
    def log_line(self) -> str:
        """For ``bugpilot.log``: the source and a length, never the text."""
        if self.problem:
            return f"[WARN] verification policy: {SHOWN_PATH} not used ({self.problem}); the default applies"
        if self.source == SOURCE_FILE:
            return f"[INFO] verification policy: {SHOWN_PATH} ({self.file.characters} characters)"
        return f"[INFO] verification policy: {self.source}"


def verification_from_switches(
    relevant_tests: bool, static_checks: bool, full_suite: bool, report_not_run: bool, *, saved: bool
) -> ResolvedVerification:
    """The policy saved switches stand for (legacy), or the default when nothing is saved."""
    if not saved:
        return ResolvedVerification()
    return ResolvedVerification(
        source=SOURCE_LEGACY, text=text_for_switches(relevant_tests, static_checks, full_suite, report_not_run)
    )


def resolve_verification(repo_root: Path, switches: ResolvedVerification) -> ResolvedVerification:
    """The effective policy: the repository's file when there is one, else what the switches gave."""
    file = read_verification_file(repo_root)
    if not file.exists:
        return switches
    if file.problem:
        return ResolvedVerification(source=SOURCE_FILE, text=DEFAULT_TEXT, file=file)
    return ResolvedVerification(source=SOURCE_FILE, text=file.text, file=file, lint=lint_policy(file.text, file.first_line))


# --- task.md --------------------------------------------------------------------------------

_SOURCE_LINES = {
    SOURCE_DEFAULT: "BugPilot defaults (no project settings saved)",
    SOURCE_LEGACY: "repository configuration (project settings)",
    SOURCE_FILE: f"repository Verification Policy ({SHOWN_PATH})",
}


def verification_section(resolved: ResolvedVerification) -> str:
    """``## Verification Policy`` for ``task.md``: always present, exactly once, from the effective policy.

    The framing is BugPilot's and stays the same whatever the policy says: where
    the section sits in the precedence, and that claiming an unrun check is
    never allowed — the policy decides what to verify, not whether to be honest.
    """
    if resolved.problem:
        source = f"BugPilot defaults, because the repository's {SHOWN_PATH} could not be used"
        notice = (
            f"The repository's Verification Policy ({SHOWN_PATH}) was not included: {resolved.problem} "
            "Until it is fixed, BugPilot's default applies.\n\n"
        )
    else:
        source = _SOURCE_LINES[resolved.source]
        notice = ""
    body = contained_markdown(resolved.text) if resolved.source == SOURCE_FILE else resolved.text
    return (
        "## Verification Policy\n\n"
        f"Source: {source}.\n\n"
        f"{notice}"
        "What this project expects from a pass that changes source code. It is part of the project / team layer in "
        "BugPilot Rule Precedence below; the AI Fix Mode decides how this attempt verifies within it, and in an "
        "investigation-only pass you record the verification you would run instead. Whatever it asks, never claim "
        "a test or check ran unless it did: that is a BugPilot rule.\n\n"
        f"{body}\n\n"
        "Use the repository's own test and check commands; do not invent commands the repository gives no "
        "evidence of. Project / team instructions may name them.\n\n"
    )


def verification_payload(resolved: ResolvedVerification) -> dict[str, object]:
    """``bugpilot verification show --json``: the effective policy, where it came from, and its file's state."""
    file = resolved.file
    return {
        "source": resolved.source,
        "path": SHOWN_PATH,
        "text": resolved.text,
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
        "default_version": DEFAULT_POLICY_VERSION,
        "default_changed": resolved.default_changed,
        "differs_from_default": resolved.differs_from_default,
        "default_text": DEFAULT_TEXT,
        "problem": resolved.problem,
        "lint": list(resolved.lint),
        "max_characters": MAX_INSTRUCTION_CHARS,
    }
