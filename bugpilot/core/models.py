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

from dataclasses import dataclass, field, replace

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

# Step -> the steps whose output it reads. Declaring these is what stops a
# partial plan from producing a run that crashes halfway: `context_step` always
# reads the keyword extraction, and every step that reads the normalized issue
# needs one with content, which for a Jira work item means `fetch` ran first.
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


#: History Depth's options (Git History Settings). ``recent`` is Batch 1's bounds;
#: ``git_history.HISTORY_DEPTH_LIMITS`` says what each one reads.
GIT_HISTORY_DEPTHS: tuple[str, ...] = ("recent", "broader")
DEFAULT_MAX_RELATED_COMMITS = 10
#: Max Related Commits' ceiling. A context section of 25 commits is already more
#: than an agent reads closely; beyond it the list is noise, not evidence.
MAX_RELATED_COMMITS_LIMIT = 25


@dataclass(frozen=True)
class GitHistoryOptions:
    """Git History Settings: how the Git history step searches. Code Search never reads them.

    The defaults are Batch 1's behaviour exactly, so a run that sets none of
    these finds what it found before they existed. ``keywords`` and ``files``
    are Git History's own — Additional Commit Keywords and Additional Files —
    and extend the shared Keywords and Focus Files rather than replace them.
    """

    use_shared_keywords: bool = True
    use_shared_focus_files: bool = True
    keywords: tuple[str, ...] = ()
    files: tuple[str, ...] = ()
    search_commit_messages: bool = True
    search_file_history: bool = True
    history_depth: str = "recent"
    max_related_commits: int = DEFAULT_MAX_RELATED_COMMITS

    @property
    def searches_nothing(self) -> bool:
        """Both routes off: the step has nothing it may do, and is skipped."""
        return not (self.search_commit_messages or self.search_file_history)

    def normalized(self) -> GitHistoryOptions:
        """These options with any out-of-range value replaced by its default.

        For a library caller; the CLI refuses such values instead. An unknown
        depth reads as ``recent`` and a count outside 1–25 as the default, which
        is the safe reading — never "everything".
        """
        depth = self.history_depth if self.history_depth in GIT_HISTORY_DEPTHS else "recent"
        count = self.max_related_commits
        if isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= MAX_RELATED_COMMITS_LIMIT:
            count = DEFAULT_MAX_RELATED_COMMITS
        return GitHistoryOptions(
            use_shared_keywords=self.use_shared_keywords is not False,
            use_shared_focus_files=self.use_shared_focus_files is not False,
            keywords=tuple(str(item) for item in self.keywords),
            files=tuple(str(item) for item in self.files),
            search_commit_messages=self.search_commit_messages is not False,
            search_file_history=self.search_file_history is not False,
            history_depth=depth,
            max_related_commits=count,
        )


#: How many similar past fixes the Similar fixes step keeps (Similar Fixes Settings).
#: Five is what the step always kept, so a run that sets nothing finds what it did.
DEFAULT_MAX_SIMILAR_FIXES = 5
#: Max Similar Fixes' ceiling. Each one is a past investigation the agent is
#: pointed at; twenty is already more than it reads closely.
MAX_SIMILAR_FIXES_LIMIT = 20


@dataclass(frozen=True)
class SimilarFixesOptions:
    """Similar Fixes Settings: how the Similar fixes step searches past fixes.

    The step scores ``.ai_memory`` entries against the issue's own extracted
    terms, which always take part. On top of them come the shared Keywords
    (``InvestigationOptions.keywords``) unless ``use_shared_keywords`` is off, and
    ``keywords`` — Additional Keywords, Similar Fixes' own, which neither Code
    Search nor Git History ever reads. The shared Focus Files are never used:
    a memory entry is scored by its words, not by the files it names.

    The defaults are the step's behaviour before these existed.
    """

    use_shared_keywords: bool = True
    keywords: tuple[str, ...] = ()
    max_results: int = DEFAULT_MAX_SIMILAR_FIXES

    def normalized(self) -> SimilarFixesOptions:
        """These options with an out-of-range count replaced by the default.

        For a library caller; the CLI refuses such a count instead. A count
        outside 1–20 reads as five, the safe reading — never "everything".
        """
        count = self.max_results
        if isinstance(count, bool) or not isinstance(count, int) or not 1 <= count <= MAX_SIMILAR_FIXES_LIMIT:
            count = DEFAULT_MAX_SIMILAR_FIXES
        return SimilarFixesOptions(
            use_shared_keywords=self.use_shared_keywords is not False,
            keywords=tuple(str(item) for item in self.keywords),
            max_results=count,
        )


def effective_plan(plan: InvestigationPlan, options: InvestigationOptions) -> InvestigationPlan:
    """The plan once the options have had their say.

    Git History with both search routes turned off has nothing it may do, so it
    is skipped exactly as an unticked Git history is — marked ``skipped`` in
    ``run.json``, a ``step_skipped`` event on the stream — rather than run to
    produce an empty section. Neither route is ever turned back on.
    """
    if plan.git_history and options.git_history.searches_nothing:
        return replace(plan, git_history=False)
    return plan


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
    # Why each attachment matters, by position: the Nth describes the Nth file;
    # blank means no description. Recorded in issue.json and named in the task.
    attachment_descriptions: list[str] = field(default_factory=list)
    # `attachments` is the complete set (§37.99): a file an earlier run copied
    # that is not among them is removed from the work item. Off, they add to it.
    replace_attachments: bool = False
    # How Git history searches (Git History Settings). Code Search reads
    # `keywords` and `focus_files` above and never this.
    git_history: GitHistoryOptions = field(default_factory=GitHistoryOptions)
    # How Similar fixes searches past fixes (Similar Fixes Settings). Neither
    # Code Search nor Git History reads it.
    similar_fixes: SimilarFixesOptions = field(default_factory=SimilarFixesOptions)


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

        Callers mark these ``skipped`` in ``run.json`` so a disabled
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
    # *Which* AI workflow to hand the prepared package to, by id. Not in
    # `options`, which is about retrieval, and not in `BugSpec`, which is the bug
    # itself — the Fix Mode is execution policy and changes nothing about what
    # is retrieved. An id rather than a resolved mode, because an entry point
    # knows what the developer typed and core owns resolution. `None` means the
    # caller expressed no preference: the work item's persisted choice, or
    # Standard Fix.
    fix_mode_id: str | None = None
    # Which branch the agent works on (`branch_policy.py`), execution policy
    # like the Fix Mode. `None`: no preference — the work item's recorded
    # policy, else the default (the current branch).
    branch_policy: str | None = None

    @property
    def work_item_id(self) -> str:
        return self.spec.work_item_id

    def resolved_steps(self) -> list[str]:
        return effective_plan(self.plan, self.options).resolve_steps(self.spec.source)

    def skipped_steps(self) -> list[str]:
        return effective_plan(self.plan, self.options).skipped_steps(self.spec.source)
