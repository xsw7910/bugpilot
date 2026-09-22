"""AI Fix Mode definitions and registry.

Fix Modes describe *how* an AI coding agent should approach a prepared bug.
They are deliberately separate from bug evidence and from BugPilot-owned safety
rules.  A mode may tune investigation, implementation and verification, but it
must never be able to weaken Git/Jira/destructive-action safeguards enforced by
BugPilot elsewhere.

One structured field, `execution_kind`, exists because prose alone cannot be
acted on: an investigation-only mode has to suppress the commit/push offer in
the generated task package, and a renderer cannot infer that from instruction
text.  It is deliberately two values rather than the beginning of a workflow
DSL; anything more expressive belongs in the instruction sections, which are
prose for the agent and not logic for BugPilot.
"""

from __future__ import annotations

from dataclasses import dataclass
import re
from typing import Iterable, Literal

FixModeSource = Literal["builtin", "user", "project"]
ExecutionKind = Literal["fix", "investigate"]

DEFAULT_FIX_MODE_ID = "standard"

# Editable instruction text is interpolated into agent_task.md as Markdown, and
# BugPilot owns that document's structure: the safety headings an agent looks for
# ("## Forbidden Actions", "## BugPilot Rule Precedence") must mean what BugPilot
# put there. A mode section carrying its own headings could forge a second copy
# of one, above the real one, and textual precedence cannot defend against a
# forged copy of the precedence rule. So sections are prose, not documents.
MAX_FIX_MODE_TEXT_LENGTH = 12_000
_MODE_ID_RE = re.compile(r"^[a-z][a-z0-9-]{0,63}$")
_MARKDOWN_HEADING_RE = re.compile(r"^#{1,6}\s", re.MULTILINE)
_SECTION_NAMES: tuple[str, ...] = (
    "objective",
    "investigation",
    "implementation",
    "verification",
    "constraints",
    "completion",
)
_VALID_SOURCES: frozenset[str] = frozenset({"builtin", "user", "project"})
_VALID_EXECUTION_KINDS: frozenset[str] = frozenset({"fix", "investigate"})


def is_valid_fix_mode_id(value: object) -> bool:
    """Whether a value is a usable Fix Mode id.

    Public because a custom mode's id becomes a file name, and the code that
    builds that path has to ask the question before it builds anything — with
    the model's own rule rather than a second copy of the pattern.
    """
    return isinstance(value, str) and bool(_MODE_ID_RE.fullmatch(value))


class FixModeError(ValueError):
    """Base error for invalid Fix Mode definitions or lookup."""


class FixModeNotFoundError(FixModeError):
    """Raised when a requested Fix Mode ID is not registered."""


def _require_text(value: object, field: str) -> str:
    """A required text field, checked for type before content.

    Custom modes will arrive from a file in a later phase, so `validate()` is
    the boundary where a hand-edited definition becomes trusted. Reaching
    `value.strip()` on a number or a list there would raise AttributeError or
    TypeError — the wrong error, from the wrong layer, naming nothing the
    developer can fix — so every field is type-checked first and every failure
    leaves here as a FixModeError.
    """
    if not isinstance(value, str):
        raise FixModeError(
            f"Fix Mode field {field!r} must be a string, got {type(value).__name__}."
        )
    if not value.strip():
        raise FixModeError(f"Fix Mode field {field!r} must not be empty.")
    return value


def _require_document_safe_text(value: object, field: str) -> str:
    """Instruction text that cannot restructure the document it is rendered into.

    Only a heading at the start of a line is rejected, so `#` inside prose
    ("issue #4102", "C#") is fine. An indented `#` is fine too, which keeps
    comment lines in an example readable.
    """
    text = _require_text(value, field)
    if _MARKDOWN_HEADING_RE.search(text):
        raise FixModeError(
            f"Fix Mode field {field!r} must not contain Markdown headings. BugPilot "
            "owns the task document's structure, including its safety headings."
        )
    if len(text) > MAX_FIX_MODE_TEXT_LENGTH:
        raise FixModeError(
            f"Fix Mode field {field!r} exceeds the maximum length of "
            f"{MAX_FIX_MODE_TEXT_LENGTH} characters."
        )
    return text


