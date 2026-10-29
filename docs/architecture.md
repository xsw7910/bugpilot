# bugpilot — Architecture & Code Guide

> **Status note:** this guide predates the artifact consolidation
> (`docs/bugpilot_prototype_development_plan.md` §37). The current prepare
> contract is five artifacts — `issue.json`, `retrieval.json` (which also holds
> Git history's structured `git_history` section), `context.md`,
> `task.md`, `run.json` — and the files this guide still describes
> (`bug_context.md`, `agent_task.md`, `workflow_status.json`,
> `execution.log`, and the per-stage issue/search files) are no longer
> written or read. Treat those sections as historical until the
> documentation pass rewrites them.

This guide explains how the codebase is put together: the layers, the two
orchestrators, every core module, and the artifact pipeline that flows through
`.ai/<issue>/`. It is aimed at a developer who needs to change bugpilot itself,
not at an end user (see the [README](../README.md) and
[extension/README.md](../extension/README.md) for that).

- Package name: `bugpilot` (`pyproject.toml`), version `0.1.5`.
- Package / import name: `bugpilot` (matches the CLI). Env vars are `BUGPILOT_*`; the artifact dirs stay `.ai/` / `.ai_memory/`.
- Console script: `bugpilot = bugpilot.cli:main`.
- Runtime dependencies: **none** — standard library only. `requires-python >= 3.10`.
- External tools used at runtime (all optional, all degraded gracefully): `git`,
  ripgrep (`rg`), and the `claude` / `copilot` CLIs (launched only when
  `bugpilot bug --launch-agent claude|copilot` asks; preparing alone is the default).

---

## 1. Design philosophy

bugpilot **prepares, then hands off**. The tool never commits, pushes, merges, or
opens PRs; every preparation step produces a reviewable Markdown/JSON artifact
under `.ai/<issue>/`; and a coding agent — the developer's own, or one started
with `--launch-agent claude|copilot` — does the actual fixing, stopping at
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

Not implemented yet. See [adapter_design.md](adapter_design.md)
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
| Full pipeline | `bug` — the **default command**, so `bugpilot JR-123` == `bugpilot bug JR-123`. Prepares, keeps existing artifacts and launches no agent. Flags: `--launch-agent claude\|copilot` (launch one after preparing) / `--prepare-only` (the default, explicit), `--fresh` (delete `.ai/<issue>/` first) / `--resume` (the default, explicit), `--include-memory` (with `--fresh`), `--repository-profile`, `--jira-comment` (add the pre-commit Jira status instruction, off by default), `--hint`, `--allow-mock` / `--no-mock`, and the legacy `--agent-fix` guidance printer. |
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
`run_bug_workflow` with a progress printer, then (only with `--launch-agent`)
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
- **One path to a task.** `work_item_task_inputs` resolves a work item's
  `TaskInputs` — its recorded hint, Jira opt-in, attachments, Fix Mode, branch
  policy and branch, and the layers the caller passes — and reads only;
  `TaskInputs.render()` is `generate_task`. `prompt_step` and
  `copilot_task_step` resolve the layers with logging, render, record a
  per-issue branch name (`_record_task_branch`, the one write) and write
  `task.md`; `bugpilot task-preview` renders the same inputs and writes
  nothing (0.1.4).
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
| `task-preview` | `task_preview.preview_work_item` / `preview_template` (writes nothing; not a step) |
| `context-preview` | `context_preview.preview_context` (reads the last generated context; not a step) |
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
  zero-dependency, py3.10 contract). The Jira site (`jira_base_url`) is the
  developer's, never a built-in company URL; `save_jira_site` rewrites only
  that key, for `bugpilot jira-site set` and the extension's Jira Setup. The dir is overridable via `BUGPILOT_CONFIG_DIR` (used
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
  `high_value` / `normal` / `dropped` / `phrase` / `expanded`. Since 0.1.3
  (§42.3) it reads the issue by field: `text` is the issue itself
  (`IssueArtifact.core_text`: title, description without its field sections,
  steps, actual, expected) and `secondary_text` the comments and environment,
  whose words count once however often they repeat and rank below the issue's
  own (`SECONDARY_RANK_PENALTY`). `remove_noise` takes links, e-mail
  addresses, host names (`*.example.invalid`, `*.com`, …) and numbered machine
  names (`build-host-01`) out first — never `utf-8`, `x86-64`, `qt-6` or
  `module.attr` — and lists the names in `noise_keywords`.
