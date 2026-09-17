# bugpilot — Architecture & Code Guide

This guide explains how the codebase is put together: the layers, the two
orchestrators, every core module, and the artifact pipeline that flows through
`.ai/<issue>/`. It is aimed at a developer who needs to change bugpilot itself,
not at an end user (see [usage_guide.md](usage_guide.md) for that).

- Package name: `bugpilot` (`pyproject.toml`), version `0.1.0`.
- Package / import name: `bugpilot` (matches the CLI). Env vars are `BUGPILOT_*`; the artifact dirs stay `.ai/` / `.ai_memory/`.
- Console script: `bugpilot = bugpilot.cli:main`.
- Runtime dependencies: **none** — standard library only. `requires-python >= 3.10`.
- External tools used at runtime (all optional, all degraded gracefully): `git`,
  ripgrep (`rg`), and the `claude` / `copilot` CLIs (Claude is launched by
  default after preparation; `--prepare-only` skips it).

---

## 1. Design philosophy

bugpilot **prepares, then hands off**. The tool never commits, pushes, merges, or
opens PRs; every preparation step produces a reviewable Markdown/JSON artifact
under `.ai/<issue>/`; and a coding agent — Claude by default, or Copilot with
`--copilot`, or none with `--prepare-only` — does the actual fixing, stopping at
the commit gate for the developer to approve. The only Jira write is one optional
status comment (opt-in via `--jira-comment`, executed explicitly).

Three properties shape the code:

1. **Deterministic, offline-friendly core.** ADF→Markdown conversion, field
   parsing, keyword extraction, and code ranking are pure functions with no
   network calls, so they are fully unit-testable. Preparation is deterministic;
   only the agent step (and Jira/email I/O) is non-deterministic or networked.
2. **Artifact-as-interface.** Modules rarely call each other at runtime; instead
   each step writes files that later steps read. `context.py`, for example,
   imports no other core module — it consumes the artifacts that jira/search/
   memory/git steps already wrote. This keeps steps independently runnable and
   `--resume`-able.
3. **One credential boundary.** Jira/SMTP/Graph secrets enter through `config.py`
   only. They come from environment variables first; the Jira email + token may
   also come from `~/.bugpilot/config.toml` (written by `bugpilot setup`), with
   env always winning. No secret is read anywhere else (the lone exception,
   `BUGPILOT_AUTO_JIRA_COMMENT`, is a behavior flag read in `cli.py`).

---

## 2. Entry points & packaging

```
bugpilot <command> [args]
  └─ project.scripts → bugpilot.cli:main
python -m bugpilot
  └─ bugpilot/__main__.py → cli.main
```

- `bugpilot/__main__.py` — 5-line shim: `raise SystemExit(main())`.
- `bugpilot/cli.py` — argparse surface + per-command dispatch (the top-level
  orchestrator for single-step commands).
- `bugpilot/core/workflow.py` — the pipeline orchestrator: `run_bug_workflow`
  chains the steps, and each `*_step` function is also individually callable so
  the matching subcommand can run just that stage.
- `install.ps1` (repo root) — a PowerShell installer that finds the newest
  `bugpilot-*.whl` beside it and installs the console script via `pipx`, then
  points the user at `bugpilot setup`.

### Planned: three entry points over one core

The CLI is currently the only entry point. A design draft adds two more — an MCP
server (`import core`) and a VS Code extension (`spawn bugpilot --json`) — over the
same `bugpilot/core/`, with Jira demoted from a core dependency to one input
adapter among several. The intended division of responsibility:

```text
Automation        -> CLI
Agent-driven      -> MCP
Developer-driven  -> VS Code Extension
```

Not implemented yet. See [adapter_design.md](adapter_design.md) (written in Chinese)
for the requirements, domain model (`BugSpec` / `InvestigationOptions` /
`InvestigationPlan`), JSON contract, and phased plan.

---

## 3. Layered architecture

Modules form a strict dependency direction (leaves import nothing from
`bugpilot.core`; orchestrators sit on top). Nothing below imports anything above it.

```
        cli.py                     ← argparse, dispatch, printing
          │
        workflow.py                ← step sequencing, artifact I/O, status/log
          │
   ┌──────┼───────────────┬──────────────┬───────────────┐
   │      │               │              │               │
 prompts  jira          search        memory          email_notify
   │      │  \            │              │               │  \
delivery  jira_adf  jira_parse       git_ops         config  jira(sanitize)
_instr.   │                              │
          └──────────── config ──────────┘
```

