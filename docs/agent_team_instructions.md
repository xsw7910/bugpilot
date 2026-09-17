# Agent Team Instructions

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