def _require_positive_int(value: object, field: str) -> int:
    """A required integer >= 1. `True` is not 1 here, however Python feels."""
    if isinstance(value, bool) or not isinstance(value, int):
        raise FixModeError(
            f"Fix Mode field {field!r} must be an integer, got {type(value).__name__}."
        )
    if value < 1:
        raise FixModeError(f"Fix Mode field {field!r} must be >= 1.")
    return value


def _require_choice(value: object, field: str, allowed: frozenset[str]) -> str:
    if not isinstance(value, str):
        raise FixModeError(
            f"Fix Mode field {field!r} must be a string, got {type(value).__name__}."
        )
    if value not in allowed:
        raise FixModeError(
            f"Unsupported Fix Mode {field}: {value!r}. "
            f"Expected one of: {', '.join(sorted(allowed))}."
        )
    return value


@dataclass(frozen=True)
class FixMode:
    """Provider-neutral instructions that control an AI bug-fixing workflow."""

    id: str
    name: str
    description: str
    objective: str
    investigation: str
    implementation: str
    verification: str
    constraints: str
    completion: str
    source: FixModeSource = "builtin"
    based_on: str | None = None
    based_on_version: int | None = None
    version: int = 1
    execution_kind: ExecutionKind = "fix"

    def validate(self) -> None:
        """Validate a mode without depending on CLI, VS Code, MCP, or Jira."""
        if not _MODE_ID_RE.fullmatch(_require_text(self.id, "id")):
            raise FixModeError(
                "Fix Mode id must start with a lowercase letter and contain only "
                "lowercase letters, digits, or hyphens (max 64 characters)."
            )
        _require_text(self.name, "name")
        _require_document_safe_text(self.description, "description")
        _require_choice(self.source, "source", _VALID_SOURCES)
        _require_choice(self.execution_kind, "execution_kind", _VALID_EXECUTION_KINDS)
        _require_positive_int(self.version, "version")
        if self.based_on is not None:
            if not _MODE_ID_RE.fullmatch(_require_text(self.based_on, "based_on")):
                raise FixModeError(f"Invalid based_on Fix Mode id: {self.based_on!r}.")
            if self.based_on == self.id:
                # Whether based_on names a mode that exists is the registry's
                # question; it needs the whole mode set, which this does not have.
                # Descent from itself needs no such context to be wrong.
                raise FixModeError(
                    f"Fix Mode based_on must not equal its own id ({self.id!r})."
                )
        if self.based_on_version is not None:
            _require_positive_int(self.based_on_version, "based_on_version")
            if self.based_on is None:
                # A version with no origin cannot be checked against anything,
                # which is the one thing the field exists to allow.
                raise FixModeError(
                    "Fix Mode based_on_version requires based_on to be set."
                )
        for section_name in _SECTION_NAMES:
            _require_document_safe_text(getattr(self, section_name), section_name)

    @property
    def is_investigation(self) -> bool:
        """True when no source change is expected in this mode's initial pass."""
        return self.execution_kind == "investigate"

    def instruction_sections(self) -> tuple[tuple[str, str], ...]:
        """Return editable instruction sections in stable rendering order."""
        return tuple((name, getattr(self, name)) for name in _SECTION_NAMES)


STANDARD_FIX = FixMode(
    id="standard",
    name="Standard Fix",
    description="Default workflow for most bugs: analyze, fix minimally, verify, summarize.",
    objective="Resolve the reported issue with the smallest correct change.",
    investigation=(
        "Read the supplied BugPilot context and relevant code before editing. "
        "Identify the most likely root cause and verify it against the available evidence. "
        "If important evidence is missing, state the assumption or request follow-up information."
    ),
    implementation=(
        "Implement the smallest safe fix that addresses the root cause. Follow nearby project "
        "patterns and avoid unrelated refactoring, formatting-only changes, or scope expansion."
    ),
    verification=(
        "Run the most relevant focused tests or checks that are available. Review the final diff "
        "for unintended changes. If a useful test cannot be run, explain why."
    ),
    constraints=(
        "Do not make speculative changes. Avoid public API changes or new dependencies unless "
        "they are required for the fix."
    ),
    completion=(
        "Summarize the root cause, files changed, fix, verification performed, remaining risks, "
        "and any follow-up information still needed."
    ),
    execution_kind="fix",
)

