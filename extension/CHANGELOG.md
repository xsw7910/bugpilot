# Changelog

## 0.1.0 — unreleased

First release. What it does today:

- **One workflow panel.** A Jira issue key or a bug you describe, one primary
  button, and six steps: issue details, code search, git history, similar fixes,
  build context, and an optional **Fix with AI**. Each row is both the choice and
  the outcome.
- **The button is the next step.** It reads **Run** until there is a context,
  **Fix with AI** once `task.md` is ready, **Open AI Session** once an agent has
  it, **Rebuild Context** when the form has changed since it was prepared, and
  **Running…** while anything is in flight. Rebuild Context and Start New Attempt
  sit behind a **⋯** beside it.
- **Fix with AI** hands the finished package to a coding agent in a terminal.
  Auto-detect, Claude Code, or a custom command of your own with a `{prompt}`
  placeholder. Off by default: preparing context and involving a model stay two
  separate decisions.
- **Artifacts and History views.** Artifacts groups what a run produced; History
  says what became of each work item — ready, fixed, retry waiting, retry
  prepared, failed, unfinished — and reopens any of them in the panel.
- **Start New Attempt.** A new agent session on the prepared context, with
  optional feedback: empty writes nothing; typed feedback becomes
  `user_feedback.md` and the retry package the CLI builds from it. A recorded
  review's findings, or checks recorded as Failed or Not Run, can be copied in.
  The CLI's two-step retry loop stays in the command palette.
- Jira credentials live in VS Code's SecretStorage and reach the CLI as
  environment variables — never on a command line, never in the panel.
- **Fix Mode.** Under **Advanced settings → Strategy**, a dropdown chooses how
  the agent approaches the bug: Standard Fix (the default), Conservative Fix,
  Investigate First, Test-Driven Fix or Deep Analysis, plus any custom mode you
  or the project define. Investigate First prepares an investigation-only pass —
  evidence, hypotheses and a fix plan, no source changes — and the panel says so
  beneath the dropdown before you run it. History shows which mode a work item
  was prepared with.
- **Manage Fix Modes.** Duplicate a built-in mode and edit the copy's
  instructions, at user scope (`~/.bugpilot/fix_modes/`) or project scope
  (`.bugpilot/fix_modes/`, shared through source control). The list of modes
  comes from the `bugpilot` CLI; the extension defines none of its own.

Requires the `bugpilot` CLI on the machine; the extension drives it and does not
bundle it.
