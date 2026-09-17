# Usage Guide

Run commands from the **target repository root**. Generated files are written under `.ai/<issue>/` and `.ai_memory/bugs/`.

## Recommended Real Workflow

```powershell
bugpilot doctor                       # check environment (Python, git, ripgrep, Jira, Copilot/Claude, email)
bugpilot jira-validate JR-12345       # confirm Jira fetch + field mapping (real Jira only)
bugpilot bug JR-12345                 # prepare the AI-ready package (prepare-only)
#   … run Copilot/Claude on .ai/JR-12345/agent_task.md, or use `bugpilot bug JR-12345 --claude`
bugpilot check-results JR-12345       # confirm the agent wrote its result files
bugpilot summarize-results JR-12345   # roll results into result_summary.md (+ optional Jira comment)
bugpilot review-package JR-12345      # generate a final review prompt
bugpilot memory update JR-12345       # fold the final result into shared memory
bugpilot delivery-check JR-12345      # is it ready for manual commit/push?
bugpilot commit-plan JR-12345         # generate a manual commit plan (+ optional email at the gate)
bugpilot push-plan JR-12345           # generate a manual push plan
```

Real Jira is the default for `fetch` and `bug`; mock/demo fallback is disabled unless `--allow-mock` is given. `bugpilot bug` runs **fresh** by default; use `--resume` only when you intentionally want to keep existing `.ai/<issue>/` artifacts. Nothing is committed, pushed, or written to Jira automatically — outward actions are explicit and opt-in.

## Running `bugpilot bug` as smaller manual steps

`bugpilot bug <ISSUE>` is a convenience wrapper that runs these steps in order. You can run each one **on its own** to inspect, re-run, or debug a single stage (each writes its own artifact under `.ai/<issue>/`):

| # | Stage | Command | Writes |
|---|-------|---------|--------|
| 1 | Environment check | `bugpilot doctor` | — (prints report) |
| 2 | Fetch Jira | `bugpilot fetch JR-12345` | `jira.json`, `jira_summary.md` |
| 3 | Parse Jira | `bugpilot parse JR-12345` | `jira_parsed.md` |
| 4 | Extract keywords | `bugpilot keywords JR-12345` | `extracted_keywords.json` |
| 5 | Search memory | `bugpilot memory search JR-12345` | `memory_search.md` |
| 6 | Search code | `bugpilot search JR-12345` | `code_search.md`, `related_files.json`, `search_quality.json` |
| 7 | Git context | `bugpilot git-context JR-12345` | `git_context.md` |
| 8 | Build context | `bugpilot context JR-12345` | `bug_context.md` |
| 9 | Generate task package | `bugpilot prompt JR-12345` | `agent_task.md`, `agent_handoff.md`, `agent_team_instructions.md` |
| 10 | Add memory entry | `bugpilot memory add JR-12345` | `.ai_memory/bugs/JR-12345.md` |

Each step reads the artifacts written by the previous one, so run them in order the first time. Notes:

- Steps 3, 4, 6, 8 read `jira.json` / `extracted_keywords.json`, so run `fetch` (and `keywords`) first.
- When you run the full `bugpilot bug`, it also **cleans** old `.ai/<issue>/` artifacts first and **folds** `memory_search.md` and `git_context.md` into `bug_context.md` (then removes those two intermediate files). Running the steps manually keeps them as separate files.
- `bugpilot agent-task <ISSUE>` regenerates just the step-9 task package from an existing `bug_context.md`.

## Command Reference

### Environment & status

#### `bugpilot doctor`
Report Python, git, current directory, git repo status, ripgrep, Jira env vars, Copilot and Claude availability, and email configuration (`email_configured`, `email_graph_configured`).
Generated files: None. Read-only: Yes. Modifies source: No.

#### `bugpilot agent-check`
Report Copilot CLI, GitHub CLI, and Claude availability. Automatic agent invocation is opt-in via `bugpilot bug --claude` / `--copilot`.
Generated files: None. Read-only: Yes. Modifies source: No.

#### `bugpilot status <ISSUE>`
Show workflow status and generated files for an issue (reads `workflow_status.json`).
Generated files: None. Read-only: Yes. Modifies source: No.

### Jira

#### `bugpilot fetch <ISSUE>` · `--allow-mock` · `--no-mock`
Fetch real Jira data. `--no-mock` (default) requires real Jira and fails clearly if unavailable. `--allow-mock` permits a clearly-marked demo fallback.
Generated files: `jira.json`, `jira_summary.md`. Read-only: writes artifacts only. Modifies source: No.
ADF descriptions/comments are converted to Markdown; attachment metadata is listed but content is not downloaded.

