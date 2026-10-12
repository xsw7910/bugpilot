# BugPilot

BugPilot turns a Jira issue — or a bug you describe yourself — into focused code context for your AI coding agent. It reads the issue, searches the repository, looks at related git history and similar past fixes, and writes a task package the agent can work from. Then it stops: you hand the package to the agent you use, and you stay in control of every commit.

It comes as a command-line tool (`bugpilot`), an MCP server (`bugpilot-mcp`) and a VS Code extension, which all share the same core.

## Key features

- **Two ways in.** A Jira issue key (`JR-12345`) or a plain description of the bug. Jira is optional.
- **Focused context.** Code search with ranked files and matched lines, related git history, similar past fixes from shared memory, and the issue's own details, collected into `.ai/<issue>/context.md`.
- **One task for the agent.** `task.md` carries BugPilot's safety rules, what the repository is, your team's and your own instructions, the verification the project expects, the branch rules and the AI Fix Mode for this attempt.
- **Repository-neutral.** Nothing is assumed about languages or frameworks: a Repository Profile describes the repository, auto-detected from its build files or written by you.
- **Safe by default.** Preparing never launches an agent, never deletes your earlier artifacts, never commits, pushes or merges, and never edits a protected branch.
- **Results you can check.** The agent writes `fix_report.md`; reviews and verification evidence are recorded separately, in your words, and nothing is called verified that was not.

## Requirements

