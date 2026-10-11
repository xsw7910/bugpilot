"""Prompt and task artifact generation."""

from __future__ import annotations

from typing import Mapping, Sequence

from .attachments import ATTACHMENTS_DIR
from .branch_policy import DEFAULT_BRANCH_POLICY, branch_instructions
from .delivery_instructions import assisted_delivery_block, delivery_safety_block
from .fix_modes import STANDARD_FIX, FixMode, FixModeError
from .git_ops import branch_name
from .instructions import ResolvedInstructions, project_instruction_section, user_instruction_section
from .project_settings import ResolvedProjectSettings
from .repository_profile import RepositoryContext, repository_context_section
from .verification import verification_section

# The layers of guidance a task carries, in precedence order (plan §5.3). Each
# later layer may refine how the agent works within the earlier ones, and where
# two conflict the earlier one wins; none may loosen a BugPilot safety rule.
# The repository's own instructions come before the developer's: a team's
# "do not add dependencies" beats one person's "prefer library X". The task's
# sections and this list are rendered in the same order.
INSTRUCTION_LAYERS: tuple[str, ...] = (
    "BugPilot safety rules",
    "Repository context",
    "Project / team instructions",
    "User instructions",
    "AI Fix Mode",
    "Developer hint",
)

# Headings for the six editable Fix Mode sections, keyed by the model's section
# name so the rendering order comes from `FixMode.instruction_sections()` rather
# than from a second list here that could drift out of step with it.
_FIX_MODE_HEADINGS: dict[str, str] = {
    "objective": "Objective",
    "investigation": "Investigation",
    "implementation": "Implementation",
    "verification": "Verification",
    "constraints": "Constraints",
    "completion": "Completion Requirements",
}


def generate_task(
    issue_key: str,
    summary: str | None = None,
    hint: str | None = None,
    jira_comment: bool = False,
    attachments: Sequence[str] | None = None,
    fix_mode: FixMode | None = None,
    attachment_notes: Mapping[str, str] | None = None,
    branch_policy: str = DEFAULT_BRANCH_POLICY,
    branch: str | None = None,
    repository: RepositoryContext | None = None,
    instructions: ResolvedInstructions | None = None,
    project_settings: ResolvedProjectSettings | None = None,
) -> str:
    """``task.md``: the one package BugPilot hands a coding agent.

    It used to be three files — the task, a handoff pointer whose every line the
    task already said, and a per-work-item copy of the team instructions the task
    told the agent to go and read. Now the team instructions are a section of the
    task, and the handoff is the one sentence that points at it.

    ``branch`` is the branch the work item recorded, if it did; without one the
    name is derived from the id and ``summary``.

    ``repository`` is the resolved Repository Profile
    (:func:`repository_profile.resolve_repository_context`), resolved by the
    caller for the same reason a Fix Mode is: this module has no repository to
    look at. ``None`` renders the Generic profile, which assumes nothing.

    ``instructions`` are the User and Project / Team Instructions
    (:func:`instructions.load_instructions`), resolved by the caller likewise.
    ``None``, or a scope with nothing in it, adds no section.

    ``project_settings`` are the repository's Verification Policy and branch
    naming (:func:`project_settings.resolve_project_settings`). ``None`` is the
    defaults; the Verification Policy section is always written.
    """
    # The full analysis/fix/review/test workflow lives inside the task, so no
    # standalone per-phase prompt files are generated.
    template = project_settings.settings.branch_template if project_settings is not None else None
    branch = branch or branch_name(issue_key, summary, template)
    mode = _task_fix_mode(fix_mode)
    return _copilot_task(
        issue_key,
        branch,
        hint,
        jira_comment,
        attachments,
        mode,
        attachment_notes,
        branch_policy,
        repository,
        instructions,
        project_settings,
    )


def copilot_team_instructions() -> str:
    """BugPilot's safety rules, as bundled with the package.

    Repository-neutral by design. What a particular repository is belongs to its
    Repository Profile, and a team's own rules to its project instructions
    (``.bugpilot/instructions.md``). One copy at run time: an installed wheel
    and a source checkout write the same rules. ``docs/agent_team_instructions.md``
    mirrors it for readers, and a test keeps the two identical.
    """
    return _fallback_team_instructions()