#### `bugpilot jira-validate <ISSUE>`
Validate Jira fetch and field mapping without code search or task generation. Requires real Jira credentials; no mock fallback.
Generated files: `jira.json`, `jira_summary.md`, `jira_parsed.md`, `jira_field_report.md`. Read-only: writes artifacts only. Modifies source: No.

#### `bugpilot parse <ISSUE>`
Parse `jira.json` into structured markdown (reproduction steps, actual/expected, environment, errors, stack traces, missing-information checklist).
Generated files: `jira_parsed.md`. Read-only: writes artifacts only. Modifies source: No.

### Analysis

#### `bugpilot keywords <ISSUE>`
Extract high-value / normal / dropped keywords from parsed Jira context.
Generated files: `extracted_keywords.json`. Read-only: writes artifacts only. Modifies source: No.

#### `bugpilot search <ISSUE>`
Run ripgrep-based code search, rank related files, and assess search confidence.
Generated files: `code_search.md`, `related_files.json`, `search_quality.json`. Read-only: writes artifacts only. Modifies source: No.
`search_quality.json` reports `high` / `medium` / `low` confidence with reasons, likely high-confidence files, low-confidence false positives, and noise indicators (CI/build/license/vendor/docs/generated paths).

#### `bugpilot git-context <ISSUE>`
Capture branch, working-tree status, and recent git history for related files.
Generated files: `git_context.md`. Read-only: writes artifacts only. Modifies source: No.

#### `bugpilot context <ISSUE>`
Build the enriched `bug_context.md` from Jira, keywords, code search, memory, and git context.
Generated files: `bug_context.md`. Read-only: writes artifacts only. Modifies source: No.

### Context package & the main workflow

#### `bugpilot prompt <ISSUE>`
Generate the Copilot/Claude task package from `bug_context.md`.
Generated files: `agent_task.md`, `agent_handoff.md`, `agent_team_instructions.md`. Read-only: writes artifacts only. Modifies source: No.

#### `bugpilot agent-task <ISSUE>`
Regenerate the task package from an existing `bug_context.md` (e.g., after editing context or upgrading templates).
Generated files: `agent_task.md`, `agent_handoff.md`, `agent_team_instructions.md`. Read-only: writes artifacts only. Modifies source: No.

#### `bugpilot agent-instructions <ISSUE>`
Generate or refresh the per-issue team-rules file (copies `docs/agent_team_instructions.md`, or a built-in fallback).
Generated files: `agent_team_instructions.md`. Read-only: writes artifacts only. Modifies source: No.

#### `bugpilot bug <ISSUE>`
Run the main end-to-end **prepare-only** workflow (the 10 steps above): fetch/parse Jira, extract keywords, search memory and code, capture git context, build `bug_context.md`, generate the task package, and write the shared memory entry.
Generated files (typical): `execution.log`, `workflow_status.json`, `jira.json`, `jira_summary.md`, `jira_parsed.md`, `extracted_keywords.json`, `code_search.md`, `related_files.json`, `search_quality.json`, `bug_context.md`, `agent_task.md`, `agent_handoff.md`, `agent_team_instructions.md`, and `.ai_memory/bugs/<issue>.md`.
Read-only: writes artifacts only. Modifies source: No.
Defaults: real Jira only, **fresh** run, mock fallback disabled. Old `.ai/<issue>/` artifacts are cleaned first; `.ai_memory/bugs/<issue>.md` is preserved unless `--include-memory`. It does not commit, push, merge, create PRs, update Jira, or invoke an agent unless you ask.

Flags:

- `--allow-mock` — permit a clearly-marked mock/demo Jira fallback when fetch fails.
- `--no-mock` — require real Jira (default). If fetch fails, the workflow stops before parse/keywords/search/etc.
- `--fresh` — clean old `.ai/<issue>/` artifacts before running (default).
- `--resume` — keep existing `.ai/<issue>/` artifacts and continue. Cannot combine with `--fresh` or `--include-memory`.
- `--include-memory` — also remove that issue's `.ai_memory/bugs/<issue>.md` before rerunning (fresh mode only).
- `--hint "TEXT"` — save `developer_hint.md` and inject a **Developer Hint** at the top of `agent_task.md` so the agent goes straight to the known fix location (also reused on `--resume`). Great for a fast, predictable demo.
- `--claude` — after preparation, launch **Claude** in the target repo to complete the workflow (see below).
- `--copilot` — same, but launch **Copilot CLI**.
- `--agent-fix` — print experimental agent invocation guidance after preparation (does not run an agent).