CONSERVATIVE_FIX = FixMode(
    id="conservative",
    name="Conservative Fix",
    description="Minimal, low-risk changes for legacy or sensitive code.",
    objective="Resolve the issue while preserving existing behavior outside the reported scope.",
    investigation=(
        "Understand the root cause before modifying code. Work from the evidence BugPilot "
        "supplied, and review the Git/history evidence it includes when existing behavior may "
        "be intentional. If historical intent matters but the supplied evidence is insufficient, "
        "report the missing evidence instead of performing broad exploration. If the evidence is "
        "not strong enough for a safe fix, stop and explain what additional information is required."
    ),
    implementation=(
        "Prefer the smallest local change possible. Minimize changed files and changed lines, "
        "preserve existing architecture, and follow the surrounding implementation style."
    ),
    verification=(
        "Run focused regression checks around the changed behavior and review the diff carefully "
        "for side effects. Document any verification that could not be completed."
    ),
    constraints=(
        "Do not perform unrelated cleanup, modernization, broad refactoring, public API changes, "
        "or dependency changes unless they are strictly required by the bug."
    ),
    completion=(
        "Report the root cause, why the chosen fix is the minimum safe change, files changed, "
        "verification, regression risks, and unresolved uncertainty."
    ),
    execution_kind="fix",
)

INVESTIGATE_FIRST_FIX = FixMode(
    id="investigate-first",
    name="Investigate First",
    description="Diagnose and build an evidence-backed fix plan before source modification.",
    objective="Establish a defensible root cause and fix plan before changing source code.",
    investigation=(
        "Do not modify source code in the initial pass. Analyze the supplied evidence, inspect the "
        "likely execution path, identify candidate root causes, rank the hypotheses, and record what "
        "evidence supports or weakens each one. Identify any additional evidence needed."
    ),
    implementation=(
        "Produce a concrete proposed fix plan rather than editing source code. Name the likely files "
        "or symbols to change and describe the smallest expected implementation."
    ),
    verification=(
        "Define how the proposed fix should be verified, including focused automated tests, manual "
        "reproduction, or diagnostic checks where applicable. Do not report verification as performed: "
        "implementation has not started."
    ),
    constraints=(
        "Do not guess a fix merely because a file matches keywords. Do not change source code until "
        "the developer explicitly continues from the investigation result."
    ),
    completion=(
        "Summarize the leading root-cause hypothesis, supporting evidence, competing hypotheses, "
        "missing information, proposed fix plan, and proposed verification. State plainly that no "
        "source change was applied, then stop and ask the developer whether to implement."
    ),
    execution_kind="investigate",
)

TEST_DRIVEN_FIX = FixMode(
    id="test-driven",
    name="Test-Driven Fix",
    description="Reproduce with a focused test, fix the cause, then rerun verification.",
    objective="Turn the reported behavior into a focused regression check and make that check pass.",
    investigation=(
        "Confirm the expected behavior from the supplied context and find the narrowest practical "
        "test level that can reproduce the failure. Understand the root cause before broad changes."
    ),
    implementation=(
        "Add or update a focused failing regression test when practical, then implement the smallest "
        "production-code change that makes the test pass without weakening existing assertions."
    ),
    verification=(
        "Run the new or updated regression test before and after the fix when practical, then run the "
        "nearest relevant existing tests. Record commands and results accurately."
    ),
    constraints=(
        "Do not rewrite large test areas just to enable the fix. Do not weaken tests to make a failure "
        "disappear. If a reliable automated reproduction is not practical, explain that and use the "
        "best focused verification available."
    ),
    completion=(
        "Summarize the reproduced failure, root cause, test change, production fix, verification "
        "results, and remaining regression risk."
    ),
    execution_kind="fix",
)