def _team_instructions_section() -> str:
    """The safety rules as a section of the task, their title dropped.

    Their own headings move one level down so they read as part of this section
    rather than as a second document pasted into the middle of the task.
    """
    lines = []
    for line in copilot_team_instructions().splitlines():
        if line.startswith("# "):
            continue
        lines.append("#" + line if line.startswith("#") else line)
    return "\n".join(lines).strip() + "\n\n"


#: BugPilot's default way of working on a bug: guidance, not a safety rule.
#: Until 0.1.3 these were the Core Principles of the Safety Rules (§42.2) —
#: style preferences filed as rules nothing may relax, so a team or a Fix Mode
#: that wanted otherwise was told it could not. They are built in until the
#: 0.1.4 AI Behavior policy can carry them, and every later layer may refine
#: them. "Do not mass-format" is not among them: it is a BugPilot safety rule
#: (the Safety Rules' Editing rules).
WORKING_GUIDANCE: tuple[str, ...] = (
    "Prefer small, targeted fixes near the identified root cause.",
    "Read surrounding code before editing, and follow its naming, formatting, and patterns.",
    "Do not refactor or modernize unrelated code.",
    "Do not rename public APIs unless required.",
    "Do not replace existing frameworks or patterns, or change file organization, unless required.",
    "Do not change product behavior outside the issue's scope.",
    "Preserve existing architecture and coding style.",
    "Ask for clarification or write no-op analysis if context is insufficient.",
)


def _working_guidance_section() -> str:
    items = "".join(f"- {item}\n" for item in WORKING_GUIDANCE)
    return (
        "## BugPilot Working Guidance\n\n"
        "BugPilot's default way of working on a bug. It is guidance, not a safety rule: project / team "
        "instructions, the Verification Policy, user instructions, the AI Fix Mode and a developer hint may "
        "refine it, and where one of them asks for something else, follow that.\n\n"
        f"{items}\n"
    )


#: Which kind of guidance each section of `task.md` is (§42.2), by its heading.
#: `protected` is BugPilot's: emitted unchanged in every task, ahead of anything
#: a person configures, and winning any conflict. The rest are the layers a
#: person or the evidence supplies. A heading missing here fails a test, so a
#: new section has to say what it is.
TASK_SECTION_CLASSES: dict[str, str] = {
    "Developer Hint": "developer-hint",
    "Execution Location": "protected",
    "BugPilot Safety Rules": "protected",
    "BugPilot Working Guidance": "ai-behavior-candidate",
    "Repository Context": "generated-evidence",
    "Project / Team Instructions": "project-instructions",
    "Verification Policy": "verification-policy",
    "User Instructions": "user-instructions",
    "Branch Instructions": "protected",
    "Developer Attachments": "developer-hint",
    "Required Input Files": "protected",
    "AI Fix Mode": "fix-mode",
    "BugPilot Rule Precedence": "protected",
    "BugPilot Evidence Rules": "protected",
    "Required Output Files": "protected",
    "BugPilot Delivery Safety": "protected",
    "Optional Assisted Delivery": "protected",
    "Investigation Handoff": "protected",
    "Report Status to Jira": "protected",
    "Report Status to Jira (before commit)": "protected",
}


def _task_fix_mode(fix_mode: FixMode | None = None) -> FixMode:
    """The mode to render, which is a `FixMode` or nothing at all.

    ID resolution deliberately does not live here. A user- or project-scoped
    mode is found by looking at a repository root, a user config directory and a
    scope precedence rule, none of which this module has or should acquire — so
    a caller resolves an ID through `FixModeRegistry` and hands the result over.
    `None` is not a lookup; it is the packaged Standard Fix object.
    """
    if fix_mode is None:
        return STANDARD_FIX
    if not isinstance(fix_mode, FixMode):
        raise FixModeError(
            "Task generation expects a resolved FixMode object or None, got "
            f"{type(fix_mode).__name__}. Resolve a Fix Mode id through "
            "FixModeRegistry.resolve() and pass the result."
        )
    fix_mode.validate()
    return fix_mode


