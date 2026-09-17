"""Prompt and task artifact generation."""

from __future__ import annotations

from pathlib import Path
from typing import Sequence

from .attachments import ATTACHMENTS_DIR
from .delivery_instructions import delivery_instructions_block
from .git_ops import branch_name


def generate_prompts(
    issue_key: str,
    summary: str | None = None,
    hint: str | None = None,
    jira_comment: bool = False,
    attachments: Sequence[str] | None = None,
) -> dict[str, str]:
    # The full analysis/fix/review/test workflow lives inside agent_task.md, so
    # the standalone per-phase prompt files are intentionally not generated.
    branch = branch_name(issue_key, summary)
    return {
        "agent_task.md": _copilot_task(issue_key, branch, hint, jira_comment, attachments),
        "agent_handoff.md": _copilot_handoff(issue_key, jira_comment),
        "agent_team_instructions.md": copilot_team_instructions(),
    }


def generate_copilot_task_files(
    issue_key: str,
    summary: str | None = None,
    hint: str | None = None,
    jira_comment: bool = False,
    attachments: Sequence[str] | None = None,
) -> dict[str, str]:
    branch = branch_name(issue_key, summary)
    return {
        "agent_task.md": _copilot_task(issue_key, branch, hint, jira_comment, attachments),
        "agent_handoff.md": _copilot_handoff(issue_key, jira_comment),
        "agent_team_instructions.md": copilot_team_instructions(),
    }


def copilot_team_instructions() -> str:
    path = Path(__file__).resolve().parents[2] / "docs" / "agent_team_instructions.md"
    if path.exists():
        return path.read_text(encoding="utf-8")
    return _fallback_team_instructions()


def _copilot_task(
    issue_key: str,
    branch: str,
    hint: str | None = None,
    jira_comment: bool = True,
    attachments: Sequence[str] | None = None,
) -> str:
    hint_block = ""
    if hint and hint.strip():
        hint_block = (
            "## Developer Hint\n\n"
            f"{hint.strip()}\n\n"
            "Trust this hint. Go straight to the location it names and implement the fix there. "
            "Do not run broad exploration and do not spawn agents to re-locate what the hint already tells you.\n\n"
        )
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
        if jira_comment
        else ""
    )
    forbidden_jira_line = (
        "- Do not update Jira fields; posting the one status comment described above is allowed.\n"
        if jira_comment
        else "- Do not update Jira.\n"
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
        "## Analysis Workflow\n\n"
        "- Investigate inline using Read, Grep, and Glob only. Do not use the Task tool or spawn any background or sub-agents, and never idle waiting on one.\n"
        "- Summarize the problem in your own words.\n"
        "- Read Jira comments in `bug_context.md` as potentially newer than the original description.\n"
        "- Review Jira attachment metadata in `bug_context.md`.\n"
        "- Do not claim to have inspected attachment contents unless the content is present in repository files or artifact files.\n"
        "- If attachment metadata suggests logs, screenshots, or crash dumps, mention follow-up review if needed.\n"
        "- Use reproduction steps, actual/expected results, environment, and error messages from jira_parsed.md.\n"
        "- Do not invent reproduction steps or error messages not present in the Jira data.\n"
        "- If required bug information is missing, document your assumptions in bug_analysis.md.\n"
        "- If missing information prevents a safe fix, write a no-op analysis or request follow-up information.\n"
        "- Identify likely root cause hypotheses.\n"
        "- Inspect top related files from `related_files.json`.\n"
        "- Read search quality from `bug_context.md` or `code_search.md`.\n"
        "- If search confidence is Low, verify whether the feature exists before editing.\n"
        "- If search confidence is Low, do not assume the matched files are the correct implementation.\n"
        "- Do not modify code based only on low-confidence keyword matches.\n"
        "- If no real implementation is found, write a no-op analysis explaining why no code fix was applied.\n"
        "- Use matched line numbers from `code_search.md`.\n"
        "- Do not edit code until after reviewing context and related files.\n"
        "- Ask follow-up questions if context is insufficient.\n\n"
        "## Implementation Workflow\n\n"
        "- Implement the smallest safe fix.\n"
        "- Avoid unrelated refactoring.\n"
        "- Avoid public API changes unless necessary.\n"
        "- Avoid formatting-only changes.\n"
        "- Avoid deleting files.\n"
        "- Run focused tests if available.\n\n"
        "## Required Output Files\n\n"
        f"- `.ai/{issue_key}/bug_analysis.md`\n"
        f"- `.ai/{issue_key}/fix_summary.md`\n"
        f"- `.ai/{issue_key}/test_result.md`\n"
        f"- `.ai/{issue_key}/diff_summary.md`\n"
        f"- `.ai/{issue_key}/review_notes.md`\n\n"
        f"{jira_status_block}"
        f"{delivery_instructions_block(issue_key, branch, jira_comment=jira_comment)}"
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
        "- Do not mass-format unrelated files.\n"
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


def _copilot_handoff(issue_key: str, jira_comment: bool = True) -> str:
    jira_reminder = (
        "- Never push main/master, force push, merge, transition/assign/edit Jira fields, or commit `.ai/` or `.ai_memory/` (posting one status comment via bugpilot is allowed).\n"
        if jira_comment
        else "- Never push main/master, force push, merge, update Jira, or commit `.ai/` or `.ai_memory/`.\n"
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
        "- Do not commit or push unless the developer explicitly approves after a delivery summary.\n"
        f"{jira_reminder}"
        f"- Generate the required result files under `.ai/{issue_key}/`.\n"
    )


# This fallback should mirror docs/agent_team_instructions.md.
def _fallback_team_instructions() -> str:
    return """# Agent Team Instructions

## Purpose

This document gives the AI agent stable team rules for working in a legacy C++/Qt desktop codebase.

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
- You may ask the developer whether they want you to commit and push after completing the workflow.
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
