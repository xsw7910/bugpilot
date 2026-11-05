"""Prompt and task artifact generation."""

from __future__ import annotations

from typing import Mapping, Sequence

from .ai_behavior import ResolvedAiBehavior, ai_behavior_section
from .attachments import ATTACHMENTS_DIR
from .branch_policy import DEFAULT_BRANCH_POLICY, branch_instructions
from .delivery_instructions import assisted_delivery_block, delivery_safety_block
from .evidence import visible_escapes
from .fix_modes import STANDARD_FIX, FixMode, FixModeError
from .git_ops import branch_name
from .instructions import (
    ResolvedInstructions,
    contained_markdown,
    normalize_instructions,
    project_instruction_section,
    user_instruction_section,
)
from .project_settings import ResolvedProjectSettings
from .protected_rules import (
    CONTRACT as PROTECTED_RULES_CONTRACT,
    EVIDENCE_RULES,
    GROUPS as PROTECTED_RULE_GROUPS,
    PROTECTED_RULES,
    PROTECTED_RULES_VERSION,
    rule_bullet,
    rule_text,
    RULE_PRECEDENCE,
    rules_in,
    safety_rules_document,
)
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
    ai_behavior: ResolvedAiBehavior | None = None,
    *,
    work_folder: str,
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

    ``ai_behavior`` is the repository's AI Behavior
    (:func:`ai_behavior.resolve_ai_behavior`): BugPilot's defaults plus the
    repository's additions. ``None`` is the defaults; the section is always
    written.

    ``work_folder`` is the work item's folder in BugPilot's data folder, as
    :func:`config.prompt_path` renders it: absolute, with forward slashes. The
    agent runs in the repository, so the task names that folder once, in
    Execution Location, and its report's destination absolutely; every other
    file is named by its plain name in that folder (plan §9.8.1).
    """
    # The full analysis/fix/review/test workflow lives inside the task, so no
    # standalone per-phase prompt files are generated.
    template = project_settings.settings.branch_template if project_settings is not None else None
    branch = branch or branch_name(issue_key, summary, template)
    mode = _task_fix_mode(fix_mode)
    return _copilot_task(
        issue_key,
        work_folder,
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
        ai_behavior,
    )


def copilot_team_instructions() -> str:
    """BugPilot's safety rules, as bundled with the package.

    Repository-neutral by design. What a particular repository is belongs to its
    Repository Profile, and a team's own rules to its project instructions
    (its ``instructions.md`` setting). One copy at run time: an installed wheel
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


