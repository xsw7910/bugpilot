# bugpilot

## What It Is
bugpilot is a prototype CLI for an AI-assisted Jira bug workflow. It works with any coding agent (Claude by default, GitHub Copilot CLI optional via `--copilot`). It builds a deterministic development package from a Jira issue, local code search, shared memory, and git context so a developer can hand the agent a clearer task.

## Why It Exists
AI-assisted bug work often starts with scattered context and ends with useful investigation notes disappearing into chat history. bugpilot is intended to make that work repeatable.

- AI usage is currently scattered across tools and conversations.
- Developers manually copy Jira context into AI tools.
- Useful AI investigation is lost after the fix is done.
- Similar bugs are repeatedly analyzed from scratch.
- Legacy C++/Qt repositories need better context before AI tools can help safely.

## How It Works
```text
Jira issue -> code search -> memory search -> bug_context.md -> agent task -> result summary -> memory update -> delivery plan
```

bugpilot prepares files under `.ai/<issue>/` and shared memory under `.ai_memory/bugs/<issue>.md`. Jira Cloud ADF descriptions and comments are converted into readable Markdown for the issue package, and Jira attachment metadata is surfaced without downloading attachment content. Code search includes a confidence assessment so low-confidence false positives are visible before the agent edits anything. The AI agent remains a manual handoff step, with reusable team instructions for legacy C++/Qt work.

## Installation

```powershell
pipx install bugpilot        # or: python -m pip install bugpilot
bugpilot setup               # asks where your Jira lives, then your credentials
```

There is no built-in Jira site. `bugpilot setup` asks for yours and saves it
next to your email; `JIRA_BASE_URL` overrides it.

**Developers (working on bugpilot itself):** editable install, so source edits are live.
```powershell
python -m pip install -e .
```

**End users (recommended):** install Python 3.10+ (e.g. `winget install -e --id
Python.Python.3.12 --scope user`, no admin), then run the installer. The
distribution package is:

```text
BugPilot/
  install.cmd            <- double-click this
  installer/
    install.ps1
    bugpilot-<version>-py3-none-any.whl
```

