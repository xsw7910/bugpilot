# Changelog

## 0.1.0 — unreleased

First release. What it does today:

- **One workflow panel.** A Jira issue key or a bug you describe, one **Run**
  button, and six steps: issue details, code search, git history, similar fixes,
  build context, and an optional **Fix with AI**. Each row is both the choice and
  the outcome.
- **Fix with AI** hands the finished package to a coding agent in a terminal.
  Auto-detect, Claude Code, or a custom command of your own with a `{prompt}`
  placeholder. Off by default: preparing context and involving a model stay two
  separate decisions.
- **Artifacts and History views.** Artifacts groups what a run produced; History
  says what became of each work item — ready, fixed, retry waiting, retry
  prepared, failed, unfinished — and reopens any of them in the panel.
- **Retry loop.** The first press writes `user_feedback.md` and opens it; the
  second builds the retry package around what you wrote.
- Jira credentials live in VS Code's SecretStorage and reach the CLI as
  environment variables — never on a command line, never in the panel.
- **Fix Mode.** A dropdown above **Run** chooses how the agent approaches the
  bug: Standard Fix, Conservative Fix, Investigate First, Test-Driven Fix or
  Deep Analysis, plus any custom mode you or the project define. Investigate
  First prepares an investigation-only pass — evidence, hypotheses and a fix
  plan, no source changes — and the panel says so before you run it. History
  shows which mode a work item was prepared with.
- **Manage Fix Modes.** Duplicate a built-in mode and edit the copy's
  instructions, at user scope (`~/.bugpilot/fix_modes/`) or project scope
  (`.bugpilot/fix_modes/`, shared through source control). The list of modes
  comes from the `bugpilot` CLI; the extension defines none of its own.

Requires the `bugpilot` CLI on the machine; the extension drives it and does not
bundle it.