#### `bugpilot bug <ISSUE> --claude` / `--copilot`
After preparing the package, launch that agent **interactively in the target repo** to read `agent_task.md` and complete the workflow (analyze → smallest safe fix → result files → one Jira status comment), stopping at the **commit gate** to ask before committing.
Read-only: bugpilot itself writes only artifacts; the launched agent may edit source — review it as third-party code before committing.
Configure with `BUGPILOT_CLAUDE_COMMAND` / `BUGPILOT_CLAUDE_ARGS` (default `--permission-mode acceptEdits`) or `BUGPILOT_COPILOT_COMMAND` / `BUGPILOT_COPILOT_ARGS`. For a fully unattended run set `BUGPILOT_CLAUDE_ARGS="--dangerously-skip-permissions"` (understand the risk).

### Results & memory

#### `bugpilot check-results <ISSUE>` · `--strict`
Check whether the agent's result files exist (`bug_analysis.md`, `fix_summary.md`, `test_result.md`, `diff_summary.md`, `review_notes.md`). `--strict` exits nonzero if any are missing.
Generated files: None. Read-only: Yes. Modifies source: No.

#### `bugpilot manual-result <ISSUE>` · `--overwrite`
Create developer manual-fix templates for any missing result files (existing files preserved). `--overwrite` replaces them with fresh templates.
Generated files: missing result files under `.ai/<issue>/`. Read-only: writes artifacts only. Modifies source: No.

#### `bugpilot summarize-results <ISSUE>` · `--jira-comment` · `--no-jira-comment`
Roll the agent's result files into a final summary and manual-validation guide.
Generated files: `result_summary.md`, `manual_validation.md`. Read-only: writes artifacts only. Modifies source: No.
With `--jira-comment` (or env `BUGPILOT_AUTO_JIRA_COMMENT` set truthy) it also posts **one** Jira status comment right after summarizing, so Jira notifies watchers by email; `--no-jira-comment` always suppresses it. A Jira/network failure is non-fatal.

#### `bugpilot review-package <ISSUE>`
Generate a final review prompt for a human or an agent.
Generated files: `final_review_prompt.md`. Read-only: writes artifacts only. Modifies source: No.

#### `bugpilot memory search <ISSUE or query>`
Search shared markdown memory by issue keywords or free-text.
Generated files: `memory_search.md` when an issue key is given. Read-only: writes artifacts only for issue searches. Modifies source: No.

#### `bugpilot memory add <ISSUE>`
Create or refresh the shared memory entry for the issue.
Generated files: `.ai_memory/bugs/<issue>.md`. Read-only: writes memory only. Modifies source: No.

#### `bugpilot memory update <ISSUE>`
Fold the final result (from `result_summary.md`) into the shared memory entry.
Generated files: updates `.ai_memory/bugs/<issue>.md`. Read-only: writes memory only. Modifies source: No.

### Notifications (email & Jira)

#### `bugpilot notify <ISSUE>` · `--execute`
Build the post-fix notification (Jira item, original problem, root cause, changes) from local artifacts.
Generated files: `email_draft.md` (preview) and `notification.eml` (portable, openable in Outlook). Read-only: writes artifacts only. Modifies source: No.
Default writes the draft only. `--execute` sends it — via **Microsoft Graph** if configured, otherwise **SMTP**; if neither is configured it reports that nothing was sent. The body is sanitized to redact secret-like values.

#### `bugpilot jira-comment-draft <ISSUE>` · `--strict`
Generate a local, reviewable Jira comment draft from existing artifacts (no Jira call). The draft is intentionally short — **Root Cause** (from `bug_analysis.md`) and a **Summary of Changes** (from `fix_summary.md`) — not the full diff or internal search/validation detail.
Generated files: `jira_comment_draft.md`. Read-only: writes artifacts only. Modifies source: No.
Without `--strict`, a missing section just shows a short "not found" note. `--strict` returns nonzero if any required result file is missing.

#### `bugpilot jira-comment <ISSUE>` · `--execute`
Preview the draft (default, no Jira call), or post exactly **one** Jira comment with `--execute`.
Generated files (execute): `jira_comment_post_result.json`, `jira_comment_post_summary.md`. Read-only: preview yes; execute adds one comment only. Modifies source: No.
`--execute` requires `JIRA_BASE_URL` / `JIRA_EMAIL` / `JIRA_TOKEN`. It does not change fields, transition status, assign, upload/download attachments, call an agent, create PRs, or run git.