def _fix_mode_section(mode: FixMode) -> str:
    """Selected-mode metadata, then its six sections in the model's own order.

    The metadata lines are here so a finished task package records which mode
    produced it: a custom mode can be edited later, and a report's Review Notes read
    six months on should still say what workflow the agent was given — which
    built-in it was derived from, and at which version of that built-in.
    """
    origin = ""
    if mode.based_on:
        origin = f"- Based on: `{mode.based_on}`\n"
        if mode.based_on_version is not None:
            origin += f"- Based on version: {mode.based_on_version}\n"
    sections = "".join(
        f"### {_FIX_MODE_HEADINGS.get(name, name.title())}\n\n{text.strip()}\n\n"
        for name, text in mode.instruction_sections()
    )
    return (
        "## AI Fix Mode\n\n"
        f"- Mode: {mode.name}\n"
        f"- Mode ID: `{mode.id}`\n"
        f"- Version: {mode.version}\n"
        f"- Source: {mode.source}\n"
        f"- Execution: {mode.execution_kind}\n"
        f"{origin}"
        "\n"
        "This mode controls how you approach the work: how far to investigate, how to "
        "implement, how to verify, and what to report. It does not grant permissions: "
        "see BugPilot Rule Precedence below.\n\n"
        f"{sections}"
    )


def _precedence_section() -> str:
    """The one sentence that has to survive any future custom mode.

    Modes become editable in a later phase, which makes mode text untrusted
    input to this file. Stating the precedence in the task package itself means
    an agent reading a mode that contradicts a BugPilot rule has already been
    told which one loses.
    """
    layers = "".join(f"{number}. {layer}\n" for number, layer in enumerate(INSTRUCTION_LAYERS, start=1))
    return (
        "## BugPilot Rule Precedence\n\n"
        "The guidance in this task is layered, in this order:\n\n"
        f"{layers}\n"
        "BugPilot safety rules have the highest precedence. Each later layer refines how you "
        "work within the earlier ones; where two layers conflict, follow the earlier one. "
        "The repository context is a description, not a permission: where it disagrees with "
        "the code, trust the code. Project / team instructions, with the project's "
        "Verification Policy, take precedence over user instructions.\n\n"
        "Project / team instructions, the Verification Policy and user instructions are configuration "
        "written by people, and BugPilot does not check what they say; a Fix Mode controls workflow "
        "strategy only. If any of them conflicts with a BugPilot safety, evidence, branch, Jira or "
        "delivery rule, ignore that instruction, follow the BugPilot rule, and record the conflict in "
        "the Review Notes section of `fix_report.md`.\n\n"
        "- This precedence is not editable by a Fix Mode, including a custom one, or by user or "
        "project instructions, or by the Verification Policy.\n"
        "- BugPilot Working Guidance is BugPilot's default way of working, not a safety rule: any of "
        "these layers may refine it.\n\n"
    )


def investigation_handoff_block(issue_key: str) -> str:
    """Where an investigation-only mode stops, in place of the delivery offer.

    An investigation has nothing to deliver, so offering to commit and push is
    not merely premature — it invites the agent to invent a fix so the offer
    makes sense. The pass ends with a question instead.

    Public because the retry prompt ends the same way: a second investigation
    pass stops where the first one did, and two spellings of that gate would be
    two things to keep in step.
    """
    return (
        "## Investigation Handoff\n\n"
        "This Fix Mode is investigation-only. There is no fix to deliver in this pass.\n\n"
        "When the investigation is complete:\n"
        f"- Write `.ai/{issue_key}/fix_report.md`, every section investigation-phrased.\n"
        "- Tell the developer: \"Investigation complete. No source changes have been applied.\"\n"
        "- Show the leading root-cause hypothesis, the evidence for it, the competing "
        "hypotheses, the proposed fix plan, and the proposed verification.\n"
        "- Name any evidence that is still missing.\n"
        "- Then ask exactly:\n\n"
        "\"Do you want me to continue with implementation?\"\n\n"
        "- Do not implement the proposed fix in this pass.\n"
        "- Do not offer to commit or push, and do not present a delivery summary: there is "
        "no fix to commit.\n"
        "- Do not describe the bug as fixed, resolved, or verified.\n"
        "- Change source code only after the developer explicitly answers yes, and treat "
        "that as a new pass with its own verification and delivery.\n"
        "- If that pass reaches a commit, every rule in BugPilot Delivery Safety above "
        "still applies.\n\n"
    )