- **`search_terms.py`** — what each term is worth. `SearchTerm` carries its
  `origins` (`TERM_ORIGINS`: title, description, reproduction, actual,
  expected, comment, environment, hint, user-keyword), read from
  `IssueArtifact.field_texts` by `term_origins` (a hand-written bug's derived
  title is not a field of its own). `weigh` keeps the weight scale: a term only
  the comments use drops to a hint's weight (identifier) or 1 (prose), a plain
  word the title and description agree on rises to `WEIGHT_AGREED` (3), a
  stack-trace term keeps 8 wherever it was pasted, `--keywords` keep 8, and a
  term only the environment uses is not searched. `qualified_parts` searches
  `Class.method` by its parts too.
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
  `_search_confidence` finish; a file-name / phrase / multi-keyword match counts as
  high per-file confidence even outside an app-source path. Since 0.1.3
  (§42.3): what comment- and environment-only terms match in one file adds up
  to `SECONDARY_EVIDENCE_CAP` at most; the issue's concepts on one matched line
  (`_concepts_together`, word starts only) earn up to 6; and **Search Confidence
  v2** (`_search_confidence`) reads the best-ranked files instead of "any high
  file": how much of the issue's matched concepts the top file holds, whether
  that includes a strong term, a phrase or the file's own name, whether it
  stands clear of the next file (`CLEAR_MARGIN`) or the next files agree, and
  whether it is there for the issue's words or for the comments', the
  environment's or the hint's. The levels stay High / Medium / Low; the reason
  codes and counts are `retrieval.json`'s additive `confidence_details`
  (version 2), the sentences its `reasons`. Caps bound the artifacts
  (`MAX_TOTAL_RELATED_FILES = 10`, `MAX_TOTAL_CODE_SEARCH_LINES = 300`).
- **`memory.py` (~124 lines)** — the `.ai_memory/bugs` store.
  `build_memory_entry` / `add_memory_entry` write `<key>.md`; `search_memory`
  scores prior entries by keyword overlap (reading `extracted_keywords.json`) and
  writes `memory_search.md`.