#### `bugpilot retry-prompt <ISSUE>`
Generate a focused second-attempt prompt from local artifacts + developer feedback.
Generated files: `agent_retry_prompt.md`; creates `user_feedback.md` if missing. Read-only: writes artifacts only. Modifies source: No.
Edit `user_feedback.md` with what failed, then re-run to include it.

### Delivery (all read-only / plans)

#### `bugpilot delivery-check <ISSUE>`
Check whether the package looks ready for manual delivery (branch not main/master, result files present, etc.).
Generated files: updates status/log when present. Read-only: writes status/log only. Modifies source: No.

#### `bugpilot commit-plan <ISSUE>` · `--no-email`
Generate a manual commit plan using read-only git commands. At this commit gate it also **sends the notification email** when a transport (Graph/SMTP) is configured; `--no-email` skips sending. If no transport is configured, it still succeeds and reports that no email was sent.
Generated files: `commit_plan.md`. Read-only: writes artifacts only. Modifies source: No.

#### `bugpilot push-plan <ISSUE>`
Generate a manual push plan using read-only git commands.
Generated files: `push_plan.md`. Read-only: writes artifacts only. Modifies source: No.

#### `bugpilot commit <ISSUE> --execute` · `bugpilot push <ISSUE> --execute`
Disabled prototype placeholders. They do **not** run real git. Use `commit-plan` / `push-plan`, review, then run git manually.
Generated files: None. Read-only: Yes. Modifies source: No.

### Cleanup

#### `bugpilot clean <ISSUE>` · `--include-memory`
Remove generated `.ai/<issue>/` artifacts. Memory is preserved by default; `--include-memory` also deletes `.ai_memory/bugs/<issue>.md`. Never touches product source, Jira, or git.
Generated files: None. Read-only: deletes generated artifacts only. Modifies source: No.

## Environment variables

### Jira (required for real fetch and Jira comments)
```powershell
$env:JIRA_BASE_URL="https://your-company.atlassian.net"
$env:JIRA_EMAIL="you@example.com"
$env:JIRA_TOKEN="your_jira_api_token"
```

### Auto Jira comment (optional)
```powershell
$env:BUGPILOT_AUTO_JIRA_COMMENT="true"   # summarize-results posts one Jira comment automatically
```

### Email notification (optional) — Microsoft Graph is preferred, else SMTP
```powershell
# recipients / sender (shared by both transports)
$env:BUGPILOT_EMAIL_FROM="you@your-company.com"
$env:BUGPILOT_EMAIL_TO="you@your-company.com"      # comma/semicolon separated for multiple

# Option A — Microsoft Graph (works when the tenant disables SMTP AUTH / blocks port 25)
$env:GRAPH_TENANT_ID="<directory (tenant) id>"
$env:GRAPH_CLIENT_ID="<application (client) id>"
$env:GRAPH_CLIENT_SECRET="..."                    # store in a secrets manager
#   requires an Entra app registration with the application permission Mail.Send (admin-consented)

# Option B — SMTP
$env:SMTP_HOST="smtp.your-company.com"
$env:SMTP_PORT="587"                              # optional, default 587
$env:SMTP_USERNAME="relay-user"                   # optional; omit for an open internal relay
$env:SMTP_PASSWORD="..."                          # store in a secrets manager
$env:SMTP_USE_STARTTLS="true"                     # optional, default true
$env:SMTP_USE_SSL="false"                         # optional, default false (set true for SMTPS/465)
```
If no transport is configured, `notify --execute` / `commit-plan` still succeed and simply report that no email was sent — the generated `notification.eml` can be sent manually (e.g., via Outlook).

### Agent invocation (optional)
```powershell
$env:BUGPILOT_CLAUDE_COMMAND="claude"                       # binary launched by `bugpilot bug --claude`
$env:BUGPILOT_CLAUDE_ARGS="--permission-mode acceptEdits"   # default; use --dangerously-skip-permissions for unattended
$env:BUGPILOT_COPILOT_COMMAND="copilot"                     # binary launched by `bugpilot bug --copilot`
$env:BUGPILOT_COPILOT_ARGS=""
```

## Demo vs real

```powershell
bugpilot bug JR-12345 --allow-mock          # demo, no Jira credentials needed
bugpilot bug JR-12345                        # real Jira (default)
bugpilot bug JR-12345 --fresh --no-mock      # equivalent explicit form
```
