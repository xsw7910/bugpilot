"""The investigation request — what every entry point builds and core consumes.

A request is three orthogonal parts, deliberately not one growing object:

- :class:`BugSpec` — the bug's identity and content. Comes from an input adapter
  (Jira, or a hand-written description), so ``core`` never talks to Jira itself.
- :class:`InvestigationOptions` — how to retrieve. Every future retrieval knob
  (``search_scope``, ``dependency_depth``, ``token_budget``) belongs here.
- :class:`InvestigationPlan` — which logical capabilities to run. Callers toggle
  capabilities, never implementation steps; :meth:`InvestigationPlan.resolve_steps`
  expands them into ``config.WORKFLOW_STEPS`` and resolves shared dependencies.

Keeping the expansion here rather than in each adapter is what stops the CLI, the
MCP server and the VS Code extension from drifting into three different notions
of "which steps ran".

See ``docs/adapter_design.md`` section 3.3.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from .config import WORKFLOW_STEPS

# Steps that are not capability-gated: the environment check always runs.
ALWAYS_STEPS: tuple[str, ...] = ("doctor",)

# Logical capability -> the WORKFLOW_STEPS it contributes. This says what a
# capability *adds*, not everything it needs; prerequisites live in
# STEP_PREREQUISITES below and are pulled in transitively by resolve_steps.
CAPABILITY_STEPS: dict[str, tuple[str, ...]] = {
    "issue_details": ("fetch", "parse"),
    "code_search": ("keywords", "code_search"),
    "git_history": ("git_context",),
    "similar_fixes": ("keywords", "memory_search"),
    "build_context": ("context", "prompt", "memory_add"),
}

# Step -> the steps whose artifacts it reads. Declaring these is what stops a
# partial plan from producing a run that crashes halfway: `context_step` always
# reads extracted_keywords.json, and every step that calls `_parsed_issue` needs
# a parsed issue, which for a Jira work item means `fetch` ran first.
#
# A prerequisite is pulled in even when its own capability is off. Running the
# prerequisite is strictly better than failing, and it is what "core resolves
# dependencies" in the design means — a caller toggles capabilities, not steps.
STEP_PREREQUISITES: dict[str, tuple[str, ...]] = {
    "parse": ("fetch",),
    "keywords": ("parse",),
    "code_search": ("keywords",),
    "memory_search": ("keywords",),
    "context": ("keywords", "parse"),
    "prompt": ("context",),
    "memory_add": ("parse",),
}

# A hand-written bug has nothing to fetch; the manual input adapter materializes
# the same artifacts before any step runs.
MANUAL_EXCLUDED_STEPS: frozenset[str] = frozenset({"fetch"})

SOURCE_JIRA = "jira"
SOURCE_MANUAL = "manual"


def _close_over_prerequisites(steps: set[str]) -> set[str]:
    """Add every step the given steps depend on, transitively."""
    closed = set(steps)
    pending = list(closed)
    while pending:
        for prerequisite in STEP_PREREQUISITES.get(pending.pop(), ()):
            if prerequisite not in closed:
                closed.add(prerequisite)
                pending.append(prerequisite)
    return closed


@dataclass(frozen=True)
class BugSpec:
    """A bug's identity and content, normalized away from its source system.

    ``work_item_id`` and ``source_ref`` are two concepts that merely coincide in
    Jira mode. Code that writes back to an external system must read
    ``source_ref``; code that names a directory must read ``work_item_id``.
    """

    work_item_id: str
    source: str
    title: str
    description: str
    source_ref: str | None = None

    @property
    def is_jira(self) -> bool:
        return self.source == SOURCE_JIRA

    @property
    def can_write_back(self) -> bool:
        """True when there is an external issue to post a comment to."""
        return self.source == SOURCE_JIRA and bool(self.source_ref)


@dataclass
class InvestigationOptions:
    """How to retrieve context. Defaults mirror the previous hardcoded constants.

    ``max_files`` and ``max_search_lines`` are exposed as a pair on purpose: file
    count alone does not bound artifact size, and the snippet line cap is what
    actually drives how much an agent has to read.
    """

    hint: str | None = None
    keywords: list[str] = field(default_factory=list)
    focus_files: list[str] = field(default_factory=list)
    ignore_paths: list[str] = field(default_factory=list)
    max_files: int = 10
    max_search_lines: int = 300
    # Files outside the repository that the developer wants the agent to see:
    # a crash log, a screenshot of the broken dialog, a config that reproduces
    # it. Unlike `focus_files`, which only ranks paths the search already
    # walks, these are copied into the work item and named in the task file.
    attachments: list[str] = field(default_factory=list)


@dataclass
class InvestigationPlan:
    """Which logical capabilities to run. Not implementation steps."""

    issue_details: bool = True
    code_search: bool = True
    git_history: bool = True
    similar_fixes: bool = True
    build_context: bool = True

    def enabled_capabilities(self) -> list[str]:
        return [name for name in CAPABILITY_STEPS if getattr(self, name)]

    def resolve_steps(self, source: str = SOURCE_JIRA) -> list[str]:
        """Expand enabled capabilities into ``WORKFLOW_STEPS``, in canonical order.

        De-duplicates shared dependencies and drops steps that do not apply to the
        given source. Ordering comes from ``WORKFLOW_STEPS`` rather than from the
        capability list, so callers cannot reorder the pipeline by reordering flags.
        """
        wanted = set(ALWAYS_STEPS)
        for capability in self.enabled_capabilities():
            wanted.update(CAPABILITY_STEPS[capability])
        wanted = _close_over_prerequisites(wanted)
        if source == SOURCE_MANUAL:
            wanted -= MANUAL_EXCLUDED_STEPS
        return [step for step in WORKFLOW_STEPS if step in wanted]

    def skipped_steps(self, source: str = SOURCE_JIRA) -> list[str]:
        """The capability-gated steps this plan turns off, in canonical order.

        Callers mark these ``skipped`` in ``workflow_status.json`` so a disabled
        capability reads as a deliberate choice rather than a failure.
        """
        resolved = set(self.resolve_steps(source))
        gated = {step for steps in CAPABILITY_STEPS.values() for step in steps}
        if source == SOURCE_MANUAL:
            gated -= MANUAL_EXCLUDED_STEPS
        return [step for step in WORKFLOW_STEPS if step in gated and step not in resolved]


@dataclass
class InvestigationRequest:
    """What an entry point hands to core: a bug, how to look, and what to run."""

    spec: BugSpec
    options: InvestigationOptions = field(default_factory=InvestigationOptions)
    plan: InvestigationPlan = field(default_factory=InvestigationPlan)

    @property
    def work_item_id(self) -> str:
        return self.spec.work_item_id

    def resolved_steps(self) -> list[str]:
        return self.plan.resolve_steps(self.spec.source)

    def skipped_steps(self) -> list[str]:
        return self.plan.skipped_steps(self.spec.source)