**Leaf modules** (no `bugpilot.core` imports): `config`, `jira_adf`, `jira_parse`,
`keywords`, `delivery_instructions`, `cleanup`, `logging_utils`, `git_ops`,
`context`.

**Consumer modules:** `jira` → (config, jira_adf, jira_parse); `search` →
git_ops; `memory` → config; `prompts` → (delivery_instructions, git_ops);
`agent_runner` → config; `copilot` → (config, git_ops); `doctor` → (config,
git_ops); `email_notify` → (config, jira).

`context.py` is a special case: it imports only `json`/`pathlib` and depends on
the *outputs* of the other steps, not their code.

---

## 4. The two orchestrators

### 4.1 `cli.py` — command surface

`build_parser()` registers every subcommand; `main(argv)` dispatches on
`args.command`. Commands fall into groups:

| Group | Commands |
| --- | --- |
| Full pipeline | `bug` — the **default command**, so `bugpilot JR-123` == `bugpilot bug JR-123`. Prepares, then launches Claude. Flags: `--copilot` (use Copilot) / `--prepare-only` (no agent), `--jira-comment` (add the pre-commit Jira status instruction, off by default), `--resume` / `--fresh`, `--include-memory`, `--hint`, `--allow-mock` / `--no-mock`, and the legacy `--agent-fix` guidance printer. |
| Setup | `setup` — interactive first-run config: collects Jira email + API token, validates them, writes `~/.bugpilot/config.toml`. |
| Jira | `fetch`, `jira-validate`, `jira-comment-draft`, `jira-comment [--execute]` |
| Individual steps | `parse`, `keywords`, `search`, `git-context`, `context`, `prompt [--jira-comment]`, `agent-task [--jira-comment]`, `agent-instructions`, `status`, `review-package` |
| Results | `check-results`, `summarize-results [--jira-comment/--no-jira-comment]`, `manual-result [--overwrite]` |
| Memory | `memory add`, `memory update`, `memory search` |
| Delivery | `delivery-check`, `commit-plan [--no-email]`, `push-plan` (and `commit` / `push` — placeholders that do **not** actually commit or push; delivery stays manual) |
| Notify | `notify [--execute]` |
| Diagnostics / housekeeping | `doctor`, `agent-check`, `clean [--include-memory]` |

Most single-step commands are thin: parse args → call the matching
`workflow.*_step` → print a result. `bug` is the exception; it calls
`run_bug_workflow` with a progress printer, then (unless `--prepare-only`)
launches the agent. `main()` injects `bug` as the default when the first token
isn't a known subcommand, which is what makes `bugpilot JR-123` work.

### 4.2 `workflow.py` — pipeline

`run_bug_workflow(repo_root, issue_key, *, fresh, include_memory, allow_mock,
agent_fix, progress, hint, jira_comment)` runs the fresh prepare sequence:

```
clean (if fresh) → doctor → fetch → parse → keywords → memory_search
→ code_search → git_context → context → (drop intermediates) → prompt → memory_add
```

Key mechanics:

- **Status & logging.** `_mark_step`/`_write_status` persist per-step pass/fail;
  `logging_utils.log` appends a UTC-timestamped line to `.ai/<issue>/execution.log`.
- **Fresh vs resume.** `fresh` first calls `cleanup.clean_issue_artifacts`;
  `--resume` preserves prior artifacts. Marker files (`developer_hint.md`,
  `jira_comment_on.flag`) are written once and read back on resume so
  `--hint` / `--jira-comment` survive a resume and standalone regeneration.
- **Intermediate cleanup.** `memory_search.md` and `git_context.md` are folded
  into `bug_context.md`, then removed by `_remove_intermediate_files`.
- **Canonical step list.** `config.WORKFLOW_STEPS` names all 24 phases used by
  status tracking (a superset of the fresh-prepare path, since results/delivery
  steps run later, on demand).

The full `command → step function` map:

| Subcommand | Step function |
| --- | --- |
| `setup` | `setup.run_setup` (interactive; not a `*_step`) |
| `fetch` | `fetch_step` |
| `jira-validate` | `jira_validate_step` |
| `parse` | `parse_step` |
| `keywords` | `keywords_step` |
| `memory search` | `memory_search_step` |
| `search` | `code_search_step` |
| `git-context` | `git_context_step` |
| `context` | `context_step` |
| `prompt` | `prompt_step` |
| `agent-task` | `copilot_task_step` |
| `agent-instructions` | `copilot_instructions_step` |
| `check-results` | `check_results_step` |
| `summarize-results` | `summarize_results_step` |
| `review-package` | `review_package_step` |
| `delivery-check` | `delivery_check_step` |
| `commit-plan` | `commit_plan_step` |
| `push-plan` | `push_plan_step` |
| `notify` | `notify_step` |
| `memory update` | `memory_update_step` |
| `memory add` | `memory_add_step` |
| `jira-comment-draft` | `jira_comment_draft_step` |
| `jira-comment` | `jira_comment_step` |
| `retry-prompt` | `retry_prompt_step` |
| `manual-result` | `manual_result_step` |

