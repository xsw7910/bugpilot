"""Prompt and task artifact generation."""

from __future__ import annotations

from pathlib import Path
from typing import Sequence

from .attachments import ATTACHMENTS_DIR
from .delivery_instructions import assisted_delivery_block, delivery_safety_block
from .fix_modes import STANDARD_FIX, FixMode, FixModeError
from .git_ops import branch_name

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


def generate_prompts(
    issue_key: str,
    summary: str | None = None,
    hint: str | None = None,
    jira_comment: bool = False,
    attachments: Sequence[str] | None = None,
    fix_mode: FixMode | None = None,
) -> dict[str, str]:
    # The full analysis/fix/review/test workflow lives inside agent_task.md, so
    # the standalone per-phase prompt files are intentionally not generated.
    branch = branch_name(issue_key, summary)
    mode = _task_fix_mode(fix_mode)
    return {
        "agent_task.md": _copilot_task(
            issue_key, branch, hint, jira_comment, attachments, mode
        ),
        "agent_handoff.md": _copilot_handoff(issue_key, jira_comment, mode),
        "agent_team_instructions.md": copilot_team_instructions(),
    }


def generate_copilot_task_files(
    issue_key: str,
    summary: str | None = None,
    hint: str | None = None,
    jira_comment: bool = False,
    attachments: Sequence[str] | None = None,
    fix_mode: FixMode | None = None,
) -> dict[str, str]:
    branch = branch_name(issue_key, summary)
    mode = _task_fix_mode(fix_mode)
    return {
        "agent_task.md": _copilot_task(
            issue_key, branch, hint, jira_comment, attachments, mode
        ),
        "agent_handoff.md": _copilot_handoff(issue_key, jira_comment, mode),
        "agent_team_instructions.md": copilot_team_instructions(),
    }


