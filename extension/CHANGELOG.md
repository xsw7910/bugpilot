# Changelog

## 0.1.0 — unreleased

First release. What it does today:

- **One workflow panel**, the **Workflow** view. A Jira issue key or a bug you describe, one primary
  button, and six steps: issue details, code search, git history, similar fixes,
  build context, and an optional **Fix with AI**. Each row is both the choice and
  the outcome: the checkbox on the left (Issue details and Build context always
  run, so they have none), and on the right how it went, said once
  in words — Completed, Skipped, Running, Failed, Context ready — with a small
  dot, never a second check mark. A second line only when it adds something, the
  file it wrote under that.
- **The button is the next step.** It reads **Run** until there is a context,
  **Fix with AI** once `task.md` is ready, **Open AI Session** once an agent has
  it, **Rebuild Context** when the form has changed since it was prepared, and
  **Running…** while anything is in flight. Rebuild Context and Start New Attempt
  sit behind **⋯ More** beside it. Open AI Session acknowledges every press under
  the button — "AI session focused", or that the session is no longer available
  — and never starts a new one.
- **Reset Session**, from ⋯ More: back to a fresh session — the issue, its
  settings and the prepared context — keeping the AI Agent preference and
  History. It asks first: keep the generated files (the default) or delete the
  current work item's `.ai/<work item>/`, and nothing else.
- **Fix with AI** hands the finished package to a coding agent. **AI Agent**:
  Auto-detect, Codex CLI, Claude CLI (each in a terminal), the Codex or Claude
  extension (the prompt copied and the agent's view opened — neither documents
  a way to hand it a prompt), or a custom command of your own with a `{prompt}`
  placeholder. Auto-detect prefers the agent the last handoff reached, then the
  strongest integration found, and says what it found under the picker; a
  choice you made is never swapped for another agent. Off by default:
  preparing context and involving a model stay two separate decisions.
- **Results view.** One native tree with three groups. **Current** is one flat
  list of the open work item's files in workflow order — each Written or Not
  written yet, with what it is for on hover. **History**, collapsed until you
  open it, says what became of each work item — ready, fixed, retry waiting,
  retry prepared, failed, unfinished — and reopens any of them in the panel.
  **Diagnostics**, also collapsed, shows the repository, Jira, AI agent, work
  item and versions BugPilot is using.
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
  Current within about a second — no reload. A new fix report offers
  Review with AI; the same report written again does not. Only that folder is
  watched; the refresh only reads, and keeps whatever is being typed.
- **Jira Setup.** The Jira row, or **BugPilot: Set Jira Credentials**, opens
  one dialog for your Atlassian email and API token, with a link to
  Atlassian's token page. Credentials live in VS Code's SecretStorage and reach
  the CLI as environment variables — never on a command line, never in the
  panel. Jira is optional: a bug you describe in your own words needs none.
- **Issue first.** The Issue field takes a Jira issue key (e.g. JR-12345) or a
  description, with Run directly under it; **Fix Mode** and **Hint** (with
  *Improve with AI ☑ using Issue details*) follow: what the bug is, how the AI
  should approach it, and any guidance.
- **Advanced Settings.** One page with sections for Issue details, Retrieval
  inputs, Code search, Git history, Similar fixes, Repository, Build context,
  Fix with AI and Branch. A step's ⚙ opens its section, and the **⚙ Advanced Settings** row
  opens the top. Changes apply with **Apply** and are discarded by Cancel or
  Back; each section is tagged *Requires rebuild* or *Next run only*, and the
  rows show a short summary of their settings. Fix Mode and Hint are on the
  main page, not here.
- **Attachments.** Under Advanced Settings → Issue details: pick files, paste
  them, or drop them on the field, each with an optional description — up to
  10 files of 10 MB each.
- **Repository profile.** Advanced Settings → Repository: *Auto-detect* (the
  default — high-confidence facts from the repository's build and package files,
  shown under the picker), *Generic* (no language or framework assumed) or
  *Custom* (six short details you write). `task.md` describes the repository from
  it and assumes nothing else. It is saved with the repository in
  `.bugpilot/repository_profile.json`, where the CLI and MCP server read it too,
  needs a rebuild when changed, and survives Reset Session.
- **An out-of-date CLI says so.** A bugpilot CLI older than the extension is
  reported as *BugPilot CLI is out of date*, with Update Instructions, Choose
  Executable and Retry — not as a run that crashed. A CLI that disappears
  mid-session is reported as not found.
- **Branch policy.** Advanced Settings → Branch: *Use current branch* (the
  default), *One branch per issue*, or *Ask before editing*. It is an
  instruction in `task.md`: BugPilot itself never creates or switches a branch,
  and `main`/`master` are never edited, committed or pushed.
- **Fix Mode.** On the main page under the issue, a dropdown chooses how
  the agent approaches the bug: Standard Fix (the default), Conservative Fix,
  Investigate First, Test-Driven Fix or Deep Analysis, plus any custom mode you
  or the project define. Investigate First prepares an investigation-only pass —
  evidence, hypotheses and a fix plan, no source changes — and the panel says so
  beneath the dropdown before you run it. History shows which mode a work item
  was prepared with.
- **Manage Fix Modes.** View any mode, **Customize copy** of a built-in, and
  **Edit**, **Duplicate** or **Delete** your own in one editor, at user scope
  (`~/.bugpilot/fix_modes/`) or project scope (`.bugpilot/fix_modes/`, shared
  through source control). The list of modes
  comes from the `bugpilot` CLI; the extension defines none of its own.
- **Add to .gitignore.** The Repository Files warning — `.ai/` and `.ai_memory/`
  are not ignored — has a button that adds the missing rules to the repository's
  `.gitignore`: only what git says is missing, appended in the file's own line
  ending, and never behind unsaved edits in an open editor. The warning goes
  once git confirms both folders are ignored, without a reload.

Requires the `bugpilot` CLI on the machine; the extension drives it and does not
bundle it.