#: Which kind of guidance each section of `task.md` is (§42.2), by its heading.
#: `protected` is BugPilot's: emitted unchanged in every task, ahead of anything
#: a person configures, and winning any conflict. The rest are the layers a
#: person or the evidence supplies. A heading missing here fails a test, so a
#: new section has to say what it is.
TASK_SECTION_CLASSES: dict[str, str] = {
    "Developer Hint": "developer-hint",
    "Execution Location": "protected",
    "BugPilot Safety Rules": "protected",
    "Repository Context": "generated-evidence",
    "Project / Team Instructions": "project-instructions",
    "Verification Policy": "verification-policy",
    # BugPilot's default conventions (the Working Guidance of 0.1.3) and the
    # repository's additions (its `ai_behavior.md` setting, 0.1.4).
    "AI Behavior": "ai-behavior",
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
    # Contained like every other editable layer: a custom mode's own heading —
    # one indented past the validator's check, say — or an open fence never
    # reads as one of the task's sections; and its name stays on its line.
    # Normalized first, as the hint is: a lone carriage return is a line break to
    # an editor or a Markdown reader, but not to the containment, which reads
    # "\n" lines — so a heading after one would never be demoted.
    sections = "".join(
        f"### {_FIX_MODE_HEADINGS.get(name, name.title())}\n\n"
        f"{contained_markdown(normalize_instructions(text).strip())}\n\n"
        for name, text in mode.instruction_sections()
    )
    return (
        "## AI Fix Mode\n\n"
        f"- Mode: {' '.join(mode.name.split())}\n"
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
        "Verification Policy and AI Behavior additions, take precedence over user instructions.\n\n"
        f"{rule_text('conflicts-follow-bugpilot')}\n\n"
        f"{rule_bullet('precedence-not-editable')}\n"
        "- BugPilot's default AI Behavior is its default way of working, not a safety rule: any of "
        "these layers may refine it.\n\n"
    )


def investigation_handoff_block() -> str:
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
        "- Write `fix_report.md` in the work folder, every section investigation-phrased.\n"
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
    work_folder: str,
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
    ai_behavior: ResolvedAiBehavior | None = None,
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
        # Contained like every other layer's text: its line endings unified (a
        # lone carriage return is a line break too), its headings demoted and an
        # open fence closed, so nothing in it reads as one of the task's sections.
        hint_block = (
            "## Developer Hint\n\n"
            f"{contained_markdown(normalize_instructions(hint))}\n\n"
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
        investigation_handoff_block()
        if investigating
        else assisted_delivery_block(issue_key, branch_policy=branch_policy, branch=branch)
    )
    return (
        f"# BugPilot Task: {issue_key}\n\n"
        f"{hint_block}"
        "## Execution Location\n\n"
        "- Run your AI agent from the target repository root, not from the bugpilot tool source directory.\n"
        f"- This work item's files are outside the repository, in `{work_folder}/`. "
        "File names in this task are in that folder.\n\n"
        "## BugPilot Safety Rules\n\n"
        f"{_team_instructions_section()}"
        f"{repository_context_section(repository)}"
        f"{project_instruction_section(instructions)}"
        f"{verification_section(project_settings.effective_verification)}"
        f"{ai_behavior_section(ai_behavior)}"
        f"{user_instruction_section(instructions)}"
        f"{branch_instructions(branch_policy, branch, issue_key)}"
        f"{_attachments_section(attachments, attachment_notes)}"
        "## Required Input Files\n\n"
        "- Read `context.md`: the Issue Details (reproduction steps, actual/expected "
        "results, environment, errors, missing information), similar fixes and git history.\n"
        "- Read and inspect `retrieval.json` if present: the ranked related files with their matched lines, the search terms, and the search confidence.\n\n"
        f"{_fix_mode_section(mode)}"
        f"{_precedence_section()}"
        f"{_evidence_rules_section()}"
        f"{_required_output_section(work_folder, investigating)}"
        f"{delivery_safety_block(issue_key, branch, branch_policy=branch_policy, standalone=False)}"
        f"{jira_status_block}"
        f"{closing_block}"
    )


def _evidence_rules_section() -> str:
    """What counts as evidence, in every Fix Mode: the protected rules' Evidence Rules."""
    bullets = "".join(f"{rule_bullet(rule.id)}\n" for rule in rules_in(EVIDENCE_RULES))
    return (
        f"## {EVIDENCE_RULES}\n\n"
        "In every Fix Mode, these govern what counts as evidence — not how deeply you "
        "investigate or how you implement.\n\n"
        f"{bullets}\n"
    )


def _required_output_section(work_folder: str, investigating: bool) -> str:
    """One report in every mode, its sections described for the mode in hand.

    One artifact contract matters more than mode-specific file names:
    `check_results`, the VS Code view, the retry prompt and bug memory all
    read this one name. `fix_report.md` means "post-agent workflow report", not
    "confirmed fix" — an investigation fills the same sections with
    investigation state, and the Summary line says honestly what happened.
    """
    if not investigating:
        return (
            "## Required Output Files\n\n"
            f"Write one report: `{work_folder}/fix_report.md`, with exactly these sections.\n\n"
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
        f"Write one report: `{work_folder}/fix_report.md`, with exactly these sections. "
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
        # The name as it is written here (0.1.5, N3). Copying gives a name no
        # line break or control character, but the folder can hold one a copy
        # did not make (outside Windows), and a name is a heading of this task:
        # a line break in it would start a line — a section — of its own. Such
        # a character is shown as `<U+XXXX>`, never dropped, and so is the file.
        shown = visible_escapes(name, keep="")
        entries += f"### {shown}\n\n"
        if note:
            entries += f"Description: {note}\n"
        entries += f"File: `{ATTACHMENTS_DIR}/{shown}`\n"
        if shown != name:
            entries += (
                "Its file name holds characters shown here as `<U+XXXX>`; list the attachments folder "
                "to open it.\n"
            )
        entries += "\n"
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


# docs/agent_team_instructions.md mirrors this document; a test keeps the two identical.
def _fallback_team_instructions() -> str:
    """The bundled Safety Rules document, rendered from the protected rules (`protected_rules.py`)."""
    return safety_rules_document()


def protected_rules_payload() -> dict[str, object]:
    """``bugpilot protected-rules show --json``: the protected rules, as every task states them.

    Everything here is read from what writes the task — the rules from
    `protected_rules.py`, the layers from `INSTRUCTION_LAYERS`, the protected
    sections from `TASK_SECTION_CLASSES` — so the inspection cannot say
    something the task does not. Nothing in it depends on a repository, a
    person's configuration or the machine.
    """
    protected_sections = [heading for heading, kind in TASK_SECTION_CLASSES.items() if kind == "protected"]
    return {
        "rules_version": PROTECTED_RULES_VERSION,
        "editable": False,
        "source": "bugpilot",
        "contract": list(PROTECTED_RULES_CONTRACT),
        "groups": [
            {"id": group, "title": title, "rules": [rule.id for rule in PROTECTED_RULES if rule.group == group]}
            for group, title in PROTECTED_RULE_GROUPS
        ],
        "rules": [
            {"id": rule.id, "group": rule.group, "section": rule.section, "title": rule.title, "text": rule.text}
            for rule in PROTECTED_RULES
        ],
        # Every section BugPilot owns. The rules above are the ones every task
        # states word for word; the other sections' text depends on the work
        # item or the Fix Mode (the branch policy's checks, the report, Jira's
        # status comment, the investigation handoff).
        "sections": [
            {"heading": heading, "rules": [rule.id for rule in PROTECTED_RULES if rule.section == heading]}
            for heading in protected_sections
        ],
        "precedence": {
            "layers": [{"position": number, "name": layer} for number, layer in enumerate(INSTRUCTION_LAYERS, start=1)],
            "rules": [rule.id for rule in rules_in(RULE_PRECEDENCE)],
        },
    }