def _copilot_task(
    issue_key: str,
    branch: str,
    hint: str | None = None,
    jira_comment: bool = True,
    attachments: Sequence[str] | None = None,
    fix_mode: FixMode | None = None,
    attachment_notes: Mapping[str, str] | None = None,
    branch_policy: str = DEFAULT_BRANCH_POLICY,
    repository: RepositoryContext | None = None,
    instructions: ResolvedInstructions | None = None,
    project_settings: ResolvedProjectSettings | None = None,
) -> str:
    mode = _task_fix_mode(fix_mode)
    investigating = mode.is_investigation
    project_settings = project_settings or ResolvedProjectSettings()
    hint_block = ""
    if hint and hint.strip():
        # "Treat", not "Trust": a hint is the developer's best hypothesis about
        # where the bug lives, and it is sometimes wrong. And it says where to
        # look, never that editing may begin — under an investigation-only mode
        # that would contradict the mode the developer selected.
        hint_block = (
            "## Developer Hint\n\n"
            f"{hint.strip()}\n\n"
            "Treat this hint as high-priority developer guidance. Inspect the named location "
            "or concept first and verify it against the available evidence. Do not perform "
            "broad exploration merely to rediscover what the developer has already identified.\n"
            "If the evidence contradicts the hint, say so and report what you found instead.\n"
            "The selected AI Fix Mode still controls whether and when source editing is "
            "allowed, and the BugPilot rules in this task still apply.\n\n"
        )
    if not jira_comment:
        jira_status_block = ""
    elif investigating:
        jira_status_block = (
            "## Report Status to Jira\n\n"
            "After writing the required investigation files, and BEFORE asking about implementation, "
            "post one Jira comment that records the investigation status and the leading root-cause "
            "hypothesis, so watchers are notified. It is the one Jira write the BugPilot Safety Rules allow.\n"
            "- Run these two commands from the target repo root:\n"
            f"  - `bugpilot jira-comment-draft {issue_key}`\n"
            f"  - `bugpilot jira-comment {issue_key} --execute`\n"
            "- Keep the comment short, and state plainly that no source change has been applied.\n"
            "- Post exactly ONE comment.\n"
            "- If the post fails (for example, no Jira access), tell the developer the comment was not posted.\n\n"
        )
    else:
        jira_status_block = (
            "## Report Status to Jira (before commit)\n\n"
            "After writing the fix report, and BEFORE asking about commit or committing, post one Jira "
            "comment that records the current work status and the analysis summary, so watchers are "
            "notified. It is the one Jira write the BugPilot Safety Rules allow.\n"
            "- Run these two commands from the target repo root:\n"
            f"  - `bugpilot jira-comment-draft {issue_key}`\n"
            f"  - `bugpilot jira-comment {issue_key} --execute`\n"
            "- Keep the comment short: the root cause and a brief summary of the changes (not the full diff), drawn from the fix report.\n"
            "- Post exactly ONE comment.\n"
            "- If the post fails (for example, no Jira access), continue to delivery and tell the developer the comment was not posted.\n\n"
        )
    # The safety gate is rendered for both execution kinds; only the offer to
    # commit and push is withheld from an investigation. Dropping both is how a
    # workflow change silently removed a BugPilot safety rule once.
    closing_block = (
        investigation_handoff_block(issue_key)
        if investigating
        else assisted_delivery_block(issue_key, branch_policy=branch_policy, branch=branch)
    )
    return (
        f"# BugPilot Task: {issue_key}\n\n"
        f"{hint_block}"
        "## Execution Location\n\n"
        "- Run your AI agent from the target repository root, not from the bugpilot tool source directory.\n"
        f"- `.ai/{issue_key}/` paths are relative to the target repository root.\n\n"
        "## BugPilot Safety Rules\n\n"
        f"{_team_instructions_section()}"
        f"{_working_guidance_section()}"
        f"{repository_context_section(repository)}"
        f"{project_instruction_section(instructions)}"
        f"{verification_section(project_settings.effective_verification)}"
        f"{user_instruction_section(instructions)}"
        f"{branch_instructions(branch_policy, branch, issue_key)}"
        f"{_attachments_section(issue_key, attachments, attachment_notes)}"
        "## Required Input Files\n\n"
        f"- Read `.ai/{issue_key}/context.md`: the Issue Details (reproduction steps, actual/expected "
        "results, environment, errors, missing information), similar fixes and git history.\n"
        f"- Read and inspect `.ai/{issue_key}/retrieval.json` if present: the ranked related files with their matched lines, the search terms, and the search confidence.\n\n"
        f"{_fix_mode_section(mode)}"
        f"{_precedence_section()}"
        "## BugPilot Evidence Rules\n\n"
        "In every Fix Mode, these govern what counts as evidence — not how deeply you "
        "investigate or how you implement.\n\n"
        "- Summarize the problem in your own words from `context.md`. Read its Jira comments as "
        "possibly newer than the description, review its attachment metadata, and use its "
        "reproduction steps, actual/expected results, environment and error messages.\n"
        "- Never invent reproduction steps or error messages that are not in the issue data, and "
        "never claim to have inspected an attachment's contents unless they are in repository or "
        "artifact files. If attachment metadata suggests logs, screenshots or crash dumps, mention "
        "follow-up review.\n"
        "- Review the context and the top related files in `retrieval.json`, with their matched "
        "line numbers, before editing code.\n"
        "- If search confidence is Low, do not assume the matched files are the implementation: "
        "verify that the feature exists before editing, and never modify code on low-confidence "
        "keyword matches alone.\n"
        "- If required information is missing, document your assumptions in the report's Analysis "
        "section, and ask follow-up questions.\n"
        "- If missing information prevents a safe fix, the issue is mock/demo, or no real "
        "implementation exists: do not invent a fix or modify unrelated files. Write a no-op "
        "analysis that explains what was searched, why no source change was applied, and what "
        "information is needed next.\n\n"
        f"{_required_output_section(issue_key, investigating)}"
        f"{delivery_safety_block(issue_key, branch, branch_policy=branch_policy, standalone=False)}"
        f"{jira_status_block}"
        f"{closing_block}"
    )