---

## 5. Module reference

Grouped by concern. Sizes are approximate and only signal where the complexity lives.

### 5.1 Configuration & layout — `config.py`, `user_config.py` (~196 / ~180 lines)

The credential boundary. Frozen dataclasses in `config.py`:

- `AppConfig` — repo root, Jira creds, `copilot`/`claude` commands + args;
  `has_jira_credentials` is true only when base URL, email, and token are all set.
  `load_config` resolves Jira creds as **env → user config → fixed URL**: env
  vars win, else the `~/.bugpilot/config.toml` values, and `jira_base_url`
  comes from `JIRA_BASE_URL` or the config file; there is no built-in default.
- `EmailConfig` — SMTP settings; `is_configured`, `uses_auth`, `missing_fields()`.
- `GraphConfig` — Microsoft Graph tenant/client/secret (the SMTP-less fallback
  transport); `is_configured`, `missing_fields()`.

Loaders: `load_config`, `load_email_config`, `load_graph_config`. Path helpers:
`issue_dir`, `memory_dir`. `WORKFLOW_STEPS` is the canonical phase list. Env
parsing goes through `_clean_env` / `_env_int` / `_env_bool` / `_parse_recipients`.

- **`user_config.py`** — the `~/.bugpilot/config.toml` store written by
  `bugpilot setup`. `load_user_config` / `save_user_config` read/write
  `jira_email` (+ token) via a minimal flat-TOML reader/writer (keeps the
  zero-dependency, py3.10 contract). The Jira site is the developer's, not a built-in company
  URL (never persisted). The dir is overridable via `BUGPILOT_CONFIG_DIR` (used
  to keep tests hermetic). Token persistence goes through a **`TokenStore`** seam
  (`FileTokenStore` today) so it can later move to the Windows Credential Manager
  without touching callers.

### 5.2 Jira ingestion — `jira.py`, `jira_adf.py`, `jira_parse.py`

- **`jira.py` (~869 lines)** — the only networked Jira module. `fetch_issue` does
  `GET /rest/api/3/issue/<key>?expand=renderedFields` with Basic auth over
  **stdlib `urllib`** (not `requests`), classifies HTTP/timeout/network errors,
  and can fall back to a synthetic `_mock_issue` when `allow_mock`. `parse_issue`
  normalizes fields (`enrich_issue`, `normalize_core_fields`,
  `normalize_comments`, `normalize_attachments`, `classify_attachment`) and calls
  into the two deterministic helpers below. Renderers `jira_summary_markdown`,
  `parsed_markdown`, `jira_field_report_markdown` produce the artifacts.
  `post_jira_comment` is the *only* Jira write — it converts Markdown to ADF
  (`_markdown_to_adf`) and POSTs one comment; `prepare_jira_comment_text` +
  `sanitize_comment_text` truncate (`MAX_JIRA_COMMENT_LENGTH = 12000`) and redact
  secrets. `sanitize_comment_text` is also reused by `email_notify`.
  `validate_credentials(base_url, email, token)` (used by `bugpilot setup`)
  checks an email + token against `/rest/api/3/myself`, reusing the shared
  `_basic_auth_header` and `_http_error_type` classification.
- **`jira_adf.py` (~167 lines)** — pure ADF→Markdown. Single public entry
  `adf_to_markdown(value)`; `_render` handles doc/paragraph/heading/lists/
  codeBlock/blockquote/panel/rule/inlineCard/media, `_apply_marks` handles
  strong/em/code/strike/link. No network, no state.
- **`jira_parse.py` (~442 lines)** — pure structured extraction.
  `extract_parsed_details(...)` pulls reproduction steps, actual/expected,
  environment (`_ENV_PATTERNS`), error messages, stack traces, log/regression
  signals, and a missing-info checklist, using section-alias matching and a set
  of precompiled regexes.

### 5.3 Analysis — `keywords.py`, `search.py`, `memory.py`, `git_ops.py`, `context.py`