- **`git_ops.py` (~122 lines)** — thin git wrappers: `command_available`,
  `run_command`, `inside_git_repo`, `current_branch`, `working_tree_status`,
  and `branch_name(issue_key, description)` → `feature/<key>-<slug>` used by prompts
  (a hand-written bug's `feature/<title-slug>`: its id is new on every run).
  Which branch a task tells the agent to use is `branch_policy.py`'s.
- **`git_history.py`** — Git History v2. `collect_git_history` finds and ranks
  the related commits — commit-message search (issue key, shared Keywords,
  Additional Commit Keywords, extracted identifiers) and file history (Focus
  Files, Additional Files, top Code Search files), merged once per commit with
  its reasons, bounded by the Git History Settings — and returns a structured
  `GitHistoryRecord`. Data flow: Git retrieval → the record, written
  by `workflow.git_context_step` atomically into `retrieval.json` as its
  `git_history` section (schema_version 1; status, search settings, summary
  counts, commits with source-tagged matched terms and files, reasons,
  warnings) → `render_git_context` renders the record into `context.md`'s Git
  History section (and for `bugpilot git-context`) → the extension's
  `gitHistory.ts` reads the same section for the Git history row ("N related
  commits found") and its Related commits disclosure. Nothing reads Git
  history back out of `context.md`. Changed-file feedback: after
  ranking, the strongest retained commits (≤5, each with evidence of its own,
  never a bulk commit) are asked for their changed file names — never a diff —
  and the files Code Search did not return become `git_history.supporting_files`,
  each with `source: "git_history"`, its commits and its reasons. They are
  supporting evidence, not search results: they never enter `related_files`,
  never trigger another search, and are shown in `context.md` under "Supporting
  Files From Related Commits" and in the panel under the Git history row's
  Supporting files — never among Code search's Relevant files. Ranking rules
  added from corpus evidence: a clean merge that only repeats the
  branch commits it brought in is not listed (a merge with a conflict
  resolution or evidence of its own stays, and lends only files its branch
  commits read for feedback did not), and a shared Keyword or extracted term matching
  more than 20 candidate commits is *broad* — it adds 2 points and says so, but
  no longer keeps a commit in the list on its own. The corpus is
  `tests/git_history_corpus.py` (`python tests/git_history_corpus.py` prints
  the table; `test_git_history_corpus.py` holds its floors). Since 0.1.3
  (§42.3) two gates sit in front of it: a term only the comments or the
  environment use is never a commit-message term unless a stack trace printed
  it (`select_extracted_terms`), and a ranked file earns its commits file-history
  credit only with relevant evidence (`weak_ranked_files`: not Code Search's
  `low`, and matched by a term the issue itself says); the other files keep
  their rank.
- **`context.py`** — `build_context(...)` assembles `context.md` from what the
  steps before it produced. **Context Quality v2** (`context_quality`, §42.3)
  scores Issue completeness (description, reproduction steps, actual and
  expected result, environment, errors/stack traces/logs, attachments),
  Retrieval quality (Search Confidence, the top file's share of the issue's
  concepts, a strong or phrase match) and Repository context (git, related
  commits, similar fixes); the overall is 40 / 40 / 20 of them, at most
  `MISSING_CORE_EVIDENCE_CAP` (75) when the report has none of steps, actual
  and expected result. Each component is shown, with the yes/no lines.

### 5.4 Task generation — `prompts.py`, `fix_modes.py`, `fix_mode_state.py`, `delivery_instructions.py`

The Fix Mode path has one resolution boundary, and everything downstream of it
holds an object rather than a name:

```text
CLI --fix-mode <id> / VS Code selector / future MCP
  -> InvestigationRequest.fix_mode_id
    -> fix_mode_state.select_fix_mode(...)      explicit > persisted > Standard
      -> FixModeRegistry.resolve(id)            the only id -> mode lookup
        -> FixMode
          -> persisted to .ai/<work item>/fix_mode.json (audit + later runs)
          -> prompt_step / copilot_task_step / retry_prompt_step
            -> generate_prompts(..., fix_mode=<FixMode>)
```

That registry is built per command from three places, with project beating user
for a custom id and built-in ids reserved against both:

```text
packaged built-ins           bugpilot/core/fix_modes.py
user Fix Modes               ~/.bugpilot/fix_modes/<id>.json
project Fix Modes            <target repo>/.bugpilot/fix_modes/<id>.json
                                  |
                                  v
                       FixModeStore.load_catalog()
                        /                              effective registry                  scoped catalog
        one mode per id,                    every physical definition,
        what a run resolves                 including a shadowed one
```

The MCP server is a third caller on that same path, and only ever a reader of
it: `list_fix_modes` and `show_fix_mode` report what the registry resolves, and
`fix_mode_id` on the prepare tools is an id handed to the same
`InvestigationRequest` field the CLI fills in.

```text
MCP client
  -> list_fix_modes / show_fix_mode        catalog_for / fix_mode_registry
  -> prepare_* (fix_mode_id)               InvestigationRequest.fix_mode_id
       -> run_investigation                 explicit > persisted > default
```

It holds no built-in list, no default id, no precedence rule and no storage
path, and reaches no `FixModeStore` mutation API: authoring a mode is the
developer's, through the CLI and the editor.

Management is the other direction, and never goes through the effective
registry — a mode one scope shadows still has to be editable in the scope that
owns it:

```text
VS Code Manage Fix Modes
  -> panel message (draft, never instruction text on a command line)
    -> controller -> app/fixModeTransport (temporary JSON payload file)
      -> bugpilot fix-mode create|update|delete|duplicate --scope … --json
        -> FixModeStore  ->  <scope>/fix_modes/<id>.json
```

`.bugpilot/` is team configuration and belongs to the developer: BugPilot writes
a mode file when asked and nothing else — it never stages, commits, or gitignores
one. `.ai/` stays runtime state, and `.ai/<work item>/fix_mode.json` stays an
audit record whose id is the only thing that selects a definition.

The VS Code panel is one of those callers and knows only ids. It discovers what
to offer, never what a mode *is*:

```text
bugpilot fix-mode list --json      (default_mode_id + display metadata)
  -> host/ports.loadFixModes -> app/fixModes.fixModesFromPayload
    -> PanelState.fixModes         the selector's options
      -> FormState.fixModeId       what the developer picked
        -> --fix-mode=<id>         the same resolution path as the CLI
```

Nothing on that path carries a mode's instruction sections, and the extension
contains no list of modes and no default id — a guard test reads every shipped
source file to keep it so. What a *prepared* work item is under is read back from
`workflow_status.fix_mode` — the persisted selection, recorded once it resolves
and before the pipeline runs — and is shown separately from the current selection.

- **`fix_modes.py` (~400 lines)** — the AI Fix Mode model and registry: a frozen
  `FixMode` with six instruction sections (objective, investigation,
  implementation, verification, constraints, completion) plus `id`, `name`,
  `source`, `version`, `based_on`, `based_on_version` and `execution_kind`;
  `FixModeRegistry` with the five built-in modes, `standard` as the deterministic
  default, and an unknown ID raising `FixModeNotFoundError` rather than falling
  back. `execution_kind` (`"fix"` | `"investigate"`) is the only structured
  workflow semantic, because a renderer cannot read "do not edit source yet" out
  of prose and know to withhold the commit/push offer. `validate()` type-checks
  every field before touching it, so a hand-edited custom mode fails as a
  `FixModeError` naming the field rather than an `AttributeError` from inside a
  `strip()`. It also contains the mode text: editable sections may not carry
  Markdown headings (a mode could otherwise forge `## BugPilot Safety Rules` above
  the real one) and are capped at `MAX_FIX_MODE_TEXT_LENGTH`. Imports no other
  core module and holds no product-specific knowledge: a mode says *how* to
  work, never what the bug is, and never what BugPilot forbids.

- **`fix_mode_store.py` (~470 lines)** — custom Fix Modes on disk. Resolves the
  two scope directories, loads and strictly validates `<id>.json` (unknown keys
  refused, `source` refused outright because scope comes from the directory,
  file name must match the id, every definition through `FixMode.validate()`),
  reports unreadable files as diagnostics rather than dropping the rest, and
  performs create/duplicate/update/delete with `expected_version` optimistic
  concurrency and path/symlink containment. `FixModeCatalog` carries the scoped
  view; `effective_registry()` is the one-mode-per-id view a run resolves
  through. Nothing is cached: these files are meant to be edited and committed.
- **`fix_mode_state.py` (~190 lines)** — which mode a work item runs under.
  `select_fix_mode` applies the precedence (explicit id, else the persisted
  selection, else Standard Fix) and `persist_fix_mode` records it at
  `.ai/<work item>/fix_mode.json` — generated runtime state beside
  `workflow_status.json`, not the team-owned `.bugpilot/` that later phases add.
  Only the id selects a mode: it is re-resolved through the registry on every
  read, so a stale file cannot describe one mode and deliver another, and a
  selection that no longer resolves fails loudly instead of becoming Standard.
  `fix_mode_registry()` is the one seam a later phase widens to include user and
  project modes. `fix_mode_metadata` gives the single audit shape used by the
  file, `workflow_status.json` and the `--json` envelope.
- **`prompts.py` (~520 lines)** — builds the three handoff files.
  `generate_prompts` / `generate_copilot_task_files` both return
  `{agent_task.md, agent_handoff.md, agent_team_instructions.md}`.
  `_copilot_task` is the large template (branch/input files, the selected AI Fix
  Mode, the rule-precedence statement, the invariant evidence and editing
  sections, output/forbidden sections, plus the optional Jira-status block and
  the closing block).
  Their `fix_mode` parameter takes a resolved `FixMode` or `None`
  (`_task_fix_mode` → the packaged `STANDARD_FIX`); an ID string raises, because
  resolving one for a user- or project-scoped mode needs a repository root, a
  user config directory and a scope precedence rule that this module does not
  have. Callers resolve through `FixModeRegistry.resolve()` and pass the object.
  `_fix_mode_section` renders the mode metadata and its six sections,
  `_precedence_section` states that a BugPilot rule wins any conflict with a
  mode, and `mode.is_investigation` selects the closing block:
  `_investigation_handoff_block` (no commit/push offer, ask before implementing)
  instead of `assisted_delivery_block`, with `_required_output_section`
  describing the same five artifacts as investigation state.
  `delivery_safety_block` is rendered either way — an investigation withholds
  the offer, never the staging and branch rules. Mode text controls
  *how* the agent works; everything below it in the file is BugPilot-owned and a
  mode cannot relax it. The `jira_comment` parameter threads through
  `_copilot_task` to include or omit the "Report Status to Jira" section.
  Since 0.1.3 (§42.4) every protected rule is defined once, in the
  section that owns it — the Safety Rules (integrity, destructive Git, force
  push, merges, pull requests, Jira, credentials, editing), Branch Instructions
  (never main/master; the branch policy), Evidence Rules (invented evidence,
  low confidence, no-op), Required Output Files (the report contract),
  Delivery Safety (approval, branch checks, staging, never push main/master)
  and Rule Precedence (how a conflict resolves) — and other sections refer to
  it rather than restate it; `tests/task_golden.CANONICAL_RULES` checks it.
  `copilot_team_instructions()` returns the bundled safety rules
  (`_fallback_team_instructions()`, rendered from `protected_rules.py` since
  0.1.4), which `docs/agent_team_instructions.md` mirrors; they name no
  agent's tools. Project / Team and User Instructions
  (`instructions.py`) are rendered after the Repository Context, project
  first, with the project's Verification Policy (`verification.py`) and then
  `## AI Behavior` (`ai_behavior.py`) between them; `INSTRUCTION_LAYERS`
  states the precedence, and is the only place it is defined. Since 0.1.4
  the former `## BugPilot Working Guidance` is AI Behavior's default: BugPilot's
  default way of working, which any editable layer may refine — not a safety
  rule. `TASK_SECTION_CLASSES` classifies every `## ` heading a task can carry
  (protected, generated evidence, project instructions, Verification Policy,
  AI Behavior, user instructions, Fix Mode, developer hint); a test fails on a
  heading it does not list.
- **`verification.py`** — the Verification Policy since 0.1.3, resolved in one
  place: `settings/verification.md` in the repository's folder of BugPilot's
  data folder (`verification-file`, replacement
  semantics) if it exists, else the switches saved in `project_settings.json`
  (`legacy-project-settings`), else BugPilot's default (`bugpilot-default`).
  The file is front matter (`schema_version: 1`, `based_on_version`,
  `mode: replace`; parsed without a YAML dependency) and a Markdown body, read
  and written through storage, by `instructions.read_settings_document`'s rules (UTF-8, 20,000
  characters, normalised, no links or junctions, atomic writes). A file that
  cannot be used is reported, never reinterpreted, and the default applies.
  `lint_policy` adds non-blocking warnings for lines that look like they ask
  for something a safety rule forbids. `verification_section` renders the one
  `## Verification Policy` section with its source; `verification_payload` is
  `bugpilot verification show --json`. The text is never logged.
- **`protected_rules.py`** — BugPilot's protected rules since 0.1.4: the one
  source both `task.md` and `bugpilot protected-rules` read. Each
  `ProtectedRule` has a stable id, one of the plan's six groups (Safety,
  Evidence Integrity, Git / Editing, Delivery, Jira, Secrets / Artifacts), the
  `## ` section that states it, a short title and its text word for word; the
  renderers write those texts — `safety_rules_document()` (the Safety Rules,
  and `docs/agent_team_instructions.md`, verified by a test), the Evidence
  Rules and Rule Precedence in `prompts.py`, Branch Instructions in
  `branch_policy.py`, Delivery Safety in `delivery_instructions.py` — so the
  task output did not change when they moved here. `PROTECTED_RULES_VERSION`
  names the list; a test pins its digest. Built in and read-only: there is no
  file for them. `prompts.protected_rules_payload()` is `bugpilot
  protected-rules show --json`: the rules, the groups, the contract (what
  BugPilot does with them, and that it cannot enforce an agent's behaviour),
  every protected section from `TASK_SECTION_CLASSES`, and the layers from
  `INSTRUCTION_LAYERS` — read from what writes the task, and from nothing in a
  repository or on the machine. Sections whose text depends on the work item
  or the mode (the branch policy's checks, the report contract, the Jira
  status comment, the investigation handoff) are listed, not modelled.
- **`task_preview.py`** — the Effective AI Task since 0.1.4: `bugpilot
  task-preview [WORK_ITEM_ID] [--json]`. Rendered by the run's own path
  (`workflow.TaskInputs.render`), never by a second template. A prepared work
  item's preview is exactly what regenerating its `task.md` writes now — its
  recorded guidance with every layer read again — and `prepared` says whether
  the `task.md` on disk still says the same (`task_current`) and which `## `
  sections differ, by comparing the two texts. Without a work item it is a
  template: `<work-item-id>`, `<title-slug>`, a hint, an attached file and its
  note are placeholders, and the Fix Mode, branch policy and Jira comment take
  `bug`'s flags and defaults; every other layer is the repository's and the
  user's own. The JSON adds each `## ` section's class from
  `TASK_SECTION_CLASSES` (protected or not) and line span, and each layer's
  source, state, problem, lint count, versions and hash — never its text a
  second time. Read-only: no `.ai/` folder, no `issue.json` write, no process,
  no Jira; the human output is written as UTF-8 (`cli_json.utf8_stdout`).
  `doctor` reports `task-preview`.
- **`context_preview.py`** — the Effective Context since 0.1.4: `bugpilot
  context-preview [WORK_ITEM_ID] [--json]`. The `context.md` the work item was
  prepared with, byte for byte, and its status — never a new context, which
  only retrieval can produce (plan §27). States: `unavailable` (no work item),
  `not-generated`, `missing` (generated once and gone), `unreadable`,
  `current`, `stale` (still shown, with reasons) and `unknown` (shown, but its
  inputs could not be checked). Reasons come from two sources only: the
  Effective AI Task's comparison of the prepared `task.md` with the task
  BugPilot would write now, each changed section named by its class
  (`project_instructions_changed`, `verification_changed`,
  `ai_behavior_changed`, `repository_profile_changed`, `fix_mode_changed`,
  `branch_changed`, …), and the prepared files (`context_step_not_passed`,
  `retrieval_missing`, `retrieval_unreadable`, `task_missing`). What it cannot
  see is listed as `unchecked`: the retrieval inputs the panel holds and the
  issue in Jira since the fetch. Context Quality is read back from the
  document (`context.read_context_quality`, the inverse of its renderer) and
  Search Confidence from `retrieval.json` — never recomputed. Artifacts load
  through `load_issue`, `load_retrieval` and `load_run`; text through
  `task_preview.read_work_item_text`, never through a link. No search, Git,
  Jira, process or write.
- **`ai_behavior.py`** — AI Behavior since 0.1.4: how an agent is expected to
  make and report changes in the repository — conventions, not safety rules.
  **Default + append**: BugPilot's default (`DEFAULT_TEXT`, Code Change
  Conventions; `DEFAULT_AI_BEHAVIOR_VERSION`) always applies, and
  `<repo>/.bugpilot/ai_behavior.md`, when usable, adds the repository's own
  beneath it under Code Change Conventions, Evidence Standards and Reporting
  Standards — names no Fix Mode section uses. Sources: `bugpilot-default`,
  `ai-behavior-file`. The file shares the Verification Policy's front-matter
  parser (`schema_version: 1`, `based_on_version`, `mode: append`, the one
  mode) and its I/O rules; a file that cannot be used is reported and left out
  whole, and the default applies. No file is no warning, and reading never
  creates it. `lint_ai_behavior` adds non-blocking warnings: the Verification
  Policy's rule-conflict lint, a heading named like a Fix Mode section, and a
  line about running tests or checks (the Verification Policy's business);
  it gives line numbers, never the line. `ai_behavior_section` renders the one
  `## AI Behavior` section — the defaults, then `### Repository Additions` with
  the file's headings held below the task's own; `ResolvedAiBehavior.sha256`
  (source, problem, `based_on_version`, text) is what a prepared context
  depends on; `ai_behavior_payload` is `bugpilot ai-behavior show --json`
  (`set --stdin|--from-file`, `clear`/`reset` remove the file). `doctor`
  reports the `ai-behavior-text` capability. The text is never logged. A file
  whose sections are all empty — headings, blank lines and HTML comments only
  (`has_additions`) — adds nothing: the task, and the hash, are those of no
  file; `TEMPLATE_BODY` (the three headings) is what the settings row's Edit
  creates, reported as the payload's `template`. The extension
  (`extension/src/app/aiBehaviorPolicy.ts`) reads the source and hash for the
  stale check, and the text and lint only for the settings row's Preview; it
  writes only through `ai-behavior set --stdin` (the CLI's template) and
  `reset`.
- **The 0.1.4 views in the extension** render the CLI's answers and
  compose nothing. `extension/src/app/protectedRules.ts`, `effectiveTask.ts`
  and `effectiveContext.ts` parse `protected-rules`, `task-preview` and
  `context-preview` `--json` (refusing anything malformed);
  `effectivePane.ts` (`Pane`) asks only while a view is open, once per
  request key — the request plus a preview epoch the controller bumps on a
  policy reread, an environment check, a run's end and a changed file list —
  drops any answer to a superseded request, and never asks a CLI without the
  capability (or one that answered `outdated`) again; `effectiveViews.ts`
  builds the rows and views. The Effective AI Task is drawn as blocks cut at
  the CLI's section lines — joined, the CLI's text byte for byte — labelled by
  the CLI's section class. The Effective Context's status merges the CLI's
  with the panel's existing fingerprints (`contextStatusView`): either side's
  rebuild wins, the CLI's *current* needs the panel's agreement, an unknown is
  never upgraded, and no context is never "stale". The views sit in Advanced
  Settings (*AI Behavior & Rules*, *Effective Output*, plan §28) and the
  Effective two in ⋯ More; they are read-only and optional, so an older CLI
  only disables them.
- **`project_settings.py`** — `<repo>/.bugpilot/project_settings.json`: the
  legacy Verification switches (resolved into a `ResolvedVerification` by
  `verification.py`; `ResolvedProjectSettings.effective_verification`) and the
  branch naming template (`{issue}`, `{slug}`;
  validated and rendered by `git_ops.branch_template_problem` /
  `render_branch_template`). Read and written only as a real file inside the
  repository; an unusable file falls back to the defaults with a warning.
  `bugpilot project-settings` and the extension's Advanced Settings edit it
  (since 0.1.3 the extension only the branch template: it carries the switches
  through unchanged); `bugpilot verification show|set|clear|reset` reads and
  writes `verification.md`. The extension's Verification policy row
  (`extension/src/app/verificationPolicy.ts`) only calls that command — `show`
  for the row and its read-only Preview, `set --stdin` with the text `show`
  reported when Edit finds no file, `reset` for Reset — and opens the file in
  an editor tab; it composes no policy and writes no file itself.
- **`delivery_instructions.py` (~110 lines)** — delivery text, split in two
  because only one half depends on the workflow. `delivery_safety_block` is the
  BugPilot-owned gate — explicit approval, the branch checks before staging, the
  forbidden add-list (`.ai/`, `.ai_memory/`, `issue.json`,
  `jira_field_report.md`, secret-bearing files), never push main/master — and is
  rendered for every Fix Mode. In `task.md` (`standalone=False`) it relies on the
  Safety Rules above for force pushes, merges, pull requests and Jira; a
  document without that section (the retry prompt) gets them in the block.
  `assisted_delivery_block` is the offer: the delivery summary, the commit
  question, and the commit/push commands, for a pass that produced a fix.
  `delivery_instructions_block` composes both, for callers that always deliver
  (the retry prompt).

### 5.5 Agent handoff & setup — `agent_runner.py`, `copilot.py`, `setup.py`

- **`agent_runner.py` (~79 lines)** — the launcher run only by
  `--launch-agent claude|copilot`; preparing alone never reaches it. `build_agent_command` builds argv from
  `config` command+args (split with `shlex`), adding `--add-dir=<work folder>` for Claude (0.1.7: the work
  item's folder is outside the repository; one `=` word, since the option takes several folders; not when the
  configured args already name that folder; refused, and nothing started, when storage's checks refuse the folder
  or it is not there); `run_agent` resolves the executable
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
  values) of Jira/SMTP/Graph configuration. `capabilities` (`CAPABILITIES`,
  since 0.1.3: `verification-text`; since 0.1.4: `ai-behavior-text`, `protected-rules`, `task-preview` and `context-preview`) names what this CLI can read, so a newer
  extension can tell an older CLI from a broken one without parsing versions.
- **`cleanup.py` (~73 lines)** — `clean_issue_artifacts` deletes `.ai/<key>/`
  (and optionally the memory file) behind `_ensure_child` containment guards so
  it can never delete outside `.ai` / `.ai_memory/bugs`. `validate_issue_key`
  enforces the `JR-12345` shape.
- **`logging_utils.py` (~13 lines)** — `log(issue_dir, message)` appends a
  UTC-timestamped line to `execution.log`.
- **`artifact_io.py` (~34 lines)** — `atomic_write_text`: temp file plus one
  rename, with the Windows `PermissionError` retry and an in-place fallback. For
  the files another process reads while a run is in progress —
  `workflow_status.json` and `fix_mode.json`.

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
| `fix_mode.json` | `--fix-mode` / default | resume, refine, prompt/agent-task/retry regeneration, status |
| `.bugpilot/fix_modes/*.json` | `fix-mode` CRUD (or a developer's editor) | the effective registry, every run |
| `bug_analysis.md`, `fix_summary.md`, `test_result.md`, `diff_summary.md`, `review_notes.md` | agent/human/`manual-result` | check-results, summarize, review-package, jira-comment-draft |
| `user_feedback.md`, `agent_retry_prompt.md` | `retry_prompt_step` | agent (2nd attempt) |
| `result_summary.md`, `manual_validation.md` | `summarize_results_step` | review-package, email, jira-comment-draft |
| `jira_comment_draft.md` | `jira_comment_draft_step` | jira-comment |
| `jira_comment_post_result.json`, `jira_comment_post_summary.md` | `jira_comment_step --execute` | (audit) |
| `execution.log`, status files | every step | status, debugging |
| `.ai_memory/bugs/<issue>.md` | `memory_add`/`memory_update` | future `memory_search` |

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
environment-only. The token is stored in plaintext behind the `TokenStore` seam — written
atomically, owner-only (`600`) from its first moment on Linux and macOS, never
through a link at its path (0.1.5) — pending a move to the Windows Credential
Manager. Nothing is echoed in errors or the `doctor` report.

---

## 8. Safety model

The guarantees enforced across the code (see also [safety.md](safety.md)):

- bugpilot never commits, pushes, merges, or opens PRs. It prepares artifacts and
  stops; only `--launch-agent` launches an agent, which edits code but **stops at
  the commit gate** for the developer to approve.
- The only Jira write is one *optional* status comment via `jira-comment
  --execute` (opt-in with `--jira-comment`; no field edits, transitions,
  assignments, or attachment up/downloads).
- Generated delivery instructions require explicit developer approval before any
  commit/push and forbid pushing `main`/`master`, force-push, and adding
  `.ai/` / `.ai_memory/` / `jira.json` / secret-bearing files.
- `cleanup` cannot delete outside `.ai` / `.ai_memory/bugs`.
- Secret redaction (`sanitize_comment_text`) runs on every outbound text
  (Jira comment, email). The Jira API token saved by `setup` is stored in
  plaintext for now (`600` from its first moment on Linux and macOS, never
  written through a link at its path), behind a replaceable seam.

### 8.1 Trust model and where it is enforced

The four classes of [safety.md](safety.md#trust-model) map onto the code (0.1.5, plan §44.3):

| Class | Written by | Enforced in |
| --- | --- | --- |
| BugPilot's own rules | BugPilot | `protected_rules.py` (one source, versioned; `bugpilot protected-rules show`), rendered by `prompts.py` |
| Guidance people write | developers, teams, the MCP client | `instructions.normalize_instructions` + `contained_markdown` (every editable layer, the hint, `user_feedback.md`) |
| Evidence | Jira, the developer's report, the repository | `evidence.evidence_block` and `evidence.one_line`, used by `context.py`, `git_history.py`, `memory.py`, the MCP server; the extension's `src/app/evidence.ts` mirrors them for the hint improver |
| Earlier AI output | earlier agent attempts, memory | `evidence_block` with an `earlier-ai-output` label: the retry prompt, the result overview, MCP's `report_excerpt` |

Files follow one rule set (`artifact_io.atomic_write_text`, `safe_paths`): written through a temp file created new and checked to be the file at its name, then renamed; never through a link BugPilot can see; owner-only when new, a rewrite keeping its bits — except the credentials file, always `600`. What the containment and the file rules guarantee, and what they cannot, is stated in [safety.md](safety.md#trust-model).

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
5. Add a row to the artifact table above.

To add a **new configuration input**: put the env read in `config.py` (in the
relevant dataclass loader), expose it via a property/`missing_fields`, and
surface presence in `doctor.py`. Do not read env vars elsewhere.

To add a **pure helper** (parsing, rendering, ranking): keep it a leaf module
with no `bugpilot.core` imports so it stays unit-testable, following `jira_adf.py`
/ `jira_parse.py` / `keywords.py`.
