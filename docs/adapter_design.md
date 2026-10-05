# BugPilot Multi-Entry and Multi-Input Design — CLI / MCP / VS Code Extension

This document records the requirements, readiness assessment, target architecture and implementation plan for extending BugPilot from "a single CLI + Jira issue input" to "three entry points and multiple bug input sources
sharing one core". The goal of the first version is a
Feature-rich Internal Beta that other programmers can try directly, rather than a mere technical validation.

- **Audience**: developers who want to change BugPilot itself.
- **Prerequisites**: [architecture.md](architecture.md) (the existing layering and artifact pipeline),
  [the README's Main Commands](../README.md#main-commands) (command semantics), [safety.md](safety.md) (safety boundaries).
- **This document does not repeat** the content of architecture.md; it only describes the **new domain model and adapter layer**,
  and the changes to existing code that this requires.
- **Status**: design draft, implementation not started.

---

## 1. Product positioning

The long-term positioning is no longer "Jira bug helper", but:

> **BugPilot turns a bug report into focused code context for AI coding agents.**

### 1.1 The user mental model of the three entry points

This is a formal product principle and should also be written into [architecture.md](architecture.md):

```text
Automation        -> CLI
Agent-driven      -> MCP
Developer-driven  -> VS Code Extension
```

The one-sentence explanation for external audiences:

> Use the VS Code Extension when you want to control the investigation.
> Use MCP when you want the AI agent to drive the investigation.
> Use the CLI for automation and scripted pipelines.

### 1.2 Extensible input sources

```text
Jira issue          -> BugSpec -> workflow
Manual description  -> BugSpec -> workflow
Future adapters     -> BugSpec -> workflow
```

In the future this can naturally extend to GitHub Issue, Azure DevOps, clipboard, selected text, log/stack trace,
without rewriting the core. This positioning is the motivation for R7 (Jira is not a core dependency) in §2.2.

**Phase 7 conclusion: add no adapters for now.** The reason is not high cost — `BugSpec` and
`bug_spec_from_description` have already pushed the cost down to "parsing + one `source` value" — but rather
**the lack of evidence**. Manual mode can already take in any pasted text (including stack traces and
log snippets), so the only incremental value of a new adapter is "fetching the content automatically". The trigger conditions are written here;
start work only once at least one of them is met:

| Candidate adapter | Signal that it is worth doing |
| --- | --- |
| GitHub Issue / Azure DevOps | Someone **actually** reports bugs in these systems, and the repetitive work of "manually copying the issue body" has already appeared |
| clipboard / selected text | Someone reports that the "paste into the panel" step is a friction point (the panel currently is the paste board; the friction is unconfirmed) |
| log / stack trace | A pattern appears where "the same stack trace is repeatedly turned into a description by hand" |

Until then, a new adapter would add surface area that all three entry points must cover, in exchange for a hypothetical convenience.

---

## 2. Requirements

### 2.1 Background

Currently BugPilot has only one entry point: `bugpilot <command>`, and it only accepts Jira issue input.
This causes three kinds of friction:

| Friction | Symptom |
| --- | --- |
| Command memorization burden | The full flow is 9 commands and 25 subcommands; newcomers have to type them in by following usage_guide. |
| Roundabout agent handoff | `agent_runner.py` starts a subprocess that launches `claude`/`copilot`, then feeds it a handoff prompt telling it to read `agent_task.md` — the direction is "the tool launches the agent". |
| Invisible artifacts | The 20 artifact files under `.ai/<issue>/` can only be opened manually, and workflow progress exists only in `workflow_status.json`. |

### 2.2 Requirement items

- **R1 — Keep the CLI as a first-class entry point.** The names, arguments, output and exit codes of existing commands must not change.
  Terminal users notice nothing. This is a hard constraint, not a compatibility compromise.
- **R2 — Agents can drive the flow directly.** Let Claude Code / Copilot Chat in VS Code
  treat investigation steps as tool calls, instead of BugPilot launching the agent the other way around.
- **R3 — Usable by non-CLI users.** Colleagues unfamiliar with the terminal can complete a full investigation in VS Code:
  choose an input source, fill in the description and hint, choose the investigation scope, see real-time progress, browse artifacts, and hand off to an agent.
- **R4 — Single core.** All three entry points share `bugpilot/core/`; a second workflow implementation is not allowed,
  nor is the step selection logic allowed to be written separately in each of the three adapters.
- **R5 — Safety boundaries are not relaxed.** External actions (Jira comments, emails, commit, push), under any entry point,
  must be explicit and manually confirmed. The agent must not be able to trigger them autonomously.
- **R6 — Credential handling does not regress.** New entry points must not introduce a credential storage method weaker than the current one.
- **R7 — Jira is not a core dependency.** BugPilot must support two equivalent kinds of input: a Jira issue and a manual bug
  description; both are normalized into a `BugSpec` before entering the workflow, and subsequent steps must not depend on Jira.
- **R8 — The first version of the VS Code extension ships a complete and polished UI.** V1 neither cuts features nor
  downgrades the interface: the interface must meet the quality bar in §5.4 (theme adaptation, usable at narrow widths, keyboard-reachable,
  all three states covered), not merely "all the features are there". V1 does not cut features: input source switching, hint,
  keywords, focus/ignore, investigation scope selection, Run/Stop, real-time progress, artifact browsing, history,
  agent handoff, and diagnostics are all built. The scope risk is known and accepted (see §10).
- **R9 — No dependency on target repository configuration.** BugPilot must be fully usable when the target repository has no BugPilot-specific configuration at all
  (including `CLAUDE.md`). Repository-side configuration can only be an optional enhancement.

### 2.3 Non-goals

- No Web UI and no server-side deployment.
- No change to the prepare-only product positioning: BugPilot does not automatically commit/push/open PRs.
- No requirement that the bug exist in Jira first; a manual description, pasted logs or a stack trace can be used directly as input.
- Not all 25 subcommands are exposed to the agent (see §5.2).
- No support for editors other than VS Code (JetBrains, etc.) — the MCP entry point is naturally portable; the extension entry point is not built for them.
- No home-grown design language: the interface must look like a native part of VS Code and introduces no brand visuals of its own.
  "Polish" means theme consistency, complete states and accessibility, not visual flair (see §5.4).

---

## 3. Readiness assessment and domain model

### 3.1 Already satisfied

| Capability the adapter needs | Current state | Location |
| --- | --- | --- |
| Reliable exit codes | Yes. `main(argv) -> int`, 21 `return 1` paths | `cli.py` |
| Errors do not pollute stdout | Yes. 39 occurrences of `file=sys.stderr` | `cli.py` |
| Structured workflow status | Yes. `workflow_status.json` contains a `steps` state machine (24 stages) + `generated_files` | `workflow.py` |
| Data/presentation separation | Yes. `collect_doctor_report() -> dict` and `doctor_report_lines()` are already split | `doctor.py` |
| Non-interactive setup | Yes. `run_setup(prompt=, prompt_secret=, out=)` are all injectable | `setup.py` |
| Step functions can be called independently | Yes. Each `*_step(repo_root, issue_key, ...)` can run on its own | `workflow.py` |
| **Per-step progress callback** | Yes. `run_bug_workflow(progress=Callable[[str], None])`, already called at 10 step points | `workflow.py:194` |
| Artifacts as the interface | Yes. Steps communicate through files and do not call each other | architecture.md §1 |
| Zero runtime dependencies | Yes. Standard library only | `pyproject.toml` |

The existing `progress` callback is the natural hook point for `--json-lines` in §5.1 — no new hook is needed;
we only need to replace the human-readable printer that the CLI currently passes in with a JSONL emitter.

### 3.2 Needs to be addressed

| Problem | Details | Impact |
| --- | --- | --- |
| **core writes to stdout** | 12 `print` calls, concentrated in `copilot.py` (10) and `doctor.py` (2). All are "print a report" functions. When MCP runs over stdio, stdout is the JSON-RPC channel, and any `print` breaks the framing. | MCP |
| **No machine-readable output** | The normal output of each command is human text (`print(f"Generated: .ai/...")`). | Extension |
| **First runtime dependency** | The MCP server needs the `mcp` package, which breaks the "zero dependencies" contract. | MCP |
| **Multiple installations coexist** | On the same machine a pipx copy (`~/.local/bin/bugpilot.exe`) and an editable install (the repository) coexist, and PATH points to the former. The extension must not hardcode paths. | Extension |
| **Confused work item identity** | Three regexes, two implementations, semantics not separated. See §3.4. | Domain model |
| **No core contract for step selection** | Currently there is only `WORKFLOW_STEPS` (24 implementation stages) and their respective `*_step` functions, with no user-facing concept of a logical investigation scope. | Risk of drift across the three entry points |

`copilot.py` used to be the only module without data/presentation separation. **Now split**: `collect_agent_status()`
returns a dict, and `agent_status_lines()` / `auto_invocation_guidance()` handle rendering.
The old `print_copilot_check()` was deleted in the Phase 7 review once nothing called it any more.

### 3.3 Domain model: InvestigationRequest

All three entry points construct the same request object. It consists of three orthogonal parts, **not merged into one ever-growing
`BugSpec`**:

```text
             INPUT

Jira ───────┐
Manual ─────┼──→ BugSpec           (bug identity / content)
GitHub ─────┘

                +

Hint / Keywords / Focus / Ignore ──→ InvestigationOptions  (retrieval config)
Investigation scope selection ─────→ InvestigationPlan     (which capabilities)

                ↓

        InvestigationRequest
        ┌──────────────────┐
        │ spec:    BugSpec │
        │ options: Options │
        │ plan:    Plan    │
        └──────────────────┘
                ↓
           BugPilot Core
                ↓
        InvestigationResult
                ↓
      .ai/<work_item>/ artifacts
```

#### BugSpec — the bug's identity and content

```python
@dataclass(frozen=True)
class BugSpec:
    work_item_id: str            # directory and artifact identifier, see §3.4
    source: str                  # jira | manual
    title: str
    description: str
    source_ref: str | None = None    # the issue key in Jira mode; None in manual mode
```

`work_item_id` and `source_ref` **are two different concepts**. In Jira mode the two happen to have the same value
(`JR-34567`); in manual mode `source_ref` is `None`. Any code that needs to "write back to an external system"
may only read `source_ref`, and must never use `work_item_id` as a Jira key.

#### InvestigationOptions — retrieval configuration

```python
@dataclass
class InvestigationOptions:
    hint: str | None = None
    keywords: list[str] = field(default_factory=list)
    focus_files: list[str] = field(default_factory=list)
    ignore_paths: list[str] = field(default_factory=list)
    max_files: int = 10              # currently search.MAX_TOTAL_RELATED_FILES
    max_search_lines: int = 300      # currently search.MAX_TOTAL_CODE_SEARCH_LINES
```

Any retrieval configuration added in the future goes here, not into `BugSpec`.

`max_files` / `max_search_lines` merely turn the hardcoded constants that already exist in [search.py](../bugpilot/core/search.py)
into parameters, at very low cost. **They must be exposed as a pair** — the file count is not the only dimension;
the total line count of the snippets has a bigger effect on the agent's context; exposing only `max_files` would make users think they can control the artifact size,
when in fact they cannot.

The other three candidate fields raised in review **do not go into V1**; the reasons are recorded here to avoid repeating the discussion:

| Candidate field | Current state | Why it is not in V1 |
| --- | --- | --- |
| `search_scope` | None (only the `_is_included_path` suffix allowlist and `NOISE_PATH_INDICATORS` down-weighting) | Semantically overlaps with `focus_files` / `ignore_paths`. "Search only a certain subtree" can almost always be expressed inversely with `ignore_paths`; three fields expressing the same thing would leave users unsure which one to use. Add it once a real scenario proves this insufficient. |
| `dependency_depth` | None. `search.py` only does ripgrep keyword matching + ranking, with no include-graph analysis at all | This is an **independent feature**, not a parameter: C++/Qt repositories require parsing `#include`, distinguishing `<>` from `""`, and handling include search paths and conditional compilation. Adding an int does not finish the job. |
| `token_budget` | None. There is only line-based section truncation (`_section_excerpt(max_lines=25/12)`) | Requires token-counting infrastructure (`tiktoken` underestimates Claude by 15–20%; either call the API or accept a rough estimate); and it is less effective and less explainable than directly controlling `max_files` / `max_search_lines`. |

**Side effect to keep in mind**: the confidence assessment in `search_quality.json` was tuned against the current defaults.
When a user lowers `max_files` to 3, the meaning of the quality score changes (fewer candidates, so the "high confidence" threshold is effectively raised).
This does not affect correctness, but the user documentation should mention it.

#### InvestigationPlan — logical investigation scope (core contract)

The user-facing switches are **logical capabilities**, not implementation steps:

```python
@dataclass
class InvestigationPlan:
    issue_details: bool = True     # fetch/normalize the bug description
    code_search: bool = True       # code retrieval
    git_history: bool = True       # git context
    similar_fixes: bool = True     # historical bug memory retrieval
    build_context: bool = True     # assemble bug_context.md + agent_task.md
```

**The core is responsible for expanding the plan into `WORKFLOW_STEPS` and resolving dependencies**; adapters do not take part:

**Two tables** are needed, not one. The first says "which steps a capability contributes":

| Logical switch | Contributed `WORKFLOW_STEPS` |
| --- | --- |
| `issue_details` | `fetch` (jira source; automatically excluded for the manual source) · `parse` |
| `code_search` | `keywords` · `code_search` |
| `git_history` | `git_context` |
| `similar_fixes` | `keywords` · `memory_search` |
| `build_context` | `context` · `prompt` · `memory_add` |

The second says "which prerequisite artifacts a step reads" (`STEP_PREREQUISITES`), and the core computes the **transitive closure**:

| Step | Depends on | Reason |
| --- | --- | --- |
| `parse` | `fetch` | Reads `jira.json` (the manual source is excluded after the closure) |
| `keywords` | `parse` | Needs the parsed issue |
| `code_search` · `memory_search` | `keywords` | Reads `extracted_keywords.json` |
| `context` | `keywords` · `parse` | `context_step` **always** reads `extracted_keywords.json` |
| `prompt` | `context` | Reads `bug_context.md` |
| `memory_add` | `parse` | Needs the summary |

**Prerequisite steps are pulled in even if the capability they belong to is turned off.** Running prerequisites is strictly better than crashing midway —
the caller dials capabilities, not steps, so the core is obliged to fill in whatever those capabilities need to read.
This was verified during implementation: when the first draft had only the first table, `InvestigationPlan(code_search=False,
similar_fixes=False)` failed outright with `FileNotFoundError` because `extracted_keywords.json` was missing.

`_remove_intermediate_files` (which folds `memory_search.md` / `git_context.md` into
`bug_context.md` and then deletes them) must run only after `context` has actually run — otherwise, under a
plan with `build_context=False`, it would delete the only artifacts of that run.

This layer is the key to preventing drift: `☑ fetch ☑ parse ☑ keywords` never appears in the UI;
the CLI, MCP and the extension share the same `InvestigationPlan`, and dependency resolution has only one implementation (invariant 7).

### 3.4 work item identity: fully separated, not bending to the old regexes

The previous version, for the sake of "zero code changes", disguised local IDs as Jira-style keys (`LOCAL-<digits>`).
**That decision is withdrawn.** Reasons: Phase 1 has to merge key validation and introduce `BugSpec` anyway;
making the new domain model bend to the old regexes would carry technical debt into the new architecture; and semantically, a local ID is simply not
an issue key, so having `looks_like_issue_key("LOCAL-2609010949")` return `True` is wrong.

Current state (three regexes, two implementations, semantics not separated):

```text
cleanup.ISSUE_KEY_CLEAN_RE = ^[A-Za-z][A-Za-z0-9_-]*-\d+$    # actually a "directory-safe id"
memory.ISSUE_KEY_RE        = ^[A-Z][A-Z0-9]+-\d+$            # actually a "Jira issue key"
workflow.looks_like_issue_key  ─┐  the same logic
memory._looks_like_issue_key  ─┘  in two copies
```

Goal: two predicate functions with clear semantics, each with a single implementation.

```python
# Whether it is a Jira issue key — used only to decide whether we can write back to Jira and whether the Jira input adapter can be used
JIRA_ISSUE_KEY_RE = re.compile(r"^[A-Z][A-Z0-9]+-\d+$")
def is_jira_issue_key(value: str) -> bool: ...

# Whether it is a valid work item id — used for directory naming, cleanup containment, and memory lookup
WORK_ITEM_ID_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]*[-_]\d+$")
def is_work_item_id(value: str) -> bool: ...
```

Local ID shape: `local_<YYYYMMDDHHMMSS>` (for example `local_20260901094133`).
The underscore prefix makes it **impossible** for `JIRA_ISSUE_KEY_RE` to match it; it is readable, sortable, directory-safe,
and introduces no new dependencies. If same-second collisions become a problem, switch to ULID.

#### No readable slug for local IDs

We considered appending a suffix generated from the title to the directory name (`local_20260901094133_3dview-crashes-after-changing-horizon`),
so that multiple local items can be told apart when running `ls .ai/`. **Decided against it**, for three reasons:

1. **The ID must be stable; the title can change.** If a user fixes a typo in the extension form, either the ID drifts along with it
   (producing orphan directories), or the slug becomes stale, misleading information. Compare `git_ops.branch_name()`
   — there a slug makes perfect sense, because a branch name is a one-off human-facing identifier, not a stable primary key.
2. **The existing slug implementation does not work for Chinese.** In [git_ops.py](../bugpilot/core/git_ops.py),
   the first step of `summary_slug()` is `re.sub(r"[^a-z0-9]+", "-", ...)`, which discards all non-ASCII characters.
   Measured: a title written entirely in Chinese (meaning "3D view crashes after switching horizon") → `''` (empty); `OpenVDS statistics` followed by Chinese for "initialization failed"
   → `openvds-statistics`. If the team writes bug descriptions in Chinese, the readability benefit is **hit and miss**,
   which is worse than consistently having none — users would be confused about why some directories have names and others do not. Doing it would first require changing
   the non-ASCII handling in `summary_slug` (keep CJK code points, or introduce a transliteration dependency that breaks the zero-dependency contract).
3. **This is a display problem, not an identity problem.** `BugSpec.title` is already in the artifacts; the extension's
   History and TreeView can simply display the title, while the directory name stays short and stable.

To close the readability gap on the terminal side: add `bugpilot list` (§5.1), which lists each work item's
id / source / title / status. The extension's History panel also consumes it (via `--json`),
so it adds no extra cost.

The trailing `[-_]\d+` in `WORK_ITEM_ID_RE` was added during implementation (the first draft only required "starts with a letter + safe characters").
The existing test `test_clean_rejects_invalid_issue_keys_without_deleting` revealed that the old
`ISSUE_KEY_CLEAN_RE` also implied a property: **the id must end with a numeric suffix**, so the bare word `HR` is not
a valid deletion target. Both `JR-12345` and `local_20260901094133` satisfy it, and keeping this property costs nothing.

**Neither** predicate function does `strip()`: they validate the exact string that is going to become a path segment;
`" JR-12345"` and `"JR-12345"` are different directories. Callers that need lenient matching strip it themselves first.

Call sites that must be changed together:

| Location | Current state | Change to |
| --- | --- | --- |
| `cleanup.validate_issue_key` | `ISSUE_KEY_CLEAN_RE` | `validate_work_item_id` → `is_work_item_id` |
| `memory.ISSUE_KEY_RE` | Jira-shaped regex | Move to a unified module, rename to `JIRA_ISSUE_KEY_RE` |
| `workflow.looks_like_issue_key` | Copy 1 | Delete |
| `memory._looks_like_issue_key` | Copy 2 | Delete |
| `cli.py:395` (`memory search`) | `looks_like_issue_key(query)` | `is_work_item_id(query)` |
| `memory.py:43` (`search_memory`) | `_looks_like_issue_key(query)` | `is_work_item_id(query)` |
| `workflow._validate_comment_issue_key` | Compares `issue_key` | Compares `spec.source_ref`, and is reachable only when `source == "jira"` |

---

## 4. Target architecture

### 4.1 Layering

On top of the layering in architecture.md §3, a new **adapter layer** is added. The three adapters construct the same
`InvestigationRequest`, and the dependency direction is strictly one-way.

```text
+-------------+------------------+---------------------+
|  CLI        |  MCP server      |  VS Code extension   |
|  cli.py     |  mcp_server.py   |  TypeScript          |
|  (existing) |  (new, import)   |  (new, spawn CLI)    |
+------+------+--------+---------+----------+----------+
       |               |                    |
       | import        | import             | spawn `bugpilot --json[-lines]`
       v               v                    |
   +-------------------------------+        |
   |  InvestigationRequest         |<-------+
   |  = BugSpec + Options + Plan   |
   +-------------------------------+
                |
                v
   +------------------------------------------+
   |   bugpilot/core/                         |
   |   plan expansion · workflow · 18 modules |
   +------------------------------------------+
                |
                v
   InvestigationResult  ->  .ai/<work_item>/  ·  .ai_memory/bugs/
```

Trade-offs between the two integration approaches:

- **MCP `import core`** — same process, no serialization overhead, and it can directly obtain `InvestigationResult`
  and similar dataclasses. The cost is that it must follow stdout discipline.
- **Extension `spawn CLI`** — process isolation, so an extension crash does not affect the flow, and it naturally reuses the argument parsing and exit codes the CLI has already
  validated. The cost is having to parse JSON output.

Not letting the extension `import core` directly is deliberate: that would require embedding a Python bridge in the extension,
whereas spawning the CLI turns R1 (the CLI is a first-class entry point) from a "convention" into a structural fact —
if the extension breaks, the CLI keeps working as usual; if the CLI breaks, the extension exposes it immediately.

### 4.2 Invariants

1. `core/` is unaware of its caller. There must be no branches such as `if running_under_mcp`.
2. No function in `core/` writes to stdout. Human-readable output happens only in `cli.py`.
3. Each `*_step` returns structured data; rendering it as text is the adapter's responsibility.
4. External actions always take `execute: bool = False` and do not execute by default.
5. Jira exists only in the input adapter / integration layer; the workflow core receives a `BugSpec`.
6. **Review rule (not a runtime constraint)**: the tool set exposed by MCP contains no operation that writes source code;
   this is guaranteed by the tool list in §5.2, and no code enforces it. When adding a new MCP tool you must confirm that its write scope
   does not go beyond `.ai/` and `.ai_memory/`; `cleanup._ensure_child` only guards deletion paths, not writes.
7. **The expansion of `InvestigationPlan` into `WORKFLOW_STEPS` and the dependency resolution have only one
   implementation, in core.** Adapters only pass the plan and do not decide on their own which steps to run.
8. `work_item_id` and `source_ref` must not be used interchangeably (§3.4).
9. BugPilot does not depend on any BugPilot-specific configuration in the target repository (R9).

---

## 5. Entry-point specifications

### 5.1 CLI (unchanged + two additions)

All 25 subcommands, their arguments, output and exit codes are unchanged. Two items are new, both pure additions.

#### `--json`: final result

Commands that need `--json` (the ones the extension consumes):

```text
bug · fetch · search · context · status · list · check-results
summarize-results · delivery-check · doctor
```

`list` is a new command (§3.4): it lists every work item under `.ai/`, closing the terminal-side readability gap left once local IDs
no longer carry a slug, and it also serves as the data source for the extension's History panel.

```text
$ bugpilot list
JR-34567              jira    Output panel min/max values not converted to dB  prepared
local_20260901094133  manual  3D view crashes after switching horizon          fixed
local_20260828171205  manual  OpenVDS statistics initialization failed         prepared
```

The `bug` main entry point accepts both kinds of input:

```text
bugpilot bug JR-12345
bugpilot bug --description "3D view crashes after changing horizon"
bugpilot bug --description-file bug.txt
```

The corresponding parameters of `InvestigationOptions` and `InvestigationPlan`:

```text
--hint  --keywords  --focus-file  --ignore-path          # Options
--max-files  --max-search-lines                          # Options (paired, see §3.3)
--git-keyword  --git-file                                # Options.git_history (Git history only)
--git-no-shared-keywords  --git-no-shared-focus-files    # Options.git_history
--git-no-commit-search  --git-no-file-history            # Options.git_history (both off = skip git_context)
--git-history-depth {recent,broader}  --git-max-commits  # Options.git_history (1–25)
--skip-code-search  --skip-git-history                   # Plan
--skip-similar-fixes  --only-issue-details               # Plan
```

JSON is the adapter API and carries a version number from the very first release. On success:

```json
{
  "schema_version": 1,
  "ok": true,
  "command": "bug",
  "work_item_id": "JR-12345",
  "source": "jira",
  "source_ref": "JR-12345",
  "issue_dir": ".ai/JR-12345",
  "generated_files": ["..."],
  "warnings": []
}
```

On failure, stdout still emits only a single JSON object, and stderr keeps the human-readable error:

```json
{
  "schema_version": 1,
  "ok": false,
  "command": "bug",
  "error": { "code": "JIRA_AUTH_FAILED", "message": "..." }
}
```

The extension must not parse the error text; it may rely only on the stable `error.code`.

**`--json` and `--json-lines` never launch an agent.** A machine-mode caller either handles the handoff itself
or takes the continuation path in §5.6; starting an interactive agent in either mode would mix its output into
a stdout that should contain only structured data. The help text states this.

**Progress numbering counts the steps that will actually run**, not a fixed `[N/9]`. manual has one fewer step (`fetch`),
and some plans have even fewer; counting toward a total that is never reached reads as if it were stuck. The human-readable text of `parse`
differs by source (Jira keeps the original text) to satisfy R1.

#### `--json-lines`: live event stream

`--json` gives only one object at the end, so for progress the extension would have to watch `workflow_status.json`,
which amounts to two communication channels. `--json-lines` turns live progress into structured events on stdout as well:

```jsonl
{"schema_version":1,"type":"started","work_item_id":"JR-34567","source":"jira"}
{"schema_version":1,"type":"step_started","step":"fetch"}
{"schema_version":1,"type":"step_completed","step":"fetch"}
{"schema_version":1,"type":"step_started","step":"code_search"}
{"schema_version":1,"type":"artifact","path":".ai/JR-34567/code_search.md"}
{"schema_version":1,"type":"step_skipped","step":"memory_search","reason":"plan"}
{"schema_version":1,"type":"completed","ok":true}
```

This draws a clear line between the responsibilities:

```text
JSONL                 = live events (while the process is alive)
workflow_status.json  = persisted state / recovery (still readable after the process ends)
```

The implementation cost is small: `run_bug_workflow` already has a `progress: Callable[[str], None]` callback,
called at 10 step points (`workflow.py:194`). The CLI only needs to replace the human-readable printer it passes in today
with a JSONL emitter. `--json-lines` goes in **Phase 2**, delivered in the same batch as `--json`.

#### Behaviour of Jira-related commands in manual mode

R7 downgrades Jira to an optional input, so the Jira-related **exit points** must be defined at the same time:

| Command | When `source == "manual"` |
| --- | --- |
| `fetch` · `jira-validate` · `parse` | Fail explicitly, `error.code = "JIRA_ONLY_COMMAND"`. |
| `jira-comment-draft` | Fail explicitly, `error.code = "NO_JIRA_TARGET"` (`source_ref is None`). |
| `jira-comment --execute` | Same as above. |
| `summarize-results --jira-comment` | Reject the flag (`NO_JIRA_TARGET`); without the flag, `result_summary.md` is generated normally. |
| `notify` · `commit-plan` email | Degrade: the body uses `spec.title` / `spec.description` instead and does not read `jira_summary.md` (it does not exist in manual mode). |
| All other commands | Unchanged; they depend only on `InvestigationRequest` and the repo. |

The `source` check happens in the CLI dispatch layer (`cli.py`) and is not pushed down into `core/`, to preserve invariant 5.

### 5.2 MCP server

Add `bugpilot/mcp_server.py`, using the official Python SDK's `MCPServer`
(`from mcp.server.mcpserver import MCPServer`), with stdio transport.

The first draft said `FastMCP`; that is the mcp 1.x name — 2.x renamed it `MCPServer`, and the fields also changed from
camelCase to snake_case (`inputSchema` → `input_schema`). We chose 2.x rather than
`pin mcp<2`: pinning a superseded major version just to match a document costs more.

**Tools must raise the SDK's own `ToolError`** (`mcp.server.mcpserver.exceptions`).
A locally defined exception class with the same name is not recognized by the SDK; it is treated as a crash and wrapped as `UnexpectedToolError`,
so the model sees only `Error executing tool <name>`, and every actionable hint written into the tool is lost.

**Tool granularity is coarse**, and tools express **intent** rather than implementation steps wherever possible — the tool list enters the model context on every turn,
and 25 tools would dilute its judgement. Seven are exposed:

| Tool | Wraps | Notes |
| --- | --- | --- |
| `prepare_jira_bug` | Jira input → core | Main Jira entry point. The description states "use this when the user gives an issue key". |
| `prepare_bug_description` | Manual input → core | Main entry point without Jira. The description states "use this when the user gives only a natural-language description, logs or a stack trace, and no issue key". |
| `refine_investigation` | Options update → rerun the relevant parts of the plan | **Replaces `search_code`.** When the agent gets a new lead, what it is expressing is "re-investigate in this direction", not "run a grep once". |
| `check_results` | `check_result_files` | Returns the list of missing result files. |
| `summarize_results` | `summarize_results_step` | Jira comment defaults to false. |
| `search_memory` | `search_memory` | Finds similar past bugs across Jira and local work items. |
| `get_status` | Reads `workflow_status.json` | Read-only. |

The shape of `refine_investigation`:

```python
refine_investigation(
    work_item="JR-34567",
    hint="Focus on OpenVDS statistics initialization",
    keywords=["OpenVDS", "statistics", "initialize"],
)
```

BugPilot decides for itself which stages to rerun (code search → git history → memory → context regeneration);
the agent does not need to know the internal steps.

In the implementation it **does not go through `run_investigation`**; it is a separate step sequence in core that starts from `keywords`.
Reason: the prerequisite closure in §3.3 would pull Jira fetching back in, because `parse` depends on `fetch`,
so every refine would need network access. The issue data is already on disk (`jira.json` or `bug_spec.json`),
and an incremental re-query should not fetch it again. **A dependency model that is correct when serving "build from scratch"
is not necessarily correct when serving "incremental update".** The lower-level `bugpilot search --json` remains available on the CLI
for scripted scenarios — it is just not exposed to the agent.

The descriptions of the two `prepare_*` tools must **state that they are mutually exclusive**; otherwise, when given a Jira key,
the model may call the wrong one.

**Not exposed**: `jira-comment --execute`, `notify --execute`, `commit`, `push`,
`clean`, `setup`. The first four are outward-facing/destructive actions (R5); the last two should not be triggered by the model.

By default the MCP server binds to the repo/workspace root at startup, and the server configuration may override it;
tool parameters do not let the model pass `repo_root` freely.

An MCP prompt is also provided (in Claude Code it appears as the slash command
`/mcp__bugpilot__fix_bug`), as a deterministic path for those who do not want to bet on the model's judgement.

**Impact on `agent_runner.py`**: V1 only marks it deprecated and does not delete it right away; it stays as the Internal Beta
fallback. It will be removed once MCP is stable and the team has confirmed the migration is complete.

**Target repository `CLAUDE.md`**: the documentation provides a recommended snippet to raise the likelihood that the agent calls BugPilot,
but **the architecture must not depend on it** (R9 / invariant 9). Recommended snippet:

```markdown
When investigating a bug or Jira issue, use the BugPilot MCP tools to gather
focused engineering context before performing broad repository searches.
```

### 5.3 VS Code extension (full functionality in V1)

Per R8, V1 neither trims features nor downgrades the UI. The extension is still a thin shell — responsible only for UI and process scheduling,
with no business logic — but the UI must meet the quality bar in §5.4.

**Choice of controls**: the main input panel uses a **Webview**; artifact browsing and history use a **native TreeView**.
Rationale: the main panel is a 7-field form plus 5 scope checkboxes, and VS Code's native input offers only
`showInputBox` / `showQuickPick` (modal, sequential), which makes for a poor interaction with a form like this;
whereas TreeView is a natural fit for hierarchical read-only browsing, where a Webview would actually be worse. Do not, for the sake of uniformity, use only
Webview or only native controls.

| Group | Capability | Implementation |
| --- | --- | --- |
| Input | Input source toggle (Jira Issue / Bug Description) | Sidebar form |
| Input | Issue key · Title · Description | Form fields → `BugSpec` |
| Input | Hint · Keywords · Focus files · Ignore paths | Form fields → `InvestigationOptions` |
| Investigation scope | Issue details · Code search · Git history · Similar fixes · Build context | Checkboxes → `InvestigationPlan`. **Implementation steps such as `fetch`/`parse`/`keywords` are not exposed** (§3.3) |
| Run | Run · Stop | spawn / kill the CLI child process |
| Run | Live progress checklist | Consumes the `--json-lines` event stream; `workflow_status.json` serves as the recovery source after a restart |
| Artifacts | Artifact TreeView | Scans `.ai/*` to list Jira and local work items; expanding one shows its artifacts, and clicking opens one in the editor |
| Artifacts | Markdown preview | VS Code's built-in preview; no home-made renderer |
| History | Work item history | List of recent entries, which can be reopened, rerun, or have their status viewed |
| Handoff | Open `agent_task.md` · Copy handoff prompt | One-click actions |
| Handoff | MCP status / Continue with Claude | Suggested when MCP is detected |
| Diagnostics | Doctor · Agent Check · Clean | Command palette items → spawn CLI |
| Diagnostics | Install wizard | Shows Install Instructions / Choose Executable / Retry when the CLI is not found |
| Configuration | `bugpilot.executablePath` | Defaults to `"bugpilot"` (resolved via PATH); supports choosing an executable |
| Configuration | Credentials | The Jira token is stored in VS Code `SecretStorage` and injected into the child process as environment variables at run time; manual mode needs no Jira credentials |

V1 reference layout (a sketch of the information hierarchy, not a visual mockup; actual styling is determined by the theme variables in §5.4):

```text
BUGPILOT
─────────────────────────
Input
 ● Jira Issue   ○ Bug Description

Issue      [ JR-34567            ]
Hint       [ optional            ]
Keywords   [ optional            ]

Investigate
 ☑ Issue details    ☑ Code search
 ☑ Git history      ☑ Similar fixes
 ☑ Build context

        [ Prepare Bug ]  [ Stop ]

Progress
 ✓ Issue details
 ✓ Code search
 ● Git history
 ○ Similar fixes
 ○ Build context

        [ Open agent_task.md ]
```

**The panel is a single line, not three blocks** (refactored 2026-09-07). Previously the same run was described in three places:
the Investigate checkbox group, the Progress checklist (repeating the same five labels), and the Hand off card
that appeared after the run finished. These are now merged into **one row per step**: the checkbox (selected or not) and the status icon (how it ran)
sit on the same row.

The model lives in `app/workflow.ts` and is computed by the host on every push. **The page does not build these rows itself** —
the rows are static markup, because the checkbox belongs to the page (it is form state) while the status belongs to the host (it is the run result),
and static rows are the only way for both of these to hold at once.

Three asymmetries, all intentional:

- **`fixWithAI` is not a CLI capability** and does not go into `form.plan`. Every item in the plan becomes a flag,
  whereas this item describes what the extension does **after the process exits**. A test asserts that it produces no argument at all —
  otherwise `--prepare-only` would no longer hold for every run the panel starts.
- **It never reports "Complete".** The agent runs in a terminal the extension does not own, so "the AI has finished the fix" is
  unknowable here. The last thing it can honestly say is "handed off", which goes in that row's `detail`.
- **A row's icon follows the file, not the event.** The icon appears because the file it opens exists.
  Deciding by step events would give an icon to a file the run never got around to writing — and would leave a work item restored from History
  without a single icon (there is no event stream there at all).

**"Fix with AI" is the last step of the workflow**. It opens a terminal and runs
`<agent> "<handoff prompt>"` at the **repository root**. Four notes:

- **It does not violate R5.** What was deprecated is the CLI auto-launching an agent **by default**; a checkbox that a person ticks
  is exactly the "separate decision" R5 asks for — which is why it is **unticked by default**. The run itself is still prepare-only.
- **Wording is kept separate from mechanism.** Nowhere in the UI does it say Claude (except for that one entry in the agent picker,
  and a test scans the markup to assert this). The mechanism lives in `app/agents.ts`: adding a provider means adding
  one row to a table. The table contains only `claude`, because only its invocation has been measured on a real machine; everything else uses a
  **custom command** (with a `{prompt}` placeholder) — whoever uses Codex/Gemini knows its flags,
  and a one-line template beats our guesses.
- **No pushing text into the Claude Code panel.** When tested, that extension (`anthropic.claude-code`
  2.1.263) contributes 26 commands, **none of which accepts a prompt** — the only way in would be to guess its undocumented
  argument shape, and that would silently break the next time it upgrades. The terminal is a verifiable mechanism,
  and it is the one `resumeAgentSession` already uses.
- **Degradation chain**: `claude` not on PATH → copy the handoff prompt + try to bring up Claude Code's view
  (`claude-vscode.sidebar.open`, likewise read from its manifest) → if neither is available, only copy and explain.
  Never open a terminal that will only print "command not found" — that looks like our bug.

The handoff prompt comes from the same source as the other four places (`handoff.py`); a test asserts that what the button passes and what Copy handoff
copies **are the same sentence**.

**CLI availability has five states, not a boolean** (shipped in Phase 4, `extension/src/executable.ts`).
It is decided not by "is it on PATH" but by a `doctor --json` handshake: it needs no work item, no network access,
and only succeeds on versions that implement the Phase 2 envelope. Each of the five states maps to **different advice**, which is the whole reason for keeping them separate:

| Verdict | Meaning | What to say |
| --- | --- | --- |
| `ready` | Handshake succeeded | Nothing |
| `not-found` | Not on PATH, or the configured path does not exist / is not executable | Install one, or set `bugpilot.executablePath` |
| `incompatible` | Runs but does not recognize `--json` — almost always a version that is too old | Upgrade bugpilot |
| `unresponsive` | Handshake timed out. **Makes no claim at all about the version** | Try again (cold start / antivirus scan) |
| `unhealthy` | Speaks the contract, but `doctor` itself failed | Defer to the `error.code` mapping table; no separate explanation |

Lumping the last two states into `incompatible` would advise the user to upgrade a perfectly good bugpilot — a well-formed
failure envelope is precisely what **proves** that the binary implements the contract.

**Credentials take up only one key in `SecretStorage`** (`bugpilot.jiraCredentials`, whose value is the JSON
`{email, token}`). Keeping email and token in two keys means two sequential writes; if the second one fails,
a new email is left paired with an old token — a state that would be judged "configured" and injected anyway, producing a `JIRA_AUTH_FAILED` that points to the wrong
cause. One key makes saving atomic; a parse failure reads as "not configured" instead of throwing an exception from every
command.

**Four things settled after the extension shipped** (Phase 5; the code is authoritative):

1. **No bundler, hence "the host computes, the page renders".** The Webview is a separate JS context
   and cannot import `form.ts` / `progress.ts` / `artifacts.ts`. The page owns only "the form that has been filled in but
   not yet run"; everything else is computed by the host and pushed over (a single `state` message).
   A by-product is that validation, progress and artifact grouping are all testable under `node --test`.
2. **The plan's five checkboxes have one coupling, because the CLI cannot express the decoupling.** There is no
   `--skip-build-context`: Build context can only be turned off with `--only-issue-details`,
   which also turns off search, history and similar fixes. The panel therefore greys out those three and explains why —
   five independent checkboxes would display a plan that has never been run.
3. **The extension defaults to `--resume`, the opposite of the CLI default.** The CLI defaults to `--fresh` (deleting existing artifacts),
   whereas on the panel deleting requires an explicit tick plus a modal confirmation. For the reason, see Phase 3: `fresh=True` once deleted
   a `fix_summary.md` written by the agent.
4. **Retry uses `--json` rather than `--json-lines`.** The CLI's retry branch only recognizes `--json`;
   passing neither would **launch an agent in the terminal**. Passing `--json-lines` the way Run does would mean:
   all the human-readable text is discarded by the event reader (it looks like a crash), while an agent is quietly started in the background.

**Icon deviation**: inside the Webview, text glyphs (✓ ● ○ – ✕) are used rather than the Codicon font — the latter would require pulling in
the `@vscode/codicons` dependency and relaxing the CSP `font-src`. The native TreeView still uses `ThemeIcon`,
i.e. real Codicons. The intent of §5.4's "icons are Codicons only" is to avoid third-party icon sets; text glyphs
satisfy that equally well, and incidentally also satisfy "state is not distinguished by colour alone".

**Manual testing checklist**: the acceptance criteria in §5.4 that cannot be automated (four themes, three width tiers, keyboard only, restart recovery,
safety boundaries) were once captured as an executable checklist `manual_qa_phase5.md` (deleted; see git history).

---

### 5.4 UI quality standard (V1 acceptance criteria)

R8 requires the first version's interface to be polished from the start. "Polish" has an explicit definition here, and every item is acceptance-testable —
otherwise the interface work has no boundary.

#### Theme and visuals

- **Use only VS Code theme CSS variables** (`--vscode-foreground`, `--vscode-input-background`,
  `--vscode-button-background`, `--vscode-focusBorder`, etc.). **Hardcoding any colour value is forbidden.**
  Acceptance: under each of the four themes Light / Dark / High Contrast Dark / High Contrast Light,
  take a screenshot; no unreadable text, no missing borders.
- **Do not use `@vscode/webview-ui-toolkit`** — that component library is no longer maintained. Use native HTML
  controls plus theme variables; styling consistent with VS Code forms is enough.
- **Icons come only from Codicons**, the same source as the rest of the editor; no third-party icon sets.
- Do not introduce own brand colours, gradients, or rounded-corner styling. The interface should look like part of VS Code.

#### Layout

- **Usable at narrow widths**: the sidebar can be dragged down to about 200px; at that width the form must not show horizontal scrolling,
  and labels must not be truncated. Acceptance: manual testing at three widths, 200px / 300px / 500px.
- **Can be opened in the editor area**: in a wide layout, the main panel may be opened as an editor tab (`ViewColumn`),
  giving multi-field input more space. The sidebar and the editor area share the same Webview implementation.

#### Complete states (all three states covered)

Every view must have all three states designed, not just the happy path:

| View | Empty state | Loading/running | Error state |
| --- | --- | --- | --- |
| Main input panel | First-use guidance (choose input source) | Button disabled after Run + current step | Readable message mapped from `error.code` + retry entry point |
| Progress checklist | Not run yet | Lights up step by step, with each step's duration | Failed step marked red in place, with the reason shown |
| Artifact TreeView | No artifacts for this work item | Scanning | Message when `.ai/` is unreadable |
| History | No history records | — | Degrades to an empty list instead of an error when the directory is corrupted |
| CLI not installed | Install wizard (Install / Choose Executable / Retry) | Detecting | Reason detection failed |

- **Failures must be readable in place**: map `error.code` to an explanation in the user's language plus a next action,
  rather than dumping raw stderr on the user (the mapping table is delivered in Phase 4).

#### Accessibility

- All interactive controls are **keyboard reachable**, the Tab order follows the visual order, and the focus ring uses `--vscode-focusBorder`.
- Every input has an associated `<label>`; icon-only buttons have an `aria-label`.
- State changes in the progress checklist are announced via `aria-live`, not distinguished by colour alone.
- Acceptance: complete a full investigation flow using only the keyboard (without touching the mouse).

#### State persistence

- When the panel is hidden and shown again, form contents are not lost. Prefer persisting with `getState`/`setState`;
  **do not** rely on `retainContextWhenHidden` (keeping it resident in memory is expensive).
- After the extension restarts, the progress view is restored from `workflow_status.json` (JSONL only covers the lifetime of the process).

#### Webview safety boundaries

- The Webview sets a strict CSP, `localResourceRoots` is restricted to the extension directory, and remote resources are disabled.
- **The Jira token never enters the Webview.** Credentials are read from `SecretStorage` only in the extension host process
  and injected into the CLI child process as environment variables. The Webview passes only non-sensitive form fields via `postMessage`.
- The Webview does not spawn processes directly; all execution goes through the extension host, keeping the boundary of §4.1.

### 5.5 Claude Code Skill (shipped in Phase 7)

**The Skill is not a fourth entry point.** It is a thin trigger shim on top of the CLI entry point — a `SKILL.md`
tells the host agent "when to run `bugpilot` and which artifacts to read afterwards"; actual execution is still done by the host's
own Bash tool. The three-entry mental model of §1.1 is unchanged.

#### Relationship to MCP

| | Skill | MCP server |
| --- | --- | --- |
| Nature | Files (`SKILL.md` + optional reference docs) | Process + JSON-RPC (stdio) |
| What it gives the model | Instructions, flow, trigger conditions | Callable tools / prompts |
| What executes it | **The host's existing Bash / Read** | Its own implementation and permissions |
| Context cost | The frontmatter `description` is always resident; the body is read on demand | The schemas of 7 tools are resident every turn |
| Amount of change to BugPilot | **Zero** — no `--json` needed, no core stdout cleanup needed, no `mcp` dependency needed | All of the shared groundwork in §6 |
| Distribution | Drop in a directory (`.claude/skills/<name>/`) | Install dependencies + configure `.mcp.json` + manage the process |
| Cross-client | Each vendor's format is incompatible with the others | Standard protocol; any MCP client can connect |

The three things MCP genuinely adds over a Skill are exactly the reasons to keep the MCP phase:

1. **Usable in clients without shell permission** — the Skill route depends entirely on the host having Bash.
2. **Structured returns** — the agent gets the `generated_files` list and `error.code` directly,
   without parsing human-readable text printed by `print`.
3. **Cross-client standard** — Copilot Chat and other MCP clients can all connect.

#### Decision: deferred, but kept in the plan

If the goal were only "saying `please fix JR-12345` in Claude Code triggers the preparation flow", a Skill would be enough,
at a few percent of MCP's cost, and testable the same day. But V1's goals include cross-client support and a structured contract (R2 + R4),
which a Skill cannot provide, so **MCP remains V1's agent entry point, and the Skill is pushed to after V1**.

The cost of deferring should be recorded clearly: Phase 0A could have used a single `SKILL.md`, with zero changes, to validate the hypothesis "will the model prefer calling
BugPilot over grepping on its own"; validating the same hypothesis with an MCP prototype instead costs more.
This is a deliberate trade-off, not an oversight.

**Shipped** (Phase 7): `skills/bugpilot-investigate/SKILL.md`; for installation and the comparison method see
[skill_setup.md](skill_setup.md). The drift problem in the handoff text was solved as the paragraph below requires —
all four places (the CLI startup prompt, MCP `fix_bug`, the extension's Copy handoff, the Skill) now render from
`bugpilot/core/handoff.py`, guarded in both directions by `tests/test_handoff.py`,
with the extension's copy checked by a TS test that reads the Python source and compares.

The shape at the time it shipped (the draft from that time; the actual file is longer, adding a retry loop and "what to do when the command does not exist"):

```markdown
---
name: bugpilot-investigate
description: Prepare focused code context for a bug before investigating.
  Use when the user references a Jira issue key (JR-12345) or describes a bug
  and asks to fix, investigate, or analyze it — before searching the codebase.
---

1. Run `bugpilot bug <ISSUE>` (or `bugpilot bug --description "..."`).
2. Read `.ai/<ISSUE>/agent_task.md` and `bug_context.md`.
3. Complete the analysis and fix according to `agent_task.md`, and stop at the commit gate.
4. Do not commit, push, or post Jira comments on your own.
```

Note that its content heavily overlaps with the MCP prompt in §5.2 (`/mcp__bugpilot__fix_bug`) —
both are carriers of the "handoff instructions". When the Skill ships, it should share a single text source with the MCP prompt,
to keep the two from drifting apart.

### 5.6 Continuation path when not fixed

`bugpilot bug` has finished and the agent has changed code, but the bug is not fixed — this is the most common real-world path,
and all three entry points must offer a clear next step.

#### Current state: the mechanism exists; discoverability is the gap

`workflow.retry_prompt_step` already implements continuation:

```text
bugpilot retry-prompt JR-12345
  → user_feedback.md          (template for the developer to fill in "what was not fixed")
  → agent_retry_prompt.md, containing:
       · list of required-reading artifacts (lists only files that actually exist)
       · developer feedback (capped at 3000 characters)
       · summary of the previous attempt (each of the 5 result files truncated to 800 characters)
       · retry instructions (first explain why it failed, re-check where it is implemented, no large-scale refactoring)
       · delivery block + required output files + handoff prompt
```

The problem is that **nobody knows it exists**: `retry-prompt` appears only in the README command table and
the usage_guide command reference, and in `usage_guide.md` (deleted) the
"Recommended Real Workflow" section **does not mention it even once** (grep count 0).
When users finish a run and find the bug not fixed, the flow simply breaks off here.

#### Key premise: information retention is no longer a problem

Because the core follows an artifact-as-interface design, all state lives in files under `.ai/<work_item>/`,
not in the agent's session. `_previous_attempt_summary` embeds the 5 result files into the retry prompt,
and `user_feedback.md` carries the human's correction — **restarting the agent loses nothing**.

So the criterion for choosing "restart" versus "stay in the session" is **not whether information will be lost, but whether the context is right**.

#### Decision rule

| Situation | Choice | Rationale |
| --- | --- | --- |
| The agent understood correctly but did not execute fully (missed one change, did not run the tests) | Stay in the current session | The reasoning chain is still useful; restarting is wasteful |
| `bug_context.md` points to the wrong files, the keywords are inaccurate, the bug description was misread | **Restart + retry-prompt** | No amount of conversation can fix wrong input; a failed attempt left in context **anchors** the model back onto the same wrong path |
| The input changed (new hint / keywords / focus files) | **Restart** | When the input changes, the artifacts should be prepared again |

**Restart by default.** The most common reason for "not fixed" is inaccurate context, and the anchoring effect makes a session drift further off course the longer it continues.
Staying in the session is an explicit option, not the default.

#### How each entry point exposes it

**CLI** (Phase 2):

```text
bugpilot bug <ISSUE> --retry                  # generate the retry prompt + user_feedback.md
                                              # stop after first generation and wait for a human to fill it in; only a rerun after that launches the agent
bugpilot bug <ISSUE> --retry --same-session    # compromise: claude -c keeps the reasoning history + injects the corrective context
                                              # the anchoring problem remains; off by default
```

Today this takes three manual steps (run `retry-prompt` → edit the feedback → copy the prompt and paste it to the agent);
merge them into one command that reuses the existing launch logic of `agent_runner`.

**It must stop after generating `user_feedback.md` for the first time.** The template contains placeholders, not the developer's
description of the failure; handing it straight to the agent amounts to feeding it an empty correction — and that correction is the only reason this loop exists.
Only running the same command again after the feedback has been filled in launches the agent.

Discoverability is addressed at the same time: `check-results` and `delivery-check` print the next command on failure —

```text
Missing result files: fix_summary.md, test_result.md
Not fixed yet? Run: bugpilot retry-prompt JR-12345
```

**Extension** (Phase 5): a `Retry` button next to Run — it opens
`user_feedback.md` in the editor and runs `bug --retry` after the file is saved. The progress checklist reuses the same set of JSONL events.

**MCP**: **no retry tool is exposed.** The reason is that retry's input is **human feedback**, not the model's judgement —
if the agent itself finds that the bug is not fixed, it will simply keep working within the session; it does not need a tool to "retry".
Making retry a tool would amount to letting the model decide on its own "I failed, start over", which contradicts R5's human in the loop.

This also draws the boundary with `refine_investigation` (§5.2); the two belong to different loops:

```text
refine_investigation  → preparation phase: change the investigation direction, rerun retrieval   (agent may act autonomously)
retry                 → fix phase: start over once after a human gives feedback                  (must be human-triggered)
```

#### VS Code session continuation

The agent launched by bugpilot runs in a terminal (`run_agent` uses `cwd=repo_root`). Whether this session can
be carried over to the Claude extension in VS Code depends on the **cwd**: Claude Code stores sessions in directories keyed by the cwd slug,
and the terminal and the extension read and write the same location.

```text
~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl
```

- **VS Code workspace root == `repo_root`** → same slug; the terminal session is visible in the extension's history and can be resumed.
- **Different workspace root** (a parent or child directory is open) → different slug → not visible.

Two limitations: **it is not a live takeover** (resume after the terminal session has ended; two live processes writing the same transcript
is unsafe); the terminal-side equivalent is `claude --resume` / `claude -c`.

Optional enhancement: after the agent exits, take the most recently modified `.jsonl` under `~/.claude/projects/<slug>/`,
and write the session id into `.ai/<work_item>/agent_session.json`, so that both the CLI and the extension can directly offer
"resume the last agent session". **Marked as fragile** — the slug derivation rule is a Claude Code
implementation detail rather than a public contract and may break on upgrade, so it must degrade gracefully (if the id cannot be obtained, that entry point is not shown).

## 6. Shared groundwork

MCP, the Extension and non-Jira input all depend on these shared changes, which should be completed first:

1. **Introduce the domain model** — `BugSpec` / `InvestigationOptions` / `InvestigationPlan` /
   `InvestigationRequest` / `InvestigationResult`.
2. **Plan expansion and dependency resolution** — implemented only once, in core (invariant 7).
3. **Unify work item identity** — `is_jira_issue_key` / `is_work_item_id`,
   delete both copies of `looks_like_issue_key`, and update every call site in the §3.4 table.
4. **Jira / Manual input adapter** — normalize both kinds of input into `BugSpec`.
5. **Split `copilot.py`** — `collect_agent_status() -> dict` + `print_agent_status()`.
   This removes the last stdout output in core.
6. **Add `--json` and `--json-lines`** — §5.1. Purely additive; existing output is not changed.
7. **Declare the `mcp` dependency** — as an optional extra
   (`[project.optional-dependencies] mcp = ["mcp"]`), keeping the CLI and PyInstaller free of dependencies.

---

## 7. Extending the safety model

How each guarantee in [safety.md](safety.md) is maintained across the three entry points:

| Existing guarantee | Handling under the new entry points |
| --- | --- |
| Never commit/push/open a PR | MCP does not expose `commit`/`push`; the extension's commit-related commands only open `commit_plan.md` and do not run git |
| Jira gets only one optional comment | `jira-comment --execute` is not in the MCP tool list; the extension requires a confirmation dialog; simply unavailable in manual mode (§5.1) |
| `cleanup` cannot delete anything outside `.ai`/`.ai_memory/bugs` | Unchanged (`_ensure_child` lives in core); the validation function is renamed to `validate_work_item_id` |
| Outbound text is redacted via `sanitize_comment_text` | Unchanged. **New requirement**: MCP tool return values must also pass through it — tool results go straight into the model context |
| Credentials enter only via `config.py` | The extension injects them via environment variables, still through the env-first path of `config.py`; no new read points are added |

New attack surface: MCP tool return values enter the model context.

**The requirement "redact tool return values" was withdrawn after implementation.** `sanitize_comment_text` was designed for
Jira comments; in practice it corrupts `def load(key, secret_path)` into
`def load(key, <redacted>`, so the model reads a signature that does not exist; and it protects nothing —
the agent has read access to the same repository and can open that file directly. The right place for redaction is **text that leaves
this machine** (Jira comments, email), and both of those already do it.

The boundaries actually needed are two others, both guaranteed by the tool implementation in §5.2 and covered by guard tests:
**every model-supplied work item id must pass `validate_work_item_id`** (otherwise
`../../elsewhere/evil-1` would write outside the bound repository), and **every tool requires the work item
to already exist** (otherwise a plausible-looking id would create a phantom directory).

---

## 8. Packaging and distribution impact

| Artifact | Current state | After the three entry points |
| --- | --- | --- |
| wheel + pipx | `install.cmd` → `install.ps1` → pipx | Unchanged; the `bugpilot-mcp` entry point is generated only after reinstalling |
| `bugpilot.exe` (PyInstaller) | Single file, bundles its own Python | Unchanged (`mcp` goes through the optional extra and does not go into the exe) |
| VS Code extension | None | New `.vsix`. V1 does not bundle the exe (an existing CLI is required); the extension is responsible for detection, choosing the executable and giving installation guidance |

**Extension toolchain: zero build steps** (shipped in Phase 4). Node 22.18+'s native TypeScript
type stripping runs `.ts` directly, with no ts-node / tsx / jest / vitest; tests use the built-in
`node --test`. One less build layer means one less source of version hell; the cost is that TS syntax that generates code cannot be used
(parameter properties, `enum`, `namespace`) — `erasableSyntaxOnly: true` is used
to make such constructs fail at **compile time** instead of waiting for `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX` at runtime.
`engines.node` is therefore tightened to `>= 22.18`. When the `.vsix` is packaged, type stripping is handled by VS Code's bundled
Node, so no extra runtime dependencies are needed (the extension has zero runtime dependencies).

**Actual contents of the `.vsix`** (shipped in Phase 6): `vsce package --no-dependencies` +
`.vscodeignore`; the artifact is 29 files / about 75KB — only `out/` (the built CommonJS),
`media/` (page assets and the activity bar icon), `package.json` and `README.md`.
Source, tests and tsconfig are all kept out of the package. `scripts/check-package.mjs` uses `vsce ls`
to check in **both directions**: files without which the extension cannot run must be present (`out/extension.js`,
`media/panel.{css,js}`, the icons declared in the manifest), and not a single file that should not be included may be present.
The reason is that this kind of error only surfaces after installation: a missing `media/panel.js` means a blank panel,
and nothing reports an error anywhere.

**The extension's README is the extension page** (`extension/README.md`), and it also serves as the onboarding document for §9 Phase 6's
"complete the first investigation in 5–10 minutes".

**The first field of the `doctor` report is `version`** (shipped in Phase 6). Having a pipx copy,
an editable install and the exe on one machine at the same time is normal (it is the case on the development machine), so "which one am I actually running right now" must be
visible: the extension shows the version together with the resolved path at the bottom of the panel. The field may be absent — older but contract-compatible
versions do not report a version number, and its absence must not downgrade a working installation.

**V1 supported platforms**: Windows 10/11 + VS Code. Linux is best effort, to be validated once the workflow and the
adapter contract are stable. Rationale: V1 already involves pipx, `.exe`, `.cmd` shims,
VS Code, Claude CLI, PATH, SecretStorage and MCP stdio all at once; validating Linux at the same time would significantly enlarge the
test matrix.

---

## 9. Phased plan

The goal for the first version is a **Feature-rich Internal Beta**. The implementation order stays
"spike → domain model → machine API → MCP → extension infrastructure → extension UI → hardening",
i.e. stabilize the contract first, then build the interface.

### Phase 0 — two validation spikes

**0A MCP feasibility**: build only one tool, `prepare_jira_bug` (wrapping the existing
`run_bug_workflow` directly, with no prior changes needed), to validate that Claude Code, when a BugPilot tool is available,
calls it first instead of grepping on its own without constraints. `prepare_bug_description` and
`refine_investigation` depend on the domain model from Phase 1 and are not part of the spike; otherwise there would be a circular dependency.

**0B VS Code UX / design spike**: build a Webview prototype containing only the main input panel, to validate
the interaction and information hierarchy of the input form, the investigation scope checkboxes and the progress checklist, and **run the §5.4
theme matrix and narrow-width checks on the spot**. The V1 feature set is already fixed by R8, so 0B does not decide which features to build,
but it does decide the layout, the information hierarchy and the component inventory — this is the means of turning "make the interface as good as possible" into bounded work:
the component inventory is frozen in 0B, and Phase 5 only implements it, without redesigning.

Neither spike is a deliverable V1.

### Phase 1 — domain model and core

- `BugSpec` / `InvestigationOptions` / `InvestigationPlan` / `InvestigationRequest` /
  `InvestigationResult`.
- plan → `WORKFLOW_STEPS` expansion and dependency resolution (a single implementation inside core).
- work item identity unification (all call sites in §3.4).
- Jira / Manual input adapter.
- Remove the Jira coupling from the downstream workflow.
- core stdout cleanup.
- step returns structured data.
- MCP write-path restriction tests.

Acceptance:

1. The same workflow can be run with either a Jira issue or a plain description, producing the same kind of
   `.ai/<work_item>/` artifacts.
2. A local work item id looks like `local_20260901094133`, and for it `is_jira_issue_key()`
   returns `False` and `is_work_item_id()` returns `True`.
3. The whole repository has only one Jira key check and one work item id check;
   `looks_like_issue_key` / `_looks_like_issue_key` have been deleted.
4. When `InvestigationPlan` turns an item off, the corresponding step in `workflow_status.json` is marked
   `skipped` rather than `fail`; dependencies (such as `keywords`) are filled in automatically according to the table and run only once.

### Phase 2 — CLI Machine API

- Existing CLI behaviour stays compatible word for word.
- Add `--json` to 9 key commands.
- `--json-lines` event stream (reusing the existing `progress` callback).
- `schema_version = 1`; stable `error.code`.
- manual description / description-file input.
- Options parameters (hint / keywords / focus / ignore / max-files / max-search-lines)
  and Plan parameters (skip-*).
- New `bugpilot list` (§3.4 / §5.1), with `--json` as well.
- Behaviour of the Jira-related commands in manual mode (§5.1 table).
- **Closed continuation loop** (§5.6): `bug --retry` completes the three steps in a single command; `--retry --same-session`
  as an explicit option; `check-results` / `delivery-check` print the next command on failure.

Acceptance: the Extension does not parse human-readable text; live progress depends only on JSONL, not on polling files;
in the not-fixed scenario, users can find the next step from the CLI output alone (without having to consult the docs).

### Phase 3 — full MCP entry point

- `prepare_jira_bug`, `prepare_bug_description`, `refine_investigation`,
  `check_results`, `summarize_results`, `search_memory`, `get_status`.
- 1 deterministic fix-bug prompt.
- repo-bound server; the model is not allowed to pass `repo_root` freely.
- tool result sanitize.
- A recommended `CLAUDE.md` snippet written into the docs (optional enhancement, not a dependency).

Acceptance: Claude Code can enter the workflow from Jira or from a natural-language bug description;
`refine_investigation` can rerun the relevant parts with a new hint; MCP calls do not modify the source tree;
all features remain usable after the target repository's `CLAUDE.md` is deleted (R9).

### Phase 4 — VS Code Extension infrastructure

- executable discovery / selection.
- process runner (including Stop / kill).
- JSON and JSONL protocol client.
- SecretStorage.
- workspace / repo root detection.
- diagnostics and the mapping from `error.code` → user-facing messages.

### Phase 5 — full Extension UX (V1)

**All** capabilities in the §5.3 table: input source switching, title/description, hint, keywords,
focus/ignore, investigation scope checkboxes, Run/Stop, live checklist, artifact TreeView,
Markdown preview, history, Open `agent_task.md`, Copy handoff prompt,
MCP status indicator, Doctor/Agent Check/Clean, install wizard, executable configuration, SecretStorage.

Plus the interface implementation from §5.4: the Webview main panel (theme variables, narrow width, three states, a11y, state persistence, CSP)
and native TreeViews (artifacts / history).

Plus the continuation UI from §5.6: the `Retry` button next to Run (opens `user_feedback.md`, and after it is saved runs
`bug --retry`), and the session continuation entry point (shown when a session id can be obtained, hidden otherwise).

Acceptance (functional): a complete investigation flow can be finished without opening a terminal, and the user clearly knows how to hand the next step to the agent.

Acceptance (interface, going through §5.4 item by item):

1. Screenshots under the four themes Light / Dark / High Contrast Dark / High Contrast Light show no problems;
   `grep` finds no hardcoded colour values in the code.
2. No horizontal scrolling and no truncated labels at the three sidebar widths 200px / 300px / 500px.
3. A complete investigation flow done using only the keyboard.
4. Every cell of the §5.4 three-state table has a corresponding implementation (including the install wizard for when the CLI is not installed).
5. Form contents are not lost after the panel is hidden and shown again; after the extension restarts, progress is restored from `workflow_status.json`.
6. No credentials appear in the Webview; CSP and `localResourceRoots` are set.

### Phase 6 — Internal Beta hardening

- VSIX packaging and installation instructions.
- Compatibility tests for the three installation types: pipx / exe / editable.
- New-machine onboarding test.
- upgrade / version mismatch notices.
- CLI JSON / JSONL compatibility tests.
- MCP tests, Extension TS tests.
- Windows 10/11 first; Linux best effort.

**V1 acceptance criterion**: a programmer who was not involved in BugPilot development can, after spending 5–10 minutes with the README, in the target
repo complete a first Jira or manual bug investigation and successfully open `agent_task.md`
to hand it to Claude/Copilot.

### Phase 7 — migration cleanup

- `agent_runner.py` is marked deprecated in V1 and deleted after Beta feedback.
- **Ship the Claude Code Skill (§5.5)**: a single `SKILL.md`, zero Python changes,
  giving Claude Code a lighter trigger path than MCP. It shares a single source of
  handoff text with the MCP prompt in §5.2. Once done, compare the actual trigger rates of the two paths and decide whether to keep both.
- Decide based on actual usage whether to add input adapters such as GitHub Issue / Azure DevOps / clipboard /
  selected text.

---

## 10. Known costs

Recorded honestly, to avoid discovering them only after the fact:

- **The V1 extension scope is on the large side (known and accepted).** R8 requires the first version to deliver both complete functionality (18 capabilities
  in Phase 5) and a polished interface (the six groups of standards in §5.4). The risk has two layers: a long delivery cycle;
  and interaction decisions get locked in before real usage feedback arrives.
  There are three mitigations — (a) the phase order is unchanged, and the contract stabilizes first; (b) **the component inventory is frozen in 0B**,
  and Phase 5 only implements it without redesigning; (c) §5.4 is **checklist-style acceptance** rather than a subjective goal such as "looks good",
  so the interface work has a clear end point.
- **The Webview brings a separate set of engineering costs of its own.** The main panel is no longer made of native controls, which means additionally maintaining
  HTML/CSS, the Webview ↔ extension host `postMessage` protocol, CSP configuration, state serialization,
  plus regression checks for the theme matrix and a11y. None of this can reuse any of the CLI's tests.
- **The three-layer domain model adds migration cost.** Existing function signatures, artifact naming and
  tests centred on `issue_key` need to be generalized step by step to `InvestigationRequest`; Phase 1 is one concentrated change and should not be split into batches.
- **Every added workflow step** requires deciding which `InvestigationPlan` switch it belongs to,
  whether it is exposed in the three places, and how to name it.
- **Entry point overlap**: the external answer is already given by the mental model of §1.1, but it still needs to be repeated once in the README.
- **Larger documentation surface**: `docs/` already has 13 files.
- **Larger test surface**: the CLI has pytest coverage; plan dependency resolution, JSONL events, MCP tools
  and the extension TS all need new tests.
- **Double writes to JSONL and `workflow_status.json`**: the two must be semantically consistent, otherwise the progress display before and after a restart
  will disagree. A test is needed to pin down this constraint.

---

## 11. Decided and open questions

### Decided

1. **Extension V1 does not bundle `bugpilot.exe`**; the CLI must be installed, and the extension is responsible for detecting and choosing the path.
2. **MCP does not let the model pass `repo_root`**; by default the server binds to the repo/workspace root it was started in, which can be overridden by configuration.
3. **`--json` carries `schema_version` from the first version**, and the extension depends only on `error.code` and does not parse error text.
4. **`agent_runner.py` is only deprecated in V1, not deleted immediately**.
5. **Jira is demoted to an input adapter**; the manual bug description is a first-class input in V1.
6. **The domain model is split into three layers**: `BugSpec` (identity/content) + `InvestigationOptions` (retrieval configuration)
   + `InvestigationPlan` (logical scope). They are not merged into a single bloated `BugSpec`.
7. **Work item identity is fully separated**: `work_item_id` ≠ `source_ref`; the local ID
   `local_<YYYYMMDDHHMMSS>` does not masquerade as a Jira key; this voids the previous version's `LOCAL-<digits>` decision.
8. **`InvestigationPlan` expansion and dependency resolution belong to the core contract**; adapters do not reimplement them;
   the UI presents only logical capabilities, not implementation steps.
9. **Phase 2 delivers `--json-lines`**: JSONL carries live events, `workflow_status.json`
   carries persisted state.
10. **MCP replaces `search_code` with `refine_investigation`**, expressing intent rather than implementation steps;
    the low-level `bugpilot search --json` remains available in the CLI.
11. **The V1 extension delivers complete functionality + a polished interface** (R8), with no 5a/5b split and no interface downgrade;
    the scope risk is recorded in §10.
11a. **Mixed control choices**: the main input panel uses a Webview; artifacts / history use native TreeViews.
11b. **Do not use `@vscode/webview-ui-toolkit`** (no longer maintained); use native HTML +
    VS Code theme CSS variables, with icons from Codicons only.
11c. **"Polish" = the checklist-style standard of §5.4** (theme matrix, narrow width, keyboard reachability, all three states covered,
    state persistence, CSP), not visual flair; no own-brand visuals are introduced.
11d. **The component inventory is frozen in Phase 0B**; Phase 5 only implements it without redesigning.
11e. **Credentials never enter the Webview**; they are read only in the extension host from `SecretStorage` and injected into the child process.
12. **`CLAUDE.md` gets a recommended snippet but is not a dependency** (R9 / invariant 9).
13. **V1 officially supports only Windows 10/11 + VS Code**; Linux is best effort.
14. **Phase 0A builds only `prepare_jira_bug`**, avoiding a circular dependency with Phase 1.
15. **The Claude Code Skill is deferred until after V1 (Phase 7)**; it is not in V1 and is not used for the hypothesis validation in Phase 0A
    either. Rationale: the Skill depends on the host having shell permission, provides no structured returns, and its format does not work across clients,
    so it cannot provide the agent contract that R2 + R4 require; but it needs zero changes and costs very little, so it is worth adding after V1 as
    a lightweight trigger path for Claude Code (§5.5).
16. **The Skill does not count as a fourth entry point**; it is a trigger shim on top of the CLI entry point; the three-entry mental model of §1.1 is unchanged.
17. **Continuation restarts by default, and does not stay in the session by default** (§5.6). Information retention is guaranteed by the artifacts, not by the agent session;
    the selection criterion is whether the context is right, not whether information will be lost. `--same-session` is an explicit option.
18. **MCP does not expose a retry tool** (§5.6). Retry's input is human feedback; making it a tool would amount to letting the model
    decide on its own "I failed, start over", which contradicts R5. `refine_investigation` (preparation phase,
    agent may act autonomously) and retry (fix phase, must be human-triggered) are two different loops.
19. **Session continuation is an optional enhancement and must degrade gracefully** (§5.6). It depends on Claude Code's cwd-slug
    storage layout, which is an implementation detail rather than a public contract; when the session id cannot be obtained, that entry point is hidden without an error.
20. **`InvestigationOptions` V1 adds only `max_files` + `max_search_lines`** (§3.3),
    and the two are exposed as a pair (file count alone cannot keep artifact size under control). `search_scope` (semantically overlapping with
    `focus_files`/`ignore_paths`), `dependency_depth` (an independent feature
    that needs include-graph analysis) and `token_budget` (needs token-counting infrastructure, and is less effective than directly
    controlling file/line counts) all stay out of V1; the reasons are recorded in the §3.3 table.
21. **Local IDs do not get a readable slug** (§3.4). IDs must be stable while titles can change; the existing `summary_slug()`
    drops non-ASCII characters, so Chinese titles produce an empty slug, and the readability benefit is hit-or-miss. Readability is instead solved in the display
    layer: a new `bugpilot list` command (§5.1), whose `--json` the extension's History panel consumes.

### Open

1. Which detection approach should `Continue with Claude` use in different agent environments: MCP prompt,
   copy handoff, or detecting the Claude Code CLI?
2. In manual mode, who decides the body template for the degraded `notify` / `commit-plan` emails?
   (§5.1 has decided the behaviour, not the template)
3. The default scope of a `refine_investigation` rerun: fixed to code search + memory + context,
   or inferred automatically from the differences in the options passed in?
4. How the session id for `agent_session.json` is captured (§5.6): is taking the newest `.jsonl` in the directory
   reliable enough? With multiple agents running concurrently on the same repo it would pick the wrong one; it needs to be confirmed whether this is worth doing.
5. What should `--retry --same-session` be implemented with: `claude -c` (the most recent session) or
   `claude --resume <id>` (requires solving question 4 first)?
