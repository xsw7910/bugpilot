# BugPilot Safety Rules

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
