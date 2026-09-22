---
name: bugpilot-investigate
description: Prepare focused code context for a bug before investigating it. Use when the user names a Jira issue key such as JR-12345, or describes a bug and asks to fix, investigate or analyse it — before searching the repository yourself.
---

# Investigate a bug with BugPilot

BugPilot turns a bug report into a task package: the issue details, ranked
candidate files, the relevant git history, and similar fixes from past work. It
runs as a command, so this skill needs nothing but the Bash tool.

Reach for it **before** searching the repository yourself. Grepping for the
words in a bug report finds the words; BugPilot's package is what someone
already assembled around them.

## Steps

1. Run `bugpilot bug <ISSUE>` from the repository root. For a bug with no issue
   key, run `bugpilot bug --description="..."` instead.
2. Read `.ai/<ISSUE>/agent_task.md` and `.ai/<ISSUE>/bug_context.md`. They
   contain the issue details, the ranked candidate files and the relevant git
   history — read them instead of searching the repository from scratch.
3. Complete the workflow `agent_task.md` describes for the selected AI Fix
   Mode — it says whether this pass investigates only or implements — and
   write the required result files.
4. Stop at the commit gate. Do not commit, push, or post to Jira.

The developer chooses the AI Fix Mode, not you: `bugpilot bug <ISSUE>
--fix-mode <id>` selects one, `bugpilot fix-mode list` names them, and Standard
Fix is the default. `agent_task.md` is authoritative for what the selected mode
asks of you.

## If the fix did not work

Do not start over. Run `bugpilot bug <ISSUE> --retry`, which creates
`.ai/<ISSUE>/user_feedback.md` and stops. The developer describes what went
wrong there; running the same command again then builds
`.ai/<ISSUE>/agent_retry_prompt.md`, carrying that correction plus a summary of
the previous attempt.

The feedback is the developer's, not yours. Ask for it rather than filling in
the template.

## What BugPilot will not do, and neither should you

- No commits, no pushes, no Jira comments. Preparing context and deciding to
  ship are different acts, and the second one belongs to a person.
- No large refactors. The task file scopes the change for the selected AI Fix
  Mode, and an investigation-only mode changes no source code at all.

## When the command is missing

If `bugpilot` is not found, say so and stop — do not fall back to searching the
repository as if the package existed. Installation:
`python -m pip install -e .` from a checkout of the bugpilot repository.

<!--
The four numbered steps above are rendered from `bugpilot/core/handoff.py`,
which is also the source for the MCP `fix_bug` prompt and the CLI's launch
prompt. `tests/test_handoff.py` compares this file against it: three copies of
the same instructions in three files drift, and the copy that drifts is the one
nobody reads (design 5.5).
-->
