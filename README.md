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

## Installation

**Public installation (available after PyPI publication).** BugPilot is not on PyPI yet. Once it is published:

```powershell
pipx install bugpilot
```

**Local installation (today).** From a checkout of this repository:

```powershell
git clone https://github.com/xsw7910/bugpilot.git
cd bugpilot
pipx install .              # or: python -m pip install .
bugpilot --version          # bugpilot 0.1.0
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
3. Project / team instructions (with the project's Verification Policy)
4. User instructions
5. AI Fix Mode
6. Developer hint

So a team's "do not add new dependencies" beats one developer's "prefer library X". No instruction can loosen a safety rule: the task tells the agent to ignore one that tries — "commit directly to main", say — and to record the conflict.

## Verification Policy and branch naming

Two project settings, saved in `.bugpilot/project_settings.json` (commit it to share it):

- **Verification Policy** — what level of checking the project expects from a fix: run relevant tests (on), run existing static checks (on), run the full test suite (off), report what was not run (on). `task.md` states it in four lines; it names no commands — your project instructions can. How an attempt verifies stays the Fix Mode's.
- **Branch naming** — the name a new branch gets when the branch policy calls for one: `feature/{issue}-{slug}` by default, or a template such as `bugfix/{issue}-{slug}`. Only `{issue}` and `{slug}` are substituted; `{issue}` is required, so two issues never share a branch, and a template that could make an unsafe ref is refused. It never creates or switches a branch, and a work item keeps the branch it already has.

```powershell
bugpilot project-settings                                   # current values, or the defaults
bugpilot project-settings set --from-file settings.json     # {"verification": {...}, "branch_naming": {"template": "bugfix/{issue}-{slug}"}}
```

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

## Licence

BugPilot — the `bugpilot` Python package (the CLI and the MCP server) and the VS Code extension — is licensed under the Business Source License 1.1 ([LICENSE](https://github.com/xsw7910/bugpilot/blob/main/LICENSE)). It is source-available, not open source: you may copy, modify, redistribute and make non-production use of it, and the Additional Use Grant permits production use, including inside a company, provided you do not offer it to third parties on a hosted or embedded basis in competition with the Licensor's paid versions. Each version converts to the Apache License 2.0 on the Change Date, 2030-09-08, or on the fourth anniversary of that version's first public release if that comes first. This is a summary; the licence text is what applies.

The extension ships the same text as [extension/LICENSE.txt](https://github.com/xsw7910/bugpilot/blob/main/extension/LICENSE.txt). Third-party components keep their own licences: the extension's codicons icon font is CC BY 4.0 ([extension/THIRD_PARTY_NOTICES.md](https://github.com/xsw7910/bugpilot/blob/main/extension/THIRD_PARTY_NOTICES.md)).