- **`keywords.py`** — `extract_keywords(text, max_keywords=15, priority_text="")`
  ranks candidates by how much they look like a **code identifier**, not by raw
  frequency (bug reports are mostly prose, so frequency put "when"/"click" on
  top while the real class/function sank). `_identifier_score` rewards camelCase
  with an internal hump, snake_case, qualified names (`Foo::bar`, `a.b`), and
  file names (`widget.cpp`); original case is preserved so the downstream
  identifier check still works. It also mines file-name **stems**, extracts
  quoted **phrases** (`_extract_phrases`), splits compound identifiers into
  lower-tier **expanded** sub-tokens (`_expanded_keywords`, generic parts like
  Widget/Dialog dropped), and **boosts** any token found in `priority_text`
  (stack traces / error messages passed by `keywords_step`). Output keys:
  `high_value` / `normal` / `dropped` / `phrase` / `expanded`.
- **`search.py`** — ripgrep-driven code search.
  `run_code_search(repo_root, issue_key, keywords)` → `(markdown, related_files,
  quality)`. It shells out to `rg --fixed-strings --ignore-case --line-number`
  per keyword and phrase (guarded by `git_ops.command_available`, so a missing
  `rg` skips gracefully), then ranks files (`_rank_related_files`). Ranking is
  **specificity-first**, not frequency: score is summed per *distinct* keyword
  with **diminishing returns** (`_match_weight` — phrase 12 > qualified `::` 10 >
  high 6 > medium 2 > low/expanded 1), plus a breadth bonus for matching several
  distinct high-value keywords and a bonus when a keyword matches the file's own
  name. `_apply_header_implementation_bonus`, `_apply_path_adjustments`
  (`_noise_flags` / `NOISE_PATH_INDICATORS`), and `_assign_confidence` /
  `_overall_quality` finish; a file-name / phrase / multi-keyword match counts as
  high confidence even outside an app-source path. Caps bound the artifacts
  (`MAX_TOTAL_RELATED_FILES = 10`, `MAX_TOTAL_CODE_SEARCH_LINES = 300`).
- **`memory.py` (~124 lines)** — the `.ai_memory/bugs` store.
  `build_memory_entry` / `add_memory_entry` write `<key>.md`; `search_memory`
  scores prior entries by keyword overlap (reading `extracted_keywords.json`) and
  writes `memory_search.md`.
- **`git_ops.py` (~122 lines)** — thin git wrappers: `command_available`,
  `run_command`, `inside_git_repo`, `current_branch`, `working_tree_status`,
  plus `generate_git_context` (branch/status/per-file recent log) and
  `branch_name(issue_key, description)` → `feature/<key>-<slug>` used by prompts.
- **`context.py` (~183 lines)** — `build_context(...)` assembles `bug_context.md`
  from every prior artifact and computes a 0–100 `_quality_score`. Imports no
  other core module; depends purely on files on disk.

### 5.4 Task generation — `prompts.py`, `delivery_instructions.py`

- **`prompts.py` (~270 lines)** — builds the three handoff files.
  `generate_prompts` / `generate_copilot_task_files` both return
  `{agent_task.md, agent_handoff.md, agent_team_instructions.md}`.
  `_copilot_task` is the large template (branch/analysis/implementation/output/
  forbidden sections, plus the optional pre-commit Jira-status block and the
  shared delivery block). The `jira_comment` parameter threads through
  `_copilot_task`, `_copilot_handoff`, and `delivery_instructions_block` to
  include or omit the "Report Status to Jira (before commit)" instruction.
  `copilot_team_instructions()` loads `docs/agent_team_instructions.md` or a
  `_fallback_team_instructions()` mirror.
- **`delivery_instructions.py` (~50 lines)** — single source of the "Optional
  Assisted Delivery" block: branch-name checks, the forbidden add-list
  (`.ai/`, `.ai_memory/`, `jira.json`, secret-bearing files), and the
  commit/push approval gate. `jira_comment` toggles the last Jira-rule sentence.

### 5.5 Agent handoff & setup — `agent_runner.py`, `copilot.py`, `setup.py`

- **`agent_runner.py` (~79 lines)** — the launcher run by default (Claude) or with
  `--copilot`; `--prepare-only` skips it. `build_agent_command` builds argv from
  `config` command+args (split with `shlex`); `run_agent` resolves the executable
  (`_resolve_launch_command`, wrapping `.cmd`/`.bat` in `cmd /c` on Windows) and
  runs it inheriting the terminal. `HANDOFF_PROMPT` is the seed instruction.