`install.cmd` runs `installer\install.ps1`, which installs bugpilot via pipx (and
can install Python via winget if it's missing), then offers to run `bugpilot setup`.
**Alternative — no Python:** use the standalone `bugpilot.exe` (see **Building &
Distributing the Standalone Executable** below).

## Building & Distributing the Standalone Executable
Package the CLI into one self-contained `bugpilot.exe` (it embeds a Python runtime, so
the target machine needs no Python, pipx, or PATH setup). This is the recommended way to
hand bugpilot to teammates — especially when their only Python is a toolchain one
(e.g. vcpkg), which an editable/pipx install would fragilely depend on.

Build from the repo root, with any Python 3.10+ that has pip:
```powershell
python -m pip install --user pyinstaller
python -m PyInstaller --onefile --name bugpilot --collect-submodules bugpilot --paths . pyi_entry.py
```
Output: `dist\bugpilot.exe` (~9 MB). `pyi_entry.py` is the packaging entry point (a
top-level absolute-import shim, because `bugpilot/__main__.py` uses a package-relative
import that PyInstaller can't use directly). Build artifacts (`dist/`, `build/`, `*.spec`,
`*.whl`) are gitignored.

Distribute: give teammates the single `dist\bugpilot.exe`. They save it (e.g.
`C:\tools\bugpilot\`), optionally add that folder to PATH, then:
```powershell
bugpilot setup        # one-time: Jira email + API token -> %USERPROFILE%\.bugpilot\config.toml
bugpilot JR-12345     # prepare, then launch the agent
```
The first run may trip SmartScreen ("Windows protected your PC") because the exe is
unsigned — choose **More info -> Run anyway**.

Note: the packaged exe can't read `docs/agent_team_instructions.md` from the repo, so it
uses the built-in fallback team instructions (same content).

## Jira Configuration
For real Jira fetches, set:

```powershell
$env:JIRA_BASE_URL="https://your-company.atlassian.net"
$env:JIRA_EMAIL="you@example.com"
$env:JIRA_TOKEN="your_jira_api_token"
```

The normal workflow uses real Jira only and does not fall back to mock data:

```powershell
bugpilot bug JR-12345
```

Equivalent explicit form:

```powershell
bugpilot bug JR-12345 --fresh --no-mock
```

Demo/testing fallback must be requested explicitly:

```powershell
bugpilot bug JR-12345 --allow-mock
```

When mock fallback is used, `jira_summary.md`, `jira.json`, and `execution.log` clearly mark the data as mock/demo fallback.

## Email Notification Configuration
At the commit gate (`bugpilot commit-plan <ISSUE>`), bugpilot can email you a summary of
the completed fix: the Jira item, the original problem, the root cause, and the changes
made. The email body is assembled from local `result_summary.md` and `jira_summary.md`;
run `bugpilot summarize-results <ISSUE>` first so those artifacts exist.

bugpilot supports two automatic transports plus a manual Outlook option. It picks
**Graph if configured, otherwise SMTP**. `bugpilot doctor` shows `email_configured`
(SMTP) and `email_graph_configured` (Graph).

### Option 1 — Microsoft Graph (recommended for Microsoft 365)
Use this when your tenant disables SMTP client authentication (error `SmtpClientAuthentication
is disabled for the Tenant`) or blocks outbound port 25 — Graph sends over HTTPS/443.
It requires a one-time **app registration** by an admin (see below), then:

```powershell
$env:GRAPH_TENANT_ID="<tenant id / directory id>"
$env:GRAPH_CLIENT_ID="<application (client) id>"
$env:GRAPH_CLIENT_SECRET="..."        # store in a secrets manager, not in scripts
$env:BUGPILOT_EMAIL_FROM="you@your-company.com"   # mailbox the app may send as
$env:BUGPILOT_EMAIL_TO="you@your-company.com"     # comma/semicolon separated for multiple
```

**What to ask IT for (app registration):**
- An Entra ID (Azure AD) app registration; give you the **Directory (tenant) ID** and **Application (client) ID**.
- A **client secret** on that app.
- The **application** permission **`Mail.Send`** (Microsoft Graph), with **admin consent granted**.
- Ideally scope it with an *Application Access Policy* so the app can only send as your mailbox.

### Option 2 — SMTP
Configure SMTP through the environment (credentials are never hardcoded or persisted):

```powershell
$env:SMTP_HOST="smtp.your-company.com"
$env:SMTP_PORT="587"              # optional, default 587
$env:SMTP_USERNAME="relay-user"   # optional; omit for an open internal relay
$env:SMTP_PASSWORD="..."          # store in a secrets manager, not in scripts
$env:SMTP_USE_STARTTLS="true"     # optional, default true
$env:SMTP_USE_SSL="false"         # optional, default false (set true for SMTPS/465)
$env:BUGPILOT_EMAIL_FROM="bugpilot@your-company.com"
$env:BUGPILOT_EMAIL_TO="you@your-company.com"   # comma/semicolon separated for multiple
```

For a guided setup that stores the password in the PowerShell SecretStore (never in
plain text) and loads every variable into your session, edit the values at the top of
`scripts/setup-email.ps1` once and run it:

```powershell
.\scripts\setup-email.ps1            # load config into the current session
.\scripts\setup-email.ps1 -Persist   # also apply to all future PowerShell sessions
.\scripts\setup-email.ps1 -ResetPassword   # re-enter the stored SMTP password
```

### Option 3 — Manual send via Outlook (no transport config)
When no automatic transport is available, `bugpilot notify` still writes a portable
`.ai/<ISSUE>/notification.eml`. To open it as a pre-filled Outlook compose window
(Outlook sends over its own modern-auth channel, so no SMTP/port-25 needed):

```powershell
bugpilot notify JR-12345                       # writes email_draft.md + notification.eml
.\scripts\send-via-outlook.ps1 JR-12345      # opens Outlook; review and click Send
```

### Sending
Sending is opt-in and human-controlled, matching the rest of the workflow:

```powershell
bugpilot notify JR-12345             # preview only: writes email_draft.md + notification.eml, sends nothing
bugpilot notify JR-12345 --execute   # send automatically (Graph if configured, else SMTP)
bugpilot commit-plan JR-12345        # generate commit plan AND send the notification email
bugpilot commit-plan JR-12345 --no-email   # generate commit plan without sending email
```

If no transport is configured, `commit-plan` still succeeds and simply reports that no
email was sent (use Option 3 to send manually). The email body is sanitized to redact
secret-like values before sending, and no secret (SMTP password or Graph client secret)
is ever logged or included in error messages.

## Notify via Jira Comment (no email server needed)
If your tenant blocks SMTP and app registration for Graph is not available, the simplest
way to be notified when a fix is ready is a **Jira comment**: bugpilot posts the analysis
summary to the issue, and Jira emails the issue's watchers/assignee/reporter through its
own notification system. This reuses your existing Jira credentials
(`JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_TOKEN`) — no mail server, no Graph, no IT ticket.

Opt in so the comment is posted automatically as soon as the fix results are summarized
(before you decide whether to commit):

```powershell
$env:BUGPILOT_AUTO_JIRA_COMMENT="true"   # enable auto-post from summarize-results
bugpilot summarize-results JR-12345       # summarizes results AND posts one Jira comment
```

Per-run control overrides the environment variable:

```powershell
bugpilot summarize-results JR-12345 --jira-comment      # force post this run
bugpilot summarize-results JR-12345 --no-jira-comment   # never post this run
```

Notes:
- You must be **watching** the issue (or be its assignee/reporter) and have Jira email
  notifications enabled to receive the message; that is a Jira-side setting.
- Auto-post adds exactly one comment; it never edits fields, transitions, or assigns.
- If posting fails (e.g., no access to the issue), `summarize-results` still succeeds and
  prints a warning — post manually later with `bugpilot jira-comment <ISSUE> --execute`.
- The comment body is sanitized to redact secret-like values.

## Optional: Let an Agent Complete the Workflow
By default `bugpilot bug` is prepare-only and prints the manual handoff line. You can
instead have it launch a coding agent to read `agent_task.md` and complete the
workflow (analyze, implement the smallest safe fix, write result files, post one Jira
status comment) — the agent still stops at the commit gate and asks before committing.

```powershell
bugpilot bug JR-12345 --claude     # launch Claude after preparation
bugpilot bug JR-12345 --copilot    # launch Copilot CLI instead
bugpilot bug JR-12345              # no flag: prepare only (default, unchanged)
```

To steer the agent straight to a known fix location (skips broad investigation — much
faster when you already know where the bug is), pass `--hint`:

```powershell
bugpilot bug JR-12345 --claude --hint "Fix in FooWidget.cxx: preserve selection on tab switch"

# Attach files the agent should see: a log, a screenshot, a config.
# Copied into .ai/<id>/attachments/ and named in agent_task.md.
bugpilot bug JR-12345 --attach ./crash.log --attach ./repro.png
```

The hint is saved to `.ai/<ISSUE>/developer_hint.md`, injected as a "Developer Hint" section
at the top of `agent_task.md`, and reused on `--resume`. agent_task.md also tells the
agent to investigate inline (Read/Grep/Glob) and not spawn background sub-agents.

The agent runs interactively in the current (target) repo so you can watch it work.
Configuration:

```powershell
$env:BUGPILOT_CLAUDE_COMMAND="claude"                        # binary to launch
$env:BUGPILOT_CLAUDE_ARGS="--permission-mode acceptEdits"    # default: auto-accept file edits
# For a fully unattended run (also skips shell prompts for git / bugpilot):
$env:BUGPILOT_CLAUDE_ARGS="--dangerously-skip-permissions"   # understand the risk first
```

With the default `acceptEdits`, the agent applies file edits without prompting but may
still ask before shell commands (e.g., running `bugpilot jira-comment --execute` or git).
`--dangerously-skip-permissions` removes those prompts too, at the cost of unattended
execution — use it only when you trust the task and repo.

Treat all agent-generated code as third-party: **review it before you commit**. bugpilot
never commits or pushes for you; the agent stops and asks at the commit gate.
`bugpilot doctor` reports `claude_available` / `copilot_available`.

## Important: Run From Target Repo Root
The bugpilot source repo can be anywhere. Run `bugpilot` from the target product repository root, because generated `.ai` and `.ai_memory` folders are written relative to the current working directory.

The AI agent should also be run from the target product repository root. Do not run the agent handoff from the bugpilot tool source directory unless that is the repository you intend to modify.

Example:
```powershell
cd C:\sandbox\target-repo
bugpilot bug JR-12345
```

**Add both folders to that repository's `.gitignore` before your first run:**

```gitignore
.ai/
.ai_memory/
```

They hold per-run artifacts and fetched Jira content, and `docs/safety.md`
already forbids the agent from committing them — but without these two lines
your own `git status` fills with files you did not write, and Jira issue text
ends up in a shared repository. `bugpilot doctor` reports
`ai_artifacts_ignored`, so this is something you can check rather than
remember. bugpilot does not edit your `.gitignore` itself.

## Quick Demo
```powershell
bugpilot doctor
bugpilot bug JR-12345
bugpilot status JR-12345
bugpilot clean JR-12345
bugpilot bug JR-12345 --resume
bugpilot agent-task JR-12345
bugpilot check-results JR-12345
bugpilot summarize-results JR-12345
bugpilot memory update JR-12345
bugpilot review-package JR-12345
bugpilot jira-comment-draft JR-12345
bugpilot jira-comment JR-12345
bugpilot retry-prompt JR-12345
bugpilot manual-result JR-12345
bugpilot delivery-check JR-12345
bugpilot notify JR-12345
bugpilot commit-plan JR-12345
bugpilot push-plan JR-12345
```

## Main Commands
- `bugpilot doctor`: report environment, git, ripgrep, Jira env vars, and Copilot CLI availability.
- `bugpilot agent-check`: check AI agent and GitHub CLI availability without invoking the agent.
- `bugpilot fetch <ISSUE>`: fetch real Jira data and fail clearly if Jira is unavailable.
- `bugpilot fetch <ISSUE> --allow-mock`: allow clearly marked mock/demo fallback when Jira fetch fails.
- `bugpilot fetch <ISSUE> --no-mock`: require real Jira data. This is the default.
- `bugpilot parse <ISSUE>`: parse Jira data into a markdown summary.
- `bugpilot keywords <ISSUE>`: extract high-value, normal, and dropped keywords.
- `bugpilot search <ISSUE>`: run ripgrep-based code search and related file ranking.
- `bugpilot memory search <ISSUE or query>`: search shared markdown memory.
- `bugpilot memory add <ISSUE>`: create or refresh a shared memory entry.
- `bugpilot memory update <ISSUE>`: update memory with final result information.
- `bugpilot git-context <ISSUE>`: generate branch, status, and recent file history context.
- `bugpilot context <ISSUE>`: generate enriched `bug_context.md`.
- `bugpilot prompt <ISSUE>`: generate agent and review prompt files.
- `bugpilot agent-task <ISSUE>`: regenerate agent task and handoff files from existing context.
- `bugpilot agent-instructions <ISSUE>`: regenerate `.ai/<issue>/agent_team_instructions.md` from the reusable team template.
- `bugpilot check-results <ISSUE>`: check whether agent result files exist.
- `bugpilot check-results <ISSUE> --strict`: return nonzero if required result files are missing.
- `bugpilot summarize-results <ISSUE>`: generate result summary and manual validation files.
- `bugpilot review-package <ISSUE>`: generate final review prompt.
- `bugpilot jira-comment-draft <ISSUE>`: generate a local, reviewable Jira comment draft from existing bugpilot artifacts.
- `bugpilot jira-comment-draft <ISSUE> --strict`: require agent result files before generating the local draft.
- `bugpilot jira-comment <ISSUE>`: preview the local Jira comment draft without posting to Jira.
- `bugpilot jira-comment <ISSUE> --execute`: post exactly one Jira comment from the local draft.
- `bugpilot retry-prompt <ISSUE>`: generate a second-attempt agent prompt from local artifacts and developer feedback.
- `bugpilot manual-result <ISSUE>`: create developer manual-fix result templates without overwriting existing result files.
- `bugpilot manual-result <ISSUE> --overwrite`: replace result files with fresh manual-fix templates.
- `bugpilot delivery-check <ISSUE>`: check readiness for manual delivery.
- `bugpilot notify <ISSUE>`: write the post-fix notification (`email_draft.md` + `notification.eml`); add `--execute` to send automatically (Graph if configured, else SMTP).
- `bugpilot commit-plan <ISSUE>`: generate a manual commit plan and email the fix summary at the commit gate (`--no-email` to skip).
- `bugpilot push-plan <ISSUE>`: generate a manual push plan.
- `bugpilot clean <ISSUE>`: remove generated `.ai/<issue>/` workflow artifacts while preserving memory.
- `bugpilot clean <ISSUE> --include-memory`: also remove `.ai_memory/bugs/<issue>.md` for that issue only.
- `bugpilot status <ISSUE>`: show workflow status and generated files.
- `bugpilot bug <ISSUE>`: run a fresh prepare-only workflow end to end with real Jira required and mock fallback disabled.
- `bugpilot bug <ISSUE> --fresh`: same as the default; kept for compatibility.
- `bugpilot bug <ISSUE> --resume`: preserve existing `.ai/<issue>/` artifacts and continue an existing workflow.
- `bugpilot bug <ISSUE> --include-memory`: clean `.ai/<issue>/` and that issue's memory entry first, then rerun.
- `bugpilot bug <ISSUE> --allow-mock`: explicitly allow mock/demo Jira fallback.
- `bugpilot bug <ISSUE> --no-mock`: require real Jira data and stop if Jira fetch fails. This is the default.
- `bugpilot jira-validate <ISSUE>`: validate Jira field mapping for a real issue (no code search, no agent task). Generates `jira_summary.md`, `jira_parsed.md`, and `jira_field_report.md`.

## Recommended Real Workflow
```powershell
bugpilot doctor
bugpilot jira-validate JR-12345
bugpilot bug JR-12345
bugpilot jira-comment-draft JR-12345
bugpilot jira-comment JR-12345
bugpilot jira-comment JR-12345 --execute
```

Run these from the target product repo root. Real Jira is the default, and mock fallback requires `--allow-mock`. `bugpilot bug <ISSUE>` is fresh by default; use `--resume` only when continuing existing artifacts. `bugpilot jira-comment <ISSUE>` previews without writing Jira, and `--execute` is required for Jira comment write-back.

## Safety Rules
- bugpilot does not automatically modify product source code.
- bugpilot does not automatically invoke an agent CLI.
- bugpilot does not update Jira.
- Jira integration is read-only; bugpilot converts fetched Jira content to Markdown but does not comment, assign, close, or transition Jira issues.
- `jira-comment-draft` writes a local markdown draft only; it does not post comments to Jira.
- `jira-comment` previews by default; `jira-comment --execute` only adds a Jira comment and does not change status, fields, assignee, attachments, source code, git state, or PRs.
- `retry-prompt` and `manual-result` generate local artifacts only; they do not call an agent or Jira.
- Generated agent instructions may ask whether you want the agent to commit and push after completing the workflow, but commit/push is never automatic and requires explicit approval inside your AI agent.
- The agent must not push main/master, force push, commit `.ai/` or `.ai_memory/`, or update Jira.
- bugpilot does not create pull requests.
- bugpilot does not merge.
- bugpilot does not run `git add`, `git commit`, or `git push`.
- `commit-plan` and `push-plan` only generate markdown plans.
- `bugpilot commit` and `bugpilot push` exist only to say so and point at the plan
  commands; `--execute` is accepted and ignored.
- `clean` and `--fresh` remove only generated bugpilot artifacts for the requested issue.
- Memory is preserved by default; `--include-memory` removes only `.ai_memory/bugs/<issue>.md`.

## Generated Artifacts
Primary issue package:
```text
.ai/<issue>/
```

Key search artifacts include:
```text
.ai/<issue>/code_search.md
.ai/<issue>/related_files.json
.ai/<issue>/search_quality.json
.ai/<issue>/agent_team_instructions.md
.ai/<issue>/jira_comment_draft.md
```

Shared memory entry:
```text
.ai_memory/bugs/<issue>.md
```

These folders belong to the target repository where the command is run.

Reusable team instructions live at:
```text
docs/agent_team_instructions.md
```

Each issue package gets a copy so the AI agent can read stable team rules together with the issue-specific task.

## Prototype Status
- Phase 1: prepare-only workflow skeleton.
- Phase 2: code search, memory search, git context, and enriched bug context.
- Phase 3: Agent task and handoff workflow.
- Phase 4: post-agent result summary, review package, and memory update.
- Phase 5: delivery readiness, commit plan, and push plan.

## Three Ways To Use It

One core, three entry points, and a bug described by hand is a first-class
input alongside a Jira issue. See [docs/adapter_design.md](docs/adapter_design.md)
for the design (written in Chinese).

| Entry | For | Start here |
| --- | --- | --- |
| **CLI** | automation, scripting, and anyone who lives in a terminal | `bugpilot bug JR-12345`, or `--description "..."` for a hand-written bug. Add `--json` or `--json-lines` for machine-readable output |
| **MCP server** | letting an agent drive the workflow itself, by calling tools | [docs/mcp_setup.md](docs/mcp_setup.md) |
| **VS Code extension** | preparing a bug without leaving the editor | [extension/README.md](extension/README.md) |

A Claude Code skill ships alongside these: `skills/bugpilot-investigate/`
tells Claude Code when to run the CLI itself, which is the lightest way in if
that is the only agent you use. See [docs/skill_setup.md](docs/skill_setup.md).

Status: the CLI is the original prototype and is in use. The MCP server and the
extension are implemented and tested, but neither has been through its final
real-world check yet — the MCP server has never been driven by a real Claude
Code client, and the extension's interface has not been through manual QA. Both
are tracked in [docs/beta_checklist.md](docs/beta_checklist.md).

## Documentation
- [docs/usage_guide.md](docs/usage_guide.md) — command reference and the
  recommended end-to-end workflow.
- [docs/workflow_overview.md](docs/workflow_overview.md) — stage-by-stage narrative.
- [docs/architecture.md](docs/architecture.md) — layers, orchestrators, module
  reference, and the artifact pipeline.
- [docs/adapter_design.md](docs/adapter_design.md) — design draft for the
  CLI / MCP / VS Code multi-entry architecture (Chinese).
- [docs/mcp_setup.md](docs/mcp_setup.md) — run bugpilot as an MCP server so an
  AI agent can drive the workflow by calling tools (Chinese).
- [extension/README.md](extension/README.md) — the VS Code extension: install,
  first run in five minutes, commands, and what it deliberately will not do.
- [docs/skill_setup.md](docs/skill_setup.md) — install the Claude Code skill,
  and how to compare it against the MCP path (Chinese).
- [docs/beta_checklist.md](docs/beta_checklist.md) — what still has to be
  checked by a human before Internal Beta: the install matrix, a new-machine
  onboarding run, and real MCP client connectivity (Chinese).
- [docs/manual_qa_phase5.md](docs/manual_qa_phase5.md) — the extension's
  interface checklist: four themes, three sidebar widths, keyboard-only
  operation, restart behaviour (Chinese).
- [docs/phases/](docs/phases/) — what each implementation phase actually delivered,
  the contracts downstream phases can rely on, and the pitfalls found along the way
  (Chinese).
- [docs/safety.md](docs/safety.md) — what bugpilot will and will not do.
