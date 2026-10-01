# Changelog

## 0.1.0 — unreleased

First release. What it does today:

- **One workflow panel**, the **Workflow** view. A Jira issue key or a bug you describe, one primary
  button, and six steps: issue details, code search, git history, similar fixes,
  build context, and an optional **Fix with AI**. Each row is both the choice and
  the outcome: the checkbox on the left, and on the right how it went, said once
  in words — Completed, Skipped, Running, Failed, Context ready — with a small
  dot, never a second check mark. A second line only when it adds something, the
  file it wrote under that.
- **The button is the next step.** It reads **Run** until there is a context,
  **Fix with AI** once `task.md` is ready, **Open AI Session** once an agent has
  it, **Rebuild Context** when the form has changed since it was prepared, and
  **Running…** while anything is in flight. Rebuild Context and Start New Attempt
  sit behind a **⋯** beside it. Open AI Session acknowledges every press under
  the button — "AI session focused", or that the session is no longer available
  — and never starts a new one.
- **Fix with AI** hands the finished package to a coding agent. **AI Agent**:
  Auto-detect, Codex CLI, Claude CLI (each in a terminal), the Codex or Claude
  extension (the prompt copied and the agent's view opened — neither documents
  a way to hand it a prompt), or a custom command of your own with a `{prompt}`
  placeholder. Auto-detect prefers the agent the last handoff reached, then the
  strongest integration found, and says what it found under the picker; a
  choice you made is never swapped for another agent. Off by default:
  preparing context and involving a model stay two separate decisions.
- **Artifacts and History views.** Artifacts is one flat list of the work
  item's files in workflow order — each Written or Not written yet, with what it
  is for on hover; History
  says what became of each work item — ready, fixed, retry waiting, retry
  prepared, failed, unfinished — and reopens any of them in the panel.
- **Start New Attempt.** A new agent session on the prepared context, with
  optional feedback: empty writes nothing; typed feedback becomes
  `user_feedback.md` and the retry package the CLI builds from it. A saved
  review's findings, or checks recorded as Failed or Not Run, can be copied in
  when you press Use Review Findings or Use Verification Evidence.
  The CLI's two-step retry loop stays in the command palette.
- **After a fix: review, then verification — kept apart.** Under the fix
  report, **Review with AI** asks for `## Summary`, `## Findings`,
  `## Validation Notes` and `## Recommendations` and for no verdict. With
  Claude CLI it runs one read-only, non-interactive review, shows
  **Reviewing…**, and opens the Review Result form filled in from the reply,
  marked *Prefilled from AI review*. While it runs, the row names the agent,
  shows a spinner and the elapsed time, and offers Show details and Cancel
  Review — which asks, ends the reviewer, keeps nothing, and offers Review with
  AI again; with Codex CLI or a custom command it hands the prompt
  over in a terminal, and with an extension it copies it. Review with AI is offered once per fix and comes back only
  when the fix report changes. **Paste Review Output** reads a reply in those
  four sections into the same form — the fallback when a reply could not be
  captured, and the way in for any other reviewer. Nothing is saved until
  **Save Review Result**. **Add Review Result** is the same form for a review
  typed by hand. **Add Verification Evidence** records the checks you actually
  performed — each with the status you chose, Not Run by default — and what you
  observed; the form saves itself shortly after you stop typing, shows
  Unsaved changes / Saving… / Saved, writes nothing while it is empty or a
  check has no name, and never writes over a report changed outside it. BugPilot runs none of them and reads no pass, approval or
  "verified" out of either record.
- **The panel follows the work item's folder.** A `fix_report.md`, a review or
  verification report, or any other file written, changed or deleted in
  `.ai/<work item>/` by an agent or another process shows up in the panel and
  the Artifacts view within about a second — no reload. A new fix report offers
  Review with AI; the same report written again does not. Only that folder is
  watched; the refresh only reads, and keeps whatever is being typed.
- Jira credentials live in VS Code's SecretStorage and reach the CLI as
  environment variables — never on a command line, never in the panel.
- **The problem at the top.** Issue, **Fix Mode** and **Hint** (with Improve
  with AI and Include issue details) sit together above the button: what the bug is, how
  the AI should approach it, and any guidance. The Issue field says it takes a
  Jira ticket (e.g. JR-12345) or a description.
- **Advanced Settings.** A ⚙ on each step that has settings — Issue details,
  Code search, Build context, Fix with AI — opens one settings page at that
  step's section, and **⚙ Advanced Settings** under Run opens it at the top.
  Changes apply with **Apply** and are discarded by Cancel or Back; each section
  says whether its changes require rebuilding context, and the rows show a
  short summary of their settings. It replaces the old settings disclosure. Fix
  Mode and Hint are on the main page, not here.
- **Fix Mode.** On the main page under the issue, a dropdown chooses how
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
- **Add to .gitignore.** The Repository Files warning — `.ai/` and `.ai_memory/`
  are not ignored — has a button that adds the missing rules to the repository's
  `.gitignore`: only what git says is missing, appended in the file's own line
  ending, and never behind unsaved edits in an open editor. The warning goes
  once git confirms both folders are ignored, without a reload.

Requires the `bugpilot` CLI on the machine; the extension drives it and does not
bundle it.