- **`copilot.py` (~25 lines)** — `collect_agent_status` reports availability of
  `copilot`/`gh`/`claude` and the current mode as a dict; `agent_status_lines`
  and `auto_invocation_guidance` render it. The `print_*` pair that predated
  that split was removed once nothing called it.
- **`setup.py`** — `run_setup()` drives `bugpilot setup`: prompts for the Jira
  email and (hidden) API token, checks `git`/`rg`/`copilot` (missing tools warn,
  they don't fail), validates the credentials via `jira.validate_credentials`,
  and saves them with `user_config.save_user_config` only on success. Prompt,
  secret, and output are injectable for testing.

### 5.6 Delivery & notification — `email_notify.py`

**`email_notify.py` (~328 lines)** — post-fix email. `build_email_draft`
assembles subject/body from `result_summary.md` + `jira_summary.md` (sanitized,
length-capped). Two transports: `send_notification` (SMTP via `smtplib`, SSL or
STARTTLS) and `send_via_graph` (Microsoft Graph client-credentials token +
`sendMail`, over stdlib `urllib`). `render_eml` produces a standalone RFC-822
file. Errors are deliberately built to never echo secrets.

### 5.7 Diagnostics & housekeeping — `doctor.py`, `cleanup.py`, `logging_utils.py`

- **`doctor.py` (~41 lines)** — `collect_doctor_report` (data) and
  `doctor_report_lines` (rendering):
  Python version, `git`/`rg` availability, repo state, and *presence* (never
  values) of Jira/SMTP/Graph configuration.
- **`cleanup.py` (~73 lines)** — `clean_issue_artifacts` deletes `.ai/<key>/`
  (and optionally the memory file) behind `_ensure_child` containment guards so
  it can never delete outside `.ai` / `.ai_memory/bugs`. `validate_issue_key`
  enforces the `JR-12345` shape.
- **`logging_utils.py` (~13 lines)** — `log(issue_dir, message)` appends a
  UTC-timestamped line to `execution.log`.

---

## 6. The artifact pipeline (`.ai/<issue>/`)

Artifacts *are* the interface between steps. Producer → consumer:

| Artifact | Written by | Read by |
| --- | --- | --- |
| `jira.json` | `fetch_step` | parse, context, jira-comment |
| `jira_summary.md` | `parse_step` | context, email |
| `jira_parsed.md` | `parse_step` | context, prompts (input list) |
| `jira_field_report.md` | `jira-validate` | (human) |
| `extracted_keywords.json` | `keywords_step` | search, memory |
| `memory_search.md` | `memory_search_step` | context *(intermediate — dropped)* |
| `code_search.md` | `code_search_step` | context, copilot_task |
| `related_files.json` | `code_search_step` | git_ops, context, copilot_task |
| `search_quality.json` | `code_search_step` | context, copilot_task |
| `git_context.md` | `git_context_step` | context *(intermediate — dropped)* |
| `bug_context.md` | `context_step` | copilot_task, memory |
| `agent_task.md` / `agent_handoff.md` / `agent_team_instructions.md` | `prompt_step` | Copilot/Claude/human |
| `developer_hint.md` | `--hint` | prompt/agent-task regeneration |
| `jira_comment_on.flag` | `--jira-comment` | prompt/agent-task regeneration |
| `bug_analysis.md`, `fix_summary.md`, `test_result.md`, `diff_summary.md`, `review_notes.md` | agent/human/`manual-result` | check-results, summarize, review-package, jira-comment-draft |
| `user_feedback.md`, `agent_retry_prompt.md` | `retry_prompt_step` | agent (2nd attempt) |
| `result_summary.md`, `manual_validation.md` | `summarize_results_step` | review-package, email, jira-comment-draft |
| `jira_comment_draft.md` | `jira_comment_draft_step` | jira-comment |
| `jira_comment_post_result.json`, `jira_comment_post_summary.md` | `jira_comment_step --execute` | (audit) |
| `execution.log`, status files | every step | status, debugging |
| `.ai_memory/bugs/<issue>.md` | `memory_add`/`memory_update` | future `memory_search` |

For the end-to-end stage narrative, see [workflow_overview.md](workflow_overview.md).

---

## 7. Configuration reference

Environment variables are read in `config.py` (except `BUGPILOT_AUTO_JIRA_COMMENT`,
read in `cli.py`); `BUGPILOT_CONFIG_DIR` is read in `user_config.py`.

| Purpose | Variables | Notes |
| --- | --- | --- |
| Jira | `JIRA_BASE_URL`, `JIRA_EMAIL`, `JIRA_TOKEN` | Basic auth = base64(`email:token`). All three fall back to `~/.bugpilot/config.toml`; none has a built-in default. |
| Agent commands | `BUGPILOT_COPILOT_COMMAND` (`copilot`), `BUGPILOT_CLAUDE_COMMAND` (`claude`), `BUGPILOT_CLAUDE_ARGS` (`--permission-mode acceptEdits`), `BUGPILOT_COPILOT_ARGS` | Used by `agent_runner` when launching the agent. |
| SMTP | `SMTP_HOST`, `SMTP_PORT` (587), `SMTP_USERNAME`, `SMTP_PASSWORD`, `SMTP_USE_SSL` (false), `SMTP_USE_STARTTLS` (true), `BUGPILOT_EMAIL_FROM`, `BUGPILOT_EMAIL_TO` | `is_configured` needs host + sender + ≥1 recipient. |
| Microsoft Graph | `GRAPH_TENANT_ID`, `GRAPH_CLIENT_ID`, `GRAPH_CLIENT_SECRET` | Fallback transport when SMTP auth is unavailable. |
| Behavior | `BUGPILOT_AUTO_JIRA_COMMENT` | Truthy → `summarize-results` auto-posts a Jira comment. |
| Config location | `BUGPILOT_CONFIG_DIR` | Overrides the `~/.bugpilot` directory (keeps tests hermetic). |

**User config file** (`~/.bugpilot/config.toml`, written by `bugpilot setup`):
`jira_email` and — for now — `jira_token`. SMTP/Graph secrets are still
environment-only. The token is stored in plaintext (perms `600` where the OS
allows) behind the `TokenStore` seam, pending a move to the Windows Credential
Manager. Nothing is echoed in errors or the `doctor` report.

---

## 8. Safety model

The guarantees enforced across the code (see also [safety.md](safety.md)):

- bugpilot never commits, pushes, merges, or opens PRs. It prepares artifacts and
  then launches an agent that edits code but **stops at the commit gate** for the
  developer to approve; `--prepare-only` launches no agent at all.
- The only Jira write is one *optional* status comment via `jira-comment
  --execute` (opt-in with `--jira-comment`; no field edits, transitions,
  assignments, or attachment up/downloads).
- Generated delivery instructions require explicit developer approval before any
  commit/push and forbid pushing `main`/`master`, force-push, and adding
  `.ai/` / `.ai_memory/` / `jira.json` / secret-bearing files.
- `cleanup` cannot delete outside `.ai` / `.ai_memory/bugs`.
- Secret redaction (`sanitize_comment_text`) runs on every outbound text
  (Jira comment, email). The Jira API token saved by `setup` is stored in
  plaintext for now (perms `600` where supported), behind a replaceable seam.

---

## 9. Testing

- `pytest` (the only dev dependency; `pip install -e .[test]`).
- Tests live under `tests/`, with `tests/test_workflow.py` covering the
  end-to-end prepare pipeline via `run_bug_workflow(..., allow_mock=True)`.
- Because the deterministic core (ADF, parse, keywords, ranking, context,
  prompts) is side-effect-free, most behavior is unit-testable without Jira,
  git, or `rg` present; `allow_mock=True` supplies synthetic Jira data.

Run the suite:

```bash
python -m pytest -q
```

---

## 10. Extending bugpilot

To add a **new pipeline step**:

1. Add a `<name>_step(repo_root, issue_key, ...)` in `workflow.py` that reads its
   input artifacts, writes its output artifact(s), and calls `_mark_step` + `log`.
2. If it belongs in the fresh-prepare path, call it from `run_bug_workflow` in
   order and add a `_progress` tag; otherwise leave it on-demand.
3. Add the phase name to `config.WORKFLOW_STEPS` if it participates in status.
4. Register the subcommand in `cli.build_parser` and dispatch it in `cli.main`.
5. Add a row to the artifact table above and to
   [workflow_overview.md](workflow_overview.md).

To add a **new configuration input**: put the env read in `config.py` (in the
relevant dataclass loader), expose it via a property/`missing_fields`, and
surface presence in `doctor.py`. Do not read env vars elsewhere.

To add a **pure helper** (parsing, rendering, ranking): keep it a leaf module
with no `bugpilot.core` imports so it stays unit-testable, following `jira_adf.py`
/ `jira_parse.py` / `keywords.py`.
