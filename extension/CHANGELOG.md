# Changelog

## 0.1.2 — unreleased

- **What to do after an extension handoff stays in the panel.** With the Codex
  or Claude extension as the AI Agent, Fix with AI copies the handoff prompt
  and opens the agent's own view. The step only you can take — *Context copied.
  Paste it into Codex to continue.* — is now said under the primary button,
  with **Copy Again**, until a new attempt, a rebuild, Reset Session, Clean or
  the agent's report; it was a notification that disappeared. The notification
  now only says *AI fix context copied.* Codex CLI, Claude CLI and a custom
  command are unchanged: they start in a terminal, with nothing to paste.
- **Open AI Session after the agent exited.** It used to bring the terminal
  back with the agent no longer running in it — after Ctrl+C or `/exit` the
  terminal stays open — and gave no way to start the agent again. Now, when the
  agent is known to have exited, or its terminal was closed, it starts the
  attempt's agent again: Claude CLI resumes the same conversation when its own
  `--help` lists `--session-id` and `--resume` (BugPilot starts it with
  `--session-id` and resumes that id), and otherwise starts again on the same
  task, as do Codex CLI and a custom command. No Claude version is required,
  and a flag the installed Claude CLI does not list is never passed. A running
  agent is still only brought forward, never started twice. Whether it is
  running comes from VS Code's shell integration (VS Code 1.93 or later);
  without it — VS Code 1.90 to 1.92 among others — the restart is offered in a
  notification rather than assumed. Not a new attempt: nothing is prepared,
  rebuilt, written or deleted.

## 0.1.1 — 2026-10-09

- **Install BugPilot Runtime.** With no CLI found, the panel says *BugPilot CLI
  is required.* and offers **Install BugPilot Runtime** as its main button
  (also **BugPilot: Install Runtime**). One click creates a private Python
  environment in VS Code's storage, one for each extension version, and
  installs the BugPilot CLI from PyPI into it at exactly the extension's
  version, checked with `bugpilot --version` before it is used. A progress
  notification shows each step; a failure says why, with Retry, Choose
  Executable and Show Details.
- **Nothing is installed automatically.** Setup runs only when you press the
  button. It needs Python 3.10 or later already installed, and never installs
  Python.
- **Your own CLI still works.** A `bugpilot` from pipx or pip on `PATH` is used
  as before, and `bugpilot.executablePath` (**Choose Executable**) is still the
  only one used when it is set. The order is the configured path, then the
  runtime, then `PATH`. A CLI on `PATH` older than the extension is offered the
  runtime as the way out.
- **Diagnostics** adds **CLI source** and **BugPilot runtime** rows.
- The `bugpilot` CLI 0.1.1 is 0.1.0 with a new version number, released so the
  runtime can install the matching version.

Requires Python 3.10 or later and the `bugpilot` CLI 0.1.1 or later — the
BugPilot runtime installs it, or install it with `pipx install bugpilot`.

## 0.1.0 — 2026-10-08

First release. What it does today:

- **Licence.** The Business Source License 1.1, with the same parameters as the `bugpilot` CLI
  (`LICENSE.txt`). The codicons icon font is CC BY 4.0 (`THIRD_PARTY_NOTICES.md`).
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
  The CLI's two-step retry loop is in the command palette too.
- **After a fix: review, then verification — kept apart.** Under the fix
  report, **Review with AI** asks for `## Summary`, `## Findings`,
  `## Validation Notes` and `## Recommendations` and for no verdict. With
  Claude CLI it runs one read-only, non-interactive review — no shell and no
  editing tool, so it cannot run a command or write a file; BugPilot collects
  the current `git status` and `git diff` itself and gives them to it — shows
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
  one dialog for your Jira site, Atlassian email and API token, with a link to
  Atlassian's token page. The site must be an `https://` address; it is saved
  where the CLI reads it (`~/.bugpilot/config.toml`), and a site set by
  `JIRA_BASE_URL` is shown, not overwritten. The email and token live in VS
  Code's SecretStorage and reach the CLI as environment variables — never on a
  command line, never in the panel. The token is never shown again: leave it
  blank to keep the stored one. Jira is optional: a bug you describe in your
  own words needs none.
- **Issue first.** The Issue field takes a Jira issue key (e.g. JR-12345) or a
  description, with Run directly under it; **Fix Mode** and **Hint** (with
  *Improve with AI ☑ using Issue details*) follow: what the bug is, how the AI
  should approach it, and any guidance.
- **Advanced Settings.** One page with sections for Issue details, Retrieval
  inputs, Code search, Git history, Similar fixes, Repository, AI
  instructions, Build context, Fix with AI and Branch. A step's ⚙ opens its section, and the **⚙ Advanced Settings** row
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
- **User and Project instructions.** Advanced Settings → Repository → *Project
  instructions* (`.bugpilot/instructions.md`, shared with the repository) and
  AI instructions → *User instructions* (`~/.bugpilot/instructions.md`, yours in
  every repository), each with **Edit**, which opens its own page with Save and
  Cancel. `task.md` carries them below BugPilot's safety rules, which always
  win, with the project's above yours: where the two disagree, the project's
  instructions win. Saving empty text removes the file; a change needs a
  rebuild; Reset Session keeps both. The CLI and the MCP server read the same
  two files.
- **Verification Policy.** Advanced Settings → AI instructions → *Verification*:
  run relevant tests, run existing static checks, run the full test suite (off
  by default), report tests not run. `task.md` states the policy without
  naming commands, as part of the project's layer; the Fix Mode still decides
  how each attempt verifies. Saved with the repository in
  `.bugpilot/project_settings.json`, read by the CLI and MCP server too; needs
  a rebuild when changed, and survives Reset Session.
- **Nothing runs from the repository.** `bugpilot`, `claude`, `codex` and
  `taskkill` are found on `PATH`'s absolute entries only and started by that
  path, so a `bugpilot.exe` or `claude.exe` planted in a repository never runs
  because the repository is the working directory. A relative
  `bugpilot.executablePath` is refused.
- **Generated files stay in the repository.** The one file the extension
  writes into `.ai/<work item>/` — `user_feedback.md` — is never written
  through a link or junction, like everything the CLI writes there.
- **An out-of-date CLI says so.** A bugpilot CLI older than the extension is
  reported as *BugPilot CLI is out of date*, with Update Instructions, Choose
  Executable and Retry — not as a run that crashed. A CLI that disappears
  mid-session is reported as not found.
- **Branch policy.** Advanced Settings → Branch: *Use current branch* (the
  default), *One branch per issue*, or *Ask before editing*. It is an
  instruction in `task.md`: BugPilot itself never creates or switches a branch,
  and `main`/`master` are never edited, committed or pushed. *Branch naming*
  names a new branch: `feature/{issue}-{slug}` by default, or the repository's
  own template, which must include `{issue}` and may add `{slug}`, checked so
  it always makes a valid branch name and saved in `.bugpilot/project_settings.json`. A work item keeps
  the branch it already has.
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

Requires the `bugpilot` CLI 0.1.0 or later (`pipx install bugpilot`); the
extension drives it and does not bundle it.