DEEP_ANALYSIS_FIX = FixMode(
    id="deep-analysis",
    name="Deep Analysis",
    description="Deeper evidence review for complex crashes, regressions, or cross-module bugs.",
    objective="Build a high-confidence explanation of the failure before selecting the safest fix.",
    investigation=(
        "Trace the relevant execution/data path across implicated modules and inspect the related "
        "code the evidence points to. Prefer evidence over broad repository exploration: expand only "
        "when the supplied evidence identifies a concrete dependency or missing link that must be "
        "inspected. Review the Git/history evidence supplied by BugPilot when regression boundaries "
        "or coupled changes may matter. Compare competing root-cause hypotheses against that "
        "evidence. If historical intent matters but the supplied evidence is insufficient, report "
        "the missing evidence instead of performing broad exploration."
    ),
    implementation=(
        "After the analysis supports a root cause, implement the narrowest change that corrects it. "
        "If multiple modules are involved, explain why each changed location is necessary."
    ),
    verification=(
        "Run focused tests across the affected path and relevant boundary conditions. Review the diff "
        "and check likely regression areas identified during analysis."
    ),
    constraints=(
        "Depth of investigation does not authorize broad refactoring. Keep the implementation scoped "
        "to the evidence-backed root cause and clearly label uncertainty."
    ),
    completion=(
        "Summarize the execution path, root cause, evidence considered, changes made, verification, "
        "regression risks, and any remaining uncertainty."
    ),
    execution_kind="fix",
)

BUILTIN_FIX_MODES: tuple[FixMode, ...] = (
    STANDARD_FIX,
    CONSERVATIVE_FIX,
    INVESTIGATE_FIRST_FIX,
    TEST_DRIVEN_FIX,
    DEEP_ANALYSIS_FIX,
)


class FixModeRegistry:
    """Validated lookup table shared by CLI, VS Code, MCP, and task generation."""

    def __init__(self, modes: Iterable[FixMode] = BUILTIN_FIX_MODES) -> None:
        self._modes: dict[str, FixMode] = {}
        for mode in modes:
            self.register(mode)
        if DEFAULT_FIX_MODE_ID not in self._modes:
            raise FixModeError(
                f"Fix Mode registry must contain default mode {DEFAULT_FIX_MODE_ID!r}."
            )

    def register(self, mode: FixMode) -> None:
        if not isinstance(mode, FixMode):
            raise FixModeError(
                f"Fix Mode registry accepts FixMode objects, got {type(mode).__name__}."
            )
        mode.validate()
        if mode.id in self._modes:
            raise FixModeError(f"Duplicate Fix Mode id: {mode.id!r}.")
        self._modes[mode.id] = mode

    def resolve(self, mode_id: str | None = None) -> FixMode:
        """Resolve an exact ID; only ``None`` selects the deterministic default.

        This is the only place an ID becomes a mode. Task generation is handed
        the resolved object instead, so that user- and project-scoped modes can
        be layered in here later without the renderer learning about config
        files, repository roots, or scope precedence.
        """
        requested = DEFAULT_FIX_MODE_ID if mode_id is None else mode_id
        if not isinstance(requested, str):
            raise FixModeError(
                f"Fix Mode id must be a string or None, got {type(mode_id).__name__}."
            )
        try:
            return self._modes[requested]
        except KeyError as exc:
            available = ", ".join(self._modes)
            raise FixModeNotFoundError(
                f"Unknown Fix Mode {requested!r}. Available modes: {available}."
            ) from exc

    def list_modes(self, *, source: FixModeSource | None = None) -> tuple[FixMode, ...]:
        modes = tuple(self._modes.values())
        if source is None:
            return modes
        _require_choice(source, "source", _VALID_SOURCES)
        return tuple(mode for mode in modes if mode.source == source)

    @property
    def default(self) -> FixMode:
        return self.resolve()


def builtin_fix_mode_registry() -> FixModeRegistry:
    """Return a fresh registry containing exactly BugPilot's packaged modes."""
    return FixModeRegistry(BUILTIN_FIX_MODES)