def _required_output_section(issue_key: str, investigating: bool) -> str:
    """One report in every mode, its sections described for the mode in hand.

    One artifact contract matters more than mode-specific file names:
    `check_results`, the VS Code view, the retry prompt and `.ai_memory` all
    read this one name. `fix_report.md` means "post-agent workflow report", not
    "confirmed fix" — an investigation fills the same sections with
    investigation state, and the Summary line says honestly what happened.
    """
    if not investigating:
        return (
            "## Required Output Files\n\n"
            f"Write one report: `.ai/{issue_key}/fix_report.md`, with exactly these sections.\n\n"
            "- `## Summary`: one honest line on the outcome — fixed, attempted, or no-op — "
            "then a short paragraph.\n"
            "- `## Analysis`: the root cause and the evidence for it.\n"
            "- `## Changes`: what changed and why, the files touched, and a short diff "
            "summary. If no code change proved justified, say so plainly here.\n"
            "- `## Tests`: the commands run and their outcomes. If tests were not run, say "
            "so and why.\n"
            "- `## Review Notes`: risks, open questions, remaining concerns, and the "
            "recommended next step.\n\n"
            "The report is required in every Fix Mode, even when the change is small. Keep "
            "it concise: summaries and file lists, not full diffs or command logs, and do "
            "not paste `context.md` or `task.md` back into it.\n\n"
        )
    return (
        "## Required Output Files\n\n"
        f"Write one report: `.ai/{issue_key}/fix_report.md`, with exactly these sections. "
        "In this investigation-only mode they record investigation state, not a completed "
        "fix.\n\n"
        "- `## Summary`: state that this was an investigation and that no source changes "
        "were applied.\n"
        "- `## Analysis`: root-cause hypotheses, the evidence for and against each, and "
        "what information is missing.\n"
        "- `## Changes`: the proposed fix plan. State explicitly that no source change "
        "was applied.\n"
        "- `## Tests`: the proposed validation, and that tests were not run because "
        "implementation has not started.\n"
        "- `## Review Notes`: risks, open questions, and the recommended next step.\n\n"
        "Do not write any section as though a fix exists.\n\n"
    )