def copilot_team_instructions() -> str:
    path = Path(__file__).resolve().parents[2] / "docs" / "agent_team_instructions.md"
    if path.exists():
        return path.read_text(encoding="utf-8")
    return _fallback_team_instructions()


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
    produced it: a custom mode can be edited later, and `review_notes.md` read
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
    return (
        "## BugPilot Rule Precedence\n\n"
        "Fix Mode controls workflow strategy only.\n\n"
        "If any Fix Mode instruction conflicts with BugPilot safety, evidence-integrity, "
        "branch, Jira, or delivery rules, the BugPilot rule wins.\n\n"
        "- This precedence is not editable by a Fix Mode, including a custom one.\n"
        "- Record any such conflict in `review_notes.md` instead of resolving it in favor "
        "of the mode.\n\n"
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
        f"- Write all five required files under `.ai/{issue_key}/`.\n"
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
) -> str:
    mode = _task_fix_mode(fix_mode)
    investigating = mode.is_investigation
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
            "After writing the required investigation files, and BEFORE asking about implementation:\n"
            "- Post one Jira comment that records the investigation status and the leading "
            "root-cause hypothesis, so watchers are notified.\n"
            "- Run these two commands from the target repo root:\n"
            f"  - `bugpilot jira-comment-draft {issue_key}`\n"
            f"  - `bugpilot jira-comment {issue_key} --execute`\n"
            "- Keep the comment short, and state plainly that no source change has been applied.\n"
            "- Post exactly ONE comment. Do not transition the issue, assign it, or change any Jira field.\n"
            "- If the post fails (for example, no Jira access), tell the developer the comment was not posted.\n"
            "- This is the only permitted Jira write.\n\n"
        )
    else:
        jira_status_block = (
            "## Report Status to Jira (before commit)\n\n"
            "After writing the required result files, and BEFORE any commit:\n"
            "- Post one Jira comment that records the current work status and the analysis summary, so watchers are notified.\n"
            "- Run these two commands from the target repo root:\n"
            f"  - `bugpilot jira-comment-draft {issue_key}`\n"
            f"  - `bugpilot jira-comment {issue_key} --execute`\n"
            "- Keep the comment short: the root cause and a brief summary of the changes (not the full diff), drawn from the result files.\n"
            "- Post exactly ONE comment. Do not transition the issue, assign it, or change any Jira field.\n"
            "- If the post fails (for example, no Jira access), continue to delivery and tell the developer the comment was not posted.\n"
            "- This is the only permitted Jira write; do it before asking about commit.\n\n"
        )
    forbidden_jira_line = (
        "- Do not update Jira fields; posting the one status comment described above is allowed.\n"
        if jira_comment
        else "- Do not update Jira.\n"
    )
    # The safety gate is rendered for both execution kinds; only the offer to
    # commit and push is withheld from an investigation. Dropping both is how a
    # workflow change silently removed a BugPilot safety rule once.
    closing_block = (
        investigation_handoff_block(issue_key)
        if investigating
        else assisted_delivery_block(issue_key)
    )
    return (
        f"# Agent Task: {issue_key}\n\n"
        f"{hint_block}"
        "## Execution Location\n\n"
        "- Run your AI agent from the target repo root (the target repository root).\n"
        "- Do not run your AI agent from the bugpilot tool source directory.\n"
        f"- `.ai/{issue_key}/` files are relative to the target repo root.\n\n"
        "## Team Instructions\n\n"
        "Before editing code, read:\n"
        f"`.ai/{issue_key}/agent_team_instructions.md`\n\n"
        "Follow these instructions together with the issue-specific context.\n"
        "- Issue-specific task instructions override general team instructions only when necessary.\n"
        "- Safety rules always apply.\n"
        "- If team instructions and task instructions conflict, choose the safer option and document the conflict in `review_notes.md`.\n\n"
        "## Branch Instructions\n\n"
        f"- Branch name: `{branch}`\n"
        "- Check the current branch before editing.\n"
        "- Do not work directly on main/master.\n"
        "- Do not edit files on main/master.\n"
        "- Create or switch to the feature branch before editing files.\n\n"
        f"{_attachments_section(issue_key, attachments)}"
        "## Required Input Files\n\n"
        f"- Read `.ai/{issue_key}/bug_context.md`.\n"
        f"- Read `.ai/{issue_key}/agent_team_instructions.md`.\n"
        f"- Read and inspect `.ai/{issue_key}/code_search.md` if present.\n"
        f"- Read and inspect `.ai/{issue_key}/related_files.json` if present.\n"
        f"- Read search quality from `.ai/{issue_key}/search_quality.json` if present.\n"
        f"- Similar historical issues and git context are included in `bug_context.md`.\n"
        f"- Read `.ai/{issue_key}/jira_parsed.md` for reproduction steps, actual/expected results, environment, errors, and missing information.\n\n"
        f"{_fix_mode_section(mode)}"
        f"{_precedence_section()}"
        "## BugPilot Evidence Rules\n\n"
        "These rules apply in every Fix Mode. They govern what counts as evidence, not how "
        "deeply you investigate or how you implement.\n\n"
        "- Summarize the problem in your own words from the supplied evidence.\n"
        "- Read Jira comments in `bug_context.md` as potentially newer than the original description.\n"
        "- Review Jira attachment metadata in `bug_context.md`.\n"
        "- Do not claim to have inspected attachment contents unless the content is present in repository files or artifact files.\n"
        "- If attachment metadata suggests logs, screenshots, or crash dumps, mention follow-up review if needed.\n"
        "- Use reproduction steps, actual/expected results, environment, and error messages from jira_parsed.md.\n"
        "- Do not invent reproduction steps or error messages not present in the Jira data.\n"
        "- If required bug information is missing, document your assumptions in bug_analysis.md.\n"
        "- If missing information prevents a safe fix, write a no-op analysis or request follow-up information.\n"
        "- Inspect top related files from `related_files.json`.\n"
        "- Read search quality from `bug_context.md` or `code_search.md`.\n"
        "- If search confidence is Low, verify whether the feature exists before editing.\n"
        "- If search confidence is Low, do not assume the matched files are the correct implementation.\n"
        "- Do not modify code based only on low-confidence keyword matches.\n"
        "- If no real implementation is found, write a no-op analysis explaining why no code fix was applied.\n"
        "- Use matched line numbers from `code_search.md`.\n"
        "- Do not edit code until after reviewing context and related files.\n"
        "- Ask follow-up questions if context is insufficient.\n\n"
        "## BugPilot Editing Guardrails\n\n"
        "These rules apply in every Fix Mode and cannot be relaxed by the selected mode.\n\n"
        "- Investigate inline using Read, Grep, and Glob only. Do not use the Task tool or spawn any background or sub-agents, and never idle waiting on one.\n"
        "- Edit only on the feature branch named above; never on main/master.\n"
        "- Do not delete source files.\n"
        "- Do not mass-format unrelated files.\n"
        "- Do not commit or push without explicit developer approval.\n"
        "- Do not create pull requests.\n"
        "- Do not transition, assign, or change Jira fields.\n"
        "- Never stage or commit `.ai/` or `.ai_memory/`.\n"
        "- Report honestly what you ran: do not claim tests or checks passed if they were not run.\n\n"
        f"{_required_output_section(issue_key, investigating)}"
        "## Forbidden Actions\n\n"
        "- Do not run `git reset --hard`.\n"
        "- Do not run `git clean -fd`.\n"
        "- Do not delete source files.\n"
        "- Do not push main/master.\n"
        "- Do not force push.\n"
        "- Do not use `--force` or `--force-with-lease`.\n"
        "- Do not merge.\n"
        f"{forbidden_jira_line}"
        "- Do not transition Jira.\n"
        "- Do not assign Jira.\n"
        "- Do not change Jira fields.\n"
        "- Do not create PRs.\n"
        "- Do not mass-format unrelated files.\n\n"
        f"{delivery_safety_block(issue_key, branch, jira_comment=jira_comment)}"
        f"{jira_status_block}"
        f"{closing_block}"
    )


