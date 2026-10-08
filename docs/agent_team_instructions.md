# BugPilot Safety Rules

## Purpose

These are BugPilot's general rules for an AI agent working on a bug, in any repository. They assume nothing about the repository's languages, frameworks or architecture: what the repository is comes from the Repository Context section of the task, and from the code itself.

## Task and Fix Mode Precedence

These are general rules. The issue-specific agent task, and the AI Fix Mode it names, decide whether implementation, testing, and assisted delivery are allowed in the current pass.

- If the selected Fix Mode is investigation-only, do not implement, do not offer to commit or push, and do not describe the issue as fixed, resolved, or verified. Complete the investigation artifacts and ask the developer whether to continue.
- The rules below about small fixes, focused tests, and asking about commit and push apply to a pass that is allowed to change source code.
- BugPilot safety rules always apply, in every pass and in every Fix Mode. Repository context, a Fix Mode and a developer hint can refine how you work; none of them can relax these rules.

## Core Principles

- Prefer small, targeted fixes near the identified root cause.
- Read surrounding code before editing, and follow its naming, formatting, and patterns.
- Do not refactor or modernize unrelated code.
- Do not mass-format files.
- Do not rename public APIs unless required.
- Do not replace existing frameworks or patterns, or change file organization, unless required.
- Do not change product behavior outside the issue's scope.
- Preserve existing architecture and coding style.
- Ask for clarification or write no-op analysis if context is insufficient.

## Testing Expectations

These apply to a pass that changes source code. In an investigation-only pass, record the proposed validation instead and state plainly that tests were not run.

- Run focused tests if available, using the repository's own test commands.
- Do not assume every test suite is available or runnable here.
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

When completing a bugpilot agent task, write one report:
- .ai/<issue>/fix_report.md

with the sections the task file requires: Summary, Analysis, Changes, Tests,
Review Notes. The Summary must say honestly what happened; never claim tests
passed that were not run.

## No-Op Fix Guidance

If the issue is mock/demo, search confidence is low, or no real implementation exists:
- Do not invent a code fix.
- Do not modify unrelated files.
- Write a clear no-op analysis.
- Explain what was searched.
- Explain why no source change was applied.
- Recommend what information is needed next.