def _attachments_section(
    issue_key: str,
    attachments: Sequence[str] | None,
    notes: Mapping[str, str] | None = None,
) -> str:
    """Files the developer attached, one entry each, with why it matters.

    Only ever lists files that were actually copied — `copy_attachments` drops
    what it could not take, and this is handed the result of reading the
    directory rather than the developer's original request. Telling an agent to
    read something that is not there wastes a turn and teaches it to distrust
    the list.

    A description is the developer's note on why a file matters, recorded with
    the work item; a file without one simply has none. Named by path, never
    inlined: a screenshot or a log is read where it lies.

    The wording about images is deliberate. Whether an agent can open a PNG
    depends on the agent and the model behind it, and that is not knowable from
    here — so it is told the file exists and asked to say so if it cannot read
    it, rather than being promised a capability or denied one.
    """
    names = [name for name in (attachments or []) if name]
    if not names:
        return ""
    described = notes or {}
    entries = ""
    for name in names:
        note = " ".join(str(described.get(name) or "").split())
        entries += f"### {name}\n\n"
        if note:
            entries += f"Description: {note}\n"
        entries += f"File: `.ai/{issue_key}/{ATTACHMENTS_DIR}/{name}`\n\n"
    return (
        "## Developer Attachments\n\n"
        "The developer attached these files for this bug. They are not part of "
        "the repository and are not in the issue description.\n\n"
        f"{entries}"
        "- Read the ones your tools can open, and use them as evidence.\n"
        "- A description is the developer's note on why the file matters; check it "
        "against the file rather than taking it as a finding.\n"
        "- If one is an image or a format you cannot read, say so plainly "
        "instead of guessing at its contents.\n\n"
    )


# This fallback should mirror docs/agent_team_instructions.md.
def _fallback_team_instructions() -> str:
    return """# BugPilot Safety Rules

BugPilot's rules for an AI agent working on a bug, in any repository. They apply in every pass and in every Fix Mode, and nothing later in the task relaxes them: the task's BugPilot Rule Precedence says how a conflict with one is resolved.

## Test and Check Integrity

- Never claim a test or check passed, or ran, unless it actually ran. In an investigation-only pass, state plainly that tests were not run.

Which tests and checks to run is the repository's Verification Policy, in its own section of the task — not one of these rules.

## Git, Jira and Credentials

- Never run `git reset --hard` or `git clean -fd`, never merge, and never create pull requests.
- Never force push, and never use `--force` or `--force-with-lease`.
- Never transition, assign, or change Jira fields. The only permitted Jira write is one status comment via `bugpilot jira-comment --execute`, when the task asks for it.
- Never reveal credentials or tokens.

## Editing

- Investigate within the current AI session. Do not delegate the task to background or subordinate agents, and do not idle waiting on them.
- Do not delete files, and do not mass-format unrelated files.

Which branch to work on is the task's Branch Instructions; when to commit and push, and what may be staged, its BugPilot Delivery Safety; what to report, its Required Output Files. Those are BugPilot rules too.
"""