def _required_output_section(issue_key: str, investigating: bool) -> str:
    """The same five files in every mode, described for the mode in hand.

    Keeping one artifact contract matters more than naming the files
    accurately: `check_results`, the VS Code view and `.ai_memory` all read
    these five names. So an investigation writes the same files and says what
    each one means when there is no fix yet — otherwise `fix_summary.md` reads
    as a completed fix and `test_result.md` as tests that passed.
    """
    if not investigating:
        return (
            "## Required Output Files\n\n"
            f"- `.ai/{issue_key}/bug_analysis.md`\n"
            f"- `.ai/{issue_key}/fix_summary.md`\n"
            f"- `.ai/{issue_key}/test_result.md`\n"
            f"- `.ai/{issue_key}/diff_summary.md`\n"
            f"- `.ai/{issue_key}/review_notes.md`\n\n"
            "These files are required in every Fix Mode. Write all five even when the change "
            "is small, and if no code change proves justified, say so plainly instead of "
            "leaving a file out.\n\n"
        )
    return (
        "## Required Output Files\n\n"
        "The file names are the same in every Fix Mode. In this investigation-only mode they "
        "record investigation state, not a completed fix.\n\n"
        f"- `.ai/{issue_key}/bug_analysis.md`: root-cause hypotheses, the evidence for and "
        "against each, and what information is missing.\n"
        f"- `.ai/{issue_key}/fix_summary.md`: the proposed fix plan. State explicitly that no "
        "source change was applied.\n"
        f"- `.ai/{issue_key}/test_result.md`: the proposed validation, and that tests were not "
        "run because implementation has not started.\n"
        f"- `.ai/{issue_key}/diff_summary.md`: state that no source changes were made.\n"
        f"- `.ai/{issue_key}/review_notes.md`: risks, open questions, and the recommended next step.\n\n"
        "Do not write any of these as though a fix exists.\n\n"
    )


def _attachments_section(issue_key: str, attachments: Sequence[str] | None) -> str:
    """Files the developer attached, named one by one.

    Only ever lists files that were actually copied — `copy_attachments` drops
    what it could not take, and this is handed the result of reading the
    directory rather than the developer's original request. Telling an agent to
    read something that is not there wastes a turn and teaches it to distrust
    the list.

    The wording about images is deliberate. Whether an agent can open a PNG
    depends on the agent and the model behind it, and that is not knowable from
    here — so it is told the file exists and asked to say so if it cannot read
    it, rather than being promised a capability or denied one.
    """
    names = [name for name in (attachments or []) if name]
    if not names:
        return ""
    lines = "".join(
        f"- `.ai/{issue_key}/{ATTACHMENTS_DIR}/{name}`\n" for name in names
    )
    return (
        "## Developer Attachments\n\n"
        "The developer attached these files for this bug. They are not part of "
        "the repository and are not in the Jira description.\n\n"
        f"{lines}"
        "\n"
        "- Read the ones your tools can open, and use them as evidence.\n"
        "- If one is an image or a format you cannot read, say so plainly "
        "instead of guessing at its contents.\n\n"
    )


def _copilot_handoff(
    issue_key: str,
    jira_comment: bool = True,
    fix_mode: FixMode | None = None,
) -> str:
    mode = _task_fix_mode(fix_mode)
    jira_reminder = (
        "- Never push main/master, force push, merge, transition/assign/edit Jira fields, or commit `.ai/` or `.ai_memory/` (posting one status comment via bugpilot is allowed).\n"
        if jira_comment
        else "- Never push main/master, force push, merge, update Jira, or commit `.ai/` or `.ai_memory/`.\n"
    )
    # An investigation has no delivery summary to approve, so it does not get the
    # sentence that promises one. What it gets instead is the stop.
    if mode.is_investigation:
        mode_lines = (
            f"- AI Fix Mode: {mode.name} (`{mode.id}`). Investigation only: do not modify "
            "source code in this pass.\n"
            "- Do not commit or push.\n"
            "- Complete the investigation artifacts and ask whether to continue with "
            "implementation.\n"
        )
    else:
        mode_lines = (
            f"- AI Fix Mode: {mode.name} (`{mode.id}`). Follow it as written in `agent_task.md`.\n"
            "- Do not commit or push unless the developer explicitly approves after a "
            "delivery summary.\n"
        )
    return (
        f"# Agent Handoff: {issue_key}\n\n"
        f"Read `.ai/{issue_key}/agent_task.md` and complete the workflow.\n\n"
        "Read these files before editing:\n"
        f"- `.ai/{issue_key}/agent_task.md`\n"
        f"- `.ai/{issue_key}/agent_team_instructions.md`\n\n"
        "## Reminder\n\n"
        "- Run your AI agent from the target repo root.\n"
        "- Do not run from the bugpilot tool repo.\n"
        "- Do not work directly on main/master.\n"
        f"{mode_lines}"
        f"{jira_reminder}"
        f"- Generate the required result files under `.ai/{issue_key}/`.\n"
    )