- Python 3.10 or later.
- Git.
- [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`) on `PATH` for code search.
- Optional: a Jira Cloud site with an API token, to work from Jira issues.
- Optional: an AI coding agent — Claude Code, Codex CLI, GitHub Copilot CLI or any other — to hand the task to.
- Platforms: BugPilot is developed and release-tested on Windows 11. The CLI is plain Python and has no dependencies, but macOS and Linux are not part of its release testing yet.

## Installation

Install BugPilot with pipx:

```powershell
pipx install bugpilot
```

Or with pip:

```powershell
python -m pip install bugpilot
```

Verify:

```powershell
bugpilot --version
```

Expected:

```text
bugpilot 0.1.4
```

The MCP server needs the optional MCP SDK: `pipx install "bugpilot[mcp]"`, or `python -m pip install "bugpilot[mcp]"`.

**Development installation.** To run BugPilot from a checkout of this repository instead:

```powershell
git clone https://github.com/xsw7910/bugpilot.git
cd bugpilot
pipx install .              # or: python -m pip install .
```

Add the MCP server with `pipx install ".[mcp]"`. Working on BugPilot itself (editable install, tests, a standalone executable) is in [Development](#development).

## First run

Run BugPilot from the root of the repository you want to fix — it writes its files there:

```powershell
cd path\to\your-repo
bugpilot doctor                                   # Python, git, ripgrep, Jira, agents
bugpilot bug --description "Saving a record with no selection crashes"
```

That prepares `.ai/<work item>/` and prints the line to hand to your agent:

```text
Read .ai/<work item>/task.md and complete the workflow.
```

Add BugPilot's two folders to the repository's `.gitignore` before the first run — they hold generated files and fetched issue text:

```gitignore
.ai/
.ai_memory/
```

`bugpilot doctor` reports whether git ignores them (`ai_artifacts_ignored`).

## Manual issue workflow

A bug you describe is a first-class input; it needs no Jira at all.

```powershell
bugpilot bug --description "Exporting with an empty filter writes an empty file" --title "Empty export"
bugpilot bug --description-file bug.md --hint "Start in the export dialog's filter handling"
bugpilot bug --description "..." --attach .\crash.log --attach .\screenshot.png
```

- `--hint` points the agent at where you think the fix belongs; it is guidance, checked against the evidence.
- `--attach` copies files into `.ai/<work item>/attachments/` and names them in the task.
- Each hand-written bug gets its own `local_<timestamp>` work item.

## Jira setup

```powershell
bugpilot setup                          # asks for the site, your email and an API token, and checks them
bugpilot bug JR-12345                   # prepare from a real Jira issue
```

- The site is `https://your-company.atlassian.net`-style: `https://` only, with no user name, password, query or fragment. Redirects are followed only within the same site. There is no option to allow plain `http://`.
- Where BugPilot reads the site, email and token: the environment first (`JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_TOKEN`), then `~/.bugpilot/config.toml` (written by `bugpilot setup`; `bugpilot jira-site set` changes only the site). The VS Code extension's Jira Setup writes the site to the same file and keeps the email and token in VS Code's secret storage.
- Real Jira is required by default. `--allow-mock` allows clearly marked demo data for trying BugPilot without a Jira site.
- BugPilot reads Jira. It writes to Jira only when you ask it to post one comment (see [Notifications](#notifications)); it never transitions, assigns or edits fields.

## Repository Profile

`task.md` describes the repository in a **Repository Context** section, from its profile:

- **Auto-detect** (default): high-confidence facts from the repository's own build and package files (`CMakeLists.txt`, `pyproject.toml`, `package.json`, `Cargo.toml`, `go.mod`, `pom.xml`, Gradle, `*.sln`, …) and its guidance files (`AGENTS.md`, `CONTRIBUTING.md`, …). Source files are never scanned and nothing is guessed.
- **Generic**: no language, framework or tooling assumption.
- **Custom**: details you write — languages, frameworks, application type, build system, test framework, codebase notes.

The profile is saved in `.bugpilot/repository_profile.json` in the repository (commit it to share it). No file means Auto-detect.

```powershell
bugpilot repository-profile                        # what is configured, and what Auto-detect finds
bugpilot repository-profile set --mode generic
```

## User / Project Instructions

Two optional Markdown files add your own guidance to every `task.md`:

- **Project / Team Instructions** — `<repo>/.bugpilot/instructions.md` — the repository's rules, meant to be committed and shared: "Maintain Windows and Linux compatibility.", "Run module tests with `make check`."
- **User Instructions** — `~/.bugpilot/instructions.md` — your own preferences, for every repository: "Prefer small focused changes."

Each is at most 20,000 characters; a file that cannot be used (a link, not UTF-8, too long) is left out with a warning, never cut short. Saving empty text removes the file. Their text is never written to a log.

```powershell
bugpilot instructions                                          # both, and what they say
bugpilot instructions set --scope project --from-file team.md
bugpilot instructions set --scope user --clear
```

**Precedence.** `task.md` lists its layers in this order, and the earlier one wins a conflict:

1. BugPilot safety rules
2. Repository context
3. Project / team instructions (with the project's Verification Policy and AI Behavior additions)
4. User instructions
5. AI Fix Mode
6. Developer hint

So a team's "do not add new dependencies" beats one developer's "prefer library X". The safety rules are written into `task.md` unchanged and before every editable layer, and no instruction file can delete or replace them; the task tells the agent to resolve a conflict in the safety rule's favour — "commit directly to main", say — and to record it in its review notes. That is an instruction to the agent, not a sandbox: review what the agent did before you commit it.

**Protected rules.** The rules every `task.md` states word for word — grouped as Safety, Evidence Integrity, Git / Editing, Delivery, Jira and Secrets / Artifacts, each with a stable id — are built into BugPilot and read-only: there is no file to edit them, and no instruction file, Verification Policy, AI Behavior or Fix Mode replaces them in the task. To see them, and the precedence above:

```powershell
bugpilot protected-rules show          # the rules by group, what BugPilot does with them, and the precedence
bugpilot protected-rules show --json   # the same for tools: rules_version, groups, rules (id, group, section, title, text), precedence
```

**Effective AI task.** `bugpilot task-preview` shows the `task.md` BugPilot would hand an agent now, written by the same code a run uses and saved nowhere. Given a prepared work item it is that work item's task with every policy read again, and it says whether the prepared `task.md` still says the same and which sections differ. Without one it is a template — `Template preview — no work item selected` — in which placeholders such as `<work-item-id>` stand for what only a work item has; everything else is your repository's and your own configuration. It creates no file, contacts no Jira and runs no Git command.

```powershell
bugpilot task-preview                                        # the template: Standard Fix, branch policy current, no Jira comment
bugpilot task-preview --fix-mode investigate-first --jira-comment   # the template with other run settings (bug's own flags)
bugpilot task-preview JR-12345 --json                        # a prepared work item's task: text, sections (protected or not), sources, prepared state
```

**Effective context.** `bugpilot context-preview JR-12345` shows the context BugPilot last generated for a work item — the `context.md` its agent was handed — and whether it is still current. It never builds a new one: only retrieval can. A stale context is still shown, under *Context status: Needs rebuild* and what changed since it was generated (the instructions, the Verification Policy, AI Behavior, the Repository Profile, the Fix Mode, branch naming, or a missing or unreadable prepared file). It does not see the retrieval settings you have changed in the panel since — the panel compares those — or the issue in Jira since it was fetched, and says so. Without a work item, or before its context is built: *No generated context available. Build context first.*

```powershell
bugpilot context-preview JR-12345          # the status, what changed, quality and confidence, then the context
bugpilot context-preview JR-12345 --json   # state, text, freshness (reasons, unchecked), task, quality, retrieval, sources, problems
```

## Verification Policy and branch naming

**Verification Policy** — what checking the project expects from a fix. `task.md` states it in one `## Verification Policy` section and names where it came from. It comes from one of three places, the first that exists:

1. `.bugpilot/verification.md` (`verification-file`) — the repository's own text, which **replaces** BugPilot's default; nothing is appended to it. Commit it to share it.
2. The four Verification switches in `.bugpilot/project_settings.json` (`legacy-project-settings`), as 0.1.2 saved them: run relevant tests (on), run existing static checks (on), run the full test suite (off), report what was not run (on).
3. BugPilot's default (`bugpilot-default`): those four switches at their defaults.

The last two also ask the agent to describe its manual validation when automated tests are unavailable, and to report the regression risk and the commands it attempted (in 0.1.2 these were BugPilot rules; they are the policy's now, so a repository's own text can replace them). Reading never creates the file; the first `bugpilot verification set` does, and from then on it is the policy. How a given attempt verifies stays the Fix Mode's, and whatever the policy says, the agent must never claim a test or check ran unless it did — that rule is BugPilot's, not the policy's.

`verification.md` starts with front matter that BugPilot writes for you:

```markdown
---
schema_version: 1
based_on_version: 1
mode: replace
---
Run the tests next to the changed module (for example `tests/test_format_a.py`).
Run the static checks the repository already has. Do not run the full suite.
Report which checks you did not run, and why.
```

A file that cannot be used — no or malformed front matter, an unknown key, an empty body, more than 20,000 characters, not UTF-8, or a link or junction — is never reinterpreted: BugPilot uses its default instead and says why, in the CLI output and in run warnings. A line that looks like it asks for something a safety rule forbids (force push, committing or pushing without approval, staging `.ai/`, ignoring the safety rules, reporting tests that did not run, hiding failures) gets a non-blocking warning; the policy is kept as written, and the warning is a hint, not a complete check.

```powershell
bugpilot verification show                       # the effective policy and where it comes from (--json: source, file state, lint, problems)
bugpilot verification set --from-file policy.md  # a policy body (front matter is added) or a whole document; also --stdin
bugpilot verification reset                      # remove .bugpilot/verification.md (clear is the same); the switches or the default apply again
```

In the VS Code extension the policy is a row in **Advanced Settings › Guidance & Verification**: it shows the source in force (*BugPilot default*, *Legacy project settings* or *Repository verification.md*), and **Edit** opens `verification.md` in an editor tab — the CLI creates it first, from the policy in force, if it is not there — **Reset** removes it after asking, and **Preview** shows the policy read-only. Problems and warnings are shown on the row, and a policy that changed since the context was prepared shows **Needs rebuild**. The extension's four Verification switches are gone; see [extension/README.md](https://github.com/xsw7910/bugpilot/blob/main/extension/README.md).

**Branch naming** — the name a new branch gets when the branch policy calls for one: `feature/{issue}-{slug}` by default, or a template such as `bugfix/{issue}-{slug}`, saved in `.bugpilot/project_settings.json`. Only `{issue}` and `{slug}` are substituted; `{issue}` is required, so two issues never share a branch, and a template that could make an unsafe ref is refused. It never creates or switches a branch, and a work item keeps the branch it already has.

```powershell
bugpilot project-settings                                   # current values, or the defaults, and the verification source
bugpilot project-settings set --from-file settings.json     # {"verification": {...}, "branch_naming": {"template": "bugfix/{issue}-{slug}"}}
```

**Mixed versions.** 0.1.2 and earlier never read `verification.md`. A 0.1.2 client can still save the four switches with `project-settings set`; they are accepted and kept (the 0.1.3 extension shows no switches and writes back the saved values unchanged), but while `verification.md` exists it decides, and `project-settings` says so (`verification_source: verification-file`, plus a warning on `set`). A 0.1.3 extension that finds `verification.md` next to a CLI whose `bugpilot doctor --json` has no `verification-text` capability reports the CLI as out of date rather than preparing a task without the repository's policy.

## AI Behavior

**AI Behavior** — how the agent is expected to make and report changes in this repository: conventions and minimum expectations, not safety rules. `task.md` states it in one `## AI Behavior` section. BugPilot's defaults (small, targeted fixes; follow the surrounding code; no unrelated refactoring, public API renames or behaviour changes outside the issue) always apply, and `.bugpilot/ai_behavior.md` **adds** the repository's own beneath them — it never replaces them. The selected Fix Mode decides how one attempt works within these conventions; what to verify stays the Verification Policy's.

```markdown
---
schema_version: 1
based_on_version: 1
mode: append
---

## Code Change Conventions
- Keep the export module's public functions backward compatible.

## Evidence Standards
- Quote the log line or stack frame that shows the failure.

## Reporting Standards
- Name the export formats the change affects in the report's Summary.
```

Without the file there is nothing to configure and nothing is warned about; reading never creates it. A file whose sections are all empty — just its headings — adds nothing either, so the task is the same as without it. A file that cannot be used — no or malformed front matter, a mode other than `append`, an empty body, more than 20,000 characters, not UTF-8, or a link or junction — is left out whole: BugPilot's defaults apply, and the CLI output and run warnings say why. The additions sit in the project / team layer of the precedence, below BugPilot's rules, which the task states first and unchanged. Non-blocking warnings point at lines that look like they ask for something a safety rule forbids, headings named like a Fix Mode section, and lines about running tests or checks (those belong in the Verification Policy); the text is kept as written.

```powershell
bugpilot ai-behavior show                          # the effective AI Behavior and where it comes from (--json: source, file state, versions, lint, problems)
bugpilot ai-behavior set --from-file behavior.md   # additions (front matter is added) or a whole document; also --stdin
bugpilot ai-behavior reset                         # remove .bugpilot/ai_behavior.md (clear is the same); BugPilot's defaults apply alone
```

In the VS Code extension it is a row in **Advanced Settings › AI Behavior & Rules**: **Edit** opens `.bugpilot/ai_behavior.md` in an editor tab (the CLI creates it first with its three sections, empty), **Reset** removes it after asking, and **Preview** shows the AI Behavior in force. The panel reads it to tell when a prepared context needs a rebuild; a 0.1.4 extension that finds `ai_behavior.md` next to a CLI whose `bugpilot doctor --json` has no `ai-behavior-text` capability reports the CLI as out of date. The same section lists the protected rules (read-only), and **Advanced Settings › Effective Output** — or **⋯ More** — shows the Effective AI Task and the Effective Context from `task-preview` and `context-preview`.

## Fix Modes

A Fix Mode decides *how* the agent approaches a bug — how far to investigate, how to implement, how to verify, what to report. It never decides what the agent may do.

- **Standard Fix** (`standard`) is the default. The other built-ins are **Conservative Fix**, **Investigate First** (no source changes in that pass), **Test-Driven Fix** and **Deep Analysis**.
- Choose one with `--fix-mode <id>`; the choice is recorded with the work item and reused when it is prepared again.
- Custom modes are JSON files: yours in `~/.bugpilot/fix_modes/`, the project's in `<repo>/.bugpilot/fix_modes/`. Start from `bugpilot fix-mode duplicate <builtin> <new-id> --scope user|project`.

## Branch Policy

BugPilot never creates or switches branches itself; `task.md` tells the agent which branch to work on, by the policy you choose with `--branch-policy`:

- **`current`** (default): work on the checked-out branch. Only on `main`/`master` or a detached HEAD does the agent stop and ask to create a branch.
- **`per-issue`**: one branch for the work item, created once and reused.
- **`ask`**: the agent asks before editing which branch to use.

Preparing a work item again — a rebuild, a resume, a retry — never calls for a new branch. Under every policy `main` and `master` are never edited, committed to or pushed.

## Security and safety

- **Nothing runs by default.** `bugpilot bug` prepares and stops. An agent is launched only with `--launch-agent claude|copilot`.
- **No delivery.** BugPilot never runs `git add`, `git commit`, `git push`, merges or opens pull requests. The agent asks before committing, and never pushes `main`/`master` or force-pushes.
- **Nothing deleted unless asked.** Only `--fresh` and `clean` delete, only BugPilot's own `.ai/<issue>/`, and never through a symbolic link or junction. Every write under `.ai/` and `.ai_memory/` refuses links the same way.
- **No programs from your repository.** `git`, `rg` and agent CLIs are found on `PATH`'s absolute entries only, never in the current folder.
- **Jira credentials stay out of artifacts.** Tokens are never written to generated files, logs or command lines.
- **AI review is read-only.** The VS Code extension's captured review runs without a shell or editing tools; BugPilot gives it the diff itself.
- **Editable text cannot pose as BugPilot's own sections.** Headings in User and Project Instructions, the Verification Policy, AI Behavior, a Fix Mode's sections and the developer hint are held below the task's own, an open code fence is closed where the layer ends, and a Fix Mode's name stays on one line, so none of them can add a second `## BugPilot Safety Rules` or `## BugPilot Rule Precedence`.
- **Terminal output is shown, not obeyed.** In text mode, control characters from an issue, a hint or a policy — ESC sequences, a carriage return or backspace that overprints a line, bidirectional overrides — are printed escaped (`\x1b`). The files themselves and `--json` output stay exactly as written.

More in [docs/safety.md](https://github.com/xsw7910/bugpilot/blob/main/docs/safety.md).

## Privacy

- Generated artifacts (`.ai/`) and shared memory (`.ai_memory/`) contain repository context: code excerpts, file paths, git history and fetched issue text. AI prompts built from them carry the same. Keep both folders out of source control unless you mean to share them.
- Project / Team Instructions and project settings in `.bugpilot/` are meant to be committed and shared. User Instructions in `~/.bugpilot/` are personal.
- Jira credentials are never written to generated artifacts.

## CLI usage

```powershell
bugpilot bug JR-12345                       # prepare from Jira (keeps existing artifacts, launches nothing)
bugpilot bug JR-12345 --fresh               # delete .ai/JR-12345/ first, then prepare
bugpilot bug JR-12345 --fix-mode conservative --branch-policy per-issue
bugpilot status JR-12345                    # where a work item stands
bugpilot check-results JR-12345             # has the agent written fix_report.md?
bugpilot summarize-results JR-12345         # the report's status and a validation checklist
bugpilot review-package JR-12345            # a review prompt for any reviewer
bugpilot record-review JR-12345 --summary "..."
bugpilot retry-prompt JR-12345              # a second attempt, from your feedback
bugpilot clean JR-12345                     # remove .ai/JR-12345/ (memory is kept)
```

Add `--json` (queries) or `--json-lines` (`bug`) for machine-readable output. `bugpilot --help` and `bugpilot <command> --help` list every command and option.

## Notifications

When a fix is ready BugPilot can tell people, if you ask: one Jira comment (`bugpilot jira-comment <ISSUE> --execute`, or `summarize-results` with `BUGPILOT_AUTO_JIRA_COMMENT=true`), or an email at the commit gate over Microsoft Graph or SMTP. Both are opt-in and preview by default. See [docs/notifications.md](https://github.com/xsw7910/bugpilot/blob/main/docs/notifications.md).

## VS Code extension

The extension puts the whole workflow in a panel: the issue or a description, the steps and their results, Fix with AI, review and verification, and Advanced Settings for everything above. It uses the same `bugpilot` CLI. See [extension/README.md](https://github.com/xsw7910/bugpilot/blob/main/extension/README.md).

## MCP server and Claude Code skill

`bugpilot-mcp` lets an agent drive BugPilot itself by calling tools ([docs/mcp_setup.md](https://github.com/xsw7910/bugpilot/blob/main/docs/mcp_setup.md)). A Claude Code skill in `skills/bugpilot-investigate/` tells Claude Code when to run the CLI ([docs/skill_setup.md](https://github.com/xsw7910/bugpilot/blob/main/docs/skill_setup.md)).

## Development

Contributor setup — editable install, the Python and extension test suites, building the wheel, a standalone executable or the Windows installer — is in [docs/development.md](https://github.com/xsw7910/bugpilot/blob/main/docs/development.md). The architecture is described in [docs/architecture.md](https://github.com/xsw7910/bugpilot/blob/main/docs/architecture.md).

External code contributions are not currently accepted. Bug reports and feature requests are welcome through [GitHub Issues](https://github.com/xsw7910/bugpilot/issues).

## Licence

BugPilot is source-available, not open source, under the Business Source License 1.1. The command-line tool, the `bugpilot-mcp` server, the Claude Code skill, the scripts, the installer tooling and the documentation in this repository are licensed as BugPilot CLI and Tools ([LICENSE](https://github.com/xsw7910/bugpilot/blob/main/LICENSE)); the VS Code extension has its own licence file, [extension/LICENSE.txt](https://github.com/xsw7910/bugpilot/blob/main/extension/LICENSE.txt), with the same terms and itself as the Licensed Work.

The licence lets you copy, modify, redistribute and make non-production use of BugPilot. Its Additional Use Grant adds production use for the internal purposes of you or your organization, including commercial software development and use while providing software development services to clients. Offering BugPilot, or a substantially similar product or service based on it, to third parties as a hosted, managed, embedded, redistributed or otherwise competing offering is not part of that grant and needs a separate commercial licence; for one, contact the Licensor through the [BugPilot GitHub repository](https://github.com/xsw7910/bugpilot). Each version becomes available under the Apache License 2.0 on its Change Date, or on the fourth anniversary of that version's first public release if that comes first. This is a summary; the licence files are authoritative.

Third-party components keep their own licences: the extension's codicons icon font and its `bug` icon (the activity bar icon, also drawn on the Marketplace icon) are CC BY 4.0 ([extension/THIRD_PARTY_NOTICES.md](https://github.com/xsw7910/bugpilot/blob/main/extension/THIRD_PARTY_NOTICES.md)).