# This fallback should mirror docs/agent_team_instructions.md.
def _fallback_team_instructions() -> str:
    return """# Agent Team Instructions

## Purpose

This document gives the AI agent stable team rules for working in a legacy C++/Qt desktop codebase.

## Task and Fix Mode Precedence

These are general team rules. The issue-specific agent task, and the AI Fix Mode it names, decide whether implementation, testing, and assisted delivery are allowed in the current pass.

- If the selected Fix Mode is investigation-only, do not implement, do not offer to commit or push, and do not describe the issue as fixed, resolved, or verified. Complete the investigation artifacts and ask the developer whether to continue.
- The rules below about small fixes, focused tests, and asking about commit and push apply to a pass that is allowed to change source code.
- BugPilot safety rules always apply, in every pass and in every Fix Mode.

## Core Principles

- Prefer small, targeted fixes.
- Do not refactor unrelated code.
- Do not mass-format files.
- Do not rename public APIs unless required.
- Do not change product behavior outside the Jira scope.
- Preserve existing architecture and coding style.
- Ask for clarification or write no-op analysis if context is insufficient.

## Legacy C++ Guidelines

- Be careful with object ownership and lifetime.
- Avoid introducing raw owning pointers unless consistent with surrounding code.
- Prefer existing project ownership patterns.
- Avoid broad exception handling changes.
- Avoid global state changes unless clearly required.
- Be careful with copy/move behavior in existing classes.
- Avoid changing ABI-sensitive public headers unless necessary.

## Qt Guidelines

- Respect QObject parent/child ownership.
- Avoid UI updates from non-UI threads.
- Be careful with signal/slot connections and duplicate connections.
- Avoid blocking the UI thread.
- Preserve existing translation/localization patterns.
- Preserve existing widget layout and object names unless required.
- Be careful with model/view updates and stale data.
- Use existing Qt version/style patterns in nearby code.

## Legacy Codebase Guidelines

- Prefer local fixes near the identified root cause.
- Read surrounding code before editing.
- Follow nearby naming and formatting style.
- Do not modernize unrelated code.
- Do not replace existing frameworks or patterns.
- Do not change file organization unless required.
- Do not assume all tests are available.

## Testing Expectations

These apply to a pass that changes source code. In an investigation-only pass, record the proposed validation instead and state plainly that tests were not run.

- Run focused tests if available.
- If automated tests are unavailable, document manual validation.
- Include regression risk.
- Include commands attempted and results.
- Do not claim tests passed if they were not run.

## Git Safety

- Do not work directly on main/master.
- Do not run git reset --hard.
- Do not run git clean -fd.
- Do not delete files.
- Do not merge.
- Do not commit or push automatically.
- When the current pass is allowed to change source code, you may ask the developer whether they want you to commit and push after completing the workflow.
- Only commit and push after explicit approval.
- Never push main/master.
- Never force push.
- Never commit .ai/ or .ai_memory/.
- Never transition, assign, or edit Jira fields. You may post exactly one status comment via `bugpilot jira-comment --execute` when the task instructions ask for it.
- Developer approval is required for any git commit or git push.
- Always summarize changed files.

## Output Expectations

When completing a bugpilot agent task, generate:
- .ai/<issue>/bug_analysis.md
- .ai/<issue>/fix_summary.md
- .ai/<issue>/test_result.md
- .ai/<issue>/diff_summary.md
- .ai/<issue>/review_notes.md

## No-Op Fix Guidance

If the issue is mock/demo, search confidence is low, or no real implementation exists:
- Do not invent a code fix.
- Do not modify unrelated files.
- Write a clear no-op analysis.
- Explain what was searched.
- Explain why no source change was applied.
- Recommend what information is needed next.
"""
