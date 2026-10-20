# BugPilot 0.1.6 — Unified External Storage

Canonical development plan for BugPilot 0.1.6. It is the authoritative plan
for the 0.1.6 implementation, and every 0.1.6 implementation prompt must cite
it. `docs/bugpilot_prototype_development_plan.md` remains the record of
everything up to and including 0.1.5. Its §45 points here, and none of its
records are superseded or rewritten.

| | |
| --- | --- |
| **Status** | PLAN, revised after the owner's architecture review (2026-10-15). The review's recommendations are recorded in §16.1. Beyond R1–R8, the owner has APPROVED US-D32 and US-D33 for Batch 0A's scope (2026-10-15), and nine Batch 1 decisions at the Batch 1 decision gate (2026-10-16): three with conditions and one in part (§16.1). On 2026-10-18 the owner approved US-D28 with conditions, as an amended design contract for the captured review. That approves the design, not its implementation or activation (§16.5.11). The same day the owner approved US-D14 with conditions: the protected staging rule stays unchanged (rules v2), and an informational note about legacy folders is added (§16.4.1). That is also a design approval only. It also approved US-D13 with conditions: the hybrid `task.md` and retry-prompt path contract (§9.8.1), again a design approval only. And it approved US-D30 with conditions: a fixed, reviewed prompt-budget allowance for that wording, with per-golden bounds (§9.8.2), also a design approval only. It also approved US-D10 with conditions: Option D, the agent handoff (§9.5.1). Here the owner accepted the missing real-agent probe evidence for the design approval only; no agent combination is declared supported. It also approved US-D12 with conditions: the prompt gate is kept and tightened, with exact prompt preservation and TypeScript–Python parity (§9.9.1), again a design approval only. And it approved US-D17 with conditions: the CLI as the only path resolver, with validated path consumption and a read-only extension (§8.9.1), also a design approval only. **Batch 0A is COMPLETED and CI-verified.** It was committed as `8b6c567` on `main` (2026-10-16, owner-approved). CI run 38942462918 passed all 9 required checks on Linux, macOS and Windows, with Python 3.10 and 3.13 (§14.1.A, §18, §19). Batch 0 as a whole is not complete while 0B has not run. **Batch 1 is COMPLETED and CI-verified, integrated into `main` but NOT activated.** Its architecture and security review found it FAIL; the owner-authorized narrow remediation fixed it, and the owner ratified its decisions and the Q1–Q7 policies (§14.2). It was committed as `5222da7` on `verify/0.1.6-batch1` (2026-10-16, owner-approved). CI run 39003264436 on that commit passed all 9 required checks on Linux, macOS and Windows, with Python 3.10 and 3.13. The commit was then fast-forwarded into `main`, and the push to `main` ran CI again on the same commit (run 39004684594): **9/9 success** (§14.2 "Batch 1 — acceptance and CI evidence", §18, §19). No product caller uses `storage`; activation stays blocked by §14.3's preconditions, of which only the CI one is met. **Batch 2A** (the storage security foundation: G-1/G-2, G-3, cache freshness, checked global accessors) is **COMPLETED and CI-verified, integrated into `main` but NOT activated**: `e78a678`, CI run 39057483843 on `verify/0.1.6-batch2a` and run 39062906366 on `main`, both 9/9 (§14.3, "Batch 2A — acceptance and CI evidence"). No product caller uses `storage` yet. **Batch 2B-1** (inactive consumer-switch preparation: C-1, C-2's storage-side invariants, checked deletion, checks that never raise, the test-only write witness) is **COMPLETED and CI-verified, integrated into `main` but NOT activated**: `7b8914d`, and `40865cf`, which fixed the two test defects that failed its first CI run (run 39085417171, 3/9). CI run 39096347226 on `verify/0.1.6-batch2b1` and run 39097757625 on `main` were both 9/9 (§14.3, "Batch 2B-1 — acceptance and CI evidence"). No product caller uses `storage` yet, and the MCP per-tool-call request scope is NOT INTEGRATED. Its follow-up fix for concurrent data-root creation (`147e1bd`), made after main CI run 39194849242 failed 8/9, is CI-verified (branch run 39285763641 and main run 39305575297, each 9/9) and integrated into `main` (§14.3, "Batch 2B-1 follow-up"). **Batch 0B** has run P10, on 2026-10-18, in two parts: a narrowed run (direct shells and the Python launcher) and a VS Code `sendText` completion. It is **PASS for the tested Windows configuration**, with limitations (§14.1.B, "Batch 0B — probe P10, narrowed" and "Batch 0B — probe P10, VS Code sendText completion"). P7's first attempt was UNKNOWN, blocked before its tests by an in-progress VS Code update. Its retry after the update passed P7-A to P7-H on Windows, with `revealFileInOS` UNKNOWN. P2, the captured review, ran once and is FAIL against the owner's acceptance criteria. Its external reads under `dontAsk` worked; the model declined to echo the marker and requested Bash, which was refused (§14.1.B, "Batch 0B — probe P2, captured review"). Every other probe is NOT EXECUTED. Batch 2B-2 to 2B-6 and Batches 3–5 have **NOT STARTED**. On 2026-10-19 the owner recorded the Batch 2B-2 decision gate (D-1 to D-9): US-D2 approved with conditions, US-D29 and US-D22 approved in part, and Batch 2B-2 specified for implementation, which is not yet authorized (§14.3, "Batch 2B-2 — decision gate"). The owner then answered Q-1 to Q-6, and the contract was resolved, with choices C-1 to C-5 still open (§14.3, "Batch 2B-2 — final contract resolution"). The owner approved C-1 to C-5 the same day. Batch 2B-1 stays COMPLETED, NOT ACTIVATED, and Batch 2B-2's implementation has NOT STARTED. |
| **Created** | 2026-10-15, by a read-only audit of the working tree at `ee3fb00` (`main`, released 0.1.5) |
| **Revisions** | **r1** (2026-10-15): created from the read-only audit. **r2** (2026-10-15): architecture review. It changed: <ul><li>the decision recommendations (§16.1);</li><li>the test-isolation redesign (§11.1);</li><li>Batch 0 split into 0A and 0B (§14.1);</li><li>the repository scope and its diagnostic (§7.1);</li><li>the exact JSON contract (§8.10);</li><li>the safer-launch evaluation (§9.9) and the handoff acceptance (§9.10);</li><li>the integration gates (§15.4) and the US-D14 options (§16.4).</li></ul> |
| **Target version** | 0.1.6 (the version in the tree stays 0.1.5 until Batch 5's bump) |
| **Nature** | An intentional breaking change of where BugPilot keeps its data. No migration and no legacy fallback (R4). |
| **Maintenance** | Updated after every batch: the batch status table (§14.0), the decision log (§16.1), the progress log (§18) and the commit/CI log (§19). |

Status labels used throughout:

- **APPROVED**: a fixed requirement or an owner decision. An approval may be qualified: **APPROVED — with conditions** (the conditions must be met before the gate they name) or **APPROVED — in part** (only the stated part is approved; every other part stays OPEN or PROPOSED and is named). §16.1 defines both.
- **PROPOSED**: this plan's recommendation; it needs owner approval before the batch that depends on it.
- **OPEN**: a real choice with alternatives; the owner decides.
- **DEFERRED**: out of 0.1.6, recorded so that it is not lost.

Nothing marked PROPOSED or OPEN is a decision yet.

A **review recommendation** (§16.1, since r2) is the architecture review's technical advice: *Accept*, *Accept conditionally*, *Keep open* or *Defer*. It is not an owner decision. An entry becomes APPROVED only when the owner says so explicitly, and §16.1 records the date.

---

## 1. Executive summary

BugPilot keeps its data in four places today:

- `<repo>/.ai/<work-item>/`: the work-item package.
- `<repo>/.ai_memory/bugs/`: similar-fix memory.
- `<repo>/.bugpilot/`: repository settings, Fix Modes and the Repository Profile.
- `~/.bugpilot/`: credentials, User Instructions and user Fix Modes. `BUGPILOT_CONFIG_DIR` can relocate it.

The repository-local paths are not configuration that a few modules read:

- **Python:** 226 path-literal lines in 39 production modules.
- **TypeScript:** 17 code lines in the extension compute `.ai` paths themselves, and 19 lines name `.bugpilot` files.
- **Agent-facing text:** the paths are part of the agent contract. That covers:
  - the one-line handoff;
  - five protected `task.md` sections;
  - the retry prompt;
  - the review prompt;
  - the MCP tool results;
  - the Claude Code skill.
- **Tests:** about 720 test lines in 55 Python test files pin them, plus 31 golden files and the cross-language handoff tests.

**What 0.1.6 does.** Every BugPilot-owned persistent file moves under one user-level root:

```text
~/.bugpilot/
├── config/                       global configuration (credentials, User Instructions, user Fix Modes)
└── repositories/<repository-id>/ one namespace per repository
    ├── repository.json           the identity record
    ├── settings/                 what <repo>/.bugpilot/ held
    ├── work/<work-item-id>/      what <repo>/.ai/<work-item-id>/ held
    └── memory/                   what <repo>/.ai_memory/bugs/ held
```

- **No reads from the old locations.** 0.1.6 never reads or writes `<repo>/.ai/`, `<repo>/.ai_memory/` or `<repo>/.bugpilot/`.
- **No migration.** It never imports, copies, renames or deletes anything from those folders, or from the 0.1.5 files in `~/.bugpilot/`.
- **The repository stays clean.** It is the agent's working directory, and BugPilot writes nothing into it.

**The three hard parts:**

1. **Agent handoff (§9).**
   - **Current state.** Agents read `task.md`, `context.md`, `retrieval.json` and the attachments, and write `fix_report.md`, through repository-relative paths.
   - **What changes outside the repository:**
     - Claude Code asks before reading or writing there.
     - Copilot CLI asks too.
     - Codex reads freely but needs approval to write.
     - The extension's shell-safety gate refuses absolute paths that contain a backslash, `~` or non-ASCII letters.
   - **Provisional recommendation** (US-D10 stays OPEN until the Batch 0B probes and §9.10's acceptance). *(Decided on 2026-10-18: Option D, approved with conditions as a design, with the probe gap accepted for design only: §9.5.1.)*
     - the absolute work-folder path in the prompt and in `task.md`, with each agent's own permission prompts left as they are;
     - the existing copy-to-clipboard paths as the fallback;
     - a narrow `--add-dir` grant only as an explicit opt-in, deferred for now.
2. **Repository identity (§7).** The ID is `<slug>-<16 hex of SHA-256>`, computed over the canonical real path of the directory BugPilot runs in. It resolves symlinks and junctions (and is expected to resolve `subst`, NOT VERIFIED: §7.3), and folds case on Windows only. The rule is "prefer split over merge": an unusual spelling may open a second namespace, but two repositories never share one. A `repository.json` record detects the impossible-in-practice hash collision and refuses it.
3. **Team-shared settings (US-D9).** Project Instructions, the Verification Policy, AI Behavior, the Repository Profile, branch naming and project Fix Modes were designed to be committed with the code. R4 forbids reading `<repo>/.bugpilot/`, so in 0.1.6 they become per-user, per-repository settings. This is the largest product consequence of the change, and the owner must accept it explicitly.

**Plan shape (§14).** Six batches, with Batch 0 in two separately authorized scopes:

| Batch | Content |
| --- | --- |
| 0A | test isolation with a fail-closed guard, inventory ratchet, synthetic baselines; no agent accounts |
| 0B | live agent capability probes, separately owner-authorized; outcomes PASS, FAIL or UNKNOWN |
| 1 | storage foundation |
| 2 | the Python switch: CLI, MCP, prompts |
| 3 | extension and handoff |
| 4 | security and cross-platform validation |
| 5 | UX, docs, packaging, readiness |

- **Where each batch lands (§15):**
  - Batches 0A and 1 are test-only or additive, and can land on `main`.
  - Batches 2–4 change shared CLI/extension contracts. They stay on `verify/0.1.6-storage` until integration is complete (§15.4), and reach `main` only by an owner-approved fast-forward after all nine CI checks are green.

**Readiness.** The plan is ready for owner decisions.

- **Decisions (§16.1).** The owner approved US-D32 and US-D33 for Batch 0A (2026-10-15), and at the Batch 1 decision gate (2026-10-16) US-D1, D3, D6, D7 and D24; US-D5, D23 and D34 with conditions; and US-D26 in part. On 2026-10-18 the owner approved, with conditions, US-D28 as an amended design contract (§16.5.11), US-D14 as Refined Option A′ (§16.4.1), US-D13 as the hybrid task-document contract (§9.8.1), US-D30 as Option D, a fixed prompt-budget allowance (§9.8.2), US-D10 as Option D, the agent handoff, with the probe gap accepted for design only (§9.5.1), US-D12 as Option C, the prompt gate kept and tightened (§9.9.1), and US-D17 as Option B, the CLI as the only path resolver (§8.9.1). On 2026-10-19, at the Batch 2B-2 decision gate, the owner approved US-D2 with conditions, and US-D29 and US-D22 in part (§14.3, "Batch 2B-2 — decision gate"). 14 still await the owner: 7 OPEN and 7 PROPOSED. 4 items are DEFERRED.
- **The 2026-10-15 architecture review recommends:**

  | Recommendation | Count | Decisions |
  | --- | ---: | --- |
  | Accept | 28 | |
  | Accept conditionally | 2 | US-D5, US-D26 |
  | Keep open | 3 | US-D10, US-D14, US-D28 |
  | Defer | 2 | US-D11, US-D20 |

  None of these is an approval.
- **Batch 0A** can be authorized on its own; it needs US-D32 and US-D33.
- **Batch 2,** the storage-changing batch, cannot begin until:
  - US-D10 is decided, from Batch 0B evidence (US-D28 was decided on 2026-10-18: §16.5.11) *(US-D10 decided on 2026-10-18 as a design, with the probe gap accepted for design only: §9.5.1)*;
  - US-D14 is decided (§16.4) *(decided on 2026-10-18: §16.4.1)*;
  - the §8.10 contract is approved (approved in part on 2026-10-16; its open parts are decided before they are built).

The seven with the widest product consequences are:

| Decision | Topic |
| --- | --- |
| US-D2 | global config location |
| US-D3 | the data-root variable |
| US-D4 | what "the repository root" is |
| US-D9 | team settings |
| US-D10 | handoff |
| US-D13 | `task.md` path text |
| US-D14 | the protected staging rule |

---

## 2. Approved requirements

These are the owner's fixed requirements. Every one is **APPROVED**.

| Id | Requirement | Plan sections |
| --- | --- | --- |
| **R1** | **Unified external storage.** All BugPilot-generated data lives outside the source repository, under a user-level root, `~/.bugpilot/` by default, resolved through the platform's home-directory API and never hard-coded. | §6, §8 |
| **R2** | **One root.** It holds global configuration, repository registrations, repository settings, work-item artifacts, similar-fix memory, caches and indexes, and other BugPilot-owned persistent data. Temporary files may use private temporary locations, but never create persistent BugPilot state inside the repository. | §6 |
| **R3** | **Repository isolation.** Each repository has its own namespace. Two repositories may use the same Jira key, local id or branch name without colliding. The Repository ID is stable, based on the normalized root, and handles collisions. No relocation or automatic identity merging unless approved later. | §7 |
| **R4** | **No legacy compatibility or migration.** BugPilot never loads or writes `<repo>/.ai/`, `<repo>/.ai_memory/` or `<repo>/.bugpilot/`. `~/.bugpilot/config.toml` and `~/.bugpilot/instructions.md` may move. Nothing is imported, renamed, copied, merged or deleted, and legacy folders are left untouched. There are no temporary readers or migration utilities. The breaking change and the reconfiguration it needs, Jira credentials included, are documented. | §13 |
| **R5** | **The repository stays clean.** BugPilot creates no persistent BugPilot-owned directory under the repository. The developer's own files, build outputs and an agent's intended source edits are outside this requirement. | §10.2 (T-S20), §11.3 |
| **R6** | **Product capabilities are preserved.** These must all keep working: <ul><li>Jira and hand-written intake</li><li>Build Context, Fix with AI, AI Session launch and reopen, retry</li><li>Artifacts, History, review and verification</li><li>Fix Modes, Project and User Instructions, Verification Policy, AI Behavior, Protected Rules, Repository Profile</li><li>Git History Retrieval, Similar Fix Memory</li><li>MCP tools, Managed Runtime, CLI and extension integration</li></ul>Storage paths may break; no unrelated feature is removed. | §4, §9.10, §14 |
| **R7** | **Security guarantees are preserved.** <ul><li>prompt-boundary containment and the Protected Evidence Rules;</li><li>credentials born `600`;</li><li>final-component link refusal;</li><li>atomic writes and temp-file safety;</li><li>no credential disclosure;</li><li>read-only previews;</li><li>safe MCP and CLI output;</li><li>hostile path components;</li><li>per-OS behaviour.</li></ul>No invariant weakens. | §10 |
| **R8** | **No automatic agent permission expansion.** Agent filesystem permissions are never widened silently, and the repository stays the agent's working directory. | §9 |

---

## 3. Explicit non-goals

- **No migration.** No import, copy, merge, rename or delete of 0.1.5 data. **No legacy fallback** reader of any kind (R4).
- **No relocation or identity merging.** No tooling to follow a moved repository, no merging of two namespaces, and no automatic re-association of a subdirectory, moved repository, clone or worktree with another namespace (US-D8, DEFERRED; §7.1).
- **No git-root discovery.** The repository scope stays the directory BugPilot runs in (US-D4). Only a diagnostic notes a subdirectory (§7.1).
- **No team sharing.** No mechanism to share repository settings across a team in 0.1.6 (US-D9; a later design, DEFERRED).
- **No repository scanning.** No "Repository Intelligence" scanning, indexing or cache layer. The proposed layout has no `cache/` directory, because nothing would use it (US-D1).
- **No OS credential store.** No move to the Windows Credential Manager or macOS Keychain; the existing `TokenStore` seam stays (DEFERRED, US-D35).
- **No broad redesign.** No broad Settings redesign, and no new panel feature beyond storage status and diagnostics (§16 of the brief).
- **No cleanup tooling.** No retention or garbage collection of orphaned repository namespaces (DEFERRED, US-D38).
- **No XDG paths.** No `$XDG_DATA_HOME` or platform-native application-data directory (DEFERRED, US-D37).
- **No sandbox changes.** No change to agent sandbox modes, and no default `--add-dir` grant (R8).
- **No unrelated changes.** No change to retrieval, ranking, Context Quality, prompt-boundary containment or the protected rules' meaning.

---

## 4. Current architecture audit

### 4.1 Method

- **Static inspection only.** Nothing that writes was run against the developer's configuration or repository.
- **Coverage:**
  - every production Python module;
  - the extension's `src/` and `media/panel.js`;
  - `package.json`;
  - the Python and TypeScript test suites;
  - the golden and baseline files;
  - `.github/workflows/`;
  - `skills/`, `scripts/` and the public docs.
- **Text search was followed by tracing the data flow** through:
  - the path helpers and artifact writers;
  - work-item lookup;
  - History, review, verification and retry;
  - memory and Git History;
  - the MCP entry points;
  - agent launch, CLI argv and the prompt renderers.
- **External agent capabilities** (§9.2) come from the vendors' current documentation. Live behaviour is listed as unverified wherever it was not observed.
- **Starting point.** The audit started on `main` at `ee3fb005f3befa36e187da05011b8b98c72d12f1`. The working tree had:
  - `docs/bugpilot_prototype_development_plan.md` modified (+667/−3: the uncommitted 0.1.5 post-release records);
  - untracked `.bugpilot/ai_behavior.md`, `.bugpilot/verification.md` and `.vscode/extensions.json`.

  `.ai/`, `.ai_memory/` and `.bugpilot/` exist locally and are not tracked (the first two are git-ignored). They were not opened or modified.

### 4.2 How a path is decided today

**Repository root:**

| Entry point | Root | Where |
| --- | --- | --- |
| CLI | `Path.cwd()`: the working directory, **not** the git top-level. Running from a subdirectory writes `.ai/` there. | `bugpilot/cli.py:747` |
| MCP | explicit argument, then `BUGPILOT_MCP_REPO_ROOT`, then `os.getcwd()`, `resolve()`d once at startup | `bugpilot/mcp_server.py:118-126`, `:333-337` |
| Extension | the workspace folder that holds a `.git` **directory**. With several candidates, the developer picks one, and the pick is stored in `workspaceState["bugpilot.repoRoot"]`. Worktrees and submodules (where `.git` is a file) are not recognized. | `extension/src/workspace.ts:43-60`, `extension/src/host/host.ts:36-45`, `extension/src/app/environment.ts:87-102` |
| Extension → CLI | every CLI spawn, terminal and agent runs with `cwd = root` | `extension/src/extension.ts`, `controller.ts:2264`, `:3007`, `:5460`, `:5531` |

**Work items and memory: the Python chokepoints.** These are in `bugpilot/core/config.py`:

| Line | Function | Behaviour |
| --- | --- | --- |
| 203–205 | `issue_dir(repo_root, id)` | returns `repo_root / ".ai" / id` (read side) |
| 208–219 | `writable_issue_dir(repo_root, id, create=)` | validates the id, then `safe_paths.writable_dir(repo_root, (".ai", id))` |
| 233–234 | `memory_dir(repo_root)` | returns `repo_root / ".ai_memory" / "bugs"` |
| 237–242 | `writable_memory_file(repo_root, id)` | the memory file, checked like `writable_issue_dir` |

`issue_dir` has 29 call sites and `writable_issue_dir` 12; most artifact I/O goes through these four. **Twelve sites build the path themselves instead:**

- `cli.py:1046`, `:1149`, `:1313`, `:1387`, `:1895` (`list`), `:2922`, `:2931`
- `workflow.py:2219`
- `context_preview.py:168`
- `task_preview.py:124`, `:223`
- `cleanup.py:42-43`

**Repository settings.** Each module joins `repo_root / ".bugpilot"` itself:

| Module | Lines |
| --- | --- |
| `instructions.py` | `:148-149` |
| `verification.py` | `:149-150` |
| `ai_behavior.py` | `:138-139` |
| `project_settings.py` | `:107-108`, `:115` |
| `repository_profile.py` | `:145-146`, `:215` |
| `fix_mode_store.py` | `:276-286` (`.bugpilot/fix_modes`) |

The same files also define three separate `PROJECT_CONFIG_DIR = ".bugpilot"` constants: `instructions.py:56`, `project_settings.py:60` and `repository_profile.py:57`. `fix_mode_store.py:49` names the same folder again as `FIX_MODE_DIR_NAME`.

**User configuration:**

- `user_config.user_config_dir()` (`user_config.py:44-53`) returns `BUGPILOT_CONFIG_DIR` or `Path.home() / ".bugpilot"`. The following hang off it:
  - `config.toml` (`:56-57`);
  - User Instructions (`instructions.py:144-145`);
  - user Fix Modes (`fix_mode_store.py:272`, `:280`).

**The extension builds its own `.ai` paths.** The CLI never sends one. The sites:

- `controller.ts:5186-5188` `#itemFile`, plus the direct joins at `:2993`, `:3339`, `:3442`, `:3506`, `:5110`;
- `host/ports.ts:65-72`, `:194-218`, `:228-266`, `:494`;
- `app/sessionReset.ts:173-313`.

It also builds `.bugpilot` paths for the policies it opens in an editor (`controller.ts:3846`, `:4252`), and watches that folder (`:4379`, `ports.ts:506-570`).

### 4.3 What reads and writes what (data flow)

**The CLI `bug` pipeline** (`workflow.run_investigation`):

- `_prepare_issue_dir` (`workflow.py:1891-1893`) is called by every step.
- `issue.json` → `save_issue` (`issue.py:305-316`).
- `retrieval.json` → `save_retrieval` (`retrieval.py:268-277`). Git History's record is written into it by `_record_git_history` (`workflow.py:1049-1071`). There is no separate Git History file and no cache.
- `context.md` (`workflow.py:1162-1171`).
- `task.md` (`:1393-1412`, `:1427-1449`).
- `run.json` (`run.py`). Its `generated_files` holds `.ai/<id>/…` strings (`workflow.py:2206-2222`).
- Attachments are copied into `<work>/attachments/` (`attachments.py`). Ownership is recorded in `issue.json` `guidance.attachment_files`.
- Memory entry: `add_memory_entry` (`memory.py:43-47`) via `workflow.py:1743-1750`. The entry text embeds `.ai/<id>/context.md` and `.ai/<id>/retrieval.json` (`memory.py:24-40`).

**Agent outputs:**

- `fix_report.md`: the agent writes it, as `task.md` tells it to (`prompts.py:287`, `:429`, `:445`), or `manual-result` writes a template (`workflow.py:1860-1880`).
- Readers of `fix_report.md`:
  - `check-results`, `summarize-results`, `memory update`, `jira-comment-draft`, email;
  - MCP `check_results` / `summarize_results`;
  - the extension (`controller.ts:6529-6536`).

**Review and verification:**

- `record-review` → `review_report.md` (`review_report.py:121-137`).
- `record-verification` → `verification_report.md` (`verification_report.py:290-305`).
- `review-package` builds the reviewer prompt, which names `.ai/<id>/…` (`workflow.py:2400-2407`).

**Retry:**

- `retry_prompt_step` (`workflow.py:1830-1850`) writes `user_feedback.md` (template) and `agent_retry_prompt.md` (`_build_retry_prompt`, `:1956-2069`).
- The **extension** also writes `user_feedback.md` itself, non-atomically. It does so through `writeWorkItemFile` (`sessionReset.ts:280-313`), which `mkdir`s `<root>/.ai/<id>` if it is missing.

**History:**

- `bugpilot list --json` lists `<root>/.ai/` (`cli.py:1889-1929`) and returns ids, source, title and prepared.
- The extension then reads, per id, `<root>/.ai/<id>` itself (`ports.ts:228-266`):
  - it stats the folder for its modified time;
  - it lists the folder and reads `run.json`.

**Reset Session and clean:**

- The extension checks `<root>/.ai/<id>` for links (`sessionReset.ts:190-225`), then calls `bugpilot clean`. `clean` checks every component again through `safe_paths.owned_path` (`cleanup.py:30-58`).

**Previews:**

- `task-preview` and `context-preview` read without writing. They refuse a linked `.ai`, a linked work-item folder, or a linked `issue.json` (`task_preview.py:124-132`, `:214-228`; `context_preview.py:168-172`).

**MCP:**

- Writes go through `workflow`. The tool results return `issue_dir: ".ai/<id>"`, `agent_task: ".ai/<id>/task.md"` and a `next_step` sentence naming both (`mcp_server.py:231-280`).
- The model reads those paths with its own tools.

**Settings:**

- The extension edits every setting through the CLI. Two exceptions: it opens `.bugpilot/verification.md` and `.bugpilot/ai_behavior.md` in an editor tab for the developer to edit and save directly (§5.1, F09/F10).
- The extension never touches `~/.bugpilot`. The Jira email and token are in SecretStorage and reach the CLI as `JIRA_EMAIL`/`JIRA_TOKEN` (`extension/src/secrets.ts:44-45`, `:125-129`). Only the site is written to `config.toml`, through `bugpilot jira-site set`.

### 4.4 Findings the audit surfaced (beyond the move itself)

| Id | Finding | Evidence | Disposition |
| --- | --- | --- | --- |
| **SF-1** | The project-settings and repository-profile payload files use a plain `writeFile`, with no exclusive create and a pid/time/6-character name. This is the class of issue 0.1.5 fixed for the Fix Mode payload (F10). | `extension/src/app/projectSettings.ts:178-182`, `repositoryProfile.ts:195-199` | **OPEN (US-D39):** fold into Batch 4 by routing both through `scratchFile.ts` |
| **SF-2** | The extension writes `user_feedback.md` non-atomically, and creates the work-item folder itself. | `sessionReset.ts:280-313`, `ports.ts:65-72` | Removed by US-D18 (the CLI owns the write) |
| **SF-3** | Fix Mode store errors and `issues[].path` carry absolute paths, and the panel shows them (F12 class). After the move they contain the home directory. | `fix_mode_store.py:312-315`, `:569-572`; `media/panel.js:4637` | Batch 2: display form (US-D22) |
| **SF-4** | Credentials and evidence will share one tree. An agent grant wider than one work folder (for example "allow `~/.bugpilot` for this session") would expose `config/config.toml`. | §10 T-S9 | Mitigated by design: named work folder, narrow optional grant, `config/` separate. Docs warn. |
| **SF-5** | The deeper tree brings Windows `MAX_PATH` (260) closer for long attachment names. | §12 | Batch 4 test; slug capped at 24 characters (US-D5) |
| **SF-6** | The default root `~/.bugpilot` already exists on upgraded machines, created by the umask (often `755`) and holding the 0.1.5 files. | `user_config.py:127`, §44.22 residual risks | New subfolders are created `0700`; the existing root is not re-moded (US-D23) |
| **SF-7** | The task-size gate leaves about 24 characters of headroom (median 3,090 against a 3,096 ceiling). | `tests/test_task_golden.py:272-278` | US-D13 / US-D30 |
| **SF-8** | Test isolation is incomplete. Only `BUGPILOT_CONFIG_DIR` is isolated; some goldens render at collection time; module-scoped fixtures run before isolation; CI sets no `HOME`; the extension's integration tests are not isolated. After the move, these would write into the developer's real `~/.bugpilot/repositories`. | `tests/conftest.py:13-17`, `tests/test_prompt_boundary_golden.py:14`, `extension/test-integration/cli.integration.test.ts:70-73` | Batch 0A, before any storage switch (US-D32, revised design in §11.1) |
| **SF-9** | `--launch-agent`'s failure hint says "complete the workflow" for a retry, where the canonical sentence is "continue the workflow". | `cli.py:1595`, `:1603-1604` | Fixed in passing in Batch 2 |
| **SF-10** | `scripts/send-via-outlook.ps1` reads `.ai/$Issue/email_draft.md` relative to the current directory. | `scripts/send-via-outlook.ps1:6`, `:39` | Batch 2 |

---

## 5. Complete path inventory

### 5.1 How to read the inventory

- **Grouping.** Each row is a *path family*: one location or one kind of file, and every call site that reaches it. Repetitive call sites are grouped; edge cases that behave differently get their own row or note.
- **Columns.** Table A covers what the location is (items 1–8 of the brief). Table B covers what happens to it (items 9–14). They share the family id.
- **Migration.** Item 12 is "Migration requirement", and it is **NONE for every row** (R4). Table B therefore has no migration column; this note records the requirement once.
- **Line references.** These are in §5.4.

**Totals measured.**

*Production Python:*

| Pattern | Lines |
| --- | ---: |
| `.ai/` | 131 |
| `".ai"` | 16 |
| `.ai_memory` | 30 |
| `.bugpilot/` | 51 |
| `".bugpilot"` | 5 |
| `~/.bugpilot` | 13 |

- In all: 226 lines across 39 modules, led by `cli.py` (66) and `workflow.py` (38).

*Extension production (`src/` and `media/panel.js`):*

| Pattern | Lines | of which code or string (not comment) |
| --- | ---: | ---: |
| `.ai/` | 62 | 17 |
| `.ai_memory` | 8 | 6 |
| `.bugpilot` | 73 | 19 |

*Tests:*

- **Python:** 720 matching lines in 55 files. At least 395 of 1,768 test functions reference a path literal directly.
- **Extension `test/`:** 117 lines with `.ai/`, 60 with `.ai_memory`, 84 with `.bugpilot`.
- **Extension `test-integration/`:** 3, 3 and 17 lines respectively.

*Goldens:*

| Family | Files | Note |
| --- | ---: | --- |
| task | 17 | 93 `.ai/`, 17 `.ai_memory`, 6 `.bugpilot` mentions |
| context | 4 | |
| context_0.1.4 | 4 | frozen |
| retry | 3 | |
| retry_0.1.4 | 3 | frozen |

*Public docs* (lines that mention a path):

| File | Lines |
| --- | ---: |
| `README.md` | 24 |
| `docs/architecture.md` | 32 |
| `docs/safety.md` | 21 |
| `docs/adapter_design.md` | 15 |
| `extension/README.md` | 31 |
| `extension/CHANGELOG.md` | 16 (history; not rewritten) |

**Batch 0A reconciliation (2026-10-15).** The line counts above were re-measured on the unchanged production sources by the same method, and they match exactly:

- **Python:** 131 / 16 / 30 / 51 / 5 / 13 lines; 226 lines in 39 modules.
- **Extension:** 62 / 8 / 73 lines.

The ratchet (`tests/storage_inventory.json`, §11.2) records a finer measure: occurrences per file and per pattern family, across 71 files. No family turned up that §5 lacks.

| Family | Occurrences | Files |
| --- | ---: | ---: |
| `ai-dir` | 245 | 47 |
| `ai-memory` | 39 | 16 |
| `bugpilot-dir` | 115 | 27 |
| `home-bugpilot` | 18 | 11 |
| `config-dir-env` | 5 | 3 |
| `agent-instruction` | 17 | 11 |
| `path-helper` | 104 | 25 |
| `path-constant` | 106 | 21 |
| `home-lookup` | 3 | 3 |

### 5.2 Table A — what each location is

Abbreviations: R = read, W = write, D = delete, O = opened in an editor, L = named to an agent or launch.

| Id | (1) Current location | (2) Responsible module / function | (3) R/W/D | (4) Consumers | (5) Secrets | (6) User / model data | (7) Security expectation today | (8) Ownership and lifecycle |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **F01** | `<repo>/.ai/<id>/` (the folder) | `config.issue_dir` / `writable_issue_dir`, `safe_paths.writable_dir` / `owned_path`, `workflow._prepare_issue_dir`; extension `sessionReset.ts`, `ports.ts`, `controller.ts #itemFile` | R W D | every step; `list`, `status`, previews; MCP; extension (History, Results, Reset Session, watchers) | no | yes, both | id validated (`identity.WORK_ITEM_ID_RE`); every component checked for links (`.ai`, `<id>`); refused rather than followed; the repo root may be a link | created by the first step; kept by default; removed by `clean`, `--fresh` and Reset Session |
| **F02** | `<id>/issue.json`, `retrieval.json` (with Git History's `git_history` section), `context.md`, `task.md`, `run.json` | `issue.save_issue`, `retrieval.save_retrieval`, `workflow` context and prompt steps, `run.py` | R W | the pipeline, `task-preview`, `context-preview`, MCP, extension (direct reads), the agent (task, context, retrieval) | no | Jira and hand-written evidence; BugPilot's prompts | atomic writer (`artifact_io.atomic_write_text`): temp in the same folder, `_check_temp`, rename; new files `600`; a link at the file refused | rewritten per run; `run.json` holds runtime state only |
| **F03** | `<id>/fix_report.md`, `review_report.md`, `verification_report.md` | the agent; `manual_result_step`; `review_report.record_review_report`; `verification_report.record` | R W | check/summarize/memory update/Jira draft/email; MCP; extension; retry prompt; captured review | no | model output; developer-recorded results | atomic writer for BugPilot's writes; the agent writes with its own tools | the agent's report is replaced per attempt; review and verification records refuse overwrite without `--replace` |
| **F04** | `<id>/user_feedback.md`, `agent_retry_prompt.md` | `retry_prompt_step`; `_build_retry_prompt`; **extension `writeWorkItemFile`** (writes feedback directly, non-atomically) | R W O | the retry agent; the developer (edits feedback) | no | developer text; BugPilot prompt | Python: atomic, link-checked. TS: lstat checks, plain `writeFile` (SF-2) | per retry |
| **F05** | `<id>/jira_field_report.md`, `jira_comment_draft.md`, `jira_comment_post_result.json`, `jira_comment_on.flag`, `email_draft.md`, `notification.eml` | `jira_validate_step`, `jira_comment_draft_step`, `jira_comment_step`, `notify_step`, the `--jira-comment` marker; `scripts/send-via-outlook.ps1` (reads the draft) | R W | the developer; `jira-comment --execute`; Outlook script | no (sanitized) | derived from artifacts | atomic writer | on demand |
| **F06** | `<id>/attachments/<name>` | `attachments.copy_attachments`, `remove_attachments`, `listed_attachments`, `attachment_names`; ownership in `issue.json` `guidance.attachment_files` | R W D | `task.md` (by path); the agent (opens the files) | possibly (the developer's files) | developer files | `refuse_link`; byte copy; 10 files of at most 10 MB; names written with visible escapes (N3) | replaced with `--replace-attachments`; removed with the folder |
| **F07** | `<repo>/.ai_memory/bugs/<id>.md` | `memory.add_memory_entry`, `search_memory`; `config.memory_dir` / `writable_memory_file`; `memory_update_step`; `cleanup` (`--include-memory`); MCP `search_memory` | R W D | the Similar Fixes step (scores every entry); MCP; `delivery-check` | no | earlier AI and run output | link-checked at `.ai_memory` and `bugs`; atomic writer | outlives the work item; removed only by `clean --include-memory` |
| **F08** | `<repo>/.bugpilot/instructions.md` (Project Instructions) | `instructions.project_instructions_path`, `read_instructions`, `save_instructions`; CLI `instructions` | R W D | every `task.md`; `task-preview`; extension (through the CLI) | no | team- or developer-written | `link_problem` refuses a link at the folder or the file; 20,000-character cap; atomic writer | **designed to be committed** (`instructions.py:7-8`) |
| **F09** | `<repo>/.bugpilot/verification.md` | `verification.verification_path`, `save_verification`, `remove_verification`; CLI `verification` | R W D O | `task.md`; extension (stat, lstat and **editor open** at `controller.ts:4252`, `:4296`; watcher) | no | team-written | as F08, plus a strict front-matter parser and lint | committed by design |
| **F10** | `<repo>/.bugpilot/ai_behavior.md` | `ai_behavior.ai_behavior_path`, `save_ai_behavior`, `remove_ai_behavior`; CLI `ai-behavior` | R W D O | `task.md`; extension (editor open at `controller.ts:3846`, `:3887`) | no | team-written | as F09 | committed by design |
| **F11** | `<repo>/.bugpilot/project_settings.json` | `project_settings.settings_path`, `save_project_settings`; CLI `project-settings` | R W | `task.md` (branch template, legacy switches); extension (through the CLI) | no | team settings | link check of `.bugpilot` and the file; atomic writer | committed by design |
| **F12** | `<repo>/.bugpilot/repository_profile.json` | `repository_profile.profile_path`, `save_repository_profile`; CLI `repository-profile` | R W | `task.md` Repository Context | no | team facts | as F11 | committed by design (`cli.py:1957-1958`) |
| **F13** | `<repo>/.bugpilot/fix_modes/<id>.json` | `fix_mode_store.FixModeStore.scope_dir("project")`, create, update, delete | R W D | the effective registry; `task.md`; MCP `list_fix_modes`; extension (through the CLI) | no | team workflows | refuses a link at the folder or its parent; resolved-parent containment; refuses a link at the file | committed by design (`fix_mode_store.py:6`) |
| **F14** | `~/.bugpilot/config.toml` (or `BUGPILOT_CONFIG_DIR/config.toml`) | `user_config.load_user_config`, `save_user_config`, `save_jira_site`; `setup`; `jira-site` | R W | `config.load_config` (every command), `doctor` | **YES: the Jira token** (CLI setup); the extension keeps the token in SecretStorage and writes only the site | credentials | private atomic write (`600` from birth, no POSIX in-place fallback); a link at the file refused (O4); the folder may be a link (B4-2) | the user's own; never deleted by BugPilot |
| **F15** | `~/.bugpilot/instructions.md` (User Instructions) | `instructions.user_instructions_path` | R W D | every `task.md` | no | developer text | as F08; the folder may not be a link (unlike F14, B4-2) | the user's own |
| **F16** | `~/.bugpilot/fix_modes/<id>.json` | `FixModeStore.scope_dir("user")` | R W D | as F13 | no | developer workflows | as F13 | the user's own |
| **F17** | `BUGPILOT_CONFIG_DIR` (environment) | `user_config.user_config_dir` | — | tests (`tests/conftest.py:13-17`), `scripts/check_cli_contract.py:41-52`, one integration test; F14–F16 | no | — | display name hides the path (`user_config.py:181-185`) | — |
| **F18** | Extension `globalStorageUri`: `runtime/<version>/venv`, `runtime.json`, `<version>.lock`; `attachments/<16 hex>/<name>` (staging); `bug-description-<uuid>.md`. Plus `globalState` (`bugpilot.attachmentReferences.<hash>`, `bugpilot.attachmentGcVersion`, `bugpilot.lastAgent`), `workspaceState` (`bugpilot.repoRoot`, `bugpilot.form` with absolute attachment paths, `bugpilot.workItem`, `bugpilot.reviewedFixes`) and SecretStorage (`bugpilot.jiraCredentials`) | `extension.ts:89-150`, `:316-317`; `managedRuntime.ts`; `attachmentStorage.ts`; `scratchFile.ts`; `secrets.ts` | R W D | the extension; the CLI receives `--attach` and `--description-file` paths | SecretStorage: yes | developer files and form state | scratch: UUID name, exclusive create, `0600`, removed after the run; attachment GC removes only inside its own folder (30-day retention) | VS Code owns the lifecycle (removed when the extension is uninstalled) |
| **F19** | OS temp folder: extension payloads `bugpilot-{fix-mode,review,verification}-<uuid>.json` (`scratchFile.ts`); `bugpilot-{project-settings,repository-profile}-<pid>-<ts>-<rand>.json` (**plain `writeFile`**, SF-1); hint improver `mkdtemp bugpilot-hint-*`; flag probe cwd. Python: `mkstemp` temp files in the **target's own folder** (`artifact_io.py:124`) | `fixModeTransport.ts:46-63`, `projectSettings.ts:178-182`, `repositoryProfile.ts:195-199`, `ports.ts:417-439`, `artifact_io.atomic_write_text` | W D | CLI (`--from-file`); hint-improver agent | no | settings payloads; issue text (hint improver) | per row; SF-1 is the gap | removed after the command |
| **F20** | `~/.claude/projects/<slug(root)>/` (Claude's own session store) | extension `session.ts:26-28`, `extension.ts:790-808` (Resume Agent Session) | R | the extension | no | the agent's | read-only | Claude's; **depends on the agent's cwd being the repository root** |
| **F21** | `<repo>/.gitignore` | extension `gitignore.ts:18-21`, `:74-162`; `controller.ts:1601-1683`; `ports.ts:451-485`; doctor `ai_artifacts_ignored*` (`git_ops.artifact_directories_ignored`, `git_ops.py:66-100`) | R W | the panel's Repository Files notice and the "Add to .gitignore" quick fix | no | — | refuses a linked `.gitignore`; edits a dirty buffer without saving it | the developer's file, written only on their click |
| **F22** | Code-search, review and lint guards naming `.ai` / `.ai_memory` | `search.EXCLUDE_DIRS` (`search.py:40-41`), `review_changes._PATHSPEC` (`review_changes.py:35`), `verification.py:322` lint | R (exclusion) | Code Search; captured review diff; Verification Policy lint | no | — | keeps BugPilot's own files out of evidence | constant |
| **F23** | Agent-facing path strings (handoff, `task.md`, retry, review, MCP, skill) | §5.5 | L | the agent | no | — | protected sections; the PLAIN_PROMPT gate | rendered per run |
| **F24** | CLI JSON, JSON-lines and MCP path fields | `cli.py` (`issue_dir`, `agent_task`, `generated_files`, `missing`, `fix_report`, `feedback_file`, `retry_prompt`, `review_report`, `verification_report`, settings `path`), `cli_json.py:137-140`, `mcp_server.py:231-280`, `doctor.py:65-66` | — | extension, MCP clients, scripts | no | — | "no absolute path in normal output" (`docs/safety.md:68`, `:73`) | contract |
| **F25** | Persisted path strings inside artifacts: `run.json.generated_files`; memory entry text (`- Context: .ai/<id>/context.md`) | `workflow._generated_files` (`:2206-2222`); `memory.build_memory_entry` (`:24-40`) | W (and R by the extension and MCP) | extension progress (`progress.ts:410-429`, not rendered); MCP `get_status`; Similar Fixes scoring | no | — | — | per run |
| **F26** | Diagnostic trace | `logging_utils` (`bugpilot.execution` logger; **not persisted**) | — | an opt-in handler | no | — | never content (counts only) | none on disk |
| **F27** | MCP server state | `mcp_server._Bound` (root bound at startup, an in-process lock) | — | — | no | — | the id is validated for every call (`_checked`, `_existing`) | **none on disk** |
| **F28** | Agent CLI state outside BugPilot (`~/.codex`, Copilot `config.json` trust list) | — | — | — | — | — | — | not BugPilot's; unchanged |
| **F29** | Test harness storage | `tests/conftest.py`, `tests/task_golden.py:189-214`, `tests/prompt_boundary_sources.py:118-210`, `tests/boundary_golden.py`, `extension/test-integration/*` | R W D | the suites | no (fake values) | synthetic | `BUGPILOT_CONFIG_DIR` isolation only (SF-8) | tmp folders |

### 5.3 Table B — what happens to each location in 0.1.6

`<R>` is the data root and `<repo-dir>` is `<R>/repositories/<repository-id>`. Migration is **NONE** for every row.

| Id | (10) Proposed new location | (11) Code changes | (12) Test changes | (13) Risk | (14) Batch |
| --- | --- | --- | --- | --- | --- |
| F01 | `<repo-dir>/work/<id>/` | `config.issue_dir` / `writable_issue_dir` delegate to `storage`; the 12 direct joins (§4.2) routed through it; `safe_paths` generalized to a data-root boundary; extension: no `.ai` joins (US-D17) | path updates in about 50 Python modules; new storage, pollution and isolation suites | **High** | 1 (API), 2 (Python), 3 (extension) |
| F02 | `<repo-dir>/work/<id>/…` (file names unchanged) | through F01 only; `task.md` text (F23) | goldens (§11.6) | Medium | 2 |
| F03 | `<repo-dir>/work/<id>/…` | the agent is told the absolute path (US-D13); `manual-result` the documented fallback when the agent cannot write (§9.6) | report tests; live handoff probes | **High** (agent write permission) | 2, 3 |
| F04 | `<repo-dir>/work/<id>/…` | **the CLI owns the `user_feedback.md` write** (`bug <id> --retry --feedback-file <tmp>`; US-D18); `writeWorkItemFile` and the `ports.ts` guard removed | `sessionReset.test.ts`; argv contract fixture | Medium | 2 (CLI flag), 3 (extension) |
| F05 | `<repo-dir>/work/<id>/…` | through F01; `send-via-outlook.ps1` takes the draft path the CLI prints (SF-10) | `test_email_notify`, `test_cli_*` | Low | 2 |
| F06 | `<repo-dir>/work/<id>/attachments/` | none beyond F01; long-path check (SF-5) | `test_attachments` paths; a `MAX_PATH` probe | Medium | 2, 4 |
| F07 | `<repo-dir>/memory/<id>.md` (US-D1: `bugs/` dropped) | `memory_dir` / `writable_memory_file` → `storage`; `search_memory` `file` field shown as `memory/<id>.md`; entry text names `work/<id>/…` | `test_context_task_artifacts`, `test_similar_fixes_settings`, `test_cleanup_safety`, MCP | Medium | 2 |
| F08 | `<repo-dir>/settings/instructions.md` | `project_instructions_path` → `storage`; one `display_path` | `test_instructions`, `test_task_preview` | Medium (US-D9) | 2 |
| F09 | `<repo-dir>/settings/verification.md` | `verification_path` → `storage`; `show --json` `path` absolute; extension opens the path the CLI gives | `test_verification_policy`; extension policy tests | Medium | 2, 3 |
| F10 | `<repo-dir>/settings/ai_behavior.md` | as F09 | `test_ai_behavior`; extension | Medium | 2, 3 |
| F11 | `<repo-dir>/settings/project_settings.json` | `settings_path` → `storage` | `test_project_settings` | Low | 2 |
| F12 | `<repo-dir>/settings/repository_profile.json` | `profile_path` → `storage`; `repository_profile_contract.json` `path` | `test_repository_profile` | Low | 2 |
| F13 | `<repo-dir>/settings/fix_modes/<id>.json` | `FixModeStore` takes the storage object; error text in display form (SF-3) | `test_fix_mode_store`, `test_fix_mode_custom` | Medium | 2 |
| F14 | `<R>/config/config.toml` (US-D2) | `user_config_dir` → `storage.global_storage().config_dir`; the private write unchanged; `_shown_config_path` renders `~/.bugpilot/config/config.toml` | `test_batch4_file_safety` S2/O4 paths; `test_setup`; `test_jira_site` | **High** (credentials) | 2 |
| F15 | `<R>/config/instructions.md` | via `storage` | `test_instructions` | Low | 2 |
| F16 | `<R>/config/fix_modes/<id>.json` | via `storage` | `test_fix_mode_store` | Low | 2 |
| F17 | replaced by `BUGPILOT_HOME` = the data root (US-D3); `BUGPILOT_CONFIG_DIR` no longer honoured (one safe warning, its value never read) | `storage.data_root()`; conftest, `check_cli_contract.py`, integration tests | all isolation fixtures | Medium | 0A (tests isolate `HOME` too), 2 |
| F18 | **unchanged**: VS Code-owned extension storage (US-D19) | none | none | Low | — |
| F19 | unchanged; SF-1 routed through `scratchFile.ts` if US-D39 | `projectSettings.ts`, `repositoryProfile.ts` | `scratchFile.test.ts` pattern | Low | 4 |
| F20 | unchanged; the agent's cwd stays the repository root | none | none | Low | — |
| F21 | **removed** if US-D16: no notice, no quick fix, no doctor keys (BugPilot writes nothing in the repository to ignore) | `gitignore.ts`, `controller.ts` notice, doctor keys, `git_ops.artifact_directories_ignored` | `gitignore.test.ts` (removed), `controller.test.ts`, `page.test.ts`, `test_core_robustness.py:303-371` | Low | 2, 3 |
| F22 | **kept** as legacy-name guards (US-D15): a left-behind `.ai/` must not become Code Search evidence or review diff | comments only | ratchet allowlist (§11.2) | Low | 2 |
| F23 | rewritten (§9, US-D13) | `handoff.py`, `prompts.py`, `workflow.py` (retry, review), `mcp_server.py`, `context.py`, `memory.py`, `SKILL.md`, extension `controller.ts:3349-3351`, `nextAction.ts:206-208` | goldens; `test_handoff`; cross-language tests | **High** | 2, 3 |
| F24 | absolute in designated path fields; display form in messages (US-D22, US-D26, US-D27) | `cli.py`, `cli_json.py`, `mcp_server.py`, `doctor.py` | `test_cli_json`, `test_cli_phase2`, `test_mcp_server`, `test_batch3_boundaries` | Medium | 2 |
| F25 | `generated_files` relative to `<repo-dir>` (`work/<id>/task.md`, `memory/<id>.md`; US-D25); memory entry text likewise | `workflow._generated_files`, `memory.build_memory_entry` | `test_workflow`, `test_run_artifact` | Low | 2 |
| F26 | unchanged | messages use the display form | — | Low | 2 |
| F27 | unchanged (the repository identity is resolved once at startup) | `mcp_server.build_server` | `test_mcp_server` | Low | 2 |
| F28 | unchanged | — | — | — | — |
| F29 | the test data root isolated (`BUGPILOT_HOME`, `HOME`, `USERPROFILE`, `BUGPILOT_CONFIG_DIR`, no `JIRA_*`) for the whole session, before collection, with a fail-closed guard (§11.1) | `tests/_isolation.py`, `tests/conftest.py`, the golden helpers, integration tests, `ci.yml` env | `tests/test_isolation_guard.py` | **High** (a test run writing into, or reading, the real home) | 0A |

### 5.4 Line-level references by family

Python paths are relative to the repository root, and extension paths are relative to `extension/`.

**F01 — the work-item folder.** Python:

- `bugpilot/core/config.py:203-242`
- `bugpilot/core/safe_paths.py:75-173`
- `bugpilot/core/workflow.py:172`, `:385-393`, `:1891-1893`, `:2236`
- `bugpilot/core/cleanup.py:30-58`
- `bugpilot/cli.py`: `:1313` (`existed`), `:1895-1905` (`list`), `:2922`, `:2931`
- `bugpilot/mcp_server.py:145-158`, `:183-200`
- `bugpilot/core/identity.py:50` (`WORK_ITEM_ID_RE`), `:82-100`

Extension:

- `src/app/controller.ts`: `:2431`, `:2693-2697`, `:2769-2771`, `:2804`, `:2824`, `:2993`, `:3339`, `:3442`, `:3506-3508`, `:5056`, `:5110-5112`, `:5186-5188`, `:5950`, `:6179`, `:6529-6536`
- `src/host/ports.ts:65-72`, `:194-218`, `:228-266`, `:494`
- `src/app/sessionReset.ts:173`, `:190-313`

**F02 — the core artifacts.**

- `bugpilot/core/artifacts.py:23-47` (names)
- `issue.py:301-341`
- `retrieval.py:264-300`
- `run.py:82-83`, `:105`, `:172`
- `workflow.py:1049-1087` (Git History record), `:1162-1171` (context), `:1393-1449` (task)
- `task_preview.py:118-132`, `:214-228`
- `context_preview.py:160-205`

**F03 — the reports.**

- `fix_report.py:63`
- `review_report.py:92`, `:121-137`
- `verification_report.py:99`, `:290-313`
- `workflow.py:1475-1481` (`check_result_files`), `:1861-1880` (`manual_result_step`)
- `cli.py:1080-1160`, `:1626-1760`

**F04 — retry.**

- `workflow.py:1831-1850`, `:1956-2069`
- `cli.py:1799-1851`
- extension `controller.ts:2431-2439`, `:2693-2701`; `src/app/nextAction.ts:206-208`

**F05 — Jira and notification files.**

- `workflow.py:708-730` (`jira_validate_step`), `:1642-1670` (`notify_step`), `:1759-1815`, `:2183-2187` (`jira_comment_on.flag`)
- `cli.py:885-888`, `:2981-2987`, `:3038-3039`
- `scripts/send-via-outlook.ps1:6`, `:39`

**F06 — attachments.**

- `attachments.py:17-19`, `:31`, `:76-255`
- `workflow.py:454`, `:466-470`, `:1298`
- `prompts.py:461-509`

**F07 — memory.**

- `memory.py:24-105`
- `config.py:233-242`
- `workflow.py:1721-1750`, `:2219-2221`, `:2486`
- `cleanup.py:43-56`
- `mcp_server.py` (`search_memory`, about lines 557-571)

**F08–F13 — repository settings.**

| Family | References |
| --- | --- |
| F08 | `instructions.py:1-9`, `:56`, `:144-187`, `:235-296` |
| F09 | `verification.py:65-66`, `:149-150`, `:209-293`; extension `controller.ts:3720-3740`, `:4252-4349`, `src/app/verificationPolicy.ts:41`, `src/host/ports.ts:534-541` |
| F10 | `ai_behavior.py:59-60`, `:138-230`; extension `controller.ts:3753-3927`, `src/app/aiBehaviorPolicy.ts:42`, `ports.ts:548-555` |
| F11 | `project_settings.py:60-61`, `:107-218` |
| F12 | `repository_profile.py:57-58`, `:145-146`, `:212-275` |
| F13 | `fix_mode_store.py:1-26`, `:49-50`, `:268-316`, `:526-573` |

Extension, for all of these: the policy watcher at `controller.ts:4379` and `ports.ts:506-518`, and the lstat kind check in `src/host/bugpilotFiles.ts:13-20`.

**F14–F17 — user configuration.**

- `user_config.py:33-57`, `:116-185`
- `config.py:127-147`
- `instructions.py:144-164`
- `fix_mode_store.py:268-286`
- `jira.py:74-77` (the message naming `~/.bugpilot/config.toml`)
- `cli.py:521-522`, `:568-584`, `:2057-2089`
- extension `src/app/jiraConnection.ts:99`, `src/panel/html.ts:1278`

**F18–F21 — the extension's other storage.**

- `src/extension.ts:89-150`, `:316-317`, `:442-476`, `:519-527`, `:790-808`, `:839-867`
- `src/managedRuntime.ts:155-165`, `:336-381`
- `src/app/attachmentStorage.ts:34-355`
- `src/app/scratchFile.ts:55-71`
- `src/app/fixModeTransport.ts:46-63`
- `src/app/projectSettings.ts:178-182`, `src/app/repositoryProfile.ts:195-199`
- `src/app/gitignore.ts:18-162`
- `controller.ts:850-927`, `:1601-1683`
- `src/host/ports.ts:417-485`, `:645-653`

### 5.5 Separate audit: paths embedded in prompts and user-visible strings

A path in agent-facing text tells a model what to read or write. It is part of the handoff (§9), not just display. Action codes:

- **R**: the agent is told to read.
- **W**: the agent is told to write.
- **X**: the agent is told to run a command from the repository root.
- **D**: descriptive only.

**A. Agent-facing.** All must change in 0.1.6 unless marked.

| Where | Text (abbreviated) | Act |
| --- | --- | --- |
| `bugpilot/core/handoff.py:85` (`handoff_prompt`); used by `agent_runner.py:43`, `copilot.py:45`, `cli.py:1433-1434`, `:1604`; mirrored at `extension/src/app/controller.ts:3349-3351` | "Read .ai/{id}/task.md and complete the workflow." | R |
| `handoff.py:90` (`retry_handoff_prompt`) with `cli.py:1824`; mirrored at `nextAction.ts:206-208` | "Read .ai/{id}/agent_retry_prompt.md and continue the workflow." | R |
| `handoff.py:99-106` (`mcp_prompt`), `mcp_server.py:85-101` (INSTRUCTIONS) | "read the returned task.md and context.md" (bare names) | R. Wording kept; the returned paths change |
| `handoff.py:116-127` (`skill_steps`); `skills/bugpilot-investigate/SKILL.md:18-42` (pinned by `tests/test_handoff.py:83-101`) | "Read `.ai/<ISSUE>/task.md` and `.ai/<ISSUE>/context.md`"; retry files | R, X |
| `prompts.py:380-382`, Execution Location (protected) | "`.ai/{id}/` paths are relative to the target repository root." | D → the work-folder statement |
| `prompts.py:393-395`, Required Input Files (protected) | "Read `.ai/{id}/context.md` …", "Read and inspect `.ai/{id}/retrieval.json` …" | R |
| `prompts.py:429`, `:445`, Required Output Files (protected); `prompts.py:287`, Investigation Handoff (protected) | "Write one report: `.ai/{id}/fix_report.md` …" | **W** |
| `prompts.py:349-351`, `:362-364`, Report Status to Jira (protected, opt-in) | "Run these two commands from the target repo root: `bugpilot jira-comment-draft {id}` …" | X. Wording kept; the CLI resolves storage from cwd |
| `prompts.py:499`, Developer Attachments | "File: `.ai/{id}/attachments/{name}`" | R |
| `protected_rules.py:186-191`, `stage-intended-files-only` (rules v2, SHA-pinned) | "never `.ai/`, `.ai_memory/`, `issue.json` …" | D. **US-D14**: kept unchanged by default |
| `protected_rules.py:109-152` | bare `fix_report.md`, `context.md`, `retrieval.json` | unchanged |
| `verification.py:457-476`, `ai_behavior.py:381-388`, `instructions.py:499-504` (Source and problem lines in `task.md`) | "Source: repository Verification Policy (.bugpilot/verification.md)." | D → the display form (US-D22) |
| `context.py:96-97` (`context.md`) | "See `.ai/{id}/retrieval.json` …" | R |
| `memory.py:96`, `:156` (Similar Fixes in `context.md`) | "`.ai_memory/bugs/<other>.md` score=…" | R → `memory/<other>.md` |
| `workflow.py:1983-2068` (retry prompt) | Required Reading list; "BugPilot's rules in `.ai/{id}/task.md` still apply"; Required Output `.ai/{id}/fix_report.md`; How to Run | R, **W**, X |
| `workflow.py:2400-2407` (`review-package` prompt, captured and terminal review) | "Use: - .ai/{id}/context.md …" | R |
| `review_changes.py:92-104` | "Review the files fix_report.md names instead." | unchanged |
| `mcp_server.py:245-247`, `:261-280` (`issue_dir`, `agent_task`, `next_step`), `:358-361` (tool description: "into .ai/<issue_key>/"), `:488-530` (`check_results`, `summarize_results`), `:557-571` (`search_memory`) | relative `.ai/` paths | R |
| `workflow.py:466-470`, `:1914`, `issue.py:329`, `:417`, `retrieval.py:292`, `:391`, `run.py:105`, `:172`, `fix_mode_state.py:167`, `:212` (errors and warnings that reach the agent through MCP `ToolError`) | "….ai/{id}/run.json could not be read" | D → the display form |

**B. Human-facing.** All must change; the extension changes in Batch 3.

| Surface | Sites | Change |
| --- | --- | --- |
| CLI help | `cli.py:210`, `:326-330`, `:353`, `:422`, `:427`, `:477`, `:488`, `:521-522`, `:539`, `:568-584`, `:600-616`, `:632-648`, `:696`, `:725` | name the work-item folder and the settings in words, plus `bugpilot doctor` for where they are |
| CLI printed output | `cli.py:885-888`, `:929`, `:1050`, `:1077`, `:1101-1123`, `:1221-1268`, `:1419-1434`, `:1595-1604`, `:1676`, `:1753`, `:1838-1849`, `:1921`, `:2089`, `:2157-2508`, `:2981-2987`, `:3038-3056`; core messages `review_report.py:123`, `:134`, `verification_report.py:292`, `:302`, `workflow.py:1588`, `:1790`, `task_preview.py:126-132`, `:224-228`, `context_preview.py:172`, `:203`, `jira.py:74-77`, `user_config.py:181-185`, `safe_paths.py:91-103`, `:148-152` ("inside this repository"), `email_notify.py:100`, `verification.py:322`, `:373-376` | the display form (`~/.bugpilot/repositories/<id>/work/JR-12345/`); handoff lines carry the absolute path |
| JSON fields | §5.2 F24 | US-D26 |
| Extension UI | `controller.ts:850-927` and `:1678-1679` (gitignore notice), `:3466`, `:3514`, `:3521`, `:3729-4327` (`.bugpilot` notices), `:2142`, `:2430-2439`, `:2719`, `:2778-2830`, `:3147-3151`, `:5796`, `:5958`, `:6154`, `:6262` (bare names); `src/app/results.ts:79`, `:187`; `sessionReset.ts:290-351`; `ports.ts:69`; `panel/html.ts:1163`, `:1229`, `:1278`, `:1281` ("which can be committed"), `:1327`, `:1345-1346`, `:1419`, `:1436-1437`; `jiraConnection.ts:99`; `verificationPolicy.ts:41`, `:124-245`; `aiBehaviorPolicy.ts:42`, `:114-216`; `package.json` titles (no paths) | US-D9 wording; display form; gitignore UI removed if US-D16 |
| Docs | `README.md` (24 lines: the handoff at `:73-76`, gitignore at `:79-83`), `extension/README.md` (31: `:114-137`, `:709-711`, `:920-926`, `:1025-1057`), `docs/architecture.md` (32: `:20`, `:742-770`, `:774-797`), `docs/safety.md` (21: `:19`, `:31`, `:36`, `:43`, `:51-68`, `:109-111`, `:127-140`, `:157`), `docs/adapter_design.md` (15), `docs/notifications.md:7`, `:71`, `docs/development.md:14`, `docs/mcp_setup.md:136`, `docs/skill_setup.md:12` | Batch 5. `extension/CHANGELOG.md` and the historical plans are records and are not rewritten. |

**Counts.** These group repeated and templated lines as one site.

| Category | Directory-path sites | Bare file names | Agent-facing? |
| --- | ---: | ---: | --- |
| Protected `task.md` sections and rules | 7 | 5 | yes: W×3, R×2, X×3 |
| Other agent prompts (`task.md`, `context.md`, retry, review) | 22 | 4 | yes |
| MCP output | 11 | 2 | yes |
| Skill | 3 | 1 | yes |
| CLI messages | about 90 | about 15 | handoff lines at `cli.py:1077`, `:1434`, `:1604`, `:1849` |
| CLI JSON fields | about 24 | — | consumed by the extension and MCP clients |
| Extension UI | about 24 `.ai`-family, about 45 `.bugpilot`-family | about 20 | the handoff and retry one-liners |
| Docs | about 160 (plus 314 in historical plans) | — | `README.md:76` repeats the handoff |

---

## 6. Target directory structure

### 6.1 Layout (PROPOSED, US-D1 and US-D2)

```text
<data root>                         ~/.bugpilot, or $BUGPILOT_HOME (US-D3)
│                                   Windows: C:\Users\you\.bugpilot
│                                   macOS:   /Users/you/.bugpilot     Linux: /home/you/.bugpilot
├── config/                         0700   global configuration (F14–F16)
│   ├── config.toml                 0600   Jira site, email and (CLI setup) token; written private
│   ├── instructions.md                    User Instructions
│   └── fix_modes/<mode-id>.json           user-scope Fix Modes
└── repositories/                   0700
    └── <repository-id>/            0700   for example checkout-9f2c41d07ab3e815 (§7)
        ├── repository.json         0600   identity record (§7.5): schema_version, repository_id, root
        ├── settings/               0700   was <repo>/.bugpilot/ (F08–F13)
        │   ├── instructions.md            Project Instructions (US-D9 wording)
        │   ├── verification.md            Verification Policy
        │   ├── ai_behavior.md             AI Behavior additions
        │   ├── project_settings.json      branch template, legacy Verification switches
        │   ├── repository_profile.json    Repository Profile
        │   └── fix_modes/<mode-id>.json   project-scope Fix Modes
        ├── work/                   0700   was <repo>/.ai/ (F01–F06)
        │   └── <work-item-id>/     0700   JR-12345, local_20260101090000
        │       ├── issue.json  retrieval.json  context.md  task.md  run.json
        │       ├── fix_report.md  review_report.md  verification_report.md
        │       ├── user_feedback.md  agent_retry_prompt.md
        │       ├── jira_field_report.md  jira_comment_draft.md
        │       ├── jira_comment_post_result.json  jira_comment_on.flag
        │       ├── email_draft.md  notification.eml
        │       └── attachments/<name>
        └── memory/                 0700   was <repo>/.ai_memory/bugs/ (F07)
            └── <work-item-id>.md
```

**Design choices**

| Choice | Why |
| --- | --- |
| File names inside a work item are unchanged | Every reader and writer agrees on `artifacts.py`'s names, and there is no reason to rename them. Only the folder moves. |
| Memory is a sibling of `work/`, not inside it | Memory outlives a work item: `clean` keeps it unless `--include-memory`, and `--fresh` keeps it too. A layout that put memory under `work/<id>/` would make "delete the work item" delete the memory. The brief requires that memory not be treated as work-item storage. |
| Credentials live in `config/`, never under `repositories/` | `config/` is the only folder holding a secret. Any grant an agent might get (US-D11) names a single `work/<id>/` and never an ancestor of `config/`. |
| `memory/<id>.md`, not `memory/bugs/<id>.md` | `bugs/` held nothing else. It is dropped in the new layout (no migration means no reason to keep it). |
| No `cache/` | Nothing today caches or indexes: Git History writes into `retrieval.json`, and memory search reads files directly. An empty, documented-but-unused directory is a maintenance trap (US-D36, DEFERRED). |
| No `state/` or `logs/` | The CLI and MCP persist no state of their own (F26, F27). `run.json` is per work item. |
| No per-repository `repository.json` beyond identity | Its only jobs are collision detection and diagnostics (§7.5). |

### 6.2 What stays where it is

| Location | Why it stays |
| --- | --- |
| **The extension's VS Code storage** (F18): managed runtime, attachment staging, per-run description file, `globalState`, `workspaceState`, SecretStorage | **PROPOSED, US-D19.** These are the extension's own runtime and staging state, not BugPilot-generated work data. VS Code creates, isolates and deletes them with the extension. None of them is inside a repository (R5). Moving the 0.1.5 managed runtime would change a released, verified install path for no storage benefit. |
| **OS temp payloads** (F19) | Temporary by design: removed after their command (R2 allows it). |
| **Atomic-write temp files** | They stay *in the target's own folder* (`artifact_io.py:124`). That is how the rename is atomic. They are now inside the data root, never inside the repository. |
| **The agent's own state** (F20, F28) | Not BugPilot's. |

### 6.3 What 0.1.6 leaves untouched

All of these are **never read, written, moved, renamed or deleted** by 0.1.6:

| Location | What it holds | 0.1.6 equivalent |
| --- | --- | --- |
| `<repo>/.ai/`, `<repo>/.ai_memory/`, `<repo>/.bugpilot/` | the 0.1.5 work items, memory and repository settings | §6.1 |
| `~/.bugpilot/config.toml` | the 0.1.5 credentials (may hold a plaintext token) | `config/config.toml` |
| `~/.bugpilot/instructions.md` | the 0.1.5 User Instructions | `config/instructions.md` |
| `~/.bugpilot/fix_modes/` | the 0.1.5 user Fix Modes | `config/fix_modes/` |

Notes on the legacy files:

- **Same root folder.** The 0.1.5 files sit directly in the default data root, beside `config/` and `repositories/`. The new names never collide with them, and a 0.1.5 installation keeps working with them after a downgrade (§14 rollback).
- **Legacy guards.** The F22 guards (Code Search exclusion, review pathspec, lint) keep naming `.ai` and `.ai_memory`, so a left-behind folder never becomes evidence (US-D15). They exclude a path; they never read from it.
- **Optional presence notice** (US-D20, OPEN; the review recommends **deferring** it).
  - **If ever approved:** `doctor` would report whether each legacy path *exists*: an `lstat`, never a read, to explain the breaking change. That is detection for a message, not a fallback.
  - **Under the review's recommendation:** 0.1.6 probes no legacy path at all, and §13's documentation explains the change instead.

---

## 7. Repository identity

### 7.1 Repository scope (US-D4, OPEN; review: accept, with a diagnostic)

The repository root is **the directory BugPilot runs in**, exactly as today:

- the CLI's working directory;
- the MCP server's bound root;
- the extension's chosen workspace folder, passed to the CLI as cwd.

0.1.6 adds **no** git top-level discovery, for identity or for scope, and no relocation.

| | Keep today's root (recommended) | Use `git rev-parse --show-toplevel` |
| --- | --- | --- |
| Behaviour change | none: Code Search scope, `Path.cwd()` and the extension's folder choice all stay as they are | running from a subdirectory joins the top-level's namespace, but Code Search would still be scoped to the subdirectory unless that changes too |
| Cost | none | a `git` call on every command; a new failure mode without git; a scope change that is out of this project's theme |
| Limitation | running BugPilot from a subdirectory creates a separate namespace (as today it creates a separate `.ai/`) | — |

**Diagnostic for a subdirectory** (review recommendation, part of US-D4). This is a hint only: it changes no path, no identity and no scope.

- `doctor`, and only `doctor`, runs `git rev-parse --show-toplevel` once.
- It reports `storage.below_git_toplevel` (§8.10):
  - `true` when the root is a subdirectory of a git top-level;
  - `false` when it is the top-level;
  - `null` without git or outside a checkout.
- When it is `true`, the panel's Diagnostics shows one line: "BugPilot is running in a subfolder of this Git repository, so this folder's work items are kept apart from the repository root's."
- The `doctor` field comes with Batch 2's `storage` object; the panel line comes in Batch 5.

**Scope in 0.1.6:**

| Situation | Namespace |
| --- | --- |
| A subdirectory of a repository | its own, separate from the top-level's (as its own `.ai/` is today) |
| A moved or renamed repository | a **different identity**; the old namespace stays where it was, orphaned, never deleted |
| A new clone at another path, even of the same remote | a **different namespace** |
| Each git worktree | its **own namespace** (US-D7) |
| Re-associating any of these with an earlier namespace | **none in 0.1.6**: no automatic merge, relocation or "this used to be…" lookup (US-D8; relocation DEFERRED) |

### 7.2 The algorithm (PROPOSED, US-D5)

```text
input   root: the directory BugPilot runs in (absolute or relative to the process cwd)

canonical  = os.path.realpath(root, strict=True)
             # resolves symlinks, Windows junctions and other name-surrogate
             # reparse points, `.`/`..`, redundant separators and (Windows)
             # (expected, NOT VERIFIED: §7.3) subst and mapped drives to their final path; on Windows
             # also the stored letter case. strict: a root that does not
             # exist is an error, never a guess.
key        = os.path.normcase(canonical) on Windows (lower case, backslashes)
             canonical unchanged on Linux and macOS (no case folding, no
             Unicode normalization: "prefer split over merge", §7.3)
digest     = sha256(b"bugpilot-repository-v1\0" + key.encode("utf-8", "surrogateescape"))
hash16     = digest.hexdigest()[:16]                       # 64 bits
slug       = basename(canonical) → NFKD → ASCII → lower case;
             every run of characters outside [a-z0-9._-] → "-";
             leading and trailing "." and "-" stripped; at most 24 characters;
             "repository" when nothing is left
repository_id = f"{slug}-{hash16}"                         # matches ^[a-z0-9][a-z0-9._-]{0,23}-[0-9a-f]{16}$
```

Each step and its reason:

| Step | Why |
| --- | --- |
| Hash a canonical path, not the git remote | A remote names a project, not a checkout. Two clones of one remote are two working trees with different branches and different work in progress, and must not share `work/JR-12345/` (R3). A repository may also have no remote, or several. |
| Hash, not inode | `(st_dev, st_ino)` survives renames, but it is not stable across a backup restore or a re-clone at the same path. `st_dev` can change across reboots for removable and network volumes, and an inode can be reused after deletion. A path is explainable to a person; an inode is not. |
| A versioned prefix (`bugpilot-repository-v1\0`) | A future change of algorithm gives new IDs deliberately, never by accident. |
| 64 bits of SHA-256 | Collision probability for k repositories is about k²/2⁶⁵: about 3×10⁻¹² for 10,000 repositories. The record (§7.5) catches the impossible case anyway. |
| The slug | Display only: it makes `~/.bugpilot/repositories/` navigable by a person. Uniqueness comes only from the hash. |
| The slug's fixed character class | Keeps every hostile basename harmless as a path segment: newlines, `..`, separators, reserved Windows device names (`CON`, `NUL`; the hash suffix makes `con-…` an ordinary name), trailing dots or spaces, non-ASCII, shell metacharacters. |
| At most 24 characters | Keeps Windows `MAX_PATH` within reach (SF-5). |
| Lower case | Avoids case-only differences between platforms. |
| `surrogateescape` | A POSIX path with undecodable bytes still hashes deterministically. |
| Computed once per process per root | Memoized (§12). The MCP server computes it once at startup. |

### 7.3 Behaviour in each case the brief names

The guiding rule is **prefer split over merge**:

- **Merging two repositories is unsafe.** Two different checkouts sharing one namespace is cross-repository confusion: one repository's `task.md` handed to an agent in the other.
- **Splitting one repository is safe.** One checkout reaching two namespaces through two spellings is a visible nuisance (its work items "disappear"), never an unsafe one.

Every rule below chooses the split when it cannot be sure.

| Case | Result | How |
| --- | --- | --- |
| Two repositories with the same basename | different IDs, same slug (`app-1f…`, `app-9c…`) | different canonical paths → different hashes |
| One repository through different spellings (`C:/x/repo`, `c:\x\repo\`, `C:\x\.\repo`) | **one ID** | `realpath` normalizes separators, `.`, `..` and trailing separators; Windows `normcase` folds case |
| Windows letter-case differences (`c:\Work\Repo` vs `C:\work\repo`) | **one ID** | `realpath` returns the stored case (observed during this audit on this checkout: a lower-case drive letter and an all-capitals spelling both resolved to the stored spelling), then `normcase` |
| Windows per-directory case sensitivity (WSL `setcaseinfo`), two folders differing only in case | the two keys are equal, so the record check sees the other root and **refuses** (§7.5) | merge prevented; the user sees a one-sentence error. Extremely rare; documented |
| Root reached through a symlink or junction | **one ID**: the target's | `realpath` follows the link for identity only. Writes still refuse links *below* the data root (§8.5). The root itself may sit behind a link, as today. |
| `subst` drive or mapped network drive vs its UNC path | **one ID** (expected) | `realpath` uses the final path. **NOT VERIFIED**, locally or in CI: a `subst` drive letter is a session-wide change outside a test's own folder, so its test is deferred pending separate owner approval (D0A-5). Mapped network drives are not observed either. |
| macOS case-insensitive APFS: `/Users/you/Repo` vs `/Users/you/repo` | **one ID** when the root comes from the working directory, which every entry point uses: `getcwd()` on macOS returns the stored spelling. **Two IDs** when `BUGPILOT_MCP_REPO_ROOT` is set with a different case. | `realpath` does not fold case on POSIX. The split is the safe failure. **The underlying behaviour was observed on macOS CI** (run 38942462918, Python 3.13): `getcwd()` returned the stored spelling, and `realpath` of a case variant did not. BugPilot's own identity is first tested in Batch 1 |
| macOS `/var` → `/private/var`, `/tmp` → `/private/tmp` | one ID (the `/private` path) | `realpath`. Observed on macOS CI (run 38942462918): the temporary folder resolves under `/private` |
| NFC vs NFD spellings of the same folder (macOS) | one ID from `getcwd()`; possibly two from an explicit root | no Unicode normalization on purpose: on Linux two such folders are different folders |
| Repository moved or renamed | **a new ID**; the old namespace stays where it was, orphaned, not deleted | no relocation in 0.1.6 (US-D8, DEFERRED). §13 tells the user how to find old data. |
| Repository cloned to a new path | a new ID (correct: a different working tree) | — |
| Several VS Code windows or workspaces on one repository | **one ID**: every window resolves the same root | concurrency in §8.7 |
| A multi-root workspace with two repositories | two IDs; the extension uses the folder the developer chose (unchanged) | — |
| Git worktrees (`git worktree add ../repo-wt`) | **one ID per worktree** (PROPOSED, US-D7) | Each worktree is a separate working tree, usually on a different branch for a different bug. Sharing `work/` between worktrees would let one worktree's agent read another's work. Keying by `git rev-parse --git-common-dir` would merge them. The extension today does not even recognize a worktree root (`.git` is a file; `host.ts:36-45`), a limitation that stays. |
| Nested repositories (a submodule or a vendored checkout inside another) | the namespace of whichever directory BugPilot runs in | §7.1 |
| A root that does not exist, or cannot be resolved | error before anything is written | `strict=True` |

**Batch 0A local observation** (this machine only: Windows 11, Python 3.14.6; `tests/baselines/0.1.6-batch0/realpath_windows.json`):

- `realpath` resolved these to the stored spelling: separators and `.`/`..`, a trailing separator, forward slashes, a case variant, a symbolic link (available here), and a junction.
- `strict=True` raised for a missing folder.
- `subst` was not observed: **NOT VERIFIED**, its test deferred pending separate owner approval (D0A-5).

**Batch 0A CI observation** (run 38942462918, on `8b6c567`). `tests/test_storage_baseline.py` recorded each system's behaviour in the job's annotations and file-safety artifact. These observe Python's `os.path.realpath` and `os.getcwd`, not BugPilot's repository identity, which Batch 1 builds and tests:

| Spelling | Linux, Python 3.10 and 3.13 | macOS, Python 3.13 | Windows, Python 3.13 |
| --- | --- | --- | --- |
| separators and `.`/`..`; a trailing separator; forward slashes | resolve to the stored spelling | resolve to the stored spelling | resolve to the stored spelling |
| a missing folder with `strict=True` | raises | raises | raises |
| a symbolic link | resolves to its target | resolves to its target | resolves to its target |
| a case variant of the folder's name | a different, missing folder (`FileNotFoundError`) | exists, but `realpath` does not return the stored spelling | resolves to the stored spelling |
| `getcwd()` inside a case variant | not observed | returns the stored spelling | not observed |
| the temporary folder | not observed | resolves under `/private` | not observed |
| a junction | not applicable | not applicable | resolves to its target |
| a `subst` drive | not applicable | not applicable | **not observed: NOT VERIFIED** (D0A-5) |

Before that run, the "Unverified" rows above had no observation from the other systems. `subst` stays NOT VERIFIED until the owner separately approves its test (D0A-5). Mapped network drives and NFC/NFD spellings were not observed anywhere.

### 7.4 Privacy of `repository.json` (US-D6, PROPOSED)

`repository.json` stores the canonical root path, for example `C:\Users\you\src\app`.

- **The cost:** one more file on disk naming a local path.
- **Where it lives:** in the user's own data root, created `0600` in a `0700` folder.
- **Where it never appears:**
  - in `task.md`, which names only the work folder (§9.4);
  - in any prompt;
  - in any normal CLI or MCP output, except `doctor --json`'s storage section (US-D21, US-D22).

**The benefit:**

- collision and mismatch detection (§7.5);
- `doctor` can tell a person which repository a namespace belongs to;
- after a repository moves (US-D8), the user can identify an orphaned namespace by reading one file.

**The alternative:** store only the digest. That loses all three benefits.

### 7.5 The identity record and collision handling (US-D24, PROPOSED)

`repository.json`:

```json
{
  "schema_version": 1,
  "repository_id": "checkout-9f2c41d07ab3e815",
  "root": "C:\\Users\\you\\src\\checkout"
}
```

- **The content is deterministic:** no timestamp and no host name. Two processes creating it at once write identical bytes (§8.7).
- **The repository namespace is not ready until the record has been written or verified.** The write path is `ensure()` (§8.3).

| State found | Write path (`ensure()`) | Read path (no `ensure()`) |
| --- | --- | --- |
| The `<repository-id>` folder is absent | create the folders (`0700`), then the record | "no such work item" or default settings; **nothing is created** |
| Record absent, folder present (an interrupted `ensure()`) | write the record (deterministic, so harmless) | proceed |
| Record present; `normcase(root)` equals our key | proceed | proceed |
| Record present; a different root | **refuse**: `StorageIdentityError`, one sentence naming the record's display path, no absolute path; nothing written | **refuse** the read: a namespace whose record names another repository is never read |
| Record unreadable, not JSON, wrong `schema_version`, wrong id, a link, or not a regular file | **refuse**, same sentence family; the developer may delete the record | **refuse** |

- **No automatic repair or overwrite.** A record that disagrees is the only evidence of a collision, and overwriting it would erase that evidence.
- **Error code:** the refusal is reported as `INVALID_INPUT`. `StorageIdentityError` subclasses `UnsafePathError`, so every entry point already turns it into one sentence (`cli.py:755-759`).

### 7.6 Limitations, stated

- **A move or rename starts an empty namespace.** Old data stays where it was until the user acts (US-D8).
- **A subdirectory gets its own namespace,** as it gets its own `.ai/` today (US-D4). `doctor` says so (§7.1).
- **No automatic re-association.** A subdirectory, moved repository, new clone or worktree is never joined with another namespace in 0.1.6 (§7.1).
- **Spelling-dependent IDs on macOS:** an explicitly configured root with different case or Unicode normalization than the stored name splits the namespace.
- **Windows case-sensitive directories** that differ only in case are refused, not distinguished.
- **The ID changes if the algorithm version changes.** That needs an owner decision and a release note.

---

## 8. Storage API contracts

### 8.1 Principles

1. **One resolver.**
   - `bugpilot/core/storage.py` is the only code that knows the data root, the repository ID or the layout.
   - Every other Python module asks it.
   - The extension asks the CLI (§8.9).
2. **Resolution never creates.**
   - Computing a path is pure, apart from `realpath`.
   - Creating folders and the identity record happens only on a write path (`create=True` / `ensure()`).
   - This is what keeps `task-preview`, `context-preview`, `list`, `status`, `doctor` and MCP reads write-free, a guarantee 0.1.4 and 0.1.5 already document (`docs/safety.md:68`, `:73`).
3. **Same signatures where possible.**
   - `config.issue_dir`, `writable_issue_dir`, `memory_dir` and `writable_memory_file` keep their signatures and delegate to `storage`.
   - This is implementation scaffolding inside 0.1.6, not legacy compatibility: they point only at the new layout.
   - It keeps the diff of about 50 modules mechanical, and lets `tests/test_containment.py` stay unchanged.
4. **No new dependency.** The standard library only, on Python 3.10.

### 8.2 Module surface (PROPOSED)

```python
# bugpilot/core/storage.py — names are proposals, settled in Batch 1

DATA_ROOT_ENV = "BUGPILOT_HOME"                 # US-D3 (name OPEN)
STORAGE_LAYOUT_VERSION = 1                      # repository.json schema_version

class StorageError(UnsafePathError): ...        # one sentence; never an absolute path
class StorageIdentityError(StorageError): ...   # record mismatch or corrupt (§7.5)

def data_root() -> Path
    # $BUGPILOT_HOME if set (stripped, must be absolute, no C0/C1 control,
    # U+2028/U+2029 or NUL characters, else StorageError), else Path.home() / ".bugpilot".
    # Never creates. Path.home() failing (no HOME / USERPROFILE) is a StorageError.

@dataclass(frozen=True)
class RepositoryIdentity:
    repository_id: str        # "<slug>-<hash16>"
    root: Path                # canonical (realpath) form, for display and the record
    key: str                  # normcase(root) on Windows, root elsewhere

def repository_identity(repo_root: Path) -> RepositoryIdentity     # §7.2; memoized

@dataclass(frozen=True)
class GlobalStorage:
    root: Path
    config_dir: Path                     # <root>/config
    config_file: Path                    # <root>/config/config.toml
    user_instructions_file: Path         # <root>/config/instructions.md
    user_fix_modes_dir: Path             # <root>/config/fix_modes
    def ensure_config_dir(self) -> Path  # 0700, link-checked; never touches <root>'s mode

def global_storage() -> GlobalStorage

@dataclass(frozen=True)
class RepositoryStorage:
    root: Path                           # the data root
    identity: RepositoryIdentity
    directory: Path                      # <root>/repositories/<id>
    settings_dir: Path                   # .../settings
    work_root: Path                      # .../work
    memory_dir: Path                     # .../memory

    def ensure(self) -> None                                     # §7.5; idempotent
    def record_state(self) -> Literal["absent", "ok", "missing-record", "mismatch", "corrupt"]
    def work_item_dir(self, work_item_id: str, *, create: bool) -> Path
    def memory_file(self, work_item_id: str, *, create: bool) -> Path
    def settings_file(self, name: SettingsName, *, create: bool) -> Path
    def fix_modes_dir(self, *, create: bool) -> Path
    def work_items(self) -> list[WorkItemEntry]                 # id, path, mtime; for `list`

def repository_storage(repo_root: Path) -> RepositoryStorage

def display_path(path: Path) -> str
    # "~/.bugpilot/repositories/<id>/work/JR-12345/task.md", or
    # "BUGPILOT_HOME/…" when the override is set: never the user's own folder (US-D22)
```

`SettingsName` is the closed set: `instructions.md`, `verification.md`, `ai_behavior.md`, `project_settings.json` and `repository_profile.json`. Nothing else can be addressed under `settings/`.

### 8.3 Contracts

| Concern | Contract |
| --- | --- |
| **Global root** | `data_root()` as above. No `~` expansion inside `BUGPILOT_HOME`: a value starting with `~` is relative, so it is refused (as a relative `bugpilot.executablePath` is refused today). The root itself **may** be a symbolic link or junction: the user's choice, as `~/.bugpilot` may be today (owner decision B4-2). |
| **Repository identity** | §7.2. Raises `StorageError` for a root that does not exist. |
| **Per-repository settings** | `settings_file(name, create=False)` for reads. Writers call `create=True`, which runs `ensure()` and then creates `settings/` with `0700`. `link_problem` semantics are kept: a link at `settings/` or at the file is refused, for reads too. |
| **Work-item folders** | `work_item_dir(id, create=)`. The id is validated by `identity.validate_work_item_id` *before* any path is built, and an invalid id raises `StorageError`. `create=False` returns the path without checking existence (the caller reports "not prepared"), but still refuses links on existing components. |
| **Memory** | `memory_file(id, create=)`. `memory/` is created only by a memory writer. Readers glob `memory/*.md` only when `memory/` is a real folder. |
| **Cache** | No cache on disk (US-D36). In memory (Batch 2A): repository identities per spelling, each re-checked against its folder's file identity on every use; containment, Git working-tree and verified-record verdicts only within one `request_scope()` (Batch 2B: one CLI command, one MCP tool call), never longer. |
| **Safe creation** | Each missing component below the data root (`config`, `repositories`, `<id>`, `settings`, `work`, `<work item>`, `memory`, `fix_modes`, `attachments`) is created one at a time with `mkdir(mode=0o700)`, which is subject to the umask, so never wider. It is re-checked with `is_link_or_junction` after creation. An existing component must be a real directory, not a link or junction. The result is compared with `realpath(data root) / parts`, as `safe_paths.writable_dir` does today. |
| **Owned files** | Unchanged: `artifact_io.atomic_write_text` (new files `0600`, rewrites keep their bits, `_check_temp`, cleanup on failure). `private=True` stays for `config.toml` only. |
| **Id validation** | `WORK_ITEM_ID_RE` (unchanged; shared fixture `tests/fixtures/work_item_ids.json`). The repository ID has its own regex (§7.2) and is never accepted from input: always computed. |
| **Path traversal** | Every segment comes from a validated id, a fixed name or a computed ID. Separators, `.`, `..` and empty segments are refused by `_check_parts` (`safe_paths.py:155-157`). The final `realpath` comparison catches anything a check missed. |
| **Cross-repository access** | No API takes a repository ID as input: a `RepositoryStorage` exists only for the root it was computed from. The record check (§7.5) refuses a namespace that names another root. MCP binds one at startup (F27). |
| **Missing or corrupt metadata** | §7.5. A corrupt `run.json`, `issue.json` or `retrieval.json` keeps today's handling (`RunArtifactError`, quiet readers). |

### 8.4 Deletion

- `clean` keeps its semantics with a new base. It calls `owned_path(data_root, ("repositories", id, "work", work_item_id))`, and with `--include-memory` also `("repositories", id, "memory", f"{work_item_id}.md")`.
- `owned_path` refuses a link at any component, and refuses a target that resolves elsewhere. `rmtree` removes links inside the tree as links.
- Nothing ever deletes `repository.json`, `settings/`, `config/` or a namespace. Retention is DEFERRED (US-D38).

### 8.5 `safe_paths` generalization (Batch 1)

The functions already take a base and parts (`safe_paths.py:75`, `:107`). Batch 1 adds:

- a `boundary` label for messages. Today the messages say "inside this repository"; they become "inside BugPilot's data folder" for the new base;
- a `mode` argument for `mkdir`.

The callers on the repository-local base keep their exact messages until Batch 2 removes them. In Batch 1, product behaviour stays unchanged.

### 8.6 Errors and messages

- **One error family.** `StorageError` and `StorageIdentityError` are `UnsafePathError` subclasses, so they reach the CLI as one sentence (`ERROR: …` or `INVALID_INPUT`) with no traceback.
- **New error code: OPEN.** A new `errors` code, for example `STORAGE_UNAVAILABLE`, could distinguish "cannot create `~/.bugpilot`" (a permission or disk problem) from bad input. It is part of US-D26.
- **No absolute paths in messages.** Every message names paths in the display form (`display_path`). A system `OSError` can still carry one, the known F12 limit (`docs/safety.md:68`).

### 8.7 Simultaneous callers

| Situation | Behaviour |
| --- | --- |
| Two processes create the same repository namespace | `mkdir` per component tolerates `FileExistsError`. The re-check after `mkdir` refuses a link made in between. The identity record is deterministic, so two atomic writes of it produce identical content. |
| Two VS Code windows and an MCP server on one repository | Same as today: per-file atomic writes; the MCP server's in-process lock serializes its own tools (`mcp_server.py:104-115`). No cross-process lock is added; there is none today either. Two simultaneous preparations of the same work item interleave per file, as in 0.1.5. |
| Extension and CLI | After US-D17 and US-D18, the extension never writes or deletes under the data root. The CLI is the only writer. |
| `atomic_write_text` | unchanged; its temp file is in the target's folder, inside the data root |

### 8.8 Interfaces: CLI, MCP and extension (PROPOSED, US-D17, US-D26, US-D27)

*(US-D17 was approved with conditions on 2026-10-18 (§8.9.1). US-D26 is approved in part, and US-D27 stays PROPOSED.)*

This table is the overview. The exact, testable contract is §8.10.

| Surface | 0.1.5 | 0.1.6 |
| --- | --- | --- |
| `bug --json` | `issue_dir: ".ai/<id>"`, `agent_task: ".ai/<id>/task.md"`, `generated_files: [".ai/<id>/…"]` | `issue_dir`: absolute work folder. `agent_task`: absolute. `generated_files` relative to the repository namespace (`work/<id>/task.md`, `memory/<id>.md`; US-D25). Keys unchanged. |
| `bug --json-lines` | `{"type":"artifact","path":".ai/<id>/…"}` | `path` relative to the namespace; the `started` event gains `work_dir` (absolute) |
| `bug <id> --retry --json` | `feedback_file`, `retry_prompt` relative | absolute; new `--feedback-file <path>` input (US-D18) |
| `list --json` | `work_item_id`, `source`, `title`, `prepared` | adds `work_dir` (absolute) and `modified` (ISO-8601 UTC, the folder's mtime), so the extension stops `stat`-ing |
| `status --json` | `generated_files` | as `bug` |
| `record-review`, `record-verification` | relative report path | absolute |
| `verification`, `ai-behavior`, `instructions`, `project-settings`, `repository-profile` (`show --json`) | `path: ".bugpilot/…"` (display) | `path`: absolute (the extension opens it); new `display_path` |
| `doctor --json` | `ai_artifacts_ignored*`; capabilities | Adds a `storage` object: `data_root`, `data_root_display`, `data_root_source`, `repository_id`, `repository_root`, `repository_dir`, `config_dir`, `state` (`ready`, `absent` or `error`), `problem`, `below_git_toplevel` (US-D4) and `legacy_config_dir_variable` (US-D3). No legacy-presence flags (US-D20 deferred). Removes `ai_artifacts_ignored*` if US-D16 is approved. Capability **`unified-storage`**. Still writes nothing. |
| MCP `prepare_*`, `refine_investigation` | `issue_dir`, `agent_task`, `next_step`, `generated_files` relative | same keys. `issue_dir` and `agent_task` absolute; `next_step` names absolute paths; `generated_files` as `bug` (US-D27). |
| MCP `search_memory` | `file: ".ai_memory/bugs/…"` | `file: "memory/<id>.md"` |
| MCP `check_results`, `summarize_results` | relative `missing`, `fix_report` | absolute |

The rule for absolute paths (US-D22):

- Absolute paths appear only in fields whose job is a path, and in the agent handoff (§9).
- Messages and warnings use the display form.
- Stored artifacts hold no absolute path, except `repository.json` and the generated agent-facing documents (§9.8.1):
  - `task.md`: its work-folder line and its report path;
  - the retry prompt: its work-folder line, its report path and its How to Run handoff line.
- Persisted display and log fields (messages, warnings, the run log) use the display form, never an absolute path.
- *(Reconciled 2026-10-18 with US-D13's approved contract. This rule first allowed only "the `task.md` work-folder line".*
  - *US-D22 stays PROPOSED. Until the owner decides it, its register wording "`task.md`'s work line" is read as the list above.)*

### 8.9 The extension's share of the resolver (US-D17, APPROVED with conditions, §8.9.1)

- **The CLI resolves; the extension asks.** The CLI is the only resolver of the data root and the repository ID. The extension never computes either, never reads `HOME` for them, and never parses `repository.json`.
- **Per root, the extension holds `repository_dir`** from `doctor --json` (it already runs `doctor` at environment check, `executable.ts:169`). It refreshes the value when the root changes. Item-scoped CLI responses (`bug`, `list`, `--retry`) also return `work_dir`.
- **For a work item known only by id**, the extension composes `<repository_dir>/work/<id>`:
  - examples: the workspace-state restore at `extension.ts:328`, a typed Jira key at `controller.ts:5056`;
  - only after the id passes the shared `WORK_ITEM_ID_RE`;
  - only through one helper whose output is tested against Python's on a shared fixture, as `tests/fixtures/work_item_ids.json` is today.
- **The extension may *read*, *open* and *watch* under that folder:**
  - `run.json`, `issue.json`, the reports and `retrieval.json`;
  - files opened in an editor, and the policy files under `settings/`;
  - it keeps its lstat checks (`bugpilotFiles.ts`), with the base now `repository_dir`.
- **It never writes or deletes there.**
  - `user_feedback.md` goes through the CLI (US-D18).
  - Reset Session's deletion goes through `bugpilot clean` only; the TypeScript pre-check (`sessionReset.ts:190-265`) is retargeted or removed.
- **Why not have the CLI return every file path?** History reads `run.json` for up to every work item in a repository. Spawning the CLI per item, at about 300 ms each, would make History slow. Composing a validated id under a CLI-given base keeps the CLI the authority on the parts that can go wrong (root, identity, links), without a process per file.
- *(Decided 2026-10-18, §8.9.1, with five clarifications and two security amendments. Where this section differs, §8.9.1 governs:*
  - *settings paths come only from `show --json` `path`;*
  - *History uses only `list --json`;*
  - *CLI-returned paths are validated before use;*
  - *a cache mismatch triggers re-resolution, never just a string update;*
  - *the extension never mutates storage.)*

#### 8.9.1 Owner decision (2026-10-18): the approved US-D17 contract

**Decision.** US-D17 is **APPROVED — with conditions**, as §8.9's design (**Option B** of the US-D17 review), with the review's five clarifications and two security amendments.

- It is a design approval only. Nothing is implemented or activated.
- The frozen US-D26 CLI JSON contract (§8.10, `tests/fixtures/storage_cli_contract.json`) is not expanded. No `storage.work_root` and no other new field is added.

**1. Who resolves paths.** `bugpilot/core/storage.py` is the authoritative Python resolver for:

- the data root;
- the canonical repository identity and namespace;
- each work item's identity and location;
- the storage layout.

The CLI, workflow, MCP and `task-preview` get their paths through the approved Python storage APIs. The VS Code extension gets its authoritative base paths from CLI JSON responses.

The extension never:

- resolves `HOME` or `BUGPILOT_HOME` itself;
- computes the repository ID;
- parses `repository.json` to rebuild storage paths;
- accepts a repository ID from an untrusted caller;
- builds a repository-local `.ai/`, `.ai_memory/` or `.bugpilot/` path as a fallback.

**2. The approved CLI fields.** These are the existing frozen fields:

| Need | Field |
| --- | --- |
| The repository namespace | `doctor --json` → `storage.repository_dir` |
| One work item | item responses' `work_dir`, `issue_dir` and `agent_task` |
| History | `list --json` → `work_items[].work_dir` and `.modified` |
| A settings file | each settings command's `show --json` `path` |
| Messages | the relevant display-path fields |

The frozen path kinds are kept as they are:

| Kind | Meaning |
| --- | --- |
| `abs` | the canonical path in the platform's native form |
| `posix-abs` | an absolute path with forward slashes, for prompt rendering |
| `display` | the privacy-conscious form |
| `ns` | relative to the repository namespace, for persisted records |
| `id` | a validated repository identity |

**3. The five clarifications.**

1. **Authority.**
   - Inside Python, every consumer asks `storage.py`.
   - The extension takes base paths only from the CLI's frozen fields.
2. **Prefer the paths the CLI returns.**
   - An item uses its own response's paths.
   - History uses `list --json` as the authoritative list of work items. It never scans the filesystem to find them. It reads `run.json` only from a validated work folder, by its fixed name, with the existing safe-read checks.
   - Settings always use `show --json` `path`. The extension never rebuilds `.bugpilot/<setting-name>` inside the source repository.
3. **Limited composition.** The extension may compose only two kinds of path:
   - **A.** A file from the closed set of fixed artifact names, under an already validated `work_dir`.
   - **B.** `<repository_dir>/work/<validated-work-item-id>`, when only a work-item id is available. Case B requires all of:
     - `WORK_ITEM_ID_RE` validation;
     - one central composition helper;
     - a shared Python and TypeScript fixture;
     - containment checks;
     - the existing per-read file-safety checks.

   Unchecked, user-provided path components are never joined.
4. **Freshness:** see point 6 below.
5. **Failure:** see point 8 below.

**4. Security amendment A: CLI paths are validated before use.** The extension never trusts a path just because it came from CLI JSON. It checks:

- that the required JSON field is present and has the right type;
- native absolute-path syntax, and the meaning expected of the path's kind;
- the work-item id's format, where one is used;
- agreement with the current repository namespace;
- containment under the authoritative repository directory;
- safe file types, and the existing lstat and link restrictions.

The rules for that checking:

- **Containment is checked component by component, never by string prefix.** It allows for each platform's documented canonicalization, case sensitivity and separators.
- **No link or junction is followed below the data-root boundary.** The Python storage guarantees, including the identity and component checks, are unchanged.
- **A syntactically valid path is not assumed to be safe.**

If a path is inconsistent, stale, corrupt or outside the expected namespace:

- it fails closed, and the relevant cached information is invalidated;
- the path is re-resolved through the CLI where appropriate;
- a questionable path is never read, opened or watched;
- nothing falls back to legacy storage.

**5. Security amendment B: the extension only reads storage.**

Allowed:

- reading validated files;
- opening validated files for viewing;
- watching validated locations;
- refreshing from CLI results;
- asking for CLI-owned operations through their approved interfaces.

Forbidden as a direct extension storage change:

- creating or overwriting BugPilot artifact files;
- deleting storage files or folders;
- moving or renaming storage objects;
- changing the repository identity records;
- cleaning up legacy storage;
- changing storage permissions to gain access;
- treating a file watcher as the authoritative state.

`user_feedback.md` is written through the approved CLI path (US-D18). Reset Session uses the approved `bugpilot clean` workflow, never deletion by the extension. These rules govern BugPilot's own programmatic storage changes; they do not redefine a developer's ordinary VS Code editing.

**6. Freshness and cache invalidation.**

- `repository_dir` is refreshed:
  - during each relevant environment check;
  - after a known storage-root change;
  - when an item response's `work_dir` disagrees with the cached `repository_dir`;
  - when the current repository context changes.
- A mismatch triggers canonical re-resolution and identity validation. The cached string is never just updated with reading carried on.
- If the mismatch stays unresolved, it fails closed.
- An item's CLI-returned `work_dir` is used only after it is validated against the refreshed repository context.
- The request-scoped identity guarantees of the storage foundation are respected.
- Caching in the extension does not remove TOCTOU risk, and is not claimed to.

**7. Repository identity.** The storage foundation's established behaviour is kept for:

- repository moves and renames;
- Windows case-only renames;
- a repository recreated at the same canonical location;
- an identity-record mismatch;
- root changes;
- concurrent readers and writers.

No migration, reconciliation, copying or deletion of old namespaces is authorized. The extension uses the existing storage APIs and error contracts, never an identity scheme of its own.

**8. Storage failure.** When `doctor --json` reports `state: error`:

- the problem is shown in the display-path form;
- no new storage path is composed;
- questionable storage is not read, opened or watched;
- no agent handoff starts;
- no legacy repository storage is used;
- existing files are preserved.

The public `STORAGE_UNAVAILABLE` error contract depends on US-D26, which this decision does not decide.

**9. Watchers and real VS Code behaviour.** File watchers are refresh hints only. After a relevant CLI operation, the extension:

- refreshes the authoritative item state;
- re-reads the final artifact content when needed;
- does not rely on receiving an initial create event;
- handles atomic replacement and a watcher that becomes ready late. P7 saw new watchers miss events for about 10 seconds.

Batch 3 tests each of these separately, on Windows, macOS and Linux where required:

- reading and watching outside the workspace;
- the initial readiness of a watcher;
- atomic replacement;
- Open Artifacts Folder;
- `revealFileInOS`.

P7 stays PASS only for the Windows API operations it tested. `revealFileInOS` stays UNKNOWN until verified.

**10. Related decisions.** No other decision's status changes:

- US-D10, US-D12, US-D13, US-D14, US-D28 and US-D30: stay APPROVED — with conditions.
- US-D18, US-D22 and US-D27: stay PROPOSED.
- US-D26: stays approved in part.
- US-D16 and US-D29: stay OPEN.

Only US-D16 governs the existing "Add to .gitignore" behaviour. US-D17 does not approve removing it.

**Required tests:**

- The shared Python and TypeScript composition fixture: ids, the two allowed compositions, and refusals.
- **CLI path validation:**
  - field presence and type, `abs` syntax and the kind's meaning;
  - component-wise containment, including Windows case folding and separators;
  - refusal of links and junctions.
- **Freshness:**
  - a mismatch leads to re-resolution;
  - an unresolved mismatch fails closed;
  - a root change invalidates the cache.
- **History and settings:** History only from `list --json`, with no scan; settings only from `show --json` `path`.
- **The extension never writes:**
  - a write witness or fake filesystem shows no creation, overwrite, deletion, rename or permission change;
  - feedback goes through the CLI;
  - Reset Session goes through `bugpilot clean`.
- **`state: error`:** no composition, read, watch or handoff.
- **Paths in output:**
  - messages and logs use only the display form;
  - the CLI's and MCP's `abs` values agree;
  - `abs` and `posix-abs` are rendered correctly on Linux, macOS and Windows.
- **Regression:**
  - the existing storage safety suites;
  - ratchet reductions in each batch;
  - frozen baselines untouched.
- **Batch 3 real-window checks:** listed in point 9.

**Implementation conditions** (all open):

- US-D18 decided (feedback through the CLI);
- US-D22 decided (display form);
- US-D27 decided (MCP values);
- US-D26's error code decided;
- US-D29 decides where the change lands.

The US-D17 review also noted US-D4 (OPEN, what the repository root is), which decides which root the CLI resolves.

**Activation conditions:**

- Batch 3's real-window checks;
- Batch 4's cross-platform validation;
- the 2B-5 per-tool-call scope, for MCP;
- §14.3's gates.

### 8.10 The storage JSON contract (US-D26; review: accept conditionally)

**Why this section exists.** The review asks for an exact, independently testable contract *before* implementation. This section is that contract in prose.

**How it is frozen and tested.**

- Batch 1 freezes it as `tests/fixtures/storage_cli_contract.json`. This is test data only; no product code reads it.
- The owner's approval of this section and the fixture, at the Batch 1 gate, is a precondition of Batch 2 (§14.3). **Approved in part on 2026-10-16** (US-D26, §16.1): the semantics below and the fixture's typed entries. The `STORAGE_UNAVAILABLE` choice stays OPEN, and the rows that follow US-D4, US-D16, US-D18, US-D25 and US-D3's deprecated-variable handling are not approved by it.
- Python (`tests/test_storage_contract.py`) and TypeScript (`extension/test/storageContract.test.ts`) each test against the fixture, never against the other side's code.
- A change to the contract is a change to the fixture, reviewed as such.

**Value kinds**

| Kind | Definition | Example |
| --- | --- | --- |
| `abs` | an absolute path in the platform's own separators. No trailing separator, never `~`; the canonical form `storage` computed. | `C:\Users\you\.bugpilot\repositories\app-0123456789abcdef\work\JR-12345`; `/home/you/.bugpilot/repositories/app-0123456789abcdef/work/JR-12345` |
| `ns` | relative to the repository namespace folder. `/` on every OS; no leading `./`; never `..`. | `work/JR-12345/task.md`, `memory/JR-12345.md` |
| `display` | the display form of §8.2: `~/.bugpilot/…` or `BUGPILOT_HOME/…`, with `/`. Never the user's own folder name. | `~/.bugpilot/repositories/app-0123456789abcdef/work/JR-12345/task.md` |
| `posix-abs` | `abs` written with `/`. Used only inside prompt and handoff text. | `C:/Users/you/.bugpilot/repositories/app-0123456789abcdef/work/JR-12345/task.md` |
| `id` | a repository ID matching `^[a-z0-9][a-z0-9._-]{0,23}-[0-9a-f]{16}$` | `app-0123456789abcdef` |

**Keys.** A key keeps its 0.1.5 name unless it is marked *new* or *removed*. "Value" means the key stays and its value's form changes.

| Command or tool | Key | Kind | Null when | Change |
| --- | --- | --- | --- | --- |
| `bug --json` | `issue_dir` | `abs` (the work folder) | never | value (was `.ai/<id>`) |
| | `agent_task` | `abs` | no `task.md` was written (`--only-issue-details`) | value |
| | `generated_files[]` | `ns` | — | value |
| `bug --json-lines`, event `started` | `work_dir` | `abs` | never | **new** |
| `bug --json-lines`, event `artifact` | `path` | `ns` | — | value |
| `bug <id> --retry --json` | `feedback_file`, `retry_prompt` | `abs` | never | value |
| | input `--feedback-file <file>` | a regular UTF-8 file, not a link, copied verbatim into `user_feedback.md` by the atomic writer | — | **new** option (US-D18) |
| `list --json` | `work_items[].work_dir` | `abs` | never | **new** |
| | `work_items[].modified` | `YYYY-MM-DDTHH:MM:SSZ` (UTC, the folder's mtime, whole seconds) | the mtime cannot be read | **new** |
| `status --json` | `generated_files[]` | `ns` | — | value |
| | `work_dir` | `abs` | never | **new** |
| `fetch --json` | `issue_dir` | `abs` | never | value |
| step commands with `--json` (`search`, `context`, …) | `generated_files[]` | `ns` | — | value |
| `check-results --json` | `missing[]` | `abs` | — | value |
| `summarize-results --json` | `fix_report` | `abs` | the report is absent | value |
| `record-review --json` | `review_report` | `abs` | never | value |
| `record-verification --json` | `verification_report` | `abs` | never | value |
| `instructions show --json` | each scope's `path` | `abs` | never | value (was a display string) |
| | each scope's `display_path` | `display` | never | **new** |
| `verification`, `ai-behavior`, `project-settings`, `repository-profile` `show --json` | `path` | `abs` | never | value |
| | `display_path` | `display` | never | **new** |
| `fix-mode list --json` | `issues[].path` | `display` | — | value (was absolute; SF-3) |
| `doctor --json` | `capabilities[]` | gains `"unified-storage"` | — | value |
| | `ai_artifacts_ignored`, `ai_artifacts_ignored_paths` | — | — | **removed** only if US-D16 is approved |
| | `storage` | an object, below | never | **new** |
| `doctor --json` → `storage` | `data_root` | `abs` | the home cannot be resolved | **new** |
| | `data_root_display` | `display` | as above | **new** |
| | `data_root_source` | `"default"` or `"BUGPILOT_HOME"` | never | **new** |
| | `repository_root` | `abs` | the root cannot be resolved | **new** |
| | `repository_id` | `id` | as above | **new** |
| | `repository_dir` | `abs` | as above | **new** |
| | `config_dir` | `abs` | the data root cannot be resolved | **new** |
| | `state` | `"ready"` (record verified), `"absent"` (namespace not created yet), `"error"` | never | **new** |
| | `problem` | one sentence, display paths only | `state` is not `"error"` | **new** |
| | `below_git_toplevel` | boolean (§7.1) | no git, or not a checkout | **new** (US-D4) |
| | `legacy_config_dir_variable` | boolean: `true` when `BUGPILOT_CONFIG_DIR` is set (its value is never read or shown) | never | **new** (US-D3) |
| MCP `prepare_jira_bug`, `prepare_bug_description`, `refine_investigation` | `issue_dir` | `abs` | never | value |
| | `agent_task` | `abs` | no task | value |
| | `generated_files[]` | `ns` | — | value |
| | `next_step` | text naming the `posix-abs` paths of `task.md` and `context.md` | — | value |
| MCP `check_results` | `missing[]` | `abs` | — | value |
| MCP `summarize_results` | `fix_report` | `abs` | absent | value |
| MCP `search_memory` | `matches[].file` | `ns` (`memory/<id>.md`) | — | value |
| MCP `get_status` | `generated_files[]` | `ns` | — | value |
| persisted `run.json` | `generated_files[]` | `ns` | — | value; `schema_version` stays 1 (US-D25) |
| persisted `repository.json` | §7.5 | — | — | **new** file |

**What stays the same.**

- The envelope (`schema_version`, `ok`, `command`, `error.code`, `error.message`) is unchanged.
- A 0.1.5 client ignores the new keys. The only removed keys are the two `ai_artifacts_ignored*`, and only if US-D16 is approved.
- `StorageError` and `StorageIdentityError` report `INVALID_INPUT`.
- Whether to add a separate `STORAGE_UNAVAILABLE` code (the data root cannot be created or written) stays an owner choice within US-D26. Until it is chosen, such failures use the existing generic code.

**How each side checks it.**

- **The fixture** lists, per command and key: the kind, when it is null, and whether the key is new, changed or removed.
- **`tests/test_storage_contract.py`** runs each command in an isolated repository and data root, and checks every listed key against its kind:
  - `abs`: absolute and under the isolated data root;
  - `ns`: `/` only, no `..`, resolving inside the namespace;
  - `display`: starts with `~/.bugpilot/` or `BUGPILOT_HOME/`, and contains no component of the isolated home's path;
  - `id`: matches the regex.
- **`extension/test/storageContract.test.ts`** reads the same fixture, and checks that every key the extension consumes is listed with the kind the extension assumes.

---

## 9. Agent Handoff analysis (critical design gate)

### 9.1 What the handoff depends on today

An agent is started with the repository as its working directory and is given repository-relative paths.

| Surface | Today | Reads | Writes | Source |
| --- | --- | --- | --- | --- |
| Fix with AI: terminal launch | `claude "Read .ai/<id>/task.md and complete the workflow."` (with `--session-id <uuid>` when the CLI's `--help` lists it); `codex "<same>"` | `task.md`, then `context.md`, `retrieval.json`, attachments | `fix_report.md` | `extension/src/app/agents.ts:320-370`, `controller.ts:2988-3033`, `:3349-3351`; `src/host/agentTerminals.ts:74-82` (`createTerminal({cwd: root})` + `sendText`) |
| Fix with AI: extension bridges (Claude Code, Codex extensions) | the prompt is copied to the clipboard, and the agent's view is revealed | as above | as above | `agents.ts:420-510` |
| Open AI Session / relaunch / Resume Agent Session | `claude --resume <uuid>` / `claude -c`; reads `~/.claude/projects/<slug(root)>` | — | — | `src/app/session.ts:26-72`, `controller.ts:2472-2552`, `extension.ts:790-808` |
| Retry | `Read .ai/<id>/agent_retry_prompt.md and continue the workflow.` | retry prompt, `user_feedback.md`, `fix_report.md`, `context.md`, `retrieval.json`, `task.md` | `fix_report.md` | `nextAction.ts:206-208`, `workflow.py:1956-2069` |
| Review with AI: terminal | the `review-package` prompt | `context.md`, `retrieval.json`, `fix_report.md` | none | `workflow.py:2400-2407`, `controller.ts:5460` |
| Review with AI: captured | `claude -p --output-format json --no-session-persistence --setting-sources "" --strict-mcp-config --permission-mode dontAsk --tools Read Grep Glob --allowedTools Read Grep Glob`, the prompt on stdin | as above | none (no write tool) | `agents.ts:210-252`, `controller.ts:5501-5540` |
| Hint improver | `claude -p --tools ""` or Codex read-only, in an empty temp folder; the issue text inline | none | none | `src/app/hintImprovement.ts:212` (**unaffected**) |
| Copy handoff prompt / Copy Again / no-agent fallback | the same sentence on the clipboard | as Fix | as Fix | `controller.ts:2808-2813`, `:3073-3140` |
| CLI `--launch-agent claude\|copilot` (deprecated) | `subprocess.run([…, prompt], cwd=repo_root)`; a `.cmd` shim runs through `cmd /c` | as Fix | as Fix | `agent_runner.py:60-138` |
| MCP | the client model calls `prepare_*`, then reads the returned `.ai/<id>/task.md` and `context.md` with its own tools | as Fix | `fix_report.md` | `mcp_server.py:231-280` |
| Claude Code skill | runs `bugpilot bug <ISSUE> --prepare-only --resume`, then reads `.ai/<ISSUE>/task.md` | as Fix | `fix_report.md` | `skills/bugpilot-investigate/SKILL.md` |
| Commands `task.md` tells the agent to run | `bugpilot jira-comment-draft <id>`, `bugpilot jira-comment <id> --execute` (opt-in), "from the target repo root" | — | the CLI writes into storage | `prompts.py:349-364` |

### 9.2 What the agents allow outside their working directory

From the vendors' documentation as of 2026-10. **V** = documented (source given). **A** = inferred. **No row was observed live.** The Batch 0B probes (§9.7) observe them, with the owner's separate approval. Until then, every row is documentation, not evidence.

| | Claude Code CLI | OpenAI Codex CLI | GitHub Copilot CLI |
| --- | --- | --- | --- |
| **Read** outside cwd, default modes | **Prompts** in default and `acceptEdits` for Read/Grep/Glob. Built-in read-only Bash commands (`cat`…) run without a prompt unless `permissions.blockReadsOutsideWorkingDirectories` (2.1.257+) is set. `auto` mode prompts once for the first outside read. (V: code.claude.com tools-reference, permissions, permission-modes) | **Allowed** in `read-only` and `workspace-write`: the default read access is full. (V: Codex app-server "Sandbox read access", agent-approvals-security). The Windows `elevated` sandbox runs commands as separate users, and whether they can read `%USERPROFILE%\.bugpilot` is **not documented** (A). | **Prompts** ("Allow directory access", once or add to the list). Default scope: cwd, its subdirectories and the system temp folder. (V: docs.github.com configure-copilot-cli) |
| **Write** outside cwd | **Prompts**. `acceptEdits` auto-accepts only inside the working directory or `additionalDirectories`. In `-p` with no permission host, a prompt becomes a deny. (V: permission-modes, headless) | `workspace-write`: **needs approval** (`on-request`); refused with `-a never`. `read-only`: refused. (V: agent-approvals-security) | **Prompts**. (V) |
| `dontAsk` (captured review) | Only working-directory reads and pre-approved tools run. A bare `Read` allow rule "matches all file reads", so the captured review **can** read an external path, except most network paths. (V: permission-modes, permissions) | — | — |
| **Grant one more directory** | `--add-dir <path>`: read **and** edit (edits follow the permission mode); the path must exist; it also widens a Bash sandbox's write set **and loads `.claude/skills\|commands\|agents` from it**. Settings: `permissions.additionalDirectories` (file access only). (V: cli-reference, permissions, sandboxing) | `--add-dir`: "additional directories write access"; config `sandbox_workspace_write.writable_roots`. OpenAI recommends it over full access. (V). Whether `codex exec` accepts `--add-dir`, and what it does in `read-only`: **A** | `--add-dir=PATH` (read/write); must exist; **loads `.github/skills\|agents` from it as trusted config**; `--allow-all-paths` disables path checks entirely. (V: cli-command-reference) |
| **Prompt input** | argv (`claude "q"`, `-p "q"`); stdin with `-p` only (10 MB); `--append-system-prompt-file` / `--system-prompt-file` (documented for interactive and `-p`; older versions `-p` only, so A for the installed version); `@path` mentions accept absolute paths, but how they are permission-checked is **not documented** | argv (`codex "q"`, `codex exec "q"`); stdin for `exec -` only; `model_instructions_file` **replaces** built-in instructions (unsuitable) | argv (`-p`, `-i`); piped stdin; `--attachment PATH` (whether `.md` is accepted: A) |
| **Bash or command sandbox** | off by default; **not available on native Windows** | per mode; Windows `mxc`, `elevated` and `unelevated` implementations | local sandbox, best effort for file tools |

**Windows command-line limits** (V: Microsoft Learn):

- CreateProcess `lpCommandLine`: at most 32,767 characters.
- `cmd.exe`: at most 8,191 characters. This applies to the npm `claude.cmd` and `codex.cmd` shims.

### 9.3 BugPilot's own constraints

1. **The prompt gate.**
   - The rule: `PLAIN_PROMPT = /^\s*[A-Za-z0-9#][A-Za-z0-9\s.,:#/_-]*$/` (`agents.ts:266`).
   - Every handoff passes it before it is sent: Fix, Retry, Review and custom commands (`agents.ts:278-280`, `:354`, `:567`, `:672`).
   - Why it exists: the prompt is typed into the user's shell with `terminal.sendText`, and is quoted with JSON's escaping, which no shell honours fully (§37.27, §37.70).
   - What it refuses: a backslash (any native Windows path), `~`, parentheses, apostrophes, `@`, `+`, `&`, `%`, and every non-ASCII letter.
   - Spaces are allowed: the prompt is a single quoted argument.
   - *(US-D12, approved 2026-10-18, §9.9.1: the character set stays exactly this. But the regular expression's `\s` also admits Unicode whitespace, and `flatten` collapses whitespace after the gate. Both are tightened before activation, so no prompt passes through `\s` alone and no path is rewritten. Python gets an equivalent gate.)*
   - Example: `C:/Users/you/.bugpilot/…` passes; `C:\Users\you\…` does not, and neither does a forward-slash home whose user name holds a letter outside ASCII.
2. **`cmd.exe` in the Python launcher.**
   - `agent_runner._resolve_launch_command` runs a `.cmd` shim as `cmd /c <shim> <prompt>` (`agent_runner.py:133-137`).
   - `cmd.exe` re-parses its arguments: `%VAR%`, `^` and `&`.
   - Today's prompt is a fixed shape around a validated id, so it is safe. A home path is not under BugPilot's control. **0.1.6 applies the same plain-prompt rule in Python before launch** (§10, T-S12).
3. **The working directory.**
   - The repository stays the agent's cwd (R8). Claude's session-store lookup for Resume Agent Session depends on it (`session.ts:26-28`).
4. **Size.**
   - `task.md` is about 12 KB and `context.md` up to tens of KB.
   - Neither fits through `cmd.exe`'s 8,191 characters, and both fail the prompt gate (Markdown).

### 9.4 Options

**Option A — the absolute external path; the agent's own permissions apply.**

- **How it works:** the prompt and `task.md` name the work folder by absolute path, written with forward slashes.
- **Reads:**
  - Codex reads freely (V).
  - Claude and Copilot ask the developer (V).
  - Claude's captured review reads under its bare `Read` allow (V).
- **Writing `fix_report.md`:** Claude and Copilot prompt; Codex `on-request` prompts (V).
- **R8:** nothing is widened; every outside access is the developer's explicit choice in the agent's own UI.
- **Costs:**
  - one or two permission prompts per session, more if the developer chooses "once" rather than "for this folder";
  - unattended runs (`-p`, `exec -a never`) cannot write the report;
  - a home path outside the gate's class cannot be launched through a terminal.

**Option B — the task inline.**

- **How it works:** the task text goes through argv, stdin or a system-prompt file.
- **What it costs or cannot do:**
  - argv is ruled out by the 8,191 and 32,767 limits and by the gate;
  - stdin works only for one-shot runs (Claude `-p`, `codex exec -`), while Fix with AI is an interactive session;
  - Claude's `--append-system-prompt-file` is the one interactive file route. It moves BugPilot's task into the system prompt, must be passed again on `--resume`, is version-dependent (A), and cannot carry attachments;
  - context and attachments still have to be read from somewhere;
  - **it does not solve the write side at all.**
- **What it is good for:** a fallback, through the clipboard into the agent's own input box (no shell involved). The extension already offers this: "Copy effective task" (`controller.ts:3991-4005`) and "Copy context" (`:2821-2831`).

**Option C — the agent's own extra-directory grant** (`--add-dir <work folder>`).

- **Effect:** prompt-free reads and writes inside one named folder, under `acceptEdits`, `workspace-write` and Copilot's path checks (V). OpenAI's documentation recommends it over full access.
- **R8:** it **is** a widening of the agent's boundary, even if a narrow one. It may therefore never be automatic.
- **If ever offered, it must be:**
  - opt-in, through an explicit setting;
  - visible on the command line;
  - narrow: exactly `work/<id>/`, never `~/.bugpilot`, `repositories/` or `config/`;
  - probed per agent version;
  - re-sent on every launch and relaunch.
- **A trust hazard of its own:** Claude and Copilot load `.claude/` and `.github/skills|agents` from added directories as trusted configuration. BugPilot would have to guarantee that no such entry can exist in a work folder (T-S16).

**Option D — the safe hybrid** (A by default, B as fallback, C opt-in later). This is the recommendation in §9.5.

### 9.5 Provisional recommendation (US-D10 APPROVED with conditions, §9.5.1; US-D28 APPROVED with conditions, §16.5.11; US-D11: review recommends deferring)

**Option D, provisionally.** It is the review's recommendation, not a decision.

- US-D10 stays OPEN until the Batch 0B probes (§9.7) show that Option D works for the combinations the owner supports, against §9.10's acceptance.
  - *(Decided on 2026-10-18, §9.5.1: approved with conditions as a design. The owner accepted the probe gap for design only, so no combination is supported until §9.10's evidence passes.)*
- US-D28 was approved with conditions on 2026-10-18, after probe P2, as an amended design contract (§16.5.11).
- Nothing here grants an agent another directory or changes a sandbox mode.

Concretely:

1. **Prompt text.** The handoff names the absolute task path in forward-slash form, rendered by `handoff.py`. The template stays the same apart from the path:

   ```text
   Read C:/Users/you/.bugpilot/repositories/checkout-9f2c41d07ab3e815/work/JR-12345/task.md and complete the workflow.
   Read C:/Users/you/.bugpilot/repositories/checkout-9f2c41d07ab3e815/work/JR-12345/agent_retry_prompt.md and continue the workflow.
   ```

   The extension's copy of each template stays and is cross-language tested as today. The path comes from the CLI (US-D17).
2. **Permissions.** No permission flag is added and the cwd stays the repository (R8). The agent's own permission prompts appear, and the developer answers them.
   - The panel's handoff guidance (the 0.1.2 inline step, §40) gains one sentence: "The agent will ask to read and write this work item's BugPilot folder, which is outside the repository. Allow that folder only."
     - *(Superseded 2026-10-18, §9.5.1: the approved guidance is "Your AI agent may need permission to access the BugPilot work folder outside your repository. Review any permission requests carefully and grant access only when necessary." It does not say an agent will always ask.)*
   - `docs/safety.md` says the same.
3. **The gate is unchanged.** When a prompt fails it, the extension does not launch a terminal. It falls back to the existing manual handoff: the prompt goes on the clipboard, with a notice saying why. A shell never sees the text; it is pasted into the agent's own input. The notice names the remedy: a `BUGPILOT_HOME` without such characters (§13). Widening the gate is **not recommended** (US-D12).
   - *(Noted 2026-10-18, §9.5.1: today a refused prompt marks the fix "skipped" with a warning, so routing a refusal to the clipboard mechanism is new 0.1.6 behaviour. How bridges and the captured review are handled on a refusal stays with US-D12.)*
   - *(Decided 2026-10-18, US-D12, §9.9.1: both stay gated in 0.1.6. A bridge refusal copies and notifies only, and Review with AI keeps its own error and manual recovery.)*

   - **Safer launch mechanisms.** A launch without a shell could let more paths through; §9.9 evaluates it. Until its conditions are met (P11 PASS on three systems, plus a separate owner approval), the gate and this fallback stand, and the limitation is documented (§13.4).
   - **The fallback is not a success.** A handoff completed through this fallback is recorded as **FALLBACK**, not as a successful one-click Fix with AI (§9.10).
4. **Python launcher (`--launch-agent`).** The same plain-prompt rule applies before `subprocess.run`. A refused prompt prints the manual instruction, which today's not-found path already does (`cli.py:1601-1605`).
5. **Captured review.** The prompt keeps naming the files, now by absolute path. It relies on the bare `Read` allow (V).
   - Probe P2 observed the external reads working on Windows (§14.1.B). US-D28 is APPROVED with conditions, as a design contract (§16.5.11).
   - `Read` is not a filesystem sandbox: the reviewer can open other files too.
   - **There is no automatic inline fallback.** This was amended on 2026-10-18; this point first proposed putting the excerpt inline on a denied read.
     - A denial that the run reliably reports is shown as a failure.
     - A separately identified, developer-initiated **Partial Review** may carry at most 2,400 characters of `fix_report.md`. The excerpt is quoted as earlier AI output and marked as incomplete source material.
     - A Partial Review is never automatic, and never presented as a full review (§16.5.11).
6. **MCP and the skill.**
   - `agent_task`, `issue_dir` and `next_step` carry absolute paths. The client model reads with its own tools, under its own permissions, as in A.
   - The skill reads the `agent_task` path the CLI prints instead of composing `.ai/<ISSUE>/…`.
7. **Commands named in `task.md`** (`bugpilot jira-comment-draft`, `jira-comment --execute`):
   - Unchanged. The CLI resolves the namespace from the repository cwd.
   - Under a sandbox that confines writes to the workspace (Codex `workspace-write`; Claude's Bash sandbox on macOS and Linux), the CLI's write into the data root needs the agent's approval, or the developer runs the command. `jira-comment --execute` also needs the network, which Codex's sandbox already blocks in 0.1.5. These steps are opt-in (`--jira-comment`). The behaviour is documented, not changed.
8. **Opt-in grant (US-D11).**
   - **Recommendation:** DEFERRED. Ship 0.1.6 with A + B; measure the prompt burden in Batch 5's live pass; offer C in a later release if the burden is real.
   - **If the owner wants it in 0.1.6:**
     - a `bugpilot.agentAccess` setting, `ask` (default) or `grantWorkItemFolder`;
     - `--add-dir <work folder>` for Claude and Codex only, after a flag probe;
     - never for Copilot until its `--add-dir` trust loading is probed;
     - Batch 3 then gains T-S16's tests.

#### 9.5.1 Owner decision (2026-10-18): the approved US-D10 contract

**Decision.** US-D10 is **APPROVED — with conditions**, as **Option D** with the owner's amendments.

- It is a design approval only.
- **The owner explicitly accepts the missing real-agent probe evidence for this design approval only.** That acceptance does not extend to:
  - implementation verification;
  - claims that any agent is supported;
  - production activation.
- §9.7 requires this acceptance to be recorded; it is, in §16.1, "Accepted evidence gaps".
- US-D12 remains a separate decision and is not approved by this one.

**1. The handoff contract.**

- The AI agent starts in the target source repository root.
- BugPilot passes it a short handoff instruction that names the canonical external work folder:

  ```text
  Read <WORK>/task.md and complete the workflow.
  Read <WORK>/agent_retry_prompt.md and continue the workflow.
  ```

  The first line is the initial handoff; the second is the retry handoff.
- `<WORK>` is resolved and validated by the BugPilot CLI, under US-D13 and US-D17. It is rendered with forward slashes on every supported operating system.
- The same canonical wording is used across the CLI, extension and retry-prompt paths.
- MCP tool outputs follow the separately decided US-D27 contract.
- The extension and the MCP layer never construct storage paths themselves.

**2. Existing agent behaviour is preserved.** This decision introduces none of the following:

- a new agent permission mode;
- an automatic `--add-dir` grant;
- a sandbox bypass flag;
- unrestricted filesystem permission;
- an automatic directory approval;
- a new shell-free launch mechanism;
- automatic staging, commits or pushes.

US-D11 remains deferred: no grant is part of this contract, and its register status is unchanged (OPEN, with the review recommending deferral past 0.1.6). Agent permissions stay under the developer's control, and BugPilot does not claim to enforce an operating-system filesystem sandbox.

**3. The prompt gate.**

- US-D12's existing prompt gate is preserved until US-D12 receives its own owner approval. No rejected prompt reaches a shell. *(US-D12 approved with conditions on 2026-10-18, §9.9.1.)*
- When an automatic handoff is unsafe or unsupported:
  - the agent is not opened or launched automatically;
  - a manually usable handoff instruction is provided through the existing clipboard mechanism;
  - an accurate notice explains why automatic launch was not available;
  - the canonical storage path is never altered or sanitized into a different path;
  - storage-path validation is never bypassed.
- How the non-shell extension-bridge and captured-review paths are handled stays subject to US-D12. This decision approves no exception to the gate. *(Decided by US-D12 on 2026-10-18, §9.9.1: both stay gated; no relaxation.)*
- *Implementation note (US-D10 review):*
  - Today a refused prompt marks the fix "skipped" with a warning (`controller.ts:2970-2979`). The clipboard mechanism is used today only when no agent is available.
  - Routing a refusal to the clipboard is therefore new 0.1.6 behaviour.
  - `#handOver`'s comment that a refusal is "Not reachable with a valid id" stops being true once the prompt carries a home-folder path.

**4. Manual fallback.** A controlled manual handoff is supported when:

- the gate refuses the automatic handoff;
- the selected agent cannot be launched;
- the selected integration is a clipboard-based extension bridge.

It follows these rules:

- The canonical handoff sentence is kept.
- A whole `task.md` never goes into an automatically built shell command.
- A different agent is never started silently.
- A clipboard operation does not claim success until it has actually completed.
- A storage-unavailable error never turns into a manual launch.

**5. Permission guidance.** The approved text:

> "Your AI agent may need permission to access the BugPilot work folder outside your repository. Review any permission requests carefully and grant access only when necessary."

- It does not say that Claude, Codex or Copilot will always ask before reading. Access to the work folder is never granted automatically.
- If an agent reliably reports a denied read or write, the actual error and the available recovery actions are shown.
- If there is no reliable denial signal, a denial is not inferred from an exit code or a missing report.
- Manual recovery stays available through the approved paths: `task-preview`, Copy effective task and `manual-result` (§9.6).

**6. Session and retry.**

- The established attempt and session-id contract is preserved.
- Session-id arguments are used only with agent versions confirmed to support the required flags.
- The agent's working directory remains the repository.
- Retry prompts use the exact retry sentence above.
- No new agent is started automatically after a failed retry.
- US-D30's A_retry stays preliminary until the final owner-approved golden diff exists.

**7. Logging and privacy.**

- Absolute work-folder paths may appear in the actual handoff prompt and in the terminal command.
- Persisted UI messages and run-log fields use the display form under US-D22, which is decided separately.
  - *Implementation note:* today `workflow.py:616` writes the handoff sentence into the run log.
- BugPilot discloses that absolute paths sent to AI agents may include user names or local folder names.
- No unnecessary absolute path is added to a stored diagnostic field.

**8. Storage failures.** If storage is unavailable, invalid or stale:

- the command fails closed, and no task is handed off;
- there is no fallback to `.ai/`, `.ai_memory/` or a repository-local `.bugpilot/`;
- legacy storage is never read or modified;
- existing data is preserved;
- the eventual US-D26 error contract is used once it is approved.

US-D26's open `STORAGE_UNAVAILABLE` decision is unchanged.

**9. The evidence gap and release gates.** Historical probe results are kept as recorded (§9.7, §14.1.B):

- P7: PASS on Windows.
- P10: PASS for the tested Windows configuration.
- P2: FAIL overall, despite successful external reads.
- P11: NOT EXECUTED.
- P1, P3, P5 and P9: blocked or unverified, because no operating-system isolation is available.
- P4, P6 and P8: not executed.

No real-agent combination is declared supported by this decision. Before production activation, all of these are required:

- the real-agent compatibility tests, for every intended supported combination;
- confirmation that the external `task.md` is read and `fix_report.md` is written in the work folder;
- verification of the relevant permission and denial behaviour;
- verification of retry and session handling;
- verification of the extension-bridge and MCP handoff paths, where those are supported;
- the applicable §9.10 end-to-end requirements;
- every §14.3 activation gate.

These tests should run in an isolated VM, under a separate user, or with other suitable operating-system containment. A redirected home or configuration folder is not sufficient filesystem containment.

**10. Dependencies.** No other decision's status changes:

- US-D12: stays PROPOSED. *(Approved with conditions later on 2026-10-18, §9.9.1.)*
- US-D13, US-D14, US-D28 and US-D30: stay APPROVED — with conditions.
- US-D17, US-D22 and US-D27: stay PROPOSED. *(US-D17 was approved with conditions later on 2026-10-18 (§8.9.1); US-D22 and US-D27 stay PROPOSED.)*
- US-D26: stays approved in part.
- US-D29: stays OPEN.
- US-D11: unchanged; OPEN in the register, with the review recommending deferral.

**Implementation conditions** (all open):

- US-D12 decided, including how bridges and the captured review are handled on a refusal *(decided 2026-10-18, §9.9.1)*;
- US-D17, US-D22 and US-D27 decided *(US-D17: approved 2026-10-18, §8.9.1)*;
- US-D26's error code decided;
- US-D29's branch decided;
- US-D13's and US-D30's conditions met (goldens; A_retry from the approved golden diff).

The US-D10 review recorded these places where today's code builds `.ai/` handoff paths or runs launches without the gate:

- the extension's `#handoffText` and `preparedContextPath` (`controller.ts:3349`, `:2996`);
- `retryHandoffText` (`nextAction.ts:206-208`);
- the Copy Handoff Prompt command (`controller.ts:2808`);
- MCP's `agent_task` and `next_step` (`mcp_server.py:246`, `:261-276`);
- the skill;
- Python's `run_agent`, which has no gate yet (`agent_runner.py:71-98`; §9.3 point 2, T-S12).

Tests must show that:

- the sentence is identical across the CLI, the extension and the retry prompt;
- a refused prompt goes to the clipboard and never to a terminal;
- clipboard success is reported only after the copy completes;
- no other agent is ever started silently.

**Activation conditions:** the release gates in point 9, §14.3, and §9.10's release rule.

### 9.6 When access is denied

| Denied | What happens | Recovery (no BugPilot permission change) |
| --- | --- | --- |
| The read of `task.md` | The agent cannot start the workflow, and says so. | **Copy effective task** in the panel (or `bugpilot task-preview <id>`, read-only, in a terminal), pasted into the agent's input. **Copy context** likewise for `context.md`. |
| Reads of `context.md`, `retrieval.json` or an attachment | The agent works from what it has. `task.md` already asks it to say plainly when it cannot read an attachment (`prompts.py:511-515`). | As above, for context. Attachments cannot be pasted: the agent reports it. |
| The write of `fix_report.md` | **Required Output Files (protected) adds one sentence:** "If you cannot write it there, say so and give the report in your reply under the same headings; never write it inside the repository." The second clause matters most: a refused agent must not "helpfully" write the report into the repository root (R5). | `bugpilot manual-result <id>` creates the template, or the panel opens `fix_report.md`; the developer pastes the reply. `check-results` and History then work as usual. |
| The captured review's read | The review answers with "could not read" (a `-p` deny). A clean exit does not prove that every input was read. | <ul><li>No automatic fallback.</li><li>A denial that the run reliably reports is shown.</li><li>The developer may choose a Partial Review (§16.5.11): reduced input, never equivalent to a full review.</li></ul> |
| The agent runs under `-p` / `exec -a never` | Writes are refused by design. | As the write row. Unattended agent runs are not a BugPilot entry point in 0.1.6. |

**How these recoveries are scored.** Every recovery in this table keeps the developer's work moving, and none adds a grant or changes a sandbox. A workflow completed through one of them counts as **FALLBACK** for the aspect concerned, never as PASS (§9.10).

### 9.7 Live capability probes (Batch 0B; separately owner-authorized)

**Authorization.**

- No probe runs as part of Batch 0A, any automated suite or CI.
- Batch 0B starts only on the owner's separate approval, which names the agents and accounts that may be used.
- Every probe that uses an agent account is run by the owner, or under that approval.

**Isolation.**

- Each probe uses a synthetic repository (`git init`, synthetic files).
- Before Batch 2 exists, it also uses a **probe kit**:
  - a synthetic work folder outside the repository, in a fresh temporary folder;
  - a short synthetic `task.md` that tells the agent to read `context.md` in that folder and write `fix_report.md` there;
  - a synthetic `context.md` and one text and one image attachment.
- The probes test what the *agent* allows. Batch 5 repeats them with real 0.1.6 artifacts (§9.10).
- Never used: the developer's configuration or real repositories, company Jira, real issue text, or real credentials.

**Record per probe and agent** (in §18):

- the probe id;
- the agent and its version (its own `--version` output);
- OS and version; the shell and terminal (P10, P11);
- the sandbox or permission mode as launched;
- the exact command line, with the home folder written as `<home>`;
- the outcome;
- the evidence: the permission prompts the agent showed, and a transcript or screenshot reference stored outside the repository (never committed if it shows personal data);
- the date, and who ran it.

**Outcomes.**

| Outcome | Meaning |
| --- | --- |
| **PASS** | observed to work as the decision needs, with no grant BugPilot added |
| **FAIL** | observed not to work |
| **UNKNOWN** | not run, not available (no account, no platform, an agent crash), or inconclusive |

- Only an observed result is PASS or FAIL. **A failed or unavailable probe is reported as FAIL or UNKNOWN, never as passed.**
- A decision that depends on an UNKNOWN probe stays OPEN, unless the owner explicitly accepts the gap and §16.1 records it.

**Status:** P10 has been run (2026-10-18). A narrowed run covered direct shells and the Python launcher (§14.1.B, "Batch 0B — probe P10, narrowed"), and a completion run covered the VS Code `sendText` path (§14.1.B, "Batch 0B — probe P10, VS Code sendText completion"). All parts PASS: **P10 is PASS for the tested Windows configuration**, with the limitations recorded there. P7 was attempted the same day and was **UNKNOWN**: the disposable VS Code would not start while a VS Code update was being installed, so none of its tests ran (§14.1.B, "Batch 0B — probe P7, attempted"). After the update, the P7 retry ran on Windows with VS Code 1.142.0: **P7-A to P7-H PASS**, and `revealFileInOS` is UNKNOWN, inconclusive on the selection (§14.1.B, "Batch 0B — probe P7, retry"). P2 ran once with Claude Code 2.1.214 and is FAIL against the owner's acceptance criteria. Its external reads under `dontAsk` worked with no prompt; the model declined to reproduce the marker and requested Bash once, which Claude Code refused (§14.1.B, "Batch 0B — probe P2, captured review"). Nothing else below has been run: P1, P3–P6, P8, P9 and P11 are NOT EXECUTED. A read-only readiness audit (2026-10-18) found no operating-system isolation on the probe machine: no administrator rights, no Windows Sandbox and no WSL distribution. So P1, P3, P5 and P9 stay blocked until the owner either provides isolation (a VM or a separate account) or, as for P2, separately approves running them with the residual read risk accepted.

| Id | Probe | Informs | Handoff aspect (§9.10) |
| --- | --- | --- | --- |
| P1 | Claude Code interactive with today's flags, on Windows: Read of an external `C:/…` forward-slash path (prompt? offered scope: file, folder or session?); Write of `fix_report.md` there under `acceptEdits` | US-D10, US-D13 | A1, A2, A3 (H1) |
| P2 | Captured review (`-p … dontAsk --tools Read …`): Read of the external work folder | US-D28 | A5 (H5) |
| P3 | Codex TUI default preset: external read, external write approval | US-D10 | A1, A2, A3 (H2) |
| P4 | Codex on Windows with each sandbox implementation available: read of `%USERPROFILE%\.bugpilot\…` | US-D10 | A1 (H2, Windows) |
| P5 | Copilot CLI: external read and write prompts | US-D10 | A1, A3 (H7) |
| P6 | The Claude Code and Codex VS Code extension bridges: a pasted prompt with an absolute path | US-D10 | A7 (H3, H4) |
| P7 | VS Code: `createFileSystemWatcher(new RelativePattern(Uri.file(<outside>), "*"))` events; `revealFileInOS` on a folder; `openTextDocument` + save of a file outside the workspace | US-D17 (watchers, Open Folder, policy editing) | — (extension platform) |
| P8 | Claude Code with BugPilot's MCP server: reading the returned absolute `agent_task` | US-D27 | A8 (H6) |
| P9 | `claude --resume <id>` after a session granted outside access: is the grant remembered? | §9.5 guidance text | A9 (H1) |
| P10 | `sendText` of a gated prompt with spaces in the path (`C:/Users/you two/…`) in PowerShell, `cmd` and Git Bash; the Python launcher through a `.cmd` shim | T-S12 | A6 (H1, H2, H7) |
| P11 | **Launching without a shell** (§9.9): `createTerminal({shellPath: <agent executable>, shellArgs: [prompt]})`, and `child_process.spawn(<exe>, [prompt], {shell: false})`. Prompts hold a space, `&`, `%`, `^`, `'`, `(`, `\` and a non-ASCII letter. Each is tried with a native executable and with an npm `.cmd` shim, on Windows, macOS and Linux. Records whether the program receives the prompt intact, and whether anything is interpreted. | US-D12 | A6 |

### 9.8 What `task.md` says (US-D13, APPROVED with conditions, §9.8.1; token budget US-D30, APPROVED with conditions, §9.8.2)

**Execution Location** (protected section) becomes:

```text
## Execution Location

- Run your AI agent from the target repository root, not from the bugpilot tool source directory.
- This work item's BugPilot files are in `<WORK>/`, outside the repository on purpose. Below, `context.md`, `retrieval.json`, `fix_report.md` and `attachments/` mean the files in that folder; never copy them into the repository.
```

- **Path form.** `<WORK>` is the absolute work folder in forward-slash form. It is the only absolute path in `task.md`, apart from the Required Output line.
  - *(Amended 2026-10-18, §9.8.1: `<WORK>` is the canonical, CLI-resolved folder. A path that cannot be represented safely is rejected and never altered, whatever the storage root's source.)*
- **Required Input Files:** "Read `context.md`: …" and "Read and inspect `retrieval.json` if present: …".
- **Required Output Files:** "Write one report: `<WORK>/fix_report.md` …", plus the §9.6 sentence. The write target is the one place where an ambiguous name costs most (a report written into the repository), so it stays absolute.
- **Developer Attachments:** "File: `attachments/<name>`".
- **Investigation Handoff:** "Write `fix_report.md` (in the work folder), every section investigation-phrased."
- **The retry prompt** follows the same pattern:
  - the work folder once, in Required Reading, with US-D14's note;
  - the required output absolute;
  - the rest by name;
  - How to Run carrying the retry handoff sentence, which is absolute too.

  That makes three absolute work paths (§9.8.1).
  - *(Amended 2026-10-18: this line first said the review prompt follows the same pattern. The review prompt follows US-D28's contract (§16.5.11), which names its three files absolutely.)*

**Token budget.** The gate `tests/test_task_golden.py:272-278` requires the median golden to stay at least 20% below 0.1.3's 3,870 tokens, a ceiling of 3,096. The median today is 3,090.

| | Effect |
| --- | --- |
| A representative `<WORK>` | about 75 characters |
| Two absolute mentions, minus about six `.ai/<id>/` prefixes removed | net about +90 characters |
| Plus the Execution Location sentence and the §9.6 sentence | about +60 tokens on the median, over the ceiling |

US-D30 asks the owner to choose. *(Decided on 2026-10-18: Option D from the US-D30 review, a fixed, reviewed allowance with per-golden bounds (§9.8.2). The options below are the plan's original ones, kept as written.)*

- **(a)** Measure the gate with the work-folder path collapsed to a fixed `<work>` token. The gate's purpose, a wording reduction, is kept, and machine-specific path length is excluded. *Recommended by the review.*

  The normalized measure alone would be too lenient, so (a) also keeps meaningful size-regression coverage:
  - **The median gate** stays: the median normalized golden is at most 3,096 tokens. If the designed sentences of §9.6 and §9.8 push it over, the owner re-baselines it once, on a recorded number, in Batch 2.
    - *(Superseded 2026-10-18, §9.8.2: there is no re-baseline. The ceiling becomes 3,096 + A, a fixed, reviewed allowance.)*
  - **A per-golden growth bound.** Each task golden's normalized size may grow over its 0.1.5 size by at most the measured cost of the designed sentences. That cost is fixed as a number in Batch 2 and recorded. Any growth beyond it stops the batch.
    - *(Amended 2026-10-18, §9.8.2: an approved delta is recorded for every golden, and the retry goldens get their own bounds.)*
  - **A count of absolute paths.** Each `task.md` golden holds the absolute work path exactly twice (Execution Location and Required Output Files). The retry golden holds it exactly three times (Required Reading, Required Output Files and How to Run).
    - *(Amended 2026-10-18: this first said twice for the retry golden. These counts are template and golden-test observations, not a permanent interface; §9.8.1.)*
  - **The raw size is reported.** It is computed with a representative real path, and reported next to the gate (not gated), so that path-length growth stays visible.
- **(b)** Re-baseline the ceiling by the measured cost.
- **(c)** Trim other protected wording. Not recommended: the protected text is SHA-pinned and its wording was settled in 0.1.4–0.1.5.

*(Preliminary token estimates from the US-D13 review are recorded in §9.8.1. They are estimates, not measured golden results.)*

**Privacy.** `<WORK>` contains the OS account name. It is sent to the model provider with the task, as the agent's working directory usually already is. `docs/safety.md` states this in Batch 5.

#### 9.8.1 Owner decision (2026-10-18): the approved US-D13 contract

**Decision.** US-D13 is **APPROVED — with conditions**, as the **hybrid task-document contract** from the US-D13 review, with the owner's amendments.

- It is a design approval only.
- It does not implement, activate or ship anything.

**The hybrid contract.** The AI agent's working directory stays the source repository root.

`task.md`:

- Execution Location states the canonical, CLI-resolved work folder as an absolute path.
- It explains that the file names in the task document refer to that work folder.
- Names such as `context.md`, `retrieval.json`, `fix_report.md` and `attachments/` are used where they are unambiguous.
- The `fix_report.md` output destination is given as an absolute work-folder path.
- The requirement stays to report an inability to write there, rather than writing the report into the source repository (§9.6).
- Protected Rules v2 stay unchanged.

The retry prompt:

- Required Reading states the canonical work folder.
- Local file names are relative to that declared folder.
- The report's output destination is absolute.
- How to Run uses the final approved US-D10 retry handoff wording, once that exists. US-D10 stays OPEN. *(US-D10 approved with conditions on 2026-10-18, §9.5.1: `Read <WORK>/agent_retry_prompt.md and continue the workflow.`)*
- It includes US-D14's informational note about legacy folders.

There are no repository-relative `.ai/` storage paths. Legacy storage is never read, migrated, copied, repaired or deleted.

**The three amendments to the review's proposal.**

1. **The absolute-path counts are observations, not an invariant.**
   - The reviewed templates hold two absolute work-folder references in `task.md` and three in the retry prompt. These are accepted as expected template and golden-test observations. They are not a permanent public interface or an architectural invariant.
   - The enforceable requirements are:
     - the correct canonical location;
     - unambiguous file references;
     - an absolute report target;
     - no accidental writes inside the source repository;
     - no unnecessary repetition of absolute paths.
   - Any future change remains subject to golden and prompt-budget review.
2. **Rendering validation is uniform and non-destructive.**
   - The final prompt-path validation is the same whatever the storage root's source: `BUGPILOT_HOME`, the default home location, or any other approved root resolution.
   - A valid filesystem location is distinguished from a location unsuitable for rendering in an agent instruction.
   - A rendering rejection does not delete, modify or corrupt existing storage.
   - Its error is actionable and names a remedy, without leaking unnecessary private path information.
3. **Implementation waits for US-D30 and for separate golden and ratchet approvals.**
   - The design is approved before US-D30, but the new task-document wording is not implemented until US-D30 is resolved.
   - The threshold is not raised silently, and the performance gate is not re-baselined silently.
   - Golden regeneration and path-literal residue are approved separately in the implementing batch (below).

**Path rendering and validation.**

- The rendered path is the canonical, CLI-resolved work directory (US-D17), with forward slashes on every supported operating system.
- Ordinary spaces and non-ASCII characters are allowed in a valid work path.
- A path that cannot be represented safely in the task documents is rejected. The reviewed cases are:
  - a backtick;
  - a C0 control character, DEL or a C1 control character;
  - the Unicode line separator or paragraph separator.
- A rejected path is never altered, sanitized, relocated or silently escaped to another location.
- None of this validation is implemented by this decision.

**US-D14's note.** The exact approved text is unchanged by this decision:

> "A `.ai/`, `.ai_memory/` or `.bugpilot/` folder inside the source repository is legacy BugPilot data. It is not the current work item's storage location, and BugPilot 0.1.6 does not use it."

- It appears once in `task.md`'s Execution Location section, and once near the retry prompt's Required Reading section.
- It is not a staging rule and not a security enforcement mechanism.
- Protected Rules v2, its digest and the protected-rule registry are unchanged.

**Prompt gate and handoff.**

- US-D12's prompt gate is preserved.
- A work-folder path may be representable in `task.md` while still being rejected for an automatic shell-based handoff. In that case:
  - the valid generated task document is kept;
  - the gate is not bypassed or relaxed;
  - the handoff fallback is recorded under the approved contract;
  - no agent is launched silently.
- US-D10 remains OPEN and is approved separately. *(Approved with conditions on 2026-10-18, §9.5.1.)*

**Storage failures.**

- An unavailable, invalid or stale storage location fails closed.
- There is no fallback to `.ai/`, `.ai_memory/` or a repository-local `.bugpilot/`.
- No partial task document is written to an unintended destination, and existing data is preserved.
- The public `STORAGE_UNAVAILABLE` error contract depends on US-D26, which this decision does not decide.

**Prompt budget** (US-D30 stays OPEN). *(US-D30 was approved with conditions later on 2026-10-18: §9.8.2.)* These are the review's preliminary estimates. They were made over the 17 task goldens in memory, with the gate's own measure of characters ÷ 4, and are not measured final golden results:

| | Median, approximate tokens |
| --- | --- |
| 0.1.5 today | 3,090 (threshold 3,096) |
| the hybrid wording, path normalized | 3,152 |
| plus US-D14's note (about 48 tokens on its own) | 3,200 |
| with a representative Linux path | 3,230 |
| with a representative Windows path | 3,242 |

The hybrid design with the note is therefore expected to exceed the threshold.

**Goldens and the path-literal ratchet.**

- These are preserved:
  - the frozen 0.1.4 goldens;
  - the frozen Batch 0A baselines;
  - the existing 0.1.3 baselines;
  - the Protected Rules v2 digest.
- The implementing batch needs separate owner approval for each of these:
  - the exact `task.md` golden changes;
  - the retry-prompt golden changes;
  - any associated context golden changes;
  - new allowed path-literal residue;
  - the required inventory and ratchet adjustments.
- No broad golden regeneration is pre-approved. The ratchet is not weakened, and no unrestricted path-literal exception is added.
- The review found that the note adds one `.ai/`, one `.ai_memory` and one `.bugpilot` literal to the file that holds it. `tests/test_storage_inventory.py` fails on any per-file increase, and `approved_residue` is empty today.

**Implementation conditions** (all open):

- US-D30 is resolved *(design approved with conditions on 2026-10-18, §9.8.2; its allowances are fixed only from the approved golden diff)*;
- the owner approves the exact task, retry and context golden changes, and the path-literal residue and ratchet adjustments;
- US-D10's retry handoff wording is approved, before How to Run is implemented *(approved 2026-10-18, §9.5.1)*;
- US-D26's error contract is decided, for the storage-failure code;
- the plan text of US-D22 is reconciled (§8.8); US-D22 itself stays PROPOSED;
- US-D29 says where the change lands.

**Activation conditions:**

- §14.3's activation preconditions;
- §9.10's release rule: A1–A4 PASS from real interactive agent runs on every supported combination.

Until real agent runs exist, these remain unverified:

- whether agents resolve bare names against the stated folder;
- whether they write the report at the absolute path, and follow §9.6's fallback;
- how Codex and Copilot handle forward-slash Windows paths and paths with spaces or non-ASCII characters;
- network storage roots.

#### 9.8.2 Owner decision (2026-10-18): the approved US-D30 contract

**Decision.** US-D30 is **APPROVED — with conditions**, as **Option D** from the US-D30 review, with the owner's amendments.

- Option D is a reviewed, fixed allowance for the approved US-D13 and US-D14 wording, plus per-golden regression bounds.
- It is a design approval only. Nothing is implemented or activated by it.
- It approves no golden change and no ratchet residue.

**1. The measurement basis is kept.**

- These stay:
  - the 17-case task golden matrix (`tests/task_golden.py`);
  - the `round(chars / 4)` approximation;
  - the historical 0.1.3 median reference of 3,870;
  - the historical 3,096-token ceiling;
  - every existing frozen baseline file;
  - the existing safety and publishability requirements.
- **The storage allowance changes the future acceptance ceiling.** It does not mean the new prompts still pass the original, unadjusted 20 % reduction test.
- `round(chars / 4)` is an approximation. It claims no tokenizer-level precision.

**2. The task budget.**

- The future task-size gate is:

  ```text
  median(normalized task sizes) <= 3096 + A
  ```

- **A** is a fixed, reviewed allowance, derived only from the approved US-D13 and US-D14 task wording.
  - The review's preliminary estimate is about 116. That is **not** the final value.
  - The final A is determined only from the exact owner-approved golden diff. How it was derived is recorded with it.
  - Once approved and recorded, A is fixed. It is never recomputed automatically from later prompt output.
- **Every task golden** must satisfy:

  ```text
  normalized_new_size <= frozen_baseline_size + approved_allowance_for_that_golden
  ```

  - `frozen_baseline_size` is the golden's 0.1.5 size in the frozen `tests/baselines/0.1.6-batch0/task_size.json`.
  - The approved delta is recorded separately for every golden.
  - The overall A may act as an additional ceiling, but it never replaces a golden's own approved delta.

**3. The retry budget.**

- A separately reviewed retry allowance, **A_retry**. The preliminary estimate is about 108; it is finalized only after US-D10's retry handoff wording is approved. *(That wording was approved on 2026-10-18 (§9.5.1). A_retry still stays preliminary until the owner-approved golden diff exists.)*
- Each retry golden gets its own reviewed delta and upper bound.
  - No frozen record holds the retry goldens' 0.1.5 sizes today.
  - So the new budget record captures them from the pre-change committed retry goldens, and names the commit. The review measured 956, 956 and 1,180.
- There is no median gate for the three retry goldens.
- Task and retry allowances are not shared.
- No allowance grows automatically when a template changes.

**4. Normalized and actual path reporting.**

- Static enforcement uses only the approved fixed `<work>` normalization.
- These are reported separately and do not take part in the gate:
  - the normalized size;
  - the size with the canonical fixed golden path (§11.6);
  - the size with representative Windows paths;
  - the size with representative Linux and macOS paths, where available;
  - the effect of unusually long paths.
- Normalization does not bound real-world absolute-path size. In the review's estimates:
  - each path mention adds about its length ÷ 4 tokens;
  - a 268-character work folder added about +233 to +247 tokens per task, against +96 to +116 normalized.
- This decision introduces no runtime path-length limit.
- Runtime correctness, path validation (US-D13) and prompt-size safety stay separate concerns.

**5. Frozen baselines are protected.** These stay byte-identical and are never regenerated or overwritten:

- the historical 0.1.3 baselines;
- `tests/baselines/0.1.6-batch0/task_size.json` and the other frozen Batch 0A records;
- the frozen 0.1.4 task, context and retry goldens;
- the Protected Rules v2 digest.

A **new, explicitly reviewed 0.1.6 budget record** holds:

- A and A_retry;
- the per-golden approved sizes and deltas;
- the measurement method;
- the normalization rules;
- the reference to the golden-diff approval it came from.

The implementation must also reconcile `test_storage_baseline.py`'s compared-record test.

- That test regenerates `task_size.json` and requires it to match the current goldens, which the designed change will make untrue.
- The reconciliation must not weaken frozen-baseline integrity. Historical baselines stay independently verifiable.

**6. Golden-diff approval is mandatory.** A and A_retry are calculated only after all of these:

1. the final US-D13 task text is determined;
2. US-D14's note is inserted exactly as approved;
3. US-D10's retry wording is resolved *(approved 2026-10-18, §9.5.1)*;
4. any US-D22 wording in the same implementation is separately approved;
5. the owner reviews and approves the exact allowed golden diff.

- A and A_retry never legitimize unrelated text growth.
- The allowed changed sections and lines are enforced independently of the size checks.
- There is no broad golden regeneration, and the path-literal ratchet is not relaxed.
- Growth beyond a golden's approved delta needs a separate owner decision.

**7. Security and quality.**

- Approved safety rules are never removed or shortened to meet the budget.
- Protected Rules v2 are unchanged.
- The US-D14 note is not altered without separate approval.
- Prompt-gate behaviour and agent permissions are unchanged.
- **Real-agent impact is unmeasured.** Small estimated-token growth is not assumed to have negligible runtime, monetary or quality impact. It stays unmeasured until tested.
- Real-path growth, and user-supplied context outside the fixed golden matrix, are reported, not ignored.

**Implementation conditions** (all open):

- the five golden-diff prerequisites above;
- the new budget record, reviewed and approved;
- the compared-record test reconciled, with every frozen file byte-identical and independently verifiable;
- the path-literal residue approved separately (US-D13, US-D14).

**Activation conditions:** the plan's existing ones.

- §14.3's preconditions;
- §17's "The task-size measures of US-D30 hold";
- §9.10's real-agent release rule.

**Review estimates** (§9.8.1, and the US-D30 review; in memory, not measured goldens):

| | Value |
| --- | --- |
| 0.1.5, measured | min 2,914; median 3,090; mean 3,066.2; p90 3,188; p95 3,205; max 3,239 |
| modeled normalized median | about 3,200 |
| modeled max | about 3,354 |
| per-golden growth | +96 to +116 |
| retry growth | +106 to +108 |

### 9.9 Safer launch mechanisms (evaluation for US-D12; US-D12 APPROVED with conditions, §9.9.1)

**The question.** Could a process-argument API replace typing the prompt into a shell, so that the gate could admit more paths (a backslash, a non-ASCII user name) without opening a shell-injection hole?

**Status.** This is a desk evaluation; nothing was run. Rows marked **A** are inferences that probe P11 must confirm.

| Mechanism | Shell involved? | Safe from injection? | Fit for Fix with AI |
| --- | --- | --- | --- |
| VS Code `createTerminal({shellPath: <exe>, shellArgs: [prompt]})` with a **native executable** | none: the terminal starts the program directly with an argument array (**A**) | yes, if the arguments reach the program intact. On Windows that depends on the terminal layer quoting the array to the program's own argument rules (**A**, P11) | partial: the terminal closes when the agent exits, so a relaunch or `--resume` needs a new terminal; the developer's shell profile is not loaded (BugPilot already resolves the agent by absolute path, but tools the agent starts inherit the terminal's environment) |
| the same, with an **npm `.cmd`/`.bat` shim** (`claude.cmd`, `codex.cmd`) | **yes**: Windows runs a batch file through `cmd.exe`, which re-parses `%`, `^`, `&`, `\|`, `<`, `>` and quotes | **no**: the batch-file argument-injection class ("BatBadBut"; for Node, CVE-2024-27980) | only behind the gate |
| Node `child_process.spawn(<exe>, args, {shell: false})` | none for a native executable. Node's 2024 security releases refuse a `.bat`/`.cmd` without `shell: true` | yes, for a native executable | **no**: there is no terminal for the developer to watch the agent or answer its permission prompts. It suits one-shot runs only, which is what the captured review already does, with stdin |
| Python `subprocess.run([<exe>, prompt])` (`--launch-agent`) | none for a native executable; `cmd /c` for a shim (`agent_runner.py:133-137`) | native: yes; shim: no | as today; the shim path keeps the gate (T-S12) |
| An extension-owned pseudo-terminal (`vscode.Pseudoterminal`) driving the agent's TTY | none | yes | **no**: BugPilot would have to implement terminal I/O for an interactive agent TUI. Out of scope |

**Conclusion (the review's recommendation under US-D12):**

- **npm shims on Windows** (today's common install of Claude Code and Codex): no safe argument API exists. The gate must stay.
- **Native executables** (for example Claude Code's native installer, Copilot CLI from WinGet): a direct launch could admit any path, *if* P11 shows VS Code passes the argument array intact on all three systems. That is unverified.
- **For 0.1.6:**
  - The existing gate stays unchanged for every launch.
  - The limitation is documented (§13.4, `docs/safety.md`): when the home or `BUGPILOT_HOME` path has a character outside `[A-Za-z0-9 .,:#/_-]`, the developer gets the copy-and-paste handoff, not one-click launch.
  - A direct launch for native executables becomes a candidate only after P11 passes on all three systems and the owner approves it as a separate change. It would never relax the gate for a shim.
  - No batch changes the gate without that approval.
  - *(US-D12, approved 2026-10-18, §9.9.1: the gate is tightened and never broadened. It gains exact prompt preservation and a Python equivalent; the character set itself is unchanged.)*

#### 9.9.1 Owner decision (2026-10-18): the approved US-D12 contract

**Decision.** US-D12 is **APPROVED — with conditions**, as **Option C** from the US-D12 review, with two amendments:

- exact prompt preservation;
- TypeScript and Python parity.

The restrictive prompt gate is kept for automatic agent handoff, the Python validation gap is closed, and silent prompt or path rewriting is prohibited. It is a design approval only: no per-transport relaxation is approved, and nothing is implemented.

**1. The security boundary is kept.** The allowed shell-safe character set is unchanged and is never broadened:

- ASCII letters A–Z and a–z;
- ASCII digits 0–9;
- the ASCII space;
- period, comma, colon, hash, slash, underscore and hyphen.

How the existing validator gets tightened:

- The existing TypeScript validator (`PLAIN_PROMPT`, `agents.ts:266`) stays the historical reference.
- Its handling of Unicode whitespace, leading and trailing whitespace, and normalization is tightened before Unified Storage handoff is activated.
- No string passes merely because JavaScript's `\s` accepts one of its characters.

What is validated:

- The initial handoff sentence must begin with its expected literal text, never with arbitrary whitespace or an option-like prefix.
- Validation applies to the complete generated handoff prompt, not to the data-root path alone.

**2. Amendment: exact prompt preservation.** For any automatic command-line handoff:

- Both the original generated prompt and the exact final text passed as the argument are validated.
- None of these may happen:
  - an absolute path rewritten silently;
  - several spaces inside a path collapsed into one;
  - Unicode whitespace normalized into ASCII spaces;
  - trimming, escaping or character replacement that changes the resolved destination.
- If exact preservation cannot be guaranteed, the automatic handoff is refused.
- The permitted line-joining behaviour for existing multi-line prompts must be defined explicitly. A permitted line join never changes the characters inside a file path.
- Unsafe cases are rejected before any agent is probed, any terminal is created or any process is started.
- A path is never changed to make it pass validation.

*Background (US-D12 review):* today `flatten` (`agents.ts:974`) collapses every run of `\s` into one space after the gate. With an absolute path in the prompt, that could silently point the agent at a different folder.

**3. Amendment: TypeScript and Python parity.**

- Python's `--launch-agent` applies an equivalent validation policy before any subprocess runs. Today `run_agent` (`agent_runner.py:71-98`) has none (T-S12).
- The JavaScript regular expression is not simply copied into Python, because its Unicode semantics differ.
- One reviewed, shared corpus fixes the expected accept or refuse result for each case, and both the TypeScript and the Python tests use it. The cases:
  - valid ordinary paths;
  - a path with one ordinary space;
  - a path with consecutive spaces;
  - tabs and line separators;
  - non-breaking spaces and other Unicode whitespace;
  - non-ASCII letters;
  - quotes, backticks and shell metacharacters;
  - leading and trailing whitespace;
  - option-like input.
- Refused corpus strings are only ever evaluated by the validators. They are never sent to a shell.
- A refused Python prompt never reaches `cmd.exe`, a `.cmd` shim or any other launched process.
- No new shell-free launch mechanism is approved by this decision.

**4. Which paths the gate applies to.**

| Invocation path | Prompt gate |
| --- | --- |
| Automatic terminal handoff (CLI agents, custom command, terminal Review with AI) | **kept**, strict |
| Python `--launch-agent` | **added**, an equivalent strict gate |
| Claude and Codex extension bridges | **kept for 0.1.6**, even though today's clipboard-based bridges put no prompt into a shell |
| Captured review | **kept**, as approved US-D28 item 10 requires |
| MCP structured outputs | no shell gate on the returned JSON. Canonical storage-path validation and the MCP contract (US-D27) apply. |
| Manual Copy Handoff Prompt | no shell gate: it is the documented recovery for a refused automatic handoff. The path must already be valid under US-D13 and US-D17. |
| Generated `task.md` and its content | no shell gate on the body. US-D13's separate path-rendering safety requirements apply. |

No transport-specific relaxation for the bridges or the captured review is approved.

**5. What happens after a refusal.**

- **Fix and Retry:**
  - no agent is launched and no terminal is created;
  - the canonical handoff sentence is copied only after the storage path has been validated;
  - an accurate notice says the automatic launch was refused;
  - clipboard success is not claimed before the copy succeeds.
- **Extension bridge:** copy and notify only. The agent's view is not revealed or started automatically after a gate refusal.
- **Review with AI:**
  - the approved review-specific error and manual recovery stay (Copy review prompt, Paste Review Output);
  - a captured review is never silently turned into a Partial Review;
  - the US-D28 gate is not bypassed.
- **Python:** the refusal is reported, no subprocess starts, and a safe, explicit manual handoff instruction is given where it is valid.
- **Invalid or unavailable storage:** fails closed before either an automatic or a manual handoff. Nothing is copied or launched, and no legacy storage is used.
- **Never:** a silent switch to a different agent.

**6. Compatibility and documentation.**

- **Known 0.1.6 limitation:** a developer whose home or work-folder path contains a character the gate refuses may lose one-click launch, even though the filesystem path is valid.
  - For valid storage paths, the manual handoff stays available.
  - The same developer also loses the bridges' automatic copy and reveal, and the captured review. Both stay gated, and Review with AI then uses its manual recovery.
- §13.4 states the actual approved character set, including colon, comma and hash.
- The `BUGPILOT_HOME` remedy is stated clearly, without showing unnecessary private path detail.
- There is no promise that every non-ASCII path can be launched automatically.
- Any later relaxation for integrations without a shell is a separate owner decision, needing supporting evidence and compatibility tests (for the bridges, P6; for the captured review, an amendment to US-D28).

**7. Tests and release conditions.** All of these are required before implementation is activated:

- TypeScript gate and normalization tests;
- Python gate tests;
- cross-language parity tests on the shared corpus;
- exact-path preservation tests;
- rejection-before-launch tests;
- clipboard fallback tests;
- extension-bridge refusal tests;
- captured-review regression tests;
- validation on Windows, Linux and macOS;
- approved transport evidence for the supported configurations.

Probe results stay as recorded:

- P10 is PASS only for the previously tested Windows configuration.
- P11 stays NOT EXECUTED.
- No other Batch 0B result is reinterpreted.

Every §9.10 and §14.3 activation gate is kept.

**Implementation conditions** (all open):

- the shared corpus is reviewed and approved;
- the tightened TypeScript validator and the Python validator are implemented with parity;
- the exact-preservation rule and the explicit line-joining definition are implemented;
- the refusal paths of point 5 are implemented, including clipboard-after-validation;
- US-D10's and US-D13's conditions are met for the handoff wording and path rendering;
- US-D29 says where the change lands.

**Activation conditions:**

- the tests and platform validation of point 7;
- §9.10;
- §14.3.

### 9.10 Handoff acceptance: what counts as working

**Principle.** The handoff is accepted aspect by aspect, for each supported agent and provider combination, from **real interactive end-to-end evidence**.

- Unit tests show that BugPilot builds the right command line, working directory and text.
- Unit tests do not show that an agent can do the work.

**Combinations.** The owner confirms which are supported before Batch 5. A combination the owner does not list is documented as unsupported, never silently left untested.

| Id | Combination | Entry point | Aspects that apply |
| --- | --- | --- | --- |
| H1 | Claude Code CLI in a VS Code terminal | Fix with AI, Retry, Open AI Session | A1, A2, A3, A4, A6, A9 |
| H2 | Codex CLI in a VS Code terminal | Fix with AI, Retry | A1, A2, A3, A4, A6 |
| H3 | the Claude Code VS Code extension (bridge) | Fix with AI | A1, A2, A3, A7 |
| H4 | the Codex VS Code extension (bridge) | Fix with AI | A1, A2, A3, A7 |
| H5 | captured review (Claude CLI, `-p`) | Review with AI | A5 |
| H6 | an MCP client (Claude Code) with `bugpilot-mcp` | the MCP prepare tools | A1, A2, A3, A8 |
| H7 | the CLI's `--launch-agent claude` / `copilot` (deprecated) | the CLI | A1, A3, A6 |

**Aspects.**

| Aspect | PASS requires | Evidence |
| --- | --- | --- |
| A1 task reading | The agent reads `task.md` in the external work folder, after the developer allows that folder in the agent's own prompt, or without a prompt where the agent's defaults allow it. BugPilot added no grant. | 0B: P1, P3, P4, P5; Batch 5 end-to-end |
| A2 context and attachment reading | The agent reads `context.md`, `retrieval.json`, and one text and one image attachment in the work folder, or says plainly that it cannot read the image (§9.6). | Batch 5 end-to-end |
| A3 writing `fix_report.md` | The report is written at `<WORK>/fix_report.md` after the developer approves, and **nothing BugPilot-related is written into the repository**: `git status` shows only the intended source edits. | 0B: P1, P3, P5; Batch 5 end-to-end with `git status` |
| A4 retry | The agent reads the retry prompt, uses `user_feedback.md` (written by the CLI, US-D18), and updates the report in the work folder. | Batch 5 end-to-end |
| A5 captured review | The review reads the work-folder files and returns a result shown in the panel, under the unchanged read-only flags. | 0B: P2; Batch 5 end-to-end |
| A6 interactive terminal launch | One click starts the agent in a terminal with cwd = the repository and the handoff prompt. **No clipboard is involved**, and no permission flag is added. | 0B: P10 (P11 if pursued); Batch 3 real pass; Batch 5 end-to-end |
| A7 VS Code agent-extension handoff | The bridge's designed flow, unchanged from 0.1.5 (prompt on the clipboard, agent view revealed), leads the agent to read the task in the work folder. For H3 and H4 this designed flow is the one-click path. | 0B: P6; Batch 5 end-to-end |
| A8 MCP handoff | A client calls `prepare_*`, reads the returned absolute `agent_task`, and writes the report in the work folder. | 0B: P8; Batch 5 end-to-end |
| A9 reopening a session | Open AI Session or Resume reopens the same conversation with cwd = the repository. Whether earlier folder grants persist is recorded, not required. | 0B: P9; Batch 5 end-to-end |

**Results: PASS, FALLBACK, FAIL or UNKNOWN.**

- **FALLBACK:** the work was completed only through a recovery of §9.6, or through the gate's copy-and-paste fallback (§9.5 point 3). It shows that the recovery works. It **never** counts as PASS for one-click Fix with AI (A6), nor for the aspect it stood in for.
- **UNKNOWN:** not run, not available, or inconclusive. It is never counted as PASS.
- **Automatic grants:** no aspect may be made to pass by adding a directory grant or changing a sandbox mode. A run that needed one is recorded as FAIL, with the grant named.

**Release rule** (§20). Release readiness requires PASS for every applicable aspect of every combination the owner lists as supported:

- from real interactive end-to-end runs on the release candidates;
- recorded in §18 with the §9.7 record fields.

A combination with FAIL, FALLBACK or UNKNOWN on a required aspect is either fixed, or listed by the owner in the release notes as unsupported or limited. It is never reported as passing.

---

## 10. Security threat model

### 10.1 Trust boundaries after the move

| Boundary | 0.1.5 | 0.1.6 |
| --- | --- | --- |
| **The repository** (working tree, possibly cloned from an untrusted source; the agent's cwd) | BugPilot wrote into it: `.ai/`, `.ai_memory/`, `.bugpilot/`. A hostile tree could plant links at those names; BugPilot refused them. | BugPilot **writes nothing** into it. Repository content is still evidence (Code Search, Git History, Repository Profile detection), contained as in 0.1.5. **A whole class of planted-link attacks on BugPilot's writes disappears.** |
| **The data root** (`~/.bugpilot` or `BUGPILOT_HOME`) | only credentials, User Instructions and user Fix Modes | **everything**: credentials, settings, Jira evidence, model output. Owned by the user; BugPilot creates it, or uses the folder the user chose. |
| **Within the data root** | — | `config/` (the only secret) is separate from `repositories/`. Each namespace is separate from every other. Each work item is separate from memory. |
| **The agent sandbox** | the repository only | the repository, plus whatever the developer approves in the agent's own UI (§9) |

**Attacker model** (unchanged from §44.4):

- Hostile *text*: Jira, attachments, repository files, an MCP client model.
- Hostile *repository layout*, for a cloned repository.
- Another local process with the *same* user's rights is **out of scope**: it can already read and change the user's files. BugPilot never claims protection against an attacker who controls the account or the data root.

### 10.2 Threats

**Kind** = prevention (made impossible by construction), detection (refused when seen), or limitation (stated, not prevented).

| Id | Threat | Control in 0.1.6 | Kind | Test (§11) |
| --- | --- | --- | --- | --- |
| T-S1 | **A hostile repository path or basename** (newline, `..`, separators, `CON`, non-ASCII, shell metacharacters) | used only through `realpath` → hash; the slug has a fixed character class (§7.2); the root path is never in `task.md`, a prompt or a message (only in `repository.json` and `doctor --json`, as JSON) | prevention | identity: a hostile-name matrix |
| T-S2 | **Path traversal through a work-item id** (MCP, CLI, a History entry) | `WORK_ITEM_ID_RE` before any path is built; `_check_parts`; a final `realpath` comparison; MCP `_checked` and `_existing` | prevention | `work_item_ids.json` + storage traversal cases |
| T-S3 | **A symlinked repository root** | identity follows it (§7.3); writes never go to the repository at all | n/a | identity |
| T-S4 | **A symlinked or junctioned data root** | allowed: the user's choice (B4-2); the canonical root is used for containment | documented policy | storage safety |
| T-S5 | **A link or junction at `config`, `repositories`, `<id>`, `settings`, `work`, `<work item>`, `memory`, `fix_modes`, `attachments` or a file** | refused, component by component, as stood (never followed), before and after creation; nothing written; one sentence | detection | a link at each component, junctions on Windows |
| T-S6 | **Windows junctions and other reparse points** | `is_link_or_junction` treats every name-surrogate tag, and any unknown tag, as a link (`safe_paths.py:52-72`) | detection | Windows junction cases |
| T-S7 | **Cross-repository confusion** | no API accepts a repository ID; the identity record is checked on every read and write path (§7.5); MCP binds once; the extension composes only below a CLI-given `repository_dir` (US-D17) | prevention + detection | two repositories with the same work-item id; a record mismatch |
| T-S8 | **A concurrent local process changing the tree mid-write** | as 0.1.5: re-check after `mkdir`; `_check_temp`; rename never follows; the Windows in-place fallback re-checks | limitation (a same-user attacker) | race sampling (no proof of race freedom) |
| T-S9 | **Credential exposure next to evidence** (SF-4) | `config/` is separate from `repositories/`; the handoff names one work folder; an opt-in grant (if ever) names exactly that folder; docs tell the developer to allow that folder only. Codex can already read the whole disk in 0.1.5 | limitation, documented | no handoff or task text names `config/` or the data root itself |
| T-S10 | **Credential storage** | `config/config.toml` private atomic write (`600` from birth; no POSIX in-place fallback); a link at the file refused (O4); `config/` `0700`; the token never in argv, output or logs (unchanged) | prevention | `test_batch4_file_safety` S2/O4 re-pointed |
| T-S11 | **Private data in logs or output** | the display form in messages (US-D22); absolute paths only in designated JSON fields, the handoff and `task.md`'s work-folder line; `repository.json` never printed except `doctor --json` | prevention (normal output); limitation (system `OSError` text, F12) | "no home path in messages" over every CLI command |
| T-S12 | **Argument injection through the home path** (`cmd.exe` `%`, `^`, `&`; shells via `sendText`) | the plain-prompt gate on both sides (TypeScript, and Python `agent_runner`); refused → manual handoff, never "cleaned". A launch without a shell (§9.9) is adopted only for native executables, only after P11 passes on three systems, and only with a separate owner approval; shims always keep the gate | prevention | gate tests with hostile home names; probes P10, P11 |
| T-S13 | **Stale artifact references** (a History entry for a moved repository; `run.json` paths) | `generated_files` relative to the namespace; History lists only the current namespace; a moved repository simply has an empty namespace | prevention | History after a move |
| T-S14 | **A read-only preview creating state** | resolution never creates (§8.1); previews and `list`/`status`/`doctor` call no `ensure()` | prevention | snapshot of the data root before and after every read-only command |
| T-S15 | **Atomic-write regressions in the new tree** | unchanged writer; its temp file in the target's folder (inside the data root) | prevention | existing W1/W2 tests on the new paths |
| T-S16 | **Agent trust-config loading** (only if US-D11 is ever enabled): `.claude/`, `.github/skills\|agents` in an added folder | BugPilot creates only known names in a work folder; attachments only inside `attachments/`, and a name is never a folder; a check before any grant that the folder holds no dot-entry | prevention (conditional) | Batch 3, only with US-D11 |
| T-S17 | **Temporary payloads** | unchanged (F19); SF-1 closed if US-D39 | prevention | `scratchFile` pattern |
| T-S18 | **POSIX modes and umask** | new folders `0700 & ~umask`; new files `0600`; an existing data root's mode is not changed (SF-6, US-D23) | prevention | modes under umasks 022, 002, 000, 077 and 277 (as §44.22) |
| T-S19 | **macOS home and temp quirks** (`/var` → `/private/var`; `$TMPDIR` per user) | judging only the components BugPilot creates; the data root may sit behind the system's links | detection | macOS CI |
| T-S20 | **Repository pollution by BugPilot** (R5) | no repository-relative writer remains; the ratchet (§11.2) blocks reintroduction; Add to .gitignore removed (US-D16) | prevention | pollution suite (§11.3) |
| T-S21 | **The agent writes BugPilot files into the repository** because it was refused outside | the §9.6 sentence in protected Required Output Files | limitation (instruction, not enforcement) | golden; live probe P1 |
| T-S22 | **Legacy content read by mistake** | no reader names a legacy path; F22 guards only exclude; the canary suite (§11.3) | prevention + detection | canary suite |
| T-S23 | **A hostile `BUGPILOT_HOME` value** (control characters, relative, `~`) | refused at resolution (§8.3); rendered with visible escapes wherever shown | prevention | storage unit tests |
| T-S24 | **The test suite writes into the developer's real BugPilot data**: an unisolated test, a collection-time render, a module-scoped fixture, a child process | isolation set before any import or collection (§11.1); the audit-hook guard refuses the operation before it happens, in the test process and in Python children (through the test-only `sitecustomize` loader); a child process with an unisolated environment is refused, and so is a recognizable Python child that would start without the loader | prevention (in-process and recognizable Python children); **limitation**, environment isolation only, for non-Python children, Python started with `-I`, `-E` or `-S`, Python started through a shell, the `py` launcher or a console script, and `scripts/check_cli_contract.py`, which runs outside pytest (§14.1.A) | `tests/test_isolation_guard.py`, against a decoy |
| T-S25 | **The test suite reads the developer's real BugPilot data** (credentials, settings) | the same isolation; the guard refuses opens for reading and directory listings under the real data root | prevention for content reads and listings; **limitation** for metadata probes (`stat`, `exists`), which raise no audit event, and for path aliases the string comparison does not see: `dir_fd`/`fchdir`-relative paths, open file handles, Windows 8.3 short names, extended-length prefixes (§14.1.A) | same |
| T-S26 | **An isolation check that itself reads user data** (r1's real-home listing) | withdrawn: no default run lists or reads the real home; the only real-home diagnostic is opt-in, read-only, names only (§11.1) | prevention | review of `tests/_isolation.py` and `tests/conftest.py` |
| T-S27 | **BugPilot's data inside a Git working tree** (a `BUGPILOT_HOME` in a checkout while BugPilot runs from a subfolder; a home folder that is a Git repository; global configuration) | the data root, and every folder above it, may hold no `.git` entry, and `GIT_WORK_TREE` may not hold it; refused for reads and writes, failing closed. Unmarked work trees and other version-control systems are a stated gap | prevention + detection | `test_storage_safety.py`, G-1/G-2 cases (Batch 2A) |
| T-S28 | **A stale verdict in a long-running process** (a retargeted link reusing an old namespace; a `.git` made later) | identities re-checked by file identity on every use; verdicts live one request scope | prevention | the retarget regressions (symbolic link, junction); the scope tests |
| T-S29 | **Credentials written where other accounts can read them** (an inherited or widened access list, a shared `BUGPILOT_HOME`, Python 3.10/3.11 on Windows) | `config.toml` is written only after the data root, `config/` and the file are proven private (owner and access list on Windows, owner and bits on POSIX); an unverifiable place is refused; no permission is ever changed | prevention | `test_private_folder.py`; the gate cases in `test_storage_safety.py` |

### 10.3 Guarantees and limits, stated

**Guaranteed (by construction, and tested on Linux, macOS and Windows before release):**

- no BugPilot write lands in the repository;
- no write follows a link below the data root;
- no work-item id leaves its namespace;
- no namespace serves another repository's root;
- credentials are `600` from birth on POSIX;
- read-only commands create nothing.

**Not guaranteed:**

- that an agent obeys "never copy them into the repository";
- that a same-user process cannot race a write;
- that a developer will not approve a wider folder than the work folder in the agent's own prompt;
- that system error messages never contain a path.

**Not claimed:** any protection against an attacker who controls the user's account or the data root.

**For the test suite** (§11.1; T-S24 to T-S26):

- **Guaranteed, once Batch 0A is accepted.** No Python code in the test process or its Python children opens, lists, creates, renames or deletes anything under the real BugPilot data root without the run failing first.
- **Not guaranteed:**
  - what a non-Python child, or a child started with `-I` or `-E`, does with a path it computes itself (it is isolated by environment only);
  - a metadata probe (`stat`, `exists`) of a real path.

---

## 11. Test and CI strategy

Tests are designed before implementation. Each new module is listed with its batch; "required" means it joins a required CI job (§11.7).

### 11.1 Test isolation first (Batch 0A, US-D32; revised 2026-10-15)

**What is wrong today (SF-8).** Once every write goes under the data root, a test that is not isolated writes into the developer's real `~/.bugpilot/repositories`. Today:

- `tests/conftest.py:13-17` isolates only `BUGPILOT_CONFIG_DIR`, per test function;
- `tests/test_prompt_boundary_golden.py:14` renders at collection time;
- module-scoped fixtures in `test_batch3_boundaries.py`, `test_context_boundary.py` and `test_prompt_boundary_baseline.py` run before the autouse fixture;
- `prompt_boundary_sources.Workspace.retry()` and `.similar_fixes()` run outside `configured()`;
- `prompt_boundary_baseline.measure_performance` runs `run_investigation` without isolation;
- the extension's integration tests set no `HOME`, apart from one test (`cli.integration.test.ts:708-712`).

The memory of this project also records that a suite run once read the developer's real company Jira configuration.

**Requirements** (the 2026-10-15 review):

1. The default automated run never lists or reads the developer's real BugPilot data.
2. `HOME`, `USERPROFILE`, `BUGPILOT_HOME`, `BUGPILOT_CONFIG_DIR` and every `JIRA_*` variable are isolated before any import-time or collection-time side effect.
3. Python tests, the TypeScript integration tests and every subprocess use isolated roots.
4. An unisolated test fails closed, *before* it writes.
5. Isolation is proven with synthetic canaries and access instrumentation, not assumed from configuration.
6. A real-home diagnostic, if any, is read-only and opt-in.
7. Changes made by unrelated background processes are never attributed to the suite.
8. It works on Windows, Linux and macOS.
9. How isolation is *verified* is recorded, not only how it is configured.
10. Protection against writes is distinguished from protection against reads.

**Why the first design was dropped.** Revision r1 proposed listing the real `~/.bugpilot` (names and mtimes) before and after each run. That design:

- listed real user data on every run (against requirement 1);
- noticed a write only after it had happened (against requirement 4);
- could not tell a test's change from one made at the same moment by a VS Code window, an MCP server or a CLI run (against requirement 7).

It is withdrawn.

**Design.**

1. **Isolation before anything else.**
   - **Where it lives.** The first statements of `tests/conftest.py`, before it imports anything from `bugpilot`, call a test-only module, `tests/_isolation.py`. pytest imports the root `conftest.py` before it collects or imports any test module, so collection-time renders and module-scoped fixtures already see the isolated environment. There is no pytest configuration in `pyproject.toml` today, and none is needed.
   - **What it sets.**
     - It creates one session root with `tempfile.mkdtemp(prefix="bugpilot-test-")`.
     - It points `HOME` and `USERPROFILE` at `<session>/home`.
     - It points `BUGPILOT_HOME` and `BUGPILOT_CONFIG_DIR` at the `.bugpilot` folder inside that session home. The second is for the 0.1.5 code, until Batch 2 removes it.
     - It removes every `JIRA_*` variable and `BUGPILOT_MCP_REPO_ROOT`.
   - **Per test.** The per-test autouse fixture stays, narrowing each test to its own folder under the session root.
   - **The real home.** It is captured once, before anything is patched, as a **path string only**: `pwd.getpwuid(os.getuid()).pw_dir` on POSIX, and the profile-folder API (`SHGetKnownFolderPath`, through `ctypes`) on Windows. It is never listed or read.
   - **One thing to check in Batch 0A.** Isolating `HOME` hides the developer's global git identity. CI already runs without one, so tests that commit must set their own; Batch 0A confirms this locally.
2. **A guard that fails closed** (Python, in-process).
   - **The mechanism.** `sys.addaudithook` (Python 3.8 and later, so every supported version) installs a hook that sees the interpreter's file events **before** they happen.
   - **Write events:** `open` with a write, append, create or update mode; `os.mkdir`; `os.rename` (which `os.replace` raises); `os.remove`; `os.rmdir`; `os.symlink`; `os.link`; `os.chmod`; `os.chown`; `os.utime`; `os.truncate`; `shutil.rmtree`; `shutil.copyfile`; `shutil.move`.
   - **Read events:** `open` for reading; `os.listdir`; `os.scandir`; `glob.glob`.
   - **The exact event list** is confirmed against the audit-event tables of Python 3.10 and 3.14 in Batch 0A.
   - **What it refuses.** For any such event whose path falls under a **protected root**, the hook raises `IsolationViolation` before the operation runs: nothing is written, nothing is read, and the test fails with the operation and its stack.
     - The protected root is the real home's `.bugpilot`: the 0.1.5 files and, later, the 0.1.6 tree.
     - Other paths may be added by the suite.
   - **How it judges.** The hook compares normalized path strings (`normcase(abspath(...))`) with the protected roots. It never touches the file system itself.
   - **Why only `.bugpilot`.** On Windows the system temp folder (where `tmp_path` lives) and Python's own files are under the real home, so a guard over the whole home would break the interpreter. The data BugPilot owns is what the guard protects.
3. **Child processes.**
   - **Environment.** Every child inherits the isolated `os.environ`.
   - **`subprocess.Popen` check.** The hook refuses the event when an explicit `env` lacks `HOME`, `USERPROFILE`, `BUGPILOT_HOME` or `BUGPILOT_CONFIG_DIR`, or points them outside the session root, or when `cwd` is under a protected root. The `os.system`, `os.exec*` and `os.spawn*` events are checked the same way. *As built, the rule is refined (deviation D0A-1, §14.1.A):*
     - *the platform's home variable must be present;*
     - *no derived BugPilot data folder may lie in or around a protected root;*
     - *inherited environments are checked too.*
   - **Python children** get the same guard: the CLI and MCP subprocess tests.
     - The isolation module writes a test-only `sitecustomize.py` (the *loader*) into the session root and puts that folder first on the children's `PYTHONPATH`. Nothing is installed.
     - The child's `sitecustomize` installs the hook.
     - *As built (pre-commit review M-1, §14.1.A):* the parent refuses a recognizable Python child that would start without the loader — the loader not first on `PYTHONPATH`, or the guard's file, log or protected roots missing from its environment, given or inherited. A test that needs its own import path uses `_isolation.child_pythonpath()`, never a replaced `PYTHONPATH`. Before this fix two tests replaced it, and their children ran with environment isolation only.
   - **`scripts/check_cli_contract.py`** is not covered by the pytest guard. It is a release check that runs on its own, outside pytest; it builds its own disposable home and removes every `BUGPILOT_*` variable, so it never carries the guard. Its own environment is its isolation.
   - **Not covered by the guard**, isolated by environment only, a stated limitation (T-S24):
     - Python started with `-I`, `-E` or `-S`, which ignores `PYTHONPATH` or skips `site` (no test uses them today);
     - Python started through something the check cannot recognize as Python: a shell (`os.system`, `shell=True`), the `py` launcher, or a console script such as an installed `bugpilot`;
     - non-Python children (`git`, `rg`, `node`).
4. **TypeScript integration tests.** `extension/test-integration/cli.integration.test.ts` gets one spawn helper. The suite runs `python -m bugpilot` with `PYTHONPATH`. The helper:
   - **(a)** builds each child's environment from a per-test temporary home (`HOME`, `USERPROFILE`, `BUGPILOT_HOME`, `BUGPILOT_CONFIG_DIR`, no `JIRA_*`);
   - **(b)** throws *before spawning* if a call's environment lacks them or points outside the test's temporary root;
   - **(c)** puts the guard's `sitecustomize` folder first on the child's `PYTHONPATH`, so the CLI it runs fails closed too.

   *As built (§14.1.A):* the helper is `isolation.ts`'s guarded spawn. Every `Runner` the suite builds gets it, and since the pre-commit review (M-2) so does `discoverExecutable`, which builds a `Runner` of its own. The one direct `execFileSync` of Python goes through `checkedEnv`. The suite's `git` calls are a stated exception, isolated by the suite's environment only. `test/integrationIsolation.test.ts` checks all of this from the sources in CI, where the integration suite itself does not run.

   The unit-test suite spawns no CLI, and is unaffected.
5. **The golden and baseline helpers** (`tests/task_golden.py`, `tests/boundary_golden.py`, `tests/prompt_boundary_baseline.py`, `tests/storage_baseline.py`):
   - when run as scripts (`--update`, `--write`), they enter the same isolation and guard in `main()`;
   - under pytest, they rely on the conftest;
   - `measure_performance` and the `Workspace` methods run inside it.
6. **CI.**
   - `ci.yml` sets `HOME` and `USERPROFILE` to `${{ runner.temp }}/home` for the Python jobs, as defence in depth; the conftest isolates again inside.
   - The nine checks keep their names (US-D33).
7. **Optional real-home diagnostic** (opt-in, read-only). Isolation does not need one.
   - If the owner wants one, it is a separate script that pytest and CI never run, started by hand with an explicit flag.
   - It reports only whether a real `~/.bugpilot` exists, and the *names* of its top-level entries: no content, no mtimes, no recursion.
   - It writes nothing, and it is part of no acceptance.

**How isolation is verified** (Batch 0A; `tests/test_isolation_guard.py`, required in CI).

Verification is by demonstration against a **decoy**, never the real home, so no real data is involved:

- **The decoy.** A fixture starts a fresh Python child whose protected root is a temporary decoy folder seeded with canaries:
  - a `config.toml` holding a fake token `canary-token-…`;
  - an `instructions.md` holding a canary string;
  - a `repositories/` tree.

  The child's environment deliberately points *at* the decoy, simulating an unisolated test.
- **Writes fail closed.** In the child, each of these must raise `IsolationViolation`:
  - the 0.1.5 writers: `save_user_config`, `save_jira_site`, `save_instructions("user", …)` (and the storage writers once Batch 1 and Batch 2 exist);
  - plain `open(…, "w")`, `mkdir`, `os.replace`, `os.remove` and `shutil.rmtree`.

  Afterwards the **parent**, which has no guard on the decoy, confirms by `lstat` and content hash that every decoy file is byte-identical with an unchanged mtime, and that the decoy gained no entry.
- **Reads fail closed.** `load_user_config`, `read_instructions("user", …)`, `open(…, "r")`, `os.listdir`, `os.scandir` and `glob.glob` each raise, and no canary string appears in the child's output or exception text.
- **Children.**
  - A grandchild started with an explicit environment pointing at the decoy is refused at `subprocess.Popen`.
  - A grandchild started with the inherited environment carries the `sitecustomize` guard, and fails closed the same way.
- **The real suite is isolated.** A session-start check asserts that:
  - `Path.home()`, `os.path.expanduser("~")` and `user_config_dir()` all resolve under the session root (and `storage.data_root()` too, from Batch 1);
  - no `JIRA_*` variable is set.
- **The integration helper.** A unit test of the TypeScript spawn helper shows it throws for an environment pointing outside the test root.
- **The record.** Batch 0A writes these into §18:
  - the guard's event list;
  - the platforms where `test_isolation_guard.py` ran (CI: Ubuntu 3.13 and 3.10, macOS, Windows), with counts;
  - the stated limits.

**Writes versus reads.**

| | Protected by | Limit |
| --- | --- | --- |
| **Writes** to the real BugPilot data | environment isolation (every path is computed from isolated variables), plus the guard, which refuses the operation before it happens, in the test process and its Python children | non-Python children, and Python children started with `-I` or `-E`: environment isolation only |
| **Reads** of the real BugPilot data | the same isolation, plus the guard, which refuses content opens and directory listings | `stat`, `lstat` and `exists` raise no audit event, so a metadata probe of a real path is not caught (no content can be read that way) |
| **Background processes** | not involved: the guard judges only operations made by the test process and its Python children | a VS Code window, an MCP server or a CLI run writing to the real home at the same time can neither fail the suite nor be mistaken for it |

### 11.2 The path-literal ratchet (Batch 0A, required)

`tests/test_storage_inventory.py` scans `bugpilot/`, `skills/`, `scripts/` and `extension/src/` (plus `media/panel.js`) for the literals `.ai/`, `".ai"`, `.ai_memory`, `.bugpilot` (both forms) and `~/.bugpilot`.

- **How it compares.** It checks the occurrences against `tests/storage_inventory.json`: file, family id and count. It does not pin line numbers, which would churn.
- **Batch 0A** records today's inventory (§5) as the baseline. The test then fails on *any* new occurrence.
- **Batch 2 and Batch 3** shrink the inventory, deliberately, in the same commit as the code.
- **The end state** (Batch 4 acceptance) is only the approved residue:
  - the F22 guards (US-D15);
  - the protected rule's text, if US-D14 keeps it;
  - the data root's default name in `storage.py`;
  - comments that name the 0.1.5 layout historically.

### 11.3 New suites

**Storage resolver** (`tests/test_storage_identity.py`, Batch 1, required):

- **Data root:**
  - default root from `Path.home()`;
  - `BUGPILOT_HOME` absolute;
  - relative or `~`-leading `BUGPILOT_HOME` refused;
  - control characters, NUL, U+2028 or U+2029 refused;
  - a missing home refused.
- **Determinism and canonicalization:**
  - a golden vector: a fixed POSIX path and a fixed Windows path each map to a known ID on every OS (determinism and algorithm version);
  - same spelling variants map to one ID (separators, `.`, `..`, trailing separator; Windows letter case);
  - a symlinked root maps to the target's ID, with a junction on Windows (the existing junction helpers).
- **Distinct repositories:**
  - two repositories with the same basename get different IDs and the same slug;
  - nested repositories and two worktrees get distinct IDs;
  - a renamed folder gets a new ID, and the old namespace is untouched.
- **Hostile basenames:** each gives a valid ID: newline, `..`, `CON`, `nul.txt`, trailing dot or space, emoji, RTL override, 300 characters, all non-ASCII.
- **Platform-only:**
  - POSIX: case-distinct folders are distinct;
  - macOS: `getcwd` gives the canonical case; `/private/var`;
  - Windows: junctions. `subst` stays NOT VERIFIED: its test is deferred pending separate owner approval, because a drive letter is a session-wide change outside a test's own folder (D0A-5).
- **Records:** missing, ok, mismatch, corrupt, a link at the record, not a regular file.
- **Processes:** two processes call `ensure()` on one namespace 50 times and end with identical records and no error.
- **Resolution creates nothing:** a snapshot of the data root shows no change.

**Storage safety** (`tests/test_storage_safety.py`, Batch 1 primitives, Batch 2 end to end, required):

- **Links:**
  - a link or junction at each of the nine components (§10, T-S5), before creation and swapped in after `mkdir`: refused, nothing written, nothing followed, one sentence, no absolute path in the message;
  - the data root behind a link works.
- **Modes (POSIX):**
  - folder modes `0700` under five umasks;
  - file modes `0600` new, rewrite keeps its bits;
  - the credentials file `600` new and rewritten.
- **Atomic writes:** W1 and W2 on the new tree.
- **Isolation:** two repositories prepare `JR-12345` with different content, and each reads back only its own (CLI and MCP).
- **Traversal:** id cases from `tests/fixtures/work_item_ids.json`.
- **`clean`:**
  - deletes only `work/<id>/` and, with `--include-memory`, `memory/<id>.md`;
  - refuses links;
  - never touches `settings/`, `config/` or the record.

**Repository pollution** (`tests/test_repository_pollution.py`, Batch 2, required; the 0.1.5 baseline in Batch 0A):

- **Setup:** a real `git init` repository with a commit, and a recorded `git status --porcelain=v2 --ignored --untracked-files=all` plus a directory snapshot.
- **Commands exercised:**
  - every CLI command that writes (`bug` with each option set, including hand-written, attachments, `--fresh`, `--retry`, `--feedback-file`; `record-review`, `record-verification`, `manual-result`, `memory add/update`, `jira-comment-draft`, `notify`, `fix-mode create/update/delete --scope project`);
  - the settings commands (`instructions`, `verification`, `ai-behavior`, `project-settings`, `repository-profile`, `set` and `reset`);
  - every read-only command;
  - every MCP tool.
- **Assertion:** after all of them, the status and snapshot are unchanged.
  - **Excluded** by construction: files a stub agent writes on purpose (none by default).
  - Explicitly asserted absent: `.ai`, `.ai_memory`, `.bugpilot`, `fix_report.md`, `task.md`, `context.md`.
- **Batch 0A baseline:** under 0.1.5 the same scenario *creates* the three folders. That is recorded as a baseline that flips in Batch 2, as 0.1.5's baselines did.

**No legacy reads** (`tests/test_no_legacy_data.py`, Batch 2, required):

- **Canaries:** `<repo>/.ai/JR-12345/task.md`, `.ai_memory/bugs/JR-11111.md`, `.bugpilot/instructions.md`, `.bugpilot/verification.md`, `.bugpilot/fix_modes/x.json`, plus legacy `$HOME/.bugpilot/config.toml` (a fake token), `instructions.md` and `fix_modes/`. Each holds a unique canary string.
- **Run:** the full workflow, via the CLI and MCP.
- **Assertions:**
  - no canary appears in any output, artifact or JSON;
  - every legacy file is byte-identical, with an unchanged mtime;
  - no legacy folder gained an entry;
  - the fake token is never used.
  - The canary `.ai/` is also never Code Search evidence (F22).

**Contract** (`tests/test_storage_contract.py`, Batch 2, required; the fixture `tests/fixtures/storage_cli_contract.json` is frozen in Batch 1).

- It checks every key §8.10 lists against its kind (`abs`, `ns`, `display`, `id`) and its null rule.
- It covers `doctor`'s `storage` object and the capability, and `list`'s `work_dir` and `modified`.
- Its TypeScript twin, `extension/test/storageContract.test.ts` (Batch 3), reads the same fixture. Neither side tests the other's code.

**Extension** (Batch 3):

- **Required TypeScript tests:**
  - `test/storagePaths.test.ts`: the composition helper against `tests/fixtures/work_item_ids.json`, plus a new shared fixture of `repository_dir` + id → path. No other `.ai`/`.bugpilot` composition remains, enforced by the ratchet.
  - `test/handoffGate.test.ts`: real homes with spaces pass; `\`, `~`, non-ASCII, `(`, `'`, `&` and `%` are refused → manual fallback.
- **Updated tests:** `sessionReset.test.ts` (TS writes gone), `controller.test.ts`, `page.test.ts`, `agents.test.ts`, `nextAction.test.ts` (cross-language regexes on the new templates), `progress.test.ts`, `results.test.ts`, `reviewPackage.test.ts`, and the policy and instructions tests.
- **Removed:** `gitignore.test.ts`, if US-D16.

**Agent handoff:**

- **Unit tests:**
  - argv composition: no `--add-dir` by default;
  - the cwd is the repository;
  - prompts pass the gate for representative homes;
  - the Python launcher refuses a non-plain prompt.
- **Live** (each run separately owner-approved; synthetic repositories and disposable data folders only):
  - probes P1–P11 (§9.7) in Batch 0B;
  - the §9.10 real interactive end-to-end runs in Batch 5, against the built candidates, for every combination the owner lists as supported.

  Outcomes are PASS, FALLBACK, FAIL or UNKNOWN as observed. A copy-and-paste completion is FALLBACK, never PASS.

### 11.4 Security regression: what must stay green

| Suite | Expected change |
| --- | --- |
| N1–N4, N5 (`test_prompt_boundary_baseline.py`, `test_prompt_boundary_oracles.py`, `test_prompt_boundary_corpus.py`) | logically unchanged; paths in 3 tests (`:442`, `:567`, `:675-701`); `golden/prompt_boundary/expected.json` and `evidence_mirror.json` hold no paths and must not move |
| N10–N12 (`test_jira_parse_fences.py`, `test_intake_linear_patterns.py`) | unchanged |
| D1 and the protected rules (`test_batch3_boundaries.py:657-750`, `test_protected_rules.py`) | unchanged if US-D14 keeps the rule (the digest stays `VERSION_2_SHA256`); `.bugpilot` write fixtures re-pointed |
| Retry, MCP and hint-improver containment (`test_batch3_boundaries.py`) | path updates; the frozen-0.1.4 diff transform (`:362-386`) taught the designed path-line change; `RULES_LINE` (`:84`) updated |
| Independent CommonMark and raw-line oracles | unchanged; they run over the regenerated goldens |
| 0.1.5 file safety (`test_batch4_file_safety.py`, `test_file_safety_baseline.py`, `test_write_boundaries.py`, `test_cleanup_safety.py`) | the credentials and atomic-writer logic unchanged; link-refusal targets re-pointed to the data-root components; F13's `.ai` cases become the new folders |
| CLI contract (`test_cli_json.py`, `test_extension_argv_contract.py`, `scripts/check_cli_contract.py`) | fields per §8.8; `extension_cli_argv.json` regenerated for `--feedback-file` and the capability |
| Publishability (`test_publishable.py`) | unchanged; docs must use generic home names (`you`, `user`) |
| Context Quality, retrieval baselines, Git History (`test_retrieval_regression.py`, `test_git_history*.py`, `baseline_report.py`) | **unchanged**: Recall@5 9/9, MRR 0.944; no storage path in them |
| Goldens | §11.6 |

### 11.5 Workflow tests

| Workflow | Where |
| --- | --- |
| Build Context (Jira, hand-written) | `test_workflow.py` and `test_cli_*` (paths); pollution suite |
| Fix with AI | extension `controller.test.ts` (prompt, cwd, no extra flags); probes P1, P3, P5, P6, P10; the §9.10 end-to-end runs (A1–A3, A6, A7) |
| Retry | `test_cli_phase2.py`, `test_batch3_boundaries.py`; `--feedback-file` contract; extension retry |
| History | `test_cli_phase2.py` `list` (new fields); extension `results.test.ts` (no TS `stat`) |
| Review and verification | `test_review_report.py`, `test_verification_report.py`, `test_review_package.py`; probe P2 |
| Settings Edit / Reset / Preview | `test_instructions.py`, `test_verification_policy.py`, `test_ai_behavior.py`, `test_project_settings.py`, `test_repository_profile.py`, `test_task_preview.py`, `test_context_preview.py`; extension policy tests; probe P7 (editor save outside the workspace) |
| Similar Fix Memory | `test_context_task_artifacts.py`, `test_similar_fixes_settings.py`, MCP `search_memory` |
| CLI and MCP parity | `test_prompt_boundary_baseline.py:675-680`, `test_mcp_server.py` |
| Agent handoff | §11.3 |

### 11.6 Goldens

**What changes intentionally:**

| Goldens | Change |
| --- | --- |
| `tests/golden/task/*.txt` (17) | Execution Location, Required Input/Output Files, Developer Attachments, Investigation Handoff; the Source lines of the Verification Policy and AI Behavior; the US-D9 wording if approved |
| `tests/golden/context/*.txt` (4) | the `retrieval.json` sentence and the memory file names |
| `tests/golden/retry/*.txt` (3) | <ul><li>the Fix Mode line ("the same Fix Mode as … `task.md`")</li><li>the Required Reading work-folder line, US-D14's note and the reading list</li><li>the rules line</li><li>the Investigation Handoff line (investigation retry only)</li><li>the required output</li><li>How to Run</li></ul>*(Amended 2026-10-18, §9.8.1: the Fix Mode line, the note and the Investigation Handoff line were omitted before.)* |

**What stays frozen:** `golden/context_0.1.4/` and `golden/retry_0.1.4/` are never regenerated. Their transforms (`test_context_boundary.py:701-751`, `test_batch3_boundaries.py:362-386`) learn exactly the designed path-line change, and nothing else may differ.

**Determinism.** Golden helpers render in temporary repositories, so the work folder and the repository ID vary by run and by OS. The helpers therefore normalize before comparing: the actual `Path(work_dir).as_posix()` is replaced with the fixed representative `/home/you/.bugpilot/repositories/app-0123456789abcdef/work/<id>`. Both `task_golden.py` and `boundary_golden.py` do this. *(Amended 2026-10-18, §9.8.1: the value replaced is the canonical (`realpath`) work folder the renderer itself uses. So, for example, a temporary folder under macOS `/var`, which is really `/private/var`, normalizes as well.)* Line endings are already normalized. No other normalization is allowed.

**How changes are checked:**

- the 17 task goldens differ from 0.1.5 **only** in the listed sections, checked by a script over the diff (not by eye), as D1's one-line change was in 0.1.5;
- the protected-rules digest is as US-D14 decides (§16.4): unchanged under options A and A′; a new pinned v3 digest under B;
- the size measures per US-D30 (§9.8 (a); as decided, §9.8.2: median ≤ 3,096 + A, per-golden approved deltas, retry bounds): the normalized median gate, the per-golden growth bound, exactly two absolute work-path occurrences per task golden and three per retry golden (template observations, §9.8.1), and the raw size reported;
- the exact task, retry and context golden changes, and any new path-literal residue or ratchet adjustment, are approved by the owner in the implementing batch. No broad regeneration is pre-approved (US-D13, §9.8.1).

### 11.7 CI

**Unchanged:**

- the nine required checks (four jobs; names pinned by `scripts/release_preflight.py:51-61` and `tests/test_release_workflow.py:338-342`);
- the SHA-pinned actions, `contents: read` and `persist-credentials: false`.

**Additions (owner-approved, Batches 0A–3).** These add isolated storage tests to the existing required jobs. No check is added or renamed, and all nine stay blocking (US-D33).

- `safety-and-baselines` gains these files, so they run on Ubuntu 3.13, macOS 3.13, Windows 3.13 and Ubuntu 3.10:
  - `tests/test_isolation_guard.py` (Batch 0A)
  - `tests/test_storage_inventory.py`
  - `tests/test_storage_identity.py`
  - `tests/test_storage_safety.py`
  - `tests/test_repository_pollution.py`
  - `tests/test_no_legacy_data.py`
  - `tests/test_storage_contract.py`
- `extension-evidence-boundary` (the required TypeScript job) gains `test/storagePaths.test.ts`, `test/handoffGate.test.ts` and `test/storageContract.test.ts`. The job keeps its name, and its step runs named files as today.
- Python jobs set `HOME` and `USERPROFILE` to runner temp (§11.1). The conftest's isolation and guard apply inside, on every OS.
- The file-safety artifact upload gains the storage observations: modes seen, links refused, `realpath` results per OS. This is how §7.3's "unverified" rows become verified.

**No platform-specific code without its platform's CI.**

- The only per-OS branches in `storage.py` are `normcase` on Windows, and the existing reparse-point check.
- Each has tests that run on its OS in CI.
- `extension/test-integration` still does not run in CI. It runs locally in Batches 0A, 3 and 5, isolated through its spawn helper (§11.1).

---

## 12. Performance and resource budgets

| Item | Analysis | Budget (measured in Batches 1, 2 and 4) |
| --- | --- | --- |
| Repository ID | one `realpath` (a handle open on Windows) and one SHA-256 over less than 1 KB, memoized per process and root | < 1 ms cold, < 10 µs warm |
| Path resolution per call | pure joins after the memoized identity; the record is read once per process per namespace | no measurable change |
| `ensure()` | about 6–9 `lstat`/`mkdir` calls on the first write of a process; after that only the work folder's `lstat` chain, as `writable_dir` does today | first write: median < 10 ms on Windows local NTFS; 2 ms on Linux and macOS, a provisional reference until measured; atomicity is never reduced for speed (owner, Q6, 2026-10-16; was < 2 ms everywhere) |
| Preparation end to end | no new network, git, search or model call | median of 5 within 2% of 0.1.5 (the §44.12 rule) |
| `list` / History | `list` now returns `work_dir` and `modified`, so the extension's N `stat` calls are removed; `run.json` reads stay cached by mtime | `list --json` over 1,000 work items < 1 s; History no slower than 0.1.5 |
| Memory search | still per repository (R3): it globs `memory/*.md` of one namespace, as before; **no cross-repository scan** | unchanged |
| Large work folders | unchanged sizes (10 attachments of at most 10 MB) | — |
| Disk growth | the same bytes as 0.1.5, in one place. Namespaces are never deleted automatically, and a moved or deleted repository leaves its namespace behind (US-D38). The cost is visible: `doctor` reports the data root; `clean` per item | documented; retention DEFERRED |
| Cache lifetime | no cache on disk (US-D36); in memory only as §8.3 states (Batch 2A) | — |
| Several VS Code windows | one identity computation each (one CLI `doctor` per root, as today) | — |
| Accidental scanning | `repositories/` is never listed except by diagnostics (an `os.scandir` of one level, if US-D21 adds a count); no walk of the data root and no walk of the repository beyond today's | a test asserts that preparation does not list `repositories/` |
| Windows path length | deepest common path: `<home>\.bugpilot\repositories\<≤41>\work\<≤40>\attachments\<name>`, about 130 characters plus the attachment name (SF-5) | test with a 100-character attachment name; the limit documented |

---

## 13. Breaking-change documentation

These texts go into the changelog, the README files and `docs/safety.md` in Batch 5. External-facing text gets the owner's review before publication.

### 13.1 What changes for a user

> **BugPilot 0.1.6 keeps all of its data outside your repositories.** Work items, similar-fix memory and repository settings now live in your user folder, under `~/.bugpilot/` (on Windows `C:\Users\you\.bugpilot\`), with one folder per repository. BugPilot no longer creates `.ai/`, `.ai_memory/` or `.bugpilot/` in your repository, and no longer reads them.
>
> **This version does not import anything from earlier versions.** Your existing files are left exactly where they are, and BugPilot 0.1.6 does not read them:
>
> - prepared work items and their reports in `<repository>/.ai/`;
> - similar-fix memory in `<repository>/.ai_memory/`;
> - repository settings in `<repository>/.bugpilot/`: Project Instructions, the Verification Policy, AI Behavior, the Repository Profile, branch naming and project Fix Modes;
> - in `~/.bugpilot/`: `config.toml` (the Jira site, email and token saved by `bugpilot setup`), `instructions.md` (User Instructions) and `fix_modes/` (your own Fix Modes).

### 13.2 What a user has to do

1. **Jira.**
   - **CLI users:** run `bugpilot setup` again.
   - **Extension users:** enter the Jira site again in **Jira Setup**. The email and token are kept by VS Code.
   - **Users with `JIRA_*` environment variables:** nothing to do.
2. **Re-create the settings you rely on.**
   - Do it through the panel or `bugpilot instructions | verification | ai-behavior | project-settings | repository-profile | fix-mode`.
   - Earlier files can be opened and their text copied by hand; BugPilot does not copy them.
3. **Prepare work items again** where needed. The earlier ones remain readable as files in `.ai/`.
4. **If you set `BUGPILOT_CONFIG_DIR`:** use `BUGPILOT_HOME` (US-D3). It now names the whole data folder. `BUGPILOT_CONFIG_DIR` is no longer honoured: BugPilot prints one line saying so, and never reads or uses the folder it names.
5. **Optional clean-up, by hand, when you no longer need them:**
   - delete `.ai/`, `.ai_memory/` and `.bugpilot/` from your repositories, and their `.gitignore` lines;
   - delete `~/.bugpilot/config.toml`, which may hold your Jira token in plain text, `~/.bugpilot/instructions.md` and `~/.bugpilot/fix_modes/`.
   - **Do not delete** `~/.bugpilot/config/` or `~/.bugpilot/repositories/`: those are 0.1.6's.

### 13.3 What changes for teams (US-D9)

> Repository settings were files in `<repository>/.bugpilot/` that a team could commit. In 0.1.6 they are your own settings for that repository, kept in your BugPilot folder, and are no longer shared through the repository. A committed `.bugpilot/` folder stays in your repository, but BugPilot does not read it. Each developer sets their own.

**Sharing settings across a team is DEFERRED** to a later design. Two possibilities to evaluate:

- an explicit "use this file" setting;
- an export and import pair.

Either must avoid becoming a legacy reader (R4).

### 13.4 Where to find things (Batch 5 UX; US-D21; the US-D20 legacy notice is recommended for deferral)

| The user wants to | How |
| --- | --- |
| find the data folder and this repository's namespace | `bugpilot doctor` (`storage`: data root, repository ID, root, namespace folder, state); the panel's Diagnostics |
| open a work item's files | the panel's **Open Artifacts Folder** (reveals the folder in the OS file manager, US-D17); **Open task.md**; or the absolute path `bugpilot bug` prints |
| inspect repository identity | `bugpilot doctor --json` → `storage.repository_id` / `repository_root`; `repository.json` in the namespace |
| understand that old data is not loaded | this note and the changelog. No legacy-presence probing under the review's recommendation (US-D20 deferred). |
| know why work items differ when running from a subfolder | `bugpilot doctor` (`storage.below_git_toplevel`) and one line in the panel's Diagnostics (§7.1) |
| reconfigure Jira | §13.2 |
| diagnose missing storage or permission errors | `doctor` `storage.state` / `problem`; errors are one sentence naming the folder in `~/.bugpilot/…` form, never a raw traceback; the panel's "Run failed" detail shows the same sentence |
| a home folder whose name the prompt gate refuses (non-ASCII, `(`, `'`, …) | **A documented limitation of 0.1.6** (§9.9). The manual handoff still works (paste). Setting `BUGPILOT_HOME` to a folder whose path has only ASCII letters, ASCII digits, ordinary spaces and `. , : # / _ -` restores one-click launch. *(Corrected 2026-10-18, US-D12, §9.9.1: this first listed only `. _ - /`, leaving out the colon every Windows drive path needs, and the comma and hash.)* |

### 13.5 Version skew

**Extension and CLI versions.**

- The managed runtime installs `bugpilot==<extension version>`, as before, so a matching pair is the default.
- If the extension meets a CLI without the `unified-storage` capability (a user-configured `bugpilot.executablePath` pointing at an older CLI), it shows the existing "outdated CLI" message and does not run storage-dependent actions.
- A 0.1.5 extension with a 0.1.6 CLI is unsupported. It would look for `.ai/`, find nothing, and show empty History. That is harmless, and documented.

**0.1.5 and 0.1.6 CLIs on one machine** see different data: 0.1.5 the legacy files, 0.1.6 the new layout. Neither touches the other's.

---

## 14. Six-batch implementation plan

### 14.0 Batch status

| Batch | Title | Status | Commit | CI run | Notes |
| --- | --- | --- | --- | --- | --- |
| 0A | Automated isolation, inventory and baselines | **COMPLETED**: committed and CI-verified. Review findings H-1, M-1, M-2, N-1, L-1, L-2, L-3 and L-8 remediated | `8b6c567` (2026-10-16) | run 38942462918: **9/9 success** | approved 2026-10-15 with US-D32 and US-D33; as built in §14.1.A; Batch 0 is not complete while 0B has not run |
| 0B | Live agent capability probes | **IN PROGRESS** (2026-10-18). P10: direct shells and the Python launcher PASS (narrowed run), then VS Code `sendText` PASS (completion run): **PASS for the tested Windows configuration**, with limitations. P7 attempted the same day: UNKNOWN, blocked before its tests by an in-progress VS Code update. P7 retry after the update (VS Code 1.142.0, Windows): P7-A to P7-H PASS, `revealFileInOS` UNKNOWN. P2 (one run, Claude Code 2.1.214): FAIL against the owner's criteria; external reads under `dontAsk` worked, the marker was declined, and a Bash request was refused. P1, P3–P6, P8, P9 and P11 NOT EXECUTED (§14.1.B) | — | — | each further probe awaits a separate approval naming the agents and accounts; no commit except plan records |
| 1 | Storage foundation | **COMPLETED**: committed, CI-verified and integrated into `main`; **NOT activated** (no caller uses `storage`). Architecture review FAIL, then remediated (H1, M1–M3, L2, L3, L6–L9; H2 investigated); decisions and Q1–Q7 ratified 2026-10-16 (§14.2). Activation blockers in §14.3: only the CI one is met | `5222da7` (2026-10-16), fast-forwarded into `main` | run 39003264436 (verification branch): **9/9 success**; run 39004684594 (push to `main`): **9/9 success** | after 0A, plus its decisions; independent of 0B |
| 2 | Python CLI, MCP and prompts on the new layout | **2A COMPLETED**: committed `e78a678`, CI-verified (run 39057483843 on the verification branch and run 39062906366 on `main`, each 9/9), integrated into `main`, **NOT activated** (§14.3 "Batch 2A — acceptance and CI evidence"). **2B-1 COMPLETED**: `7b8914d` and the corrective `40865cf`, CI-verified (run 39085417171 failed 3/9; run 39096347226 on the verification branch and run 39097757625 on `main`, each 9/9), integrated into `main`, **NOT activated** (§14.3 "Batch 2B-1 — acceptance and CI evidence"). **2B-1 follow-up** (concurrent data-root creation): `147e1bd`, branch CI 39285763641 and main CI 39305575297, each 9/9; integrated by fast-forward `7a2a1f4..147e1bd`. **2B-2 to 2B-6 NOT STARTED** (the switch of callers); 2B-2's decision gate recorded and the slice specified on 2026-10-19 (§14.3, "Batch 2B-2 — decision gate"), implementation not authorized; Q-1 to Q-6 answered and the contract resolved the same day, with C-1 to C-5 open (§14.3, "Batch 2B-2 — final contract resolution"); C-1 to C-5 approved later that day, and implementation NOT STARTED | — | — | implementation paths only; **no user data is migrated**; blocked until §8.10 is approved (US-D28, US-D14 and US-D10: APPROVED with conditions on 2026-10-18, §16.5.11, §16.4.1 and §9.5.1) |
| 3 | Extension and Agent Handoff | **NOT STARTED** | — | — | — |
| 4 | Security and cross-platform validation | **NOT STARTED** | — | — | — |
| 5 | Final UX, packaging and release readiness | **NOT STARTED** | — | — | — |

**Order.** 0A → 1. 0A → 0B. Batch 2 needs 1, 0B and the decisions above. Then 2 → 3 → 4 → 5 (§15).

- 0A and 0B are independent of each other: 0A reaches its own gate without 0B.
- Batch 1 does not wait for 0B.

**Rules for every batch:**

- **Start and stop.** A batch starts only on the owner's explicit approval, and stops at its gate for the owner.
- **Review recommendations are not approvals.** A decision counts as APPROVED only when the owner says so, and §16.1 then records the date.
- **Before the gate:**
  - the whole of §11.4 stays green;
  - `git diff --check` is clean;
  - publishability passes;
  - the protected local files (`.bugpilot/`, `.vscode/extensions.json` and the 0.1.5 post-release plan records) are unchanged and unstaged.
- **No test is weakened to pass.**
  - No regression test is skipped, deleted, loosened or marked expected-to-fail to hide a known failure.
  - A test changes only when the behaviour it pins changes by design, in the same commit, with the reason in §18.
- **Commits and pushes.**
  - No commit, push, tag, fast-forward, release or publish happens without the owner's approval, and nothing is pushed automatically.
  - Every implementation prompt cites this plan.
- **Account-using probes** (0B, and Batch 5's end-to-end runs) need their own owner approval.
  - They use only synthetic repositories and disposable data folders.
  - Their outcomes are PASS, FAIL or UNKNOWN as observed (§9.7); nothing is reported as passed unless it was observed.
- **The version** stays 0.1.5 until Batch 5's approved bump.
- **Records.** After each batch, update §14.0, §16.1, §18 and §19.
- **Deviations from the brief's outline:**
  - Batch 0 also hardens test isolation, and is split into 0A and 0B (2026-10-15 review);
  - the MCP *code* switches in Batch 2, because it shares `workflow` and the path chokepoints;
  - Batch 3 keeps MCP live verification and any wording found there (US-D31).

### 14.1 Batch 0 — two scopes, authorized separately

#### 14.1.A Batch 0A — Automated isolation, inventory and baselines

**1. Scope.** No product behaviour changes, and no agent account is used. Batch 0A:

- builds the test isolation and its fail-closed guard, verified by demonstration (§11.1);
- records the inventory as a ratchet (§11.2);
- captures synthetic baselines of 0.1.5 behaviour that later batches flip;
- makes the CI changes approved for isolation;
- collects the CI observations of `realpath` per OS that §7.3's unverified rows need.

**2. Files.**

| Kind | Files |
| --- | --- |
| Isolation | `tests/_isolation.py` (new), `tests/conftest.py` (first statements), `tests/task_golden.py`, `tests/boundary_golden.py`, `tests/prompt_boundary_sources.py`, `tests/prompt_boundary_baseline.py`, `extension/test-integration/cli.integration.test.ts` (spawn helper) |
| New | `tests/test_isolation_guard.py`, `tests/test_storage_inventory.py`, `tests/storage_inventory.json`, `tests/storage_baseline.py`, `tests/baselines/0.1.6-batch0/` |
| CI | `.github/workflows/ci.yml`: Python jobs' `HOME`/`USERPROFILE`; `test_isolation_guard.py` and `test_storage_inventory.py` in `safety-and-baselines`; the `realpath` observation artifact. The nine check names stay unchanged. |
| Plan | this plan |

Not touched: `pyproject.toml`, `bugpilot/`, `extension/src/`, goldens and fixtures.

**The baselines** (synthetic, isolated temporary repositories only):

| File | What it records |
| --- | --- |
| `pollution.json` | the folders 0.1.5 creates in a repository |
| `handoff.json` | today's handoff sentences |
| `cli_paths.json` | today's JSON path fields |
| `task_size.json` | the task-size measurements, both the raw and the normalized measure of US-D30 |
| `prepare_timing.json` | preparation timing |
| `realpath_<os>.json` | CI observations of the §7.3 spellings: junction, `/private`, case. `subst` is not observed (D0A-5) |

**3. Preconditions.**

- The owner approves Batch 0A's implementation, plus US-D32 (as revised) and US-D33.
- The 0.1.5 post-release records in `docs/bugpilot_prototype_development_plan.md` are committed by the owner, or explicitly carried forward unstaged.
- The starting commit is recorded in §19.

**4. Explicit exclusions.**

- no change under `bugpilot/` or `extension/src/`; no golden or fixture change; no version change;
- no agent account; no Jira; no real repository;
- the real home is never listed or read (§11.1, requirement 1).

**5. Steps.**

1. `tests/_isolation.py` and the conftest's first statements: the session environment, the real-home path captured as a string, the audit-hook guard, the `sitecustomize` for Python children.
2. `tests/test_isolation_guard.py`: the decoy demonstrations of §11.1 (writes, reads, children, session check).
3. Isolate the golden and baseline helpers. Add the integration-test spawn helper and its unit test. Confirm git identity handling under an isolated `HOME`.
4. The inventory scanner. Reconcile its counts with §5; a family it finds that §5 lacks is added to §5 before going on.
5. The baseline generator; record `tests/baselines/0.1.6-batch0/`.
6. `ci.yml` changes; an owner-dispatched CI run.
7. Update §7.3 from the CI `realpath` observations: each "unverified" row becomes verified or failed.

**6. Acceptance.**

- The full Python suite and the extension suite are green, on Windows locally and on the three systems in CI. All nine checks are green; counts are recorded.
- **Isolation is demonstrated, not configured.** `test_isolation_guard.py` passes on every CI configuration, with:
  - every write and read event against the decoy refused before it happens;
  - the decoy byte-identical, with unchanged mtimes;
  - no canary in any output;
  - Python grandchildren guarded;
  - the session check green.
- A full local run passes with the guard active. Any `IsolationViolation` it raised was fixed by isolating the test, never by narrowing the guard.
- The inventory equals §5, or §5 is corrected in the same batch.
- Baselines are recorded and reproducible: a second run yields identical files, timing excluded.
- §18 records the guard's event list, where it ran, and its stated limits.

**7. Security tests.** The isolation guard (T-S24, T-S25, T-S26); the inventory ratchet.

**8. Regression.** All of §11.4, unchanged (Batch 0A changes no product file).

**9. Cross-platform.** CI on Ubuntu (3.13 and 3.10), macOS and Windows. The guard and the `realpath` observations run on each.

**10. Rollback.** Revert the test-only commit. Nothing in the product depends on it.

**11. Dependencies.** None.

**12. Stop and approval gate.**

- **Stop if:**
  - the guard cannot cover a write path the suite uses. The gap is reported with its operation, and the owner decides;
  - isolation cannot be made complete before collection;
  - the inventory finds a writer this plan missed. §5 and §14 are amended first.
- **Gate:** the owner reviews the isolation evidence. 0A is complete on its own; 0B is not required.

##### Batch 0A — as built (2026-10-15)

**Status: implemented and verified locally on Windows. The pre-commit review's findings H-1, M-1 and M-2, and the final diff review's N-1, L-1, L-2, L-3 and L-8, are remediated and re-verified locally ("Pre-commit review remediation" and "Final security remediation", below). COMPLETED: committed as `8b6c567` and pushed to `main` on 2026-10-16 (owner-approved), and CI run 38942462918 passed all 9 required checks** ("Acceptance and CI evidence", below; §19).

| | |
| --- | --- |
| Authorized | 2026-10-15, Batch 0A only, with US-D32 and US-D33 |
| Starting point | `main` at `ee3fb00`; the 0.1.5 post-release records in `docs/bugpilot_prototype_development_plan.md` uncommitted and unchanged |
| Version | 0.1.5, unchanged |
| Product code | none changed. `bugpilot/`, `extension/src/`, `extension/media/`, `skills/`, `scripts/` and `pyproject.toml` are byte-identical to `ee3fb00` (SHA-256 compared) |
| Goldens and fixtures | none changed (`tests/golden/`, the 0.1.4 frozen goldens, `tests/fixtures/`, existing `tests/baselines/`) |
| Accounts | no Jira request, no agent account, no live probe |

**Files.**

| File | Change |
| --- | --- |
| `tests/_isolation.py` | **new**: session isolation, the audit-hook guard, the child-guard set-up, `require_isolated()`; Windows' native copy and junction events (N-1) and report-once bookkeeping (L-2) from the final security remediation |
| `tests/isolation_child/sitecustomize.py` | **new**: the child guard's loader, the one copy both suites use (D0A-2); fails closed when the guard is configured but cannot be installed (L-3) |
| `tests/conftest.py` | isolation as its first statement; the per-test home; the per-test refusal check; a session-wide refusal check and an end-of-session backstop (L-2) |
| `tests/task_golden.py`, `tests/boundary_golden.py`, `tests/prompt_boundary_sources.py`, `tests/prompt_boundary_baseline.py`, `tests/baseline_report.py` | refuse to touch storage outside isolation; isolate in `main()`; `Workspace.retry()` and `.similar_fixes()` inside `configured()` |
| `tests/test_isolation_guard.py` | **new**, required in CI: 26 demonstrations against a decoy (14 as first built, 4 from the review remediation, 8 from the final security remediation) |
| `tests/test_storage_inventory.py`, `tests/storage_inventory.json` | **new**, required in CI: the ratchet and its record |
| `tests/storage_baseline.py`, `tests/baselines/0.1.6-batch0/` | **new**: the generator and the six records; path arguments recorded with `/` on every platform (H-1) |
| `tests/test_storage_baseline.py` | **new**, required in CI: the compared records held to today's behaviour; portable path arguments (H-1); the platform path observation (D0A-3) |
| `tests/test_cli_json.py`, `tests/test_mcp_stdio.py` | their Python children get `_isolation.child_pythonpath(...)`: the loader, then the sources, instead of a replaced `PYTHONPATH` (M-1) |
| `extension/test-integration/isolation.ts` | **new**: the integration suite's one isolation helper; its comment on which variables are removed corrected (L-1) |
| `extension/test-integration/cli.integration.test.ts` | isolates first; every CLI child through the guarded spawn, `discoverExecutable` included since the review (M-2); `git` a stated exception; a final no-refusal test |
| `extension/test/integrationIsolation.test.ts` | **new**: the helper's checks, with a fake spawn, and a check of the integration suite's sources for every way it can start a process (M-2); runs in the required extension job |
| `.github/workflows/ci.yml` | both Python test steps: an isolated home created first, `HOME` and `USERPROFILE` set; three files added to `safety-and-baselines`; header comments. Job ids, names, pins, permissions and the artifact upload unchanged |

**The design, as built.**

- **Isolation before collection.** `tests/conftest.py` calls `_isolation.isolate_session()` before importing `pytest` or anything from `bugpilot`. pytest imports the root conftest before it collects a test module, so collection-time renders (`test_prompt_boundary_golden.py:14`) and module-scoped fixtures run isolated, and `test_isolation_guard.py` demonstrates both.
- **The session.**
  - One folder from `tempfile.mkdtemp(prefix="bugpilot-test-")`, removed at exit (`BUGPILOT_TEST_KEEP_SESSION` keeps it).
  - `HOME`, `USERPROFILE`, on Windows `HOMEDRIVE`/`HOMEPATH`, `BUGPILOT_HOME` and `BUGPILOT_CONFIG_DIR` point inside it.
  - Removed: every `JIRA_*`, `SMTP_*`, `GRAPH_*` and `BUGPILOT_EMAIL_*` variable, plus `BUGPILOT_AUTO_JIRA_COMMENT` and `BUGPILOT_MCP_REPO_ROOT` (D0A-4). A test that wants a synthetic value still sets it.
  - Each test gets its own home and configuration folder inside the session.
- **The real home is a string.** Candidates are the account database (`pwd`; on Windows `SHGetKnownFolderPath(FOLDERID_Profile)`), plus `HOME`, `USERPROFILE`, `HOMEDRIVE`+`HOMEPATH`, `~`, `BUGPILOT_HOME` and `BUGPILOT_CONFIG_DIR` as they were before isolation. Each gives a protected root (`<home>/.bugpilot`, or the configured folder). Nothing under a protected root is listed, read or probed by the isolation or by any test.
- **The guard** (`sys.addaudithook`, before the operation):
  - write events: `open` (any mode), `os.mkdir`, `os.rename`/`replace`, `os.remove`, `os.rmdir`, `os.symlink`, `os.link`, `os.chmod`, `os.chown`, `os.utime`, `os.truncate`, `os.chdir`, `os.startfile`, `shutil.rmtree`, `shutil.copyfile`, `shutil.copymode`, `shutil.copystat`, `shutil.copytree`, `shutil.move`, `tempfile.mkstemp`, `tempfile.mkdtemp`;
  - on Windows, read and write: `_winapi.CopyFile2` and `_winapi.CreateJunction`, both source and destination (N-1). With Python 3.12 and later, `shutil.copy2`, `Path.copy` and `Path.copy_into` copy through `CopyFile2` and raise no `shutil.copyfile` or `open` event. Measured on 3.14.6: `CopyFile2` carries (source, destination, flags) and `CreateJunction` carries (target, junction);
  - read events: `open`, `os.listdir`, `os.scandir`, `glob.glob`, `glob.glob/2`;
  - process events: `subprocess.Popen`, `os.exec`, `os.posix_spawn`, `os.spawn`, `os.system`. A child is refused when its working directory is under a protected root, or when its environment (given, or inherited) has no home variable (`HOME` on POSIX, `USERPROFILE` on Windows) or would put its BugPilot data in, or around, a protected root. A child recognizable as Python (by its program name, from every event form, the Windows command line included) is also refused when it would start without the loader (M-1): the loader not first on `PYTHONPATH`, or the guard's file, log or protected roots missing from its environment. Python started with `-I`, `-E` or `-S` cannot load it and is not required to.
  - `IsolationViolation` is a `BaseException`, so product code that catches `Exception` or `OSError` cannot swallow it. Every refusal is also recorded, and a per-test check fails a test whose code swallowed one anyway. A refusal swallowed outside any single test is reported too (L-2), whether at collection, in a module- or session-scoped fixture, or in a teardown:
    - an autouse session fixture's teardown fails the run with one error, attached to the last test's teardown and saying it belongs to no single test;
    - a `pytest_sessionfinish` backstop fails a run where that fixture never ran (no test ran) with an `ERROR test isolation - …` line and exit status 1;
    - each refusal is reported once, by the first check that sees it.
  - Messages name the operation and "protected BugPilot data root #n", never a path.
- **Python children.** `PYTHONPATH` starts with `<session>/pyguard`, which holds a copy of `tests/isolation_child/sitecustomize.py`. It loads `tests/_isolation.py` from `BUGPILOT_TEST_GUARD_FILE` and protects `BUGPILOT_TEST_GUARD_ROOTS`; refusals go to `BUGPILOT_TEST_GUARD_LOG`, which the per-test check reads. It chains to an interpreter's own `sitecustomize` if one exists. A test that needs its own import path uses `_isolation.child_pythonpath(...)`, which keeps the loader first; replacing `PYTHONPATH` is refused (M-1). The loader tells three cases apart (L-3):
  - **not configured** (neither the guard's file nor its roots given): it does nothing, so an ordinary Python program that finds it on its path runs unchanged;
  - **configured:** the child runs guarded;
  - **configured but broken** (the file missing, failing or not the guard, or no root given): the child fails closed. It writes the reason to stderr and to the guard log, and exits with status 70 before its own code runs. Without this, `site` would report the exception and carry on unguarded.
- **Helpers run as scripts** enter the same isolation in `main()`. Their storage-touching entry points (`task_golden._resolved_inputs`, `boundary_golden.render_all`, `Workspace`, `measure_performance`, `storage_baseline.Session`) call `require_isolated()` and refuse otherwise.
- **The TypeScript integration suite** isolates its process once, at module load, the same way, and its children get the same `sitecustomize`. It hands every `Runner`, and `discoverExecutable` (M-2), a spawn that throws before starting a child whose environment has no home, aims its BugPilot data at the real folder, carries a real Jira, mail or Graph value under one of those names, or starts Python without the guard first on `PYTHONPATH`. The one direct `execFileSync` of Python goes through the same check; its `git` calls are a stated exception, isolated by the environment only; and the suite's last test asserts that no Python child was refused. Production `Runner` and `src/` are unchanged: the `SpawnFn` constructor parameter already existed for tests.

**How isolation was verified** (not just configured): `tests/test_isolation_guard.py`, 26 tests (14 as first built, 4 from the review remediation, 8 from the final security remediation), against a decoy whose `.bugpilot` holds canaries (a fake token, instructions, a task file).

- **In-process:** 12 write operations and 9 read operations, the 0.1.5 writers and readers among them (`save_user_config`, `save_jira_site`, `save_instructions("user")`, `load_user_config`, `read_instructions("user")`), are each refused before they happen.
- **A Python child and its own child:** 11 operations refused, including a grandchild pointed at the decoy (refused at `Popen`), and a grandchild reading the decoy (refused by its own inherited guard).
- **Decoy integrity:** every decoy file byte-identical, with an unchanged mtime, checked by the unguarded parent. No canary in any output or message; no decoy path in any message.
- **Refused children:** a child with no home, and a child pointed at a protected root or started inside one, are refused before they start.
- **Python children without the loader** (M-1): 9 launches refused before they start — `PYTHONPATH` replaced, removed, or with the loader not first; the guard's file removed or replaced; its log removed; its roots removed or replaced; and an inherited environment without the loader. No child ran (each would have created a marker file). A child given `child_pythonpath`, `-I`, `-E` and `-S` children, and `git` start. Every process-event form is read for its program, driven directly so nothing starts.
- **A swallowed refusal** is still recorded.
- **Windows-native copies and junctions** (N-1): these are each refused before they happen:
  - `shutil.copy2`, `shutil.copy`, `Path.copy` and `Path.copy_into`, into and out of the decoy;
  - a junction pointing into the decoy, and one placed inside it.

  On Windows the refusal names `_winapi.CopyFile2` or `_winapi.CreateJunction`: the new events are what refuse them. The same operations inside the test's own folder work, and the decoy is unchanged. The `Path.copy` test needs Python 3.14 and the junction test needs Windows; elsewhere they skip with that reason.
- **Refusals outside any test** (L-2): three whole pytest sessions run in Python children with the suite's own conftest, against the decoy.
  - Refusals swallowed at collection and in a module-scoped fixture fail the session: one error, exit status 1, an `ERROR` line for CI's annotations.
  - A refusal a test swallows is reported once, by that test.
  - With every test deselected, the end-of-session backstop fails the run (status 1, not 5).
  - A refusal collected once is not collected again.
- **The loader fails closed** (L-3): run from a launcher without a guard, every child whose guard is configured but broken stops with status 70 before its own code runs, with the reason on stderr and in the log. The broken cases are:
  - the guard's file missing;
  - the file failing to load;
  - the file not being the guard;
  - the file not given;
  - no root given.

  A child with no guard configured runs unchanged, and a configured child runs guarded.
- **Each new test bites:** each fix was reverted in a scratch copy of the files, and the tests covering it failed:
  - N-1: 3 of 3;
  - L-2: the session-level tests with the session check removed, and the once-only tests with report-marking removed;
  - L-3: 1 of 1.
- **Ran isolated:** collection-time code, module-scoped fixtures and each test, all inside the session.
- **Variables:** no Jira or mail variable survives.
- **The guard's own wiring:** installed; the session copy of `sitecustomize` equals the template; a helper refuses to run outside isolation.
- **The TypeScript side:** `test/integrationIsolation.test.ts`, 9 tests: 8 with a fake spawn (refusals happen before spawning, real credentials are refused only under Jira-type names, the guard is required first on `PYTHONPATH`), and one that reads the integration suite's sources (M-2): of the 33 modules it loads at run time only `src/runner.ts` starts a process, none builds the production `trustedRunner`, every `Runner` and every `discoverExecutable` call gets the isolation's spawn, and every `execFileSync` is checked or is `git`. The integration suite (21 tests) passes with the isolation active, and its final test confirms that no Python child was refused.

**Event coverage and cost.**

- **Verified on 3.14.6 here:** the events the demonstrations exercise, `open` (read and write), `os.listdir`, `os.scandir`, `glob.glob`, `os.mkdir`, `os.rename`/`replace`, `os.remove`, `shutil.rmtree`, `shutil.copyfile`, `os.utime` and `subprocess.Popen` fire and are refused, and so do `_winapi.CopyFile2` and `_winapi.CreateJunction` on Windows.
- **Verified in CI on Python 3.10 and 3.13, Linux, macOS and Windows** (run 38942462918): `test_isolation_guard.py` passed in every `safety-and-baselines` and `full-suite` job. Its only skips were the two with stated reasons: the `Path.copy` test (needs 3.14) everywhere in CI, and the junction test off Windows. Before that run, the 3.10 coverage was inferred.
- **Cost:** a micro-benchmark measured about +18% on 20,000 `open` + `listdir` pairs, and about +12% on 100,000 logging calls (taken during a concurrent suite run, so approximate).

**Limits** (T-S24, T-S25; documented in `tests/_isolation.py`; completed after the pre-commit review and the final diff review, whose L-4 to L-7 are recorded here and not changed):

- **Not an OS sandbox.** These children are isolated by their environment only, never by the guard:
  - non-Python programs (`git`, `rg`, `node`), the integration suite's `git` calls among them;
  - Python started with `-I`, `-E` or `-S`, which ignores `PYTHONPATH` or skips `site` (no test uses them today);
  - Python started through something the check cannot recognize as Python: a shell (`os.system`, `shell=True`), the `py` launcher, or a console script such as an installed `bugpilot`. The integration suite's `discoverExecutable` test runs one when an install is on `PATH`; the guarded spawn checks its environment.
  - a process started without any of the checked events: `multiprocessing` (`_winapi.CreateProcess` on Windows, fork or forkserver on POSIX). No test or product code uses it. A forked child's refusals would also stay in its own memory, since the test process's guard keeps no log.
- **Recognizing Python** (L-4). The Python check recognizes the interpreter by file name: `python`, `python3`, `python3.13`, `pythonw`, with or without `.exe`. It does not recognize:
  - a free-threaded `python3.14t` or a debug `python_d` (these are treated as non-Python);
  - on a hand-written Windows command line, an unquoted program path with a space in it, which is read up to the space. `subprocess` always quotes such a path.

  The TypeScript check matches `python`, `python3`, `python3.13` and `.exe`, and not `pythonw`.
- **The TypeScript check** (L-5) requires the home, the data variables, no real credential, and the loader first on `PYTHONPATH`. Unlike the Python check, it does not require the guard's file, roots and log. Every `Runner` child merges `process.env`, which carries them.
- **The source check** (L-6) in `test/integrationIsolation.test.ts`:
  - it sees `from "node:child_process"` imports, and `new Runner(`, `discoverExecutable(` and `execFileSync(` in the suite file;
  - it would not see a `require`, a dynamic import or a bare `"child_process"` specifier.
- **Run options and the network** (L-7):
  - `--noconftest` (or the same in `PYTEST_ADDOPTS`) skips the root conftest, and with it the isolation, the guard and `no_real_jira`; CI never passes it;
  - there is no network guard. No test makes a real Jira request because none has credentials: isolation removes them, and `no_real_jira` clears them for each test.
- **Native file access without a judged event.** Measured on 3.14.6, these each create a file with no `open` event: `_winapi.CreateFile` and `sqlite3.connect`. Calls through `ctypes` or a compiled extension raise no event either. Product code uses none of them. `_winapi.CopyFile2` and `_winapi.CreateJunction` are judged (N-1).
- **`scripts/check_cli_contract.py`** runs on its own, outside pytest, as a release check. It builds its own disposable home and removes every `BUGPILOT_*` variable, so the pytest guard never covers it; its own environment is its isolation.
- **Path aliases.** The guard compares normalized path strings (`normcase(abspath(...))`), so it does not recognize:
  - a relative path used after the working directory changed through a handle: a `dir_fd=` argument, or `os.fchdir` (the comparison resolves against the working directory, not the handle);
  - an already-open file handle: reads and writes through it carry no path, so only its `open` was checked;
  - a Windows 8.3 short name (`RUNNER~1`) for a protected folder;
  - an extended-length or device prefix (`\\?\C:\…`, `\\.\C:\…`);
  - a symbolic link or junction a test planted inside its own folder, pointing into real data (creating one that points there is refused);
  - a different letter case on a case-insensitive macOS volume (`normcase` folds case only on Windows).
- **Metadata-only operations** (`stat`, `lstat`, `exists`, `access`) raise no audit event, so a metadata probe of a real path is not refused (no content can be read that way).
- **The loader** does nothing where the guard is not configured at all (neither its file nor its roots given). The parent's check (M-1) refuses such a child, but only a child it recognizes as Python. A configured but broken guard fails closed (L-3).
- In Python 3.10, `glob.glob(..., root_dir=)` reports no `root_dir` in its event.

**Deviations from the plan, recorded:**

| Id | Deviation | Why |
| --- | --- | --- |
| D0A-1 | §11.1 item 3 said a child is refused when an explicit environment "lacks `HOME`, `USERPROFILE`, `BUGPILOT_HOME` or `BUGPILOT_CONFIG_DIR`, or points them outside the session root". As built, a child is refused when its environment, given *or inherited*, lacks its platform's home variable, or puts any derived BugPilot data folder (`<home>/.bugpilot`, `BUGPILOT_HOME`, `BUGPILOT_CONFIG_DIR`) in or around a protected root. | The literal rule refused legitimate tests: `test_cli_json.py:445-450` and `scripts/check_cli_contract.py:41-52` build their own disposable homes outside the session folder, and tests that remove `BUGPILOT_CONFIG_DIR` deliberately exercise the default `~/.bugpilot` under an isolated home. The safety property — no child reaches real BugPilot data through its environment — is kept, and is checked for inherited environments too, which the literal rule did not cover. |
| D0A-2 | The child loader is a committed template (`tests/isolation_child/sitecustomize.py`) that both suites copy, not text written by `_isolation.py`. | One copy for Python and TypeScript, which cannot drift apart. It lives in a folder no `sys.path` holds, so it never activates itself. |
| D0A-3 | `tests/test_storage_baseline.py` (new, in `safety-and-baselines`) and `extension/test/integrationIsolation.test.ts` (new, in the required extension job) are not in §14.1.A's file list. `tests/baseline_report.py` also isolates in `main()`. | The baselines needed a regression check, and §14.1.A's per-OS path artifact needed a test to produce it. The TypeScript helper needed a unit test in CI, because the integration suite does not run there. `baseline_report.py` renders the task goldens, so it touches storage too. |
| D0A-4 | Isolation also removes `SMTP_*`, `GRAPH_*`, `BUGPILOT_EMAIL_*`, `BUGPILOT_AUTO_JIRA_COMMENT` and `BUGPILOT_MCP_REPO_ROOT`. | Each reaches a real service or chooses a real folder. |
| D0A-5 | The `subst`-drive observation of §7.3 is not made, locally or in CI. | `subst` assigns a drive letter for the whole user session, a machine-level change outside a test's own folder. It needs an owner decision; the observation records "not observed". |
| D0A-6 | The integration suite's real-credential check matches values only under Jira, mail and Graph names. | Matching a value under any name refused a legitimate child: a developer's email is also the value of unrelated variables. |

**Local verification, as first built** (before the pre-commit review; Windows 11, Python 3.14.6, Node 24.21; `PYTHONPATH` = the repository; no `JIRA_*` in the test processes after isolation). The remediation's own verification follows below.

| Check | Command | Result |
| --- | --- | --- |
| Isolation demonstrations | `python -m pytest tests/test_isolation_guard.py` | **14 passed** |
| Path inventory ratchet | `python -m pytest tests/test_storage_inventory.py` | **4 passed**; counts reconciled with §5.1 |
| Baselines, regenerated twice | `python tests/storage_baseline.py --write`, then `--check` twice | both checks: **baselines match** (byte-identical on Windows; timing and path observation excluded). The records then held Windows path separators, which Linux and macOS would not reproduce: review finding H-1, remediated below |
| Baseline tests | `python -m pytest tests/test_storage_baseline.py` | **5 passed** |
| Release workflow and CI report (CI file parsed, pins, permissions) | `python -m pytest tests/test_release_workflow.py tests/test_ci_report.py` | **80 passed** |
| Publishability, with the new files scanned | `python -m pytest tests/test_publishable.py` | **20 passed**, after two findings in new code were fixed (a dotted `local` read as a host) |
| Full Python suite, first run | `python -X utf8 -m pytest -q -p no:cacheprovider -rfEs` | 3,242 passed, **1 failed** (publishability, above, fixed), 36 skipped (POSIX- and macOS-only), 23 min 32 s |
| Full Python suite, after the fix | same | **3,243 passed, 0 failed**, 36 skipped (the same POSIX- and macOS-only skips), 24 min 35 s |
| Extension typecheck | `npx tsc --noEmit -p .` | clean |
| Extension unit tests | `npm test` | **2,349 passed**, 0 failed (2,341 before + 8 new) |
| The required TypeScript job's files | `node --test test/evidence.test.ts test/hintImprovement.test.ts test/scratchFile.test.ts` | **27 passed** |
| CLI integration suite (synthetic repositories, isolated) | `npm run integration` | **21 passed**, 0 failed (20 existing + the no-refusal check) |
| Python 3.10 syntax | `ast.parse(..., feature_version=(3, 10))` over the 12 new or changed Python files, plus a scan for 3.12-only f-string quoting | parse as 3.10; no 3.12-only form. No 3.10 interpreter here: CI's 3.10 job runs them first |
| Goldens and product files | SHA-256 of `bugpilot/`, `extension/src/`, `extension/media/`, `extension/package.json`, `skills/`, `scripts/`, `pyproject.toml`, `tests/golden/` (0.1.4 frozen sets included), `tests/fixtures/` and the existing `tests/baselines/`, before and after | **identical** (239 files) |
| Protected local files | SHA-256 of `.bugpilot/`, `.ai/`, `.ai_memory/`, `.vscode/` and the historical plan | **identical** |
| Whitespace | `git diff --check`, plus a scan of the new files | clean; the 16 new files: no trailing whitespace, a final newline, one line-ending convention each |

**Not executed:**

- **CI:** no run dispatched, as instructed.
- **POSIX and macOS** runs of the new tests, and the Python 3.10 event coverage: these first ran in CI run 38942462918, all green ("Acceptance and CI evidence", below).
- `scripts/check_cli_contract.py`: a release check that needs a freshly built wheel's executable. No product code changed and nothing was built; the CLI contract is exercised by `test_extension_argv_contract.py` and `test_cli_json.py` in the full suite.
- **Batch 0B probes:** not authorized.

##### Batch 0A — pre-commit review remediation (2026-10-16)

**Authorization.** An independent, read-only pre-commit review recommended FAIL for Batch 0A as it stood: no Critical finding, one High and two Medium. The owner then authorized a narrow remediation of H-1, M-1 and M-2, corrections to this plan, and an explicit regeneration of the affected synthetic baseline. Batch 0B, Batch 1 and all storage work remain unauthorized. Nothing was staged, committed, pushed or dispatched.

| Finding | What was wrong | Fix | Proof |
| --- | --- | --- | --- |
| **H-1** (High) | `pollution.json` recorded path arguments as `str(path)`, so Windows wrote `<input>\review.json` where Linux and macOS write `<input>/review.json`. The comparison is byte-for-byte, so 5 of the 9 required checks would have failed: `safety-and-baselines` on Ubuntu 3.13, macOS 3.13 and Ubuntu 3.10, and `full-suite` on Ubuntu and macOS. | Path-valued arguments stay `Path` objects until they are recorded. `storage_baseline.portable_path()` replaces the temporary root with its label and joins the parts below it with `/`. Other text is normalized as before and keeps any backslash it holds. How the command runs is unchanged. | 3 new tests: Windows- and POSIX-style paths give the same text; a non-path argument keeps its backslash; no compared record has a label followed by `\`. Only `pollution.json` was regenerated (below). |
| **M-1** (Medium) | `test_cli_json.py:135` and `test_mcp_stdio.py:47` replaced `PYTHONPATH` with the repository, so their Python children ran without the loader, isolated by environment only. The parent's check did not require the loader, and this plan said those children were guarded. | `_isolation.child_pythonpath(...)` returns the loader, then the given entries, each once, joined with `os.pathsep`. An entry that holds `os.pathsep` is refused. Both tests and `storage_baseline.Session` use it. The parent's process check now refuses a Python child whose environment, given or inherited, would start it without the guard. Python is recognized by program name from every event form: argument lists, an explicit executable, and the Windows command line. The child is refused when the loader is not first on `PYTHONPATH`, when the guard's file is missing or is not this session's, when its log is missing, or when its protected roots are missing or fewer than this process passes on. Children started with `-I`, `-E` or `-S` are exempt, as are non-Python programs. D0A-1's home rule is unchanged. | 4 new tests: 9 launches refused before they start, with no marker file created; a `child_pythonpath` child, `-I`, `-E` and `-S` children, and `git` all start; 15 event forms read correctly; the helper's ordering and refusal. One existing test changed: its child's protected roots are now the decoy plus the session's roots, because a child may protect more than its parent, never less. |
| **M-2** (Medium) | `cli.integration.test.ts` called `discoverExecutable` without a spawn, so the `Runner` it builds used Node's own `spawn`, unchecked and isolated by environment only. This plan said every CLI child went through the guarded spawn. | The test passes `spawn` through the existing `DiscoverOptions.spawn`. It is a wrapper that records each start and calls `ISOLATION.spawn`, and the test asserts it was used whenever an install is found. Production `discoverExecutable` is unchanged. A new unit test in the required extension job reads the suite's sources and checks: of the 33 modules the suite loads at run time, only `src/runner.ts` starts a process and none builds `trustedRunner`; every `Runner` and `discoverExecutable` call gets the isolation's spawn; every `execFileSync` is either checked or `git`, a stated exception. | The integration suite: 21 passed. No `bugpilot` is on `PATH` in this environment, so the discovery test took its "not found" branch, and the guarded start of an installed CLI was not exercised end to end here. The source check catches each of 4 deliberate mutations, run on copies outside the repository: the spawn removed from the discovery call; a `Runner` with the default spawn; an unchecked Python `execFileSync`; `spawn` imported from `child_process`. |

**The regenerated baseline.** Only `tests/baselines/0.1.6-batch0/pollution.json` was regenerated.

- The compared records were generated into a scratch folder inside the isolation (`generate(..., timing=False)`).
- `handoff.json`, `cli_paths.json` and `task_size.json` came out byte-identical to the existing ones; `pollution.json` was copied in.
- A value-by-value comparison found exactly seven differences, all of them `command` strings, each changed only from `\` to `/`. For example, `bugpilot record-review JR-12345 --from-file <input>\review.json --json` became `… <input>/review.json …`. The same change applies to `checks.json`, `project.md`, `verification.md`, `behavior.md`, `settings.json` and `user.md`.
- `prepare_timing.json` and `realpath_windows.json` were not regenerated, so their machine-dependent values are unchanged.
- `--check` then ran twice: **baselines match** both times.

**Plan corrections.**

- **`subst`:** marked NOT VERIFIED wherever it appears: §1, §7.2, the §7.3 table and its observation, §11.3's platform tests, this batch's outputs, Batch 1's cross-platform gate (§14.2), and RK-7 (§16.2). Its test is deferred pending separate owner approval (D0A-5).
- **§11.1 item 3:**
  - `scripts/check_cli_contract.py` is no longer listed as guarded: it runs outside pytest;
  - the loader rule is added;
  - the full list of children isolated by environment only is given.
- **§11.1 item 4:** the TypeScript spawn coverage as built.
- **§10.2 T-S24 and T-S25:** the limitations are completed.
- **This section:**
  - the guard's limits are completed, path aliases included;
  - the files, design and verification statements are corrected;
  - the first verification table is marked as the first build's.
- **§18 and §19:** updated.

**Remediation verification** (Windows 11, Python 3.14.6, Node 24.21; `PYTHONPATH` = the repository):

| Check | Command | Result |
| --- | --- | --- |
| H-1 and M-1 tests | `python -m pytest tests/test_isolation_guard.py tests/test_storage_baseline.py`, the full-regeneration test excluded | **24 passed** |
| Baselines | `python tests/storage_baseline.py --check`, twice | **baselines match**, both times |
| Focused suites | `python -m pytest` over `test_isolation_guard.py` (18), `test_storage_baseline.py` (8), `test_storage_inventory.py` (4), `test_cli_json.py` (46), `test_mcp_stdio.py` (5), `test_publishable.py` (20), `test_release_workflow.py` (73), `test_ci_report.py` (7) | **181 passed** |
| Full Python suite | `python -X utf8 -m pytest -q -p no:cacheprovider -rfEs` | **3,250 passed, 0 failed**, 36 skipped (the same POSIX- and macOS-only skips), 24 min 9 s. That is 3,243 before, plus the 7 new tests |
| Extension typecheck | `npx tsc --noEmit -p .` | clean |
| Extension unit tests | `npm test` | **2,350 passed**, 0 failed (2,349 + the source check) |
| The required TypeScript job's files | `node --test test/evidence.test.ts test/hintImprovement.test.ts test/scratchFile.test.ts` | **27 passed** |
| CLI integration suite | `npm run integration` | **21 passed**, 0 failed; the final no-refusal test passed |
| Publishability, after the plan edits | `python -m pytest tests/test_publishable.py` | **20 passed** |
| Python 3.10 syntax | `ast.parse(..., feature_version=(3, 10))` over the 7 changed Python files | all parse |
| Goldens and product files | the 239-file SHA-256 record from the first build | **identical** |
| Protected local files | `.bugpilot/`, `.ai/`, `.ai_memory/`, `.vscode/`, the historical plan | **identical** |
| The other baseline records | SHA-256 before and after | only `pollution.json` changed |
| Version | `bugpilot/__init__.py`, `extension/package.json` | 0.1.5 |
| Whitespace | `git diff --check`, plus a scan of the new and changed files | clean: no trailing whitespace, a final newline and one line-ending convention in each |

**Not executed:**

- CI;
- POSIX, macOS and Python 3.10 runs: the H-1 fix is shown by tests with both path styles, but its byte-identical result on Linux and macOS is first observed in CI. It was, in run 38942462918: the compared baselines matched on every system;
- `scripts/check_cli_contract.py`;
- the guarded start of an installed `bugpilot`, since none is on `PATH` here;
- Batch 0B probes.

##### Batch 0A — final security remediation (2026-10-16)

**Authorization.** The independent final diff review recommended PASS WITH CONDITIONS:
- H-1, M-1 and M-2 were complete;
- one new Medium (N-1) was found, along with Low findings L-1 to L-8.

The owner authorized a final, narrow remediation of N-1, L-1, L-2, L-3 and L-8. Only test infrastructure, its tests and this plan could change. L-4 to L-7 stay as documented limitations (§14.1.A "Limits"). Nothing was staged, committed, pushed or dispatched.

| Finding | What was wrong | Fix | Proof |
| --- | --- | --- | --- |
| **N-1** (Medium) | On Windows with Python 3.12 and later, `shutil.copy2`, `Path.copy` and `Path.copy_into` copy through `_winapi.CopyFile2`, an event the guard did not judge. A scratch experiment against a guarded decoy copied into and out of it unrefused. `_winapi.CreateJunction` was not judged either. | The event arguments were measured on 3.14.6 before any handler was added: `CopyFile2` carries (source, destination, flags), and `CreateJunction` carries (target, junction). Both events are now judged at positions 0 and 1, so neither end may be protected. Nothing else was blocked: copies and junctions inside a test's own folder work. | 3 new tests: copies (all platforms; on Windows the refusal names `_winapi.CopyFile2`), `Path.copy` and `Path.copy_into` (3.14+), and junctions (Windows). With the two entries removed in a scratch copy, all 3 fail. |
| **L-1** (Low) | The module comments of `tests/_isolation.py` and `extension/test-integration/isolation.ts` said agent variables were removed; they are not. | The comments now name exactly what is removed, and say agent-command variables are kept. Sanitization is unchanged. | Read against `SANITIZED_PREFIXES` and `SANITIZED_NAMES` in both files. |
| **L-2** (Low) | A refusal swallowed outside a test function (at collection, in a module- or session-scoped fixture, or in a teardown) reached no check. | `_isolation.collect_since()` and `collect_unreported()` mark each refusal reported once. Three checks share them: the per-test check; an autouse session fixture whose teardown fails the run with one error that says it belongs to no single test; and a `pytest_sessionfinish` backstop for a run where that fixture never ran (exit status 1, plus an `ERROR test isolation - …` line, which CI's annotations read). | 4 new tests: three nested pytest sessions run with the suite's own conftest against the decoy, plus a report-once test. With the session check removed, the two session-level tests fail; with report-marking removed, the two once-only tests fail. |
| **L-3** (Low) | If the guard could not be loaded, `site` reported the exception and the child ran on unguarded. | The loader tells three cases apart. Not configured (neither the file nor the roots given): it does nothing. Configured: the child runs guarded. Configured but broken: the child writes the reason to stderr and the guard log, then exits with status 70 before its own code runs. | 1 new test of 7 cases, run in disposable children from a launcher without a guard: 5 broken configurations exit 70, run none of their code and log one line each; the unconfigured and configured children run. With the old loader restored in a scratch copy, it fails. |
| **L-8** (Low) | D0A-1 cited `test_cli_json.py:442-447`; the M-1 edits had moved those lines. | Now cites `445-450`. | — |

**Remediation verification** (Windows 11, Python 3.14.6, Node 24.21):

| Check | Command | Result |
| --- | --- | --- |
| The guard's tests | `python -m pytest tests/test_isolation_guard.py` | **26 passed**, 0 skipped here (Windows, 3.14: every conditional case ran) |
| Focused suites | `python -m pytest` over the guard (26), `test_storage_inventory.py` (4), `test_storage_baseline.py` (8), `test_cli_json.py` (46), `test_mcp_stdio.py` (5), `test_publishable.py` (20), `test_release_workflow.py` (73), `test_ci_report.py` (7) | **189 passed** |
| Full Python suite | `python -X utf8 -m pytest -q -p no:cacheprovider -rfEs`, writing no bytecode | **3,258 passed, 0 failed**, 36 skipped (the same POSIX- and macOS-only skips), 20 min 48 s: 3,250 before, plus the 8 new tests. The new session-wide check reported nothing: no refusal anywhere in the suite was swallowed outside a test |
| Extension typecheck | `tsc --noEmit -p .` | clean |
| Extension unit tests | `npm test` | **2,350 passed**, 0 failed |
| The required TypeScript job's files | `node --test test/evidence.test.ts test/hintImprovement.test.ts test/scratchFile.test.ts` | **27 passed** |
| CLI integration suite (the new loader in every Python child) | `npm run integration` | **21 passed**; the final no-refusal test passed |
| Baselines | `python tests/storage_baseline.py --check`, twice | **baselines match**, both times; the records unchanged |
| Publishability, after the plan edits | `python -m pytest tests/test_publishable.py` | **20 passed** |
| Goldens, product files, fixtures, existing baselines, packaging configuration | `git diff HEAD` over them, and the 239-file SHA-256 record | **unchanged** |
| Protected local files and the historical plan | SHA-256 record | **identical** |
| Version | `bugpilot/__init__.py`, `extension/package.json` | 0.1.5 |

**Not executed:**
- CI;
- POSIX, macOS and Python 3.10 runs (the `Path.copy` and junction tests skip there, with their reasons). These later ran in CI run 38942462918, all green;
- `scripts/check_cli_contract.py`;
- the guarded start of an installed `bugpilot`, since none is on `PATH` here;
- Batch 0B probes.

##### Batch 0A — acceptance and CI evidence (2026-10-16)

**Status: COMPLETED.** The owner accepted Batch 0A.
- **Commit:** `8b6c567a074e4ddef6490ccc837e817cf7f48866`, `test: isolate BugPilot storage and record 0.1.5 baselines`. It holds exactly the 26-file allowlist. Author and committer use the noreply identity.
- **Push:** a fast-forward `ee3fb00..8b6c567` to `main`; nothing forced, tagged or published.
- **CI:** workflow `CI` (`.github/workflows/ci.yml`), run 38942462918, triggered by that push (no dispatch; the only run for the commit). Conclusion: success.

**The nine required checks** (counts from the jobs' published annotations; each Python job also deselects the one test that needs the private word list):

| Check | Result |
| --- | --- |
| Safety and baselines (ubuntu-latest, Python 3.13) | success: 1,319 passed, 23 skipped, 1 deselected |
| Safety and baselines (ubuntu-latest, Python 3.10) | success: 1,319 passed, 23 skipped, 1 deselected |
| Safety and baselines (macos-latest, Python 3.13) | success: 1,321 passed, 21 skipped, 1 deselected |
| Safety and baselines (windows-latest, Python 3.13) | success: 1,304 passed, 38 skipped, 1 deselected |
| Extension evidence boundary (ubuntu-latest) | success: 27 passed |
| Full Python suite (ubuntu-latest) | success: 3,264 passed, 29 skipped, 1 deselected (4 min 16 s) |
| Full Python suite (macos-latest) | success: 3,266 passed, 27 skipped, 1 deselected (6 min 43 s) |
| Full Python suite (windows-latest) | success: 3,255 passed, 38 skipped, 1 deselected (16 min 49 s) |
| Extension unit tests (ubuntu-latest) | success: 2,348 passed, 2 skipped |

**Acceptance (§14.1.A, item 6):**

| Criterion | Evidence | Met |
| --- | --- | --- |
| The full Python and extension suites green, on Windows locally and on the three systems in CI; all nine checks green; counts recorded | Locally on Windows: 3,258 passed, 36 skipped; extension 2,350. In CI: the table above | yes |
| Isolation demonstrated, not configured: `test_isolation_guard.py` passes on every CI configuration | It ran in all four `safety-and-baselines` jobs and all three `full-suite` jobs. Its only skips there were stated ones: the `Path.copy` test (needs 3.14) everywhere, and the junction test off Windows. On Windows 3.13 the copy refusals went through `_winapi.CopyFile2`. Its demonstrations check the decoy's integrity, the absence of canaries, Python grandchildren, and the session-wide check | yes |
| A full local run passes with the guard active; any refusal fixed by isolating the test, never by narrowing the guard | Local full runs green. Tests were fixed (`child_pythonpath`, M-1); the guard only gained coverage (M-1, N-1, L-2, L-3). The one rule refinement, D0A-1, is recorded as a deviation | yes |
| The inventory equals §5, or §5 is corrected | Reconciled exactly with §5.1; the ratchet passed in every CI job | yes |
| Baselines recorded and reproducible | `--check` matched twice locally. The byte-for-byte comparison passed in CI on Linux (3.10 and 3.13), macOS and Windows, which confirms H-1 | yes |
| The record holds the guard's event list, where it ran, and its stated limits | The event list and limits are in "Batch 0A — as built" above; where it ran is recorded here, in §18 and in §19 | yes |

**Findings.** CI produced no new findings:
- no test failed;
- every annotation was notice-level: summaries, skips and platform observations;
- no Critical, High or Medium finding is open.

GitHub posted two notices about the runners themselves: the `ubuntu-latest` label moves to Ubuntu 26 from 2026-10-19, and macOS arm64 jobs may queue longer.

**Platform observations:** §7.3, "Batch 0A CI observation".

**Still not verified:**
- a `subst` drive (D0A-5);
- mapped network drives and NFC/NFD spellings;
- the guarded start of an installed `bugpilot`. None was on `PATH` locally, and the integration suite does not run in CI;
- the `Path.copy` test outside Windows with Python 3.14, and the junction test off Windows;
- `scripts/check_cli_contract.py`, which needs a built wheel;
- every live agent behaviour (Batch 0B, NOT STARTED).

The guard's documented limits ("Limits", above) are unchanged.

**Version:** 0.1.5, unchanged. **Decisions:** US-D32 and US-D33 remain APPROVED, and no other decision changed.

#### 14.1.B Batch 0B — Live agent capability probes

**1. Scope.** Probes P1–P11 (§9.7), where each applies and is available.

**2. Files.** None in the repository, apart from this plan's §18 records. Transcripts and screenshots are stored outside the repository, and are never committed if they show personal data.

**3. Preconditions.**

- The owner separately approves Batch 0B, naming the agents, versions and accounts that may be used.
- Batch 0A is not required.

**4. Explicit exclusions.**

- no real Jira, real work repository, real issue text, developer configuration or real credentials;
- no change to any agent's sandbox or permission settings;
- no `--add-dir` or other grant;
- no product change.

**5. Steps.**

1. Build the probe kit (§9.7): a synthetic repository, a synthetic external work folder and a disposable data folder.
2. Run each approved probe, recording every §9.7 field.
3. Record the outcomes in §18 as PASS, FAIL or UNKNOWN. **A probe that was not run, was unavailable or was inconclusive is UNKNOWN, never passed.**
4. Update §9.2's rows from observation, marking each as observed, with agent and version.
5. Write each decision's evidence summary into §16.1 (US-D10, US-D12, US-D13, US-D17, US-D27, US-D28). The owner decides; a probe result does not decide on its own.

**6. Acceptance.**

- Every approved probe is recorded with its fields.
- Every probe that was not run is listed as UNKNOWN, with the reason.
- No outcome is inferred from documentation.

**7–9.** Not applicable: there is no code, and the platforms are those the probes ran on, as recorded.

**10. Rollback.** None needed: nothing is installed or changed. The disposable folders are deleted after recording.

**11. Dependencies.** None. It may run before, during or after Batch 0A and Batch 1.

**12. Stop and approval gate.**

- **Stop if:** a probe would need a real account, repository or configuration not covered by the approval; a probe shows that Option A cannot work for an agent the owner considers supported (US-D10 returns to the owner with the evidence).
- **Gate:** the owner decides US-D10 and US-D28 from the evidence, and US-D12's direct-launch question if P11 ran. **A storage-changing Batch 2 does not begin while US-D10, US-D14 or US-D28 is still OPEN** (§14.3). *(US-D28, US-D14 and US-D10 were approved with conditions on 2026-10-18: §16.5.11, §16.4.1 and §9.5.1. US-D10's approval is a design approval with the probe gap accepted for design only.)*

##### Batch 0B — probe P10, narrowed (as run, 2026-10-18)

**Outcome: UNKNOWN overall.** The VS Code `sendText` path, which is P10's essential one, was not exercised. *(It was completed later the same day, and P10 is now PASS for the tested Windows configuration: see "Batch 0B — probe P10, VS Code sendText completion" below.)*
- Direct shells: **20 of 20 PASS**.
- The Python launcher through a `.cmd` shim: **5 of 5 PASS**.

No real agent, account, credential or real repository was used. No decision changed.

**Authorization and scope.** The owner's narrowed P10 brief of 2026-10-18 limited the probe to:
- prompts BugPilot's own filter accepts, sent through BugPilot's own command construction to inert argument recorders;
- two refused strings, checked against the filter only and never sent to a shell.

An earlier, broader P10 attempt that day was stopped before anything was created or run.

**The code exercised, and what differs from the readiness assumptions:**
- **Where the code is:** the filter and command line live in `extension/src/app/agents.ts` (the brief said `extension/src/agents.ts`). The Python launcher is `bugpilot/core/agent_runner.py`.
- **The filter** is `PLAIN_PROMPT = /^\s*[A-Za-z0-9#][A-Za-z0-9\s.,:#/_-]*$/`. Because `\s` admits newlines and tabs, a multi-line prompt is accepted. The terminal command line is then `` `${command} ${JSON.stringify(flatten(prompt))}` ``, where `flatten` collapses every whitespace run to one space and trims. So the transmitted argument is the flattened prompt, by design, and every comparison was made against that.
- **The Python launcher has no prompt filter** in 0.1.5. It sends the fixed `handoff_prompt(<id>)` sentence, with the default `--permission-mode acceptEdits` arguments, and runs a `.cmd` shim as `[cmd.exe, /c, <shim>, …]`. This matches the plan: T-S12 adds the filter in 0.1.6.

**Environment** (Windows 11 10.0.26300, run by Claude Code at the owner's instruction):

| Shell | Version | Started as | Shim it resolved |
| --- | --- | --- | --- |
| PowerShell 7 | 7.6.6 | `pwsh -NoProfile -NoLogo -NonInteractive -Command -` | `agentstub.ps1` |
| Windows PowerShell | 5.1.26100.9711 | `powershell -NoProfile -NoLogo -NonInteractive -Command -` | `agentstub.ps1` |
| cmd | 10.0.26300.9711 | `cmd /d` (AutoRun off) | `agentstub.cmd` |
| Git Bash | 5.3.15(2) | `bash --noprofile --norc -s` | the sh `agentstub` |

- **How the shells were fed:** each received BugPilot's command line as one input line on stdin, as a typed line would be. The execution policy is RemoteSigned, so local `.ps1` shims run.
- **Environment:** stripped down. Home, app-data and temp folders all pointed into the kit, Git's global configuration was an empty kit file, and no tokens were inherited.
- **Safety check before running:** `claude`, `codex` and `copilot` did not resolve on the probe's PATH; `agentstub` resolved only inside the kit.

**The stand-ins.** `agentstub.cmd`, `agentstub.ps1` and the sh `agentstub` are modelled line for line on npm's generated `claude` shims, calling `standins/recorder.py` instead of an agent. The recorder writes its argv and its raw command line into the kit, and nothing else.
- **The command lines** came from BugPilot's own code: the real `claude-cli` definition, `cliAgent(...).run()`, with only the command name changed to `agentstub` (Node 24, `standins/construct.mjs`).
- **The Python runs** used the real `run_agent()`, with an explicit `AppConfig` naming the stand-in, so no user configuration was read.

**Cases** (synthetic; the kit root is `C:/bp-0b/run-p10/`):

| Case | Prompt | Filter | Through the 4 shells | Through the Python launcher |
| --- | --- | --- | --- | --- |
| A1 | `Read .ai/JR-12345/task.md and complete the workflow.` | accepted | PASS ×4 | PASS |
| A2 | the same with extra leading, inner and trailing spaces | accepted, flattened | PASS ×4 | PASS (sent unflattened, received exactly) |
| A3 | `Read C:/bp-0b/run-p10/you two/work/JR-12345/task.md and complete the workflow.` (absolute path with a space) | accepted | PASS ×4 | PASS |
| A4 | A3 split by a newline and a tab | accepted, flattened to A3 | PASS ×4 | not applicable: the Python path has no flattening, and never receives multi-line text today |
| A5 | `#Review: C:/bp-0b/run-p10/you two/work/JR-12345/fix_report.md, context.md - done_now.` (`# : , - _`) | accepted | PASS ×4 | PASS |
| H0 | `handoff_prompt("JR-12345")`, the Python launcher's own prompt | — | — | PASS |
| R1 | a backslash Windows path | **refused** (`failed`, nothing launched) | not sent | not sent |
| R2 | a prompt starting with `-p` | **refused** | not sent | not sent |

**What PASS means here:**
- The recorder ran exactly once, and its argv equalled the intended argument sequence: `[flatten(prompt)]` for the shells, and `[--permission-mode, acceptEdits, prompt]` for the Python launcher.
- The shell exited 0.
- No unexpected record was written, and no new path appeared outside the kit's `evidence`, `home` and `tmp` folders.

The only error output was `run_agent`'s expected deprecation note. Git Bash's path conversion left every argument untouched, and so did PowerShell's native argument passing.

**Evidence** (outside the repository, kept for review, never committed): `C:/bp-0b/run-p10/evidence/`, holding `command_lines.json`, `results.json` and 25 records in `received/`. Raw command lines have the Python install folder replaced by `<python-dir>`.

**Isolation, verified after the run:**
- the repository is unchanged, and the 11 protected local files are hash-identical;
- no `__pycache__` appeared in it;
- the PowerShell and Bash history files are untouched;
- PowerShell's startup cache was written into the kit's home, which shows the redirection held.

The real `~/.codex` folder changed during the day, but not because of the probe. It is written continuously by Codex processes that the developer's VS Code and the ChatGPT desktop app had started long before the kit existed. Two of its writes predate the kit, the last came after the probe had finished, and Codex never resolved on the probe's PATH. This is one more reason a Codex probe must use its own `CODEX_HOME`. A Codex Windows sandbox service is installed and running, which is relevant to P4.

**Limits and missing evidence:**
- **VS Code `sendText`: UNKNOWN.** No harness was built, by instruction. The terminal layer, shell integration and PSReadLine were not exercised. The direct-shell results do not prove the VS Code integration.
- **Not an interactive console:** the shells read stdin. It is the same parser as a typed line, but with no line editor and no developer profile; a profile that redefines commands was not tested.
- **Windows only.** macOS and Linux were not run.
- **No real agent executable:** only shims, so native-executable argument handling remains P11's question.
- **Only filter-accepted characters,** by design. Nothing outside the gate was sent.
- **Not exercised:** the `--session-id <uuid>` command shape (no flag probe was offered) and the Codex command (`cliAgent` builds it the same way).

**What it means for the decisions** (evidence only; nothing approved):
- **US-D12:** for the four Windows shells and the Python launcher, the filter-accepted class, including an absolute forward-slash path with a space and a leading `#`, reaches the program intact. That supports keeping the gate as it is for these paths. It says nothing about characters outside the gate, VS Code's terminal layer, other systems or direct launch (P11).
- **US-D10:** the 0.1.6 handoff prompt shape (an absolute work-folder path, here with a space) survives every shell and the Python launcher, which removes one transport concern for Option A's terminal launch (A6). A6 stays UNKNOWN until the VS Code `sendText` path is observed, and Option A still depends on the agents' own behaviour (P1, P3).
- **T-S12:** the Python launcher passes these prompts intact through `cmd /c` and a `.cmd` shim today. The 0.1.6 filter is still to be added.

**Kit and cleanup.** The kit `C:/bp-0b/run-p10/` is left in place for review: the evidence, the stand-ins and the synthetic files, plus `home/` and `tmp/`, which hold only PowerShell's startup cache and an empty Git configuration. It was created by this probe; deleting `C:/bp-0b/` removes all of it.

##### Batch 0B — probe P7, attempted (2026-10-18)

**Outcome: UNKNOWN. No P7 test ran.** The disposable VS Code instance would not start, because an update of the developer's own VS Code was being installed at the time. Every case, P7-A to P7-H, is UNKNOWN.

**Authorization and design.** The owner's P7 brief of 2026-10-18 covers VS Code extension APIs on synthetic files outside the workspace:

| Case | API | What it checks |
| --- | --- | --- |
| P7-A | `workspace.fs.readFile` | reading an external file |
| P7-B | `workspace.fs.writeFile` | writing it |
| P7-C | `workspace.openTextDocument` | opening it as a document |
| P7-D | `window.showTextDocument` | showing it in an editor |
| P7-E | `createFileSystemWatcher(new RelativePattern(Uri.file(<outside>), "*"))` | create, modify and delete events, plus an atomic temp-and-rename replace like the CLI's |
| P7-F | `TextEditor.edit`, `TextDocument.save`, `onDidSaveTextDocument` | saving through the editor |
| P7-G | the same | a folder and file names with spaces |
| P7-H | `workspaceFolders`, `getWorkspaceFolder`, `asRelativePath` | the workspace boundary |

- **The harness:** a minimal plain-JavaScript probe extension loaded with `--extensionDevelopmentPath`, so no tool was installed and nothing was downloaded. Readiness waits and event waits are bounded at 10 s, and a missing event is never PASS.
- **Launched as:** the installed `Code.exe` with its own `--user-data-dir` and an empty `--extensions-dir`, inside the kit. Telemetry, updates, experiments, Git, AI features and workspace trust were off, and Settings Sync was never enabled (a fresh profile with no account). The environment was stripped down, with its home, app-data and temp folders inside the kit.
- §9.7's `revealFileInOS` on a folder was not part of the brief; it would open the operating system's file explorer.

**What happened.**
- VS Code 1.140.0 started at 13:49:03, created its profile in the kit, and exited with code 1 at 13:49:36, before its log files or the extension host were written. The probe extension never ran, and no results file was written.
- **Cause, confirmed read-only:**
  - the installer for VS Code 1.142.0 (`CodeSetup-stable-6d62b1d5…`) was running and holding the `vscodesetup` and `vscode-updating` mutexes;
  - the installed build uses versioned updates (`win32VersionedUpdate`) and refuses to start a new instance while that setup mutex is held.
- A "being updated" message may have been shown on screen.
- Per the stop rule set before the launch, there was no retry, and the staged 1.142.0 build was not launched, since that could disturb the update.

**Isolation, verified.**
- **This repository:** unchanged apart from this plan; the 11 protected local files are hash-identical.
- **The P10 kit:** digest unchanged.
- **The external synthetic files:** untouched, with their original content and timestamps.
- **The developer's VS Code:** the real `~/.vscode/argv.json` is unchanged since 2026-10-07; the disposable instance wrote its own inside the kit. The real extensions folder's listing is unchanged.
- **Leftovers:** no process of the disposable instance remained; none had to be stopped.

**Kit.** `C:/bp-0b/run-p7/` holds `repo/`, `external work/JR-12345/{task.md,context.md}` and `external work/spaced dir/notes file.md`, plus `user-data/` (the disposable profile), the empty `extensions/`, `harness/` (`package.json`, `extension.js`, `run_p7.py`) and `evidence/p7-run.json`. It is kept, so P7 can be rerun as it is once no VS Code update is in progress, for example after the developer's VS Code has restarted into 1.142.0.

**Decisions.** US-D17 and Batch 3 gain no evidence; nothing is approved. *(Retried after the update the same day: see "Batch 0B — probe P7, retry" below.)*

##### Batch 0B — probe P7, retry after the VS Code update (2026-10-18)

**Outcome, Windows only:**
- **P7-A to P7-H: PASS, 17 of 17 checks.** The VS Code APIs read, wrote, opened, showed, watched and saved synthetic files outside the workspace, including paths with spaces.
- **`revealFileInOS`: UNKNOWN.** It opened the file manager at the right place, but whether the folder was selected is unconfirmed.

No real agent, account, network service or real data was used. Nothing is approved.

**Run.**
- **Authorization:** the owner's P7 retry brief, issued once the update had completed.
- **Update state, checked first, read-only:**
  - the 1.142.0 installer had exited, and the `vscodesetup` and `vscode-updating` locks were released;
  - the installed `Code.exe` was 1.142.0, `new_Code.exe` and `updating_version` were gone, and the developer's VS Code had restarted.
- **Reused** as they were: the first attempt's kit, isolated profile, synthetic repository, external files and probe extension.
- **Two harness corrections,** with the originals kept in `evidence/attempt1-harness/`:
  - the evidence files are named `-retry1` and refuse to overwrite, so the first attempt's `p7-run.json` is preserved;
  - a P7-I step for `revealFileInOS` was added, with its operating-system side checked outside VS Code.
- **Environment:** VS Code 1.142.0 (Electron 43.7.7), Windows 11 Enterprise 10.0.26300; the `bp-p7-probe` extension 0.0.1, loaded with `--extensionDevelopmentPath`; profile `C:/bp-0b/run-p7/user-data`, extensions `C:/bp-0b/run-p7/extensions` (empty); the only workspace folder is `C:/bp-0b/run-p7/repo`.
- **Timing:** the window wrote its results 31 s after launch and closed itself; nothing had to be stopped.

**Results** (`evidence/p7-results-retry1.json`; every check is VS Code API evidence, with Node `fs` used only as a second reading of the bytes):

| Case | API | Observed | Result |
| --- | --- | --- | --- |
| P7-A | `workspace.fs.readFile` on `external work/JR-12345/task.md` | the bytes on disk (SHA-256 equal) | PASS |
| P7-B | `workspace.fs.writeFile` on `context.md` | the written bytes, read back by the API and by Node | PASS |
| P7-C | `workspace.openTextDocument` | not untitled, `markdown`, text equal to the file | PASS |
| P7-D | `window.showTextDocument` | an editor showing it, and the active one | PASS |
| P7-E | `createFileSystemWatcher(new RelativePattern(Uri.file(<external folder>), "*"))` | create, modify, delete and a temp-and-rename replace, each reported (below) | PASS ×4 |
| P7-F | `TextEditor.edit`, `TextDocument.save`, `onDidSaveTextDocument` | the edit applied; dirty, then `save()` true; the save event 46 ms after; clean; the bytes on disk equal the edited text (LF) | PASS |
| P7-G | read, open, write and watcher in `external work/spaced dir/` (`notes file.md`, `written file.md`, `watched file.txt`) | as P7-A, C, B and E | PASS ×6 |
| P7-H | `workspaceFolders`, `getWorkspaceFolder`, `asRelativePath` | the only workspace folder is the synthetic repo; external files belong to no workspace folder, and `asRelativePath` returns them as absolute paths | PASS |
| P7-I | `commands.executeCommand('revealFileInOS', Uri.file(<external folder>))` | the command returned without an error; a new Explorer window opened at the folder's parent, `external work`, which is how Windows reveals an item; its selection read back empty when it was read, right after the window appeared | **UNKNOWN** |

On P7-I, the harness's automatic rule wrote FAIL in `p7-run-retry1.json`, because no selection was read. It is recorded here as UNKNOWN: the location is right, and the selection was read once, possibly before Explorer applied it. It is not equated with `showTextDocument`. The Explorer window was closed by its handle, and no other window was read beyond its handle.

**The file watcher, observed** (Node `fs` operations from the extension host, as an outside writer such as the CLI would be):
- **Startup.** A newly created watcher on a folder outside the workspace was not active straight away. In both folders, the first readiness marker's create event was not delivered within the 10 s bound, and only its later delete arrived. The second marker was reported after 84–91 ms. So events in the first seconds after a watcher is created can be missed, up to about 10 s here.
- **After readiness:**
  - a file created and written gave `create` then `change`, at 82–84 ms;
  - an append gave one `change`, at 83–84 ms;
  - a delete gave one `delete`, at 188–201 ms.
- **The CLI-style atomic replace** (write `.fix_report.md.p7.tmp`, then rename it over `fix_report.md`) gave the temp file's `create`, then a single `change` for the target and the temp file's `delete`, both at 204 ms. The target was never reported as deleted and recreated.

Events came in operation order, with no duplicates beyond the expected `create`-then-`change` of a fresh write, and none missing after readiness.

**Isolation and integrity.**
- **External files** changed exactly as the tests intended: `context.md` (P7-B, then P7-F), `fix_report.md` (P7-E's replace) and `spaced dir/written file.md` (P7-G). The watcher's files are gone, and `task.md` and `notes file.md` are unchanged.
- **Elsewhere:** the repository is unchanged apart from this plan; the 11 protected files are hash-identical; the P10 kit digest is unchanged; the first attempt's evidence is untouched.
- **The developer's VS Code:** `~/.vscode/argv.json` is unchanged since 2026-10-07, and the extensions folder listing is unchanged.
- **Leftovers:** no Explorer window inside `C:/bp-0b` was left open. VS Code wrote only its own profile, an empty `extensions/extensions.json` and its migration of one setting, all inside the kit.

**Limits:**
- Windows only, one VS Code version, local NTFS. macOS and Linux watcher implementations, network drives and other VS Code versions were not tested.
- The writes came from Node in the extension host, not from a separate process.
- One run, not a soak or a load test.
- VS Code was not network-isolated: telemetry, updates, experiments and AI features were off by setting, but no firewall rule was applied.
- The P7-I selection is unconfirmed.

**What it means for US-D17 and Batch 3** (evidence only; US-D17 stays PROPOSED). *(US-D17 was approved with conditions on 2026-10-18 (§8.9.1). P7 stays PASS only for the Windows API operations it tested, and `revealFileInOS` stays UNKNOWN.)*
- On Windows, the extension can read, open, show, edit, save and watch a work folder outside the workspace through public APIs, with spaces in paths and no workspace folder for it. That supports US-D17's "the extension reads, opens and watches the CLI-given folder".
- **For Batch 3:**
  - a watcher must be created early and treated as possibly blind for its first seconds, so the panel should refresh once after creating it rather than rely on events alone;
  - the CLI's atomic replace arrives as a `change` of the target;
  - a fresh write arrives as `create` then `change`, so refresh logic should coalesce events;
  - "reveal the work folder" opens Explorer at the folder's parent, and its highlighting is unconfirmed.
- The VS Code `sendText` part of P10 is still UNKNOWN; P7 does not cover it.

**Evidence** (outside the repository, kept for review): `C:/bp-0b/run-p7/evidence/`, holding `p7-results-retry1.json`, `p7-run-retry1.json`, the first attempt's `p7-run.json`, and `attempt1-harness/`.

##### Batch 0B — probe P10, VS Code sendText completion (2026-10-18)

**Outcome: 24 of 24 PASS. P10 is now PASS for the tested Windows configuration,** combining this run with the narrowed run's direct shells (20 of 20) and Python launcher (5 of 5). No real agent, account or real data was used. Nothing is approved.

**What it adds:** the essential VS Code path. BugPilot's own command lines were typed into real VS Code terminals the way the extension host does it: `window.createTerminal({ name, cwd: <repository>, env: { NoDefaultCurrentDirectoryInExePath: "1" } })`, then `terminal.show()`, then `terminal.sendText(commandLine, true)` immediately, without waiting for the shell.

**Run:**
- **Kit:** `C:/bp-0b/run-p10-vscode/`, new; the P10 and P7 kits were left untouched, their digests unchanged.
- **VS Code:** 1.142.0, launched with its own `--user-data-dir`, an empty `--extensions-dir` and a stripped-down environment. Home, app-data and temp pointed into the kit. PATH was the kit's stand-ins, then `System32` and `Windows`; `claude`, `codex` and `copilot` did not resolve on it.
- **The probe extension:** `bp-p10-sendtext-probe` 0.0.1, plain JavaScript, loaded with `--extensionDevelopmentPath`.
- **The stand-ins** are byte copies of the narrowed run's npm-shaped `agentstub` shims and recorder.
- **The command lines** came from BugPilot's own code: the real `claude-cli` definition with its command renamed `agentstub`, and `cliAgent(...).run()` under Node 24 (`harness/construct.mjs`). That includes the session-id form, which the same code builds when the flag probe answers yes, here with the synthetic id `0b0b0b0b-1010-4a10-8a10-0b0b0b0b1010`.
- **Results** were written after 200 s, and the window closed by itself.

**Shells:** each terminal named its shell explicitly (`shellPath`), with profile loading off. Production uses the developer's default terminal profile.

| Shell | Version | Arguments | Shim it resolved |
| --- | --- | --- | --- |
| PowerShell 7 | 7.6.6 | `-NoProfile -NoLogo` | `agentstub.ps1` |
| Windows PowerShell | 5.1.26100.9711 | `-NoProfile -NoLogo` | `agentstub.ps1` |
| cmd | 10.0.26300.9711 | `/d` | `agentstub.cmd` |
| Git Bash | 5.3.15(2) | `--noprofile --norc` | the sh `agentstub` |

**Cases** (each in each shell; the refused cases were checked against the filter only and never sent):

| Case | Command line typed | Received by the stand-in | Result |
| --- | --- | --- | --- |
| A1 simple | `agentstub "Read .ai/JR-12345/task.md and complete the workflow."` | exactly that one argument | PASS ×4 |
| A2 repeated spaces | the same line, after `flatten` | the flattened prompt | PASS ×4 |
| A3 absolute path with a space | `agentstub "Read C:/bp-0b/run-p10-vscode/you two/work/JR-12345/task.md and complete the workflow."` | exactly that one argument | PASS ×4 |
| A4 multi-line | A3's line, after `flatten` | the flattened prompt | PASS ×4 |
| A5 punctuation `# : , - _` | `agentstub "#Review: …/fix_report.md, context.md - done_now."` | exactly that one argument | PASS ×4 |
| S1 session id | `agentstub --session-id 0b0b0b0b-1010-4a10-8a10-0b0b0b0b1010 "<A3's prompt>"` | `--session-id`, the id, the prompt: three arguments, boundaries intact | PASS ×4 |
| R1 backslash path, R2 `-p` start | refused by the filter (`failed`, nothing built) | not sent | — |

**What PASS means here:**
- The recorder ran exactly once per terminal, and its argument list equalled the intended one.
- No record appeared that did not belong to a case, so no unexpected command ran.
- Every terminal closed when disposed.
- The stand-in started 0.4 s after `sendText` in cmd, and 1.1–2.1 s in the other shells, which includes their start-up.

**Limits:**
- **Exit codes were not observed through VS Code.** Its shell-integration execution events did not fire in any of these terminals (no start and no end events), so an exit status is UNKNOWN. The recorder writes its record as its last step, so each invocation ran to completion.
- **Shell configuration:**
  - shells were chosen with an explicit `shellPath`, not through the developer's default terminal profile;
  - developer profiles were not loaded (`-NoProfile`, `/d`, `--noprofile --norc`), so a profile that redefines commands was not covered;
  - the environment was stripped down.
- **Windows only;** macOS and Linux were not run.
- **Stand-ins only:** npm-shaped shims, no real agent and no native executable (P11's question).
- **Accepted characters only,** by design. No claim is made beyond the inputs tested.

**What it means for US-D10 and US-D12** (evidence only; nothing approved):
- **US-D12:** on this Windows configuration, the filter-accepted class reaches the program intact through the real VS Code terminal path in all four shells, the 0.1.6 absolute-path form with a space and the session-id form included. That supports keeping the gate as it is.
- **US-D10:** the terminal-launch transport for Option A's one-click handoff (aspect A6) works for the tested configuration. A6 also needs real agents to read and write the work folder (P1, P3), which is not yet observed.

**Evidence** (outside the repository, kept for review): `C:/bp-0b/run-p10-vscode/evidence/`, holding:
- `command_lines.json`, the builder's output;
- `p10-sendtext-run1.json`, every case's command line, expected and received arguments, invocation count, timing and shell-integration events;
- `p10-sendtext-run1-launch.json`, the launch and isolation record;
- `received/`, 24 recorder records.

The narrowed run's evidence stays in `C:/bp-0b/run-p10/evidence/`.

##### Batch 0B — probe P2, captured review (2026-10-18)

**Outcome: FAIL against the owner's acceptance criteria.** Two of the brief's seven conditions were not met. The question US-D28 depends on was nevertheless answered: under `--permission-mode dontAsk` with the bare `Read` allow, the captured review read the external work folder by absolute path with no prompt and no denial. One run only, with no retry and no wider permissions. Nothing is approved.

| Condition (the owner's brief) | Observed |
| --- | --- |
| Claude reads the intended external files | **met.** `Read` of `C:/bp-0b/run-p2/work/JR-12345/context.md` and `fix_report.md`, outside the working directory, succeeded |
| the marker in `fix_report.md` is incorporated into the review | **not met.** The marker reached the model inside the `fix_report.md` read result, and the review names its location and prefix. The model deliberately declined to reproduce it, calling it "an embedded instruction in the document under review", and recommended removing such reviewer-directed text |
| no unauthorized tool is invoked | **not met as written.** The model requested Bash once (`git status`, `git log`, `git diff` in the synthetic repository). Claude Code refused it ("No such tool available: Bash. Bash exists but is not enabled in this context"), and it never ran |
| no permission escalation is requested | **met.** No prompt; `permission_denials` empty |
| no unexpected file access | **met within the kit, with one note.** Glob and Grep stayed in the synthetic repository. The model also tried to read its own auto-memory file in the isolated configuration (`projects/<repository slug>/memory/MEMORY.md`), which did not exist |
| no synthetic file modified | **met.** Hashes identical to before the run; the repository's `git status` is clean |
| the review matches the synthetic task | **met.** The four requested sections; the `range(1, 4)` trace; the missing edge cases (`start == end`, `start > end`, negative ranges); and a plain statement that nothing was run |

**Run.**
- **Authorization:** the owner's P2 brief of 2026-10-18. The owner accepted the residual filesystem-read risk of running Claude Code on this Windows machine, for this probe only.
- **Agent:** Claude Code 2.1.214 (the npm package's `bin/claude.exe`, invoked directly), on Windows 11 Enterprise 10.0.26300.
- **Kit:** `C:/bp-0b/run-p2/`: a synthetic repository (one commit, no remote, author `dev <dev@example.com>`) and a synthetic work folder.
- **Environment:** stripped down. `CLAUDE_CONFIG_DIR`, home, app-data and temp pointed into the kit; no API key or token variable was present.
- **Sign-in:** the owner signed in to the isolated configuration with a claude.ai account. `claude auth status` showed `loggedIn: true` before the run; no account detail was recorded.
- **Command:** the captured-review flags of `CLAUDE_CAPTURED_REVIEW`, with `--output-format stream-json --verbose` in place of `json` for observation; permissions unchanged:

  ```text
  claude.exe -p --output-format stream-json --verbose --no-session-persistence --setting-sources "" --strict-mcp-config --permission-mode dontAsk --tools Read Grep Glob --allowedTools Read Grep Glob
  ```

  The prompt went on stdin: BugPilot's final review request (`_build_final_review_prompt`), with its file list made absolute and limited to the two external files, and "current changes: none are included".
- **The session reported** its tools as exactly `Glob`, `Grep` and `Read`, no MCP servers, `permissionMode: dontAsk`, `apiKeySource: none`.
- **Result:** exit 0, 53.3 s, 9 turns, `success`, empty stderr.

**Tool-use transcript,** in order:
1. `Read` `context.md`: success.
2. `Read` `fix_report.md`: success, marker included.
3. `Read` `repo/src/calc.py`: success.
4. `Read` `repo/tests/test_calc.py`: success.
5. `Bash`: refused, tool not enabled.
6. `Glob` `**/*.py` in the repository: success.
7. `Grep` `inclusive_sum|range\(` in the repository: success.
8. `Read` of the auto-memory file: the file does not exist.

**What the run wrote,** all inside the kit's isolated configuration:
- `remote-settings.json` and `policy-limits.json`, fetched from the service;
- `.last-cleanup` and a backup of `.claude.json`;
- empty `sessions/` and `projects/<repository slug>/memory/` folders.

There is no transcript anywhere, so `--no-session-persistence` held. The raw output holds no email address, account, organization or token field.

**What it means for US-D28** (evidence only; US-D28 stays OPEN):
- **The main path works on this configuration.** The captured review reads an external work folder named by absolute path under the unchanged read-only flags, with no prompt. The inline `fix_report.md` fallback was not needed for that.
- **`--tools` is what kept the reviewer read-only.** The model asked for a shell to check the Git state, and only the absent tool stopped it. That confirms the existing design, where the tool list, not `--allowedTools` alone, defines what exists.
- **Instructions inside an artifact were treated as data:** the model refused one and reported it. BugPilot must not rely on in-artifact instructions to steer a reviewer, and quoting earlier AI output as data stays appropriate.
- **Claude Code's auto-memory is not switched off by `--setting-sources ""`.** With a developer's real configuration, the captured review can read the developer's auto-memory for that repository. That is read-only, but its contents can reach the review. `--bare` disables auto-memory, but its help says it accepts only API-key authentication.
- **A run writes small state files** (remote settings, policy limits) into the agent's configuration folder, which for a developer is `~/.claude`.

*(Added 2026-10-18, after the owner's US-D28 decision, §16.5.11:*

- *The auto-memory point above is an observed read **attempt** on the isolated configuration's memory file, which did not exist.*
- *Access to a real developer's memory was not observed. "Can read" is inferred from the bare `Read` allow.*
- *US-D28 is now APPROVED with conditions, as a design contract.)*

**Limits:**
- One run, one model, one Windows machine, no OS-level isolation. The bare `Read` allow permits any path, so that real files were not read rests on the prompt and the model's behaviour; the transcript shows only kit paths.
- The probe's marker design, an instruction inside a data file, was refused by a well-behaved model. A future probe should prove the read from the tool result, not by asking the model to echo a token.
- `stream-json` was used instead of `json`.
- The service was reached over the network, as every real run does.

**Evidence** (outside the repository, kept for review): `C:/bp-0b/run-p2/evidence/`, holding:
- `p2-prompt.txt`;
- `p2-stream.jsonl` (raw) and `p2-stderr.txt` (empty);
- `p2-analysis.json`;
- `synthetic-before.sha256`;
- `cli-version.txt`, `cli-help.txt`, `cli-auth-help.txt` and `auth-status-before.txt`.

**Credentials.** The sign-in lives only in `C:/bp-0b/run-p2/home/claude/`. The owner should run `claude auth logout` in that configuration before the kit is deleted, since the sign-in stays valid on the service until then.

### 14.2 Batch 1 — Storage foundation

**1. Scope.** `bugpilot/core/storage.py` (§8.2) and the `safe_paths` generalization (§8.5), with their tests. **No caller is switched.**

**2. Files.**

- `bugpilot/core/storage.py` (new)
- `bugpilot/core/safe_paths.py` (a `boundary` label and a `mode` argument; existing messages byte-identical)
- `bugpilot/core/errors.py` (only if US-D26 adds a code)
- `tests/test_storage_identity.py` and `tests/test_storage_safety.py` (primitives)
- `tests/fixtures/storage_cli_contract.json`: §8.10 frozen as test data; no product code reads it
- `.github/workflows/ci.yml` (the file list)
- this plan

**3. Preconditions.**

- Batch 0A is on `main`, with green CI and its isolation evidence accepted by the owner.
- The owner approves Batch 1's prerequisite decisions: US-D1, D3, D5 (conditionally, on §7.3's verification), D6, D7, D23, D24 and D34.
- Batch 0B is **not** required.

**4. Explicit exclusions.**

- `config.py`, the settings modules, the CLI, MCP and the extension are untouched;
- no product module imports `storage`;
- `doctor` is unchanged;
- no golden changes.

**5. Steps.**

1. `data_root()` and its validation (US-D34).
2. `repository_identity()`, plus golden vectors for one POSIX path and one Windows path (US-D5).
3. The record: read, verify, deterministic write (US-D24).
4. `ensure()`: creation one component at a time (`0700`), link checks before and after, and the `realpath` containment comparison (US-D23).
5. Path accessors with `create=` semantics; `SettingsName`; `work_items()`.
6. `display_path()` (US-D22).
7. Memoization; timing against §12.
8. Tests (§11.3, resolver and primitives); CI file list.
9. Freeze §8.10 as `tests/fixtures/storage_cli_contract.json`. Add a schema check that the fixture is well-formed and lists every key of §8.10. No product test uses it yet.

**6. Acceptance.**

- The new suites are green on the four CI configurations.
- Every §7.3 row is covered by a test, or recorded as "not testable in CI" with the reason.
- Every existing suite is unchanged: goldens identical, ratchet unchanged.
- §12's identity and `ensure()` budgets are met.
- `python -c "import bugpilot.core.storage"` works on 3.10.
- The isolation guard is active throughout; the resolver tests show `data_root()` under the session root.
- The contract fixture matches §8.10 exactly.

**7. Security tests.** T-S1, T-S2, T-S4, T-S5, T-S6, T-S7 (record), T-S14 (resolution creates nothing), T-S18 and T-S23, at the primitive level; T-S24 and T-S25 stay green.

**8. Regression.** All of §11.4 unchanged.

**9. Cross-platform.** POSIX modes, macOS `/private` and Windows junctions, all in CI. `subst` only if the owner separately approves its test (D0A-5).

**10. Rollback.** Revert the commit. Nothing uses the module.

**11. Dependencies.** Batch 0A's isolation and guard: the resolver tests rely on `BUGPILOT_HOME` being set session-wide, before collection. There is no dependency on Batch 0B.

**12. Stop and approval gate.**

- **Stop if:**
  - a §7.3 case behaves differently on a platform than the plan says (for example `subst` is not resolved, or macOS `getcwd` is not canonical). The table and US-D5 return to the owner;
  - `realpath(strict=True)` behaves differently on 3.10.
- **Gate:**
  - the owner approves the commit to `main` (US-D29);
  - the owner approves §8.10 and its fixture (US-D26's condition).

  Batch 2 then still waits for its own preconditions (§14.3).

#### Batch 1 — as built (2026-10-16)

**Status: implemented and verified locally on Windows. Not staged, not committed, not pushed; no CI run** (§19). It awaits the owner's review. No product module uses the new module.

| | |
| --- | --- |
| Authorized | 2026-10-16, Batch 1 only, by the owner's Batch 1 brief, on `main` at `64056ca` (Batch 0A completed and CI-verified) |
| Version | 0.1.5, unchanged |
| Product behaviour | unchanged: no caller is switched; `config.py`, `user_config.py`, the settings modules, the CLI, MCP and the extension are untouched |
| Goldens, fixtures, baselines | none changed; one new fixture (below) |
| Accounts | no Jira request, no agent, no live probe |

**The decision gate.** §14.2's precondition asks the owner to approve US-D1, D3, D5, D6, D7, D23, D24 and D34 first.
- **Status in §16.1:** US-D3 is OPEN and the others are PROPOSED. Their status is unchanged: nothing is marked approved. *(Ratified on 2026-10-16: see "Batch 1 — owner decision gate" below.)*
- **Why implementation went ahead:** the owner's Batch 1 brief directs each one's content:
  - the layout (US-D1);
  - `BUGPILOT_HOME` naming the whole data root (US-D3's name);
  - the §7.2 algorithm (US-D5);
  - the record schema (US-D6);
  - one namespace per worktree (US-D7);
  - private folders and the existing-root policy (US-D23);
  - refusal of a mismatched or corrupt record (US-D24);
  - data-root validation (US-D34).
- **What remains:** approving them is the owner's step at this batch's review. Nothing is committed, so a different decision changes the code before any commit (deviation B1-1).
- **§8.10:** its open choices concern only Batch 2's consumers:
  - the `STORAGE_UNAVAILABLE` code;
  - US-D16's removal of the `ai_artifacts_ignored*` fields;
  - US-D4's `below_git_toplevel`;
  - US-D3's `legacy_config_dir_variable`.

  None changes a Batch 1 primitive, so the contract is frozen unchanged (below).

**Files.**

| File | Change |
| --- | --- |
| `bugpilot/core/storage.py` | **new**: the resolver and its primitives (below); standard library only |
| `bugpilot/core/safe_paths.py` | `writable_dir(..., mode=, boundary=)` and `refuse_link(..., boundary=)`. `is_link_stat()` holds the `lstat` test that `is_link_or_junction` applies, unchanged, for callers that already hold the `lstat`. With the defaults every message is byte-identical (tested) |
| `tests/test_storage_identity.py` | **new**, required in CI: 102 tests (data root, algorithm and golden vectors, canonicalization, distinct repositories, platform cases, the record, two processes, read-only resolution, isolation, the §8.10 fixture) |
| `tests/test_storage_safety.py` | **new**, required in CI: 92 tests (a link at each of the nine components, before and swapped in after `mkdir`; the data root behind a link; modes; traversal; closed sets; message hygiene; no legacy reads; timing record) |
| `tests/fixtures/storage_cli_contract.json` | **new**: §8.10 frozen as test data (step 9), generated from §8.10's two tables; a test checks it equals them exactly. No product code reads it. Status: PROPOSED (US-D26) |
| `tests/storage_inventory.json` | the ratchet record, updated with `--update` for `storage.py`'s new references (`bugpilot-dir` 1, `home-bugpilot` 3, `home-lookup` 1, `path-helper` 1). No other file's counts changed |
| `.github/workflows/ci.yml` | the two suites join `safety-and-baselines`; a header comment. Job ids, names, matrix, pins and permissions unchanged |

**The API surface, settled** (§8.2's names were proposals):

- **Constants:** `DATA_ROOT_ENV` (`"BUGPILOT_HOME"`), `DEFAULT_DATA_DIR_NAME`, `STORAGE_LAYOUT_VERSION` (1), `RECORD_NAME`, `DATA_ROOT_BOUNDARY`, `DIRECTORY_MODE` (`0o700`), `REPOSITORY_ID_RE`, `SETTINGS_NAMES` (the closed set of five), `SettingsName`, `RecordState`.
- **Errors:** `StorageError(UnsafePathError)` and `StorageIdentityError(StorageError)`. Their messages are one sentence, with no absolute path.
- **The data root:**
  - `data_root()`: `BUGPILOT_HOME` must be absolute, with no C0 or C1 control, DEL, U+2028 or U+2029, and no `~` expansion; a blank value counts as unset, as `BUGPILOT_CONFIG_DIR` does today. Otherwise `Path.home() / ".bugpilot"`; a home that cannot be found, or is relative, is refused.
  - `data_root_source()`.
  - `display_path()`: `~/.bugpilot/…` or `BUGPILOT_HOME/…`; a path outside the data root is a `ValueError`.
- **Identity:**
  - `RepositoryIdentity(repository_id, root, key)` and `repository_identity()`: §7.2, memoized per process and spelling.
  - `repository_id_for(canonical, windows=)`: the pure algorithm, for the golden vectors.
- **Global storage:** `GlobalStorage` (`config_dir`, `config_file`, `user_instructions_file`, `user_fix_modes_dir`, `ensure_config_dir()`) and `global_storage()`.
- **Repository storage:** `RepositoryStorage` (`directory`, `settings_dir`, `work_root`, `memory_dir`, `record_file`) and `repository_storage()`. Its methods:
  - `ensure()` and `record_state()`;
  - `work_item_dir()`, `attachments_dir()`, `memory_file()`, `settings_file()` and `fix_modes_dir()`, each with `create=`;
  - `work_items()`, returning `WorkItemEntry(work_item_id, path, mtime)`.
- **Additions** to §8.2: `repository_id_for`, `data_root_source`, `attachments_dir` (the ninth component, §10's T-S5) and `record_file`.

**Deviations and clarifications, recorded:**

| Id | What | Why |
| --- | --- | --- |
| B1-1 | Implemented with its prerequisite decisions still PROPOSED or OPEN in §16.1 (the gate above) | The owner's brief directs their content and forbids marking them approved; the formal approval stays with the owner, before any commit |
| B1-2 | The slug strips `_` from its ends, as well as `.` and `-` | §7.2's own ID pattern requires a letter or digit first; a basename such as `_x` would otherwise give an invalid ID. Display only: uniqueness is the hash |
| B1-3 | The record matches only when its `root` equals the canonical root **exactly**, not only its folded key. *Revised by B1-13 (finding M2): a Windows case-only rename of the same folder is accepted* | §7.5's table compared `normcase(root)` with the key, which cannot refuse two folders whose keys collide. §7.3's case-sensitive-folder row says they are refused. Exact equality refuses them, preferring a split to a merge (tested; a key-only comparison fails that test) |
| B1-4 | A new record is published by **hard link** from a private temp file, falling back to an atomic rename only where the file system has no hard links and the name is still free. *Superseded by B1-14 (finding M1): that fallback checked and then replaced; there is no replacing step now* | `os.link` fails if the name exists and never follows it. An existing record, identical or the evidence of a collision, is never replaced, and a reader sees no record or a whole one. A rename, which §8.7 assumed, can fail on Windows while a reader has the file open, and the writer's in-place fallback could then show a half record |
| B1-5 | Reads check each existing component with one `lstat` (link or junction refused, a non-folder refused) and do not repeat the final `realpath` comparison that writes make | §8.3's read contract is "refuses links on existing components". Nothing a read does can land elsewhere, and on Windows each `realpath` costs about 0.4 ms. Writes keep `writable_dir`'s full check, comparison included |
| B1-6 | `owned_path` keeps its messages: its `boundary` label waits for Batch 2 | Its only caller is `clean`, which moves in Batch 2; Batch 1 deletes nothing |
| B1-7 | A system `OSError` while creating (permissions, a full disk) is not translated; a missing parent of the data root, and a data root that is a file, are `StorageError`s | §8.10: until the owner chooses `STORAGE_UNAVAILABLE`, such failures keep the existing generic code. The two configuration cases are bad input |
| B1-8 | `tests/fixtures/storage_cli_contract.json` was added, though the brief's file list did not name it | §14.2 step 9 and the gate need it; it is test data only, generated from §8.10 and checked equal to it |
| B1-9 | `bugpilot/core/errors.py` is unchanged | No code is added while `STORAGE_UNAVAILABLE` is OPEN |
| B1-10 | A record-only timing test writes `storage_timing_<platform>_py<version>.json` to CI's file-safety artifact | §12's numbers on Linux and macOS come from the next CI run, without a timing gate that would be flaky |

**§7.3, row by row.**

| Row | Covered by |
| --- | --- |
| Same basename | a test: different IDs, the same slug |
| Spellings (separators, `.`, `..`, trailing separator, relative) | a test |
| Windows letter case and drive-letter case | a test (Windows) |
| Windows case-sensitive folders | the refusal is tested at the record (B1-3). A real case-sensitive folder needs `fsutil` and the Windows Subsystem for Linux feature: **not testable in CI** |
| A symbolic link or junction as the root | tests (a symbolic link everywhere, a junction on Windows) |
| `subst` and mapped drives | **NOT VERIFIED**; a skipped test states why (D0A-5) |
| macOS letter case (`getcwd`) and `/private/var` | a test (macOS; it first runs in CI) |
| NFC and NFD | a test: two folders where they can coexist; the same folder on a normalization-insensitive volume |
| Moved or renamed | a test: a new ID; the old namespace is untouched |
| Cloned elsewhere; several windows; multi-root | the same-basename, spelling and memoization tests |
| Worktrees | a test with a real `git worktree add`: distinct IDs |
| Nested | a test |
| Missing or unresolvable root | a test: refused before anything is written |

**Golden vectors** (pinned in the tests, and recomputed independently from §7.2):
- `/home/you/src/checkout` → `checkout-16f9432d5af86ec5`;
- `C:\Users\you\src\Checkout` → `checkout-9162ffe8034ca234`.

Other Windows spellings of the same path give the same ID.

**Each test bites.** Six mutations of the final `storage.py`, run on copies outside the repository, were each caught:

| Mutation | Tests that failed |
| --- | --- |
| The record compared by folded key only | 1 |
| Reads skipping the record check | 14 |
| Reads following links (the `lstat` refusal off) | 4 |
| `~` expanded | 2 |
| The slug keeping `_` | 2 |
| Work-item IDs not validated | 33 |

**Performance (§12).** Measured on Windows 11 with Python 3.14.6, outside the test guard, on synthetic repositories in a scratch data root. All values are medians.

| Measure | Result | Budget |
| --- | --- | --- |
| Repository identity, cold | 227 µs | < 1 ms: **met** |
| Repository identity, warm | 1.7 µs | < 10 µs: **met** |
| `ensure()`, first write of a namespace | **4.96 ms**: the folder 1.26 ms, the record's publish 2.72 ms, its first verification 0.55 ms | < 2 ms: **not met on Windows** |
| A read lookup (`repository_storage().work_item_dir(create=False)`) | 0.37 ms | "no measurable change". 0.1.5's own read was a bare join (1.8 µs) with no link check; its checked read (`writable_issue_dir(create=False)`) is 0.72 ms |
| `ensure()` on a ready namespace | 0.26 ms | — |
| `work_items()` over 1,001 work items | 103 ms | `list --json` over 1,000 < 1 s (Batch 2) |
| For comparison: 0.1.5's first `.ai/<id>` creation | 1.55 ms | — |

**The two budgets not met are an owner decision; nothing was weakened to meet them.**
- **First write.** The first write is dominated by creating files on Windows. The record's hard-link publish (B1-4) is what keeps it safe for a concurrent reader. Writing it in place would save about 1.5 ms, and could show that reader half a record.
- **Read lookups.** These now refuse links (§8.3), which 0.1.5's bare join never did.
- **Options:**
  - accept a Windows budget for the first write (for example, below 10 ms);
  - keep < 2 ms for Linux and macOS until CI's timing record (B1-10) gives their numbers;
  - judge reads by §12's end-to-end rule instead: preparation within 2% of 0.1.5, measured in Batch 2.

**Security.**
- **New findings:** none.
- **Guarantees, tested here:**
  - nothing is created inside the repository;
  - no link or junction below the data root is followed, at any of the nine components, before or after `mkdir`;
  - no work-item ID leaves its namespace;
  - a record naming another root, or not a readable record, is refused for reads and writes alike, and never repaired;
  - read-only resolution creates nothing;
  - new folders are `0700` and the record `0600` under four umasks;
  - a restrictive umask narrows and never widens;
  - an existing data root's mode is never changed;
  - no message holds an absolute path;
  - no legacy location is read. The test guard protects them, and any access would have failed the test.
- **Limitations, stated:**
  - **The identity key on Windows.** Since Python 3.12, `normcase` folds case through the system rather than `str.lower`. A non-ASCII path could therefore get a different ID under a different Python version: a split, the safe direction.
  - **Same-user races.** A same-user process can still race a write between the checks and the use, as §10.3 states.

**Local verification** (Windows 11, Python 3.14.6, Node 24.21; `PYTHONPATH` = the repository; the test isolation active):

| Check | Command | Result |
| --- | --- | --- |
| The new suites | `python -m pytest tests/test_storage_identity.py tests/test_storage_safety.py` | **185 passed, 9 skipped**. Skips: POSIX modes ×6, POSIX letter case, macOS, and `subst` (NOT VERIFIED) |
| `safe_paths`, file safety, prompt boundary, goldens, publishability, isolation, baselines | `python -m pytest` over those suites | **594 passed**, 35 skipped (POSIX-only) |
| Release workflow, CI report, ratchet | `python -m pytest tests/test_release_workflow.py tests/test_ci_report.py tests/test_storage_inventory.py` | **84 passed** |
| Baselines | `python tests/storage_baseline.py --check`, twice | **baselines match**, both times |
| Python 3.10 syntax | `ast.parse(..., feature_version=(3, 10))` over the four changed Python files | all parse. No 3.10 interpreter here: CI's 3.10 job runs them first |
| Extension | `tsc --noEmit`; `npm test`; the required TypeScript job's files | clean; **2,350 passed**; **27 passed** (the extension is unchanged) |
| Goldens, fixtures, baselines, product files | `git diff HEAD` over them | unchanged; no product module imports `storage` |
| Full Python suite | `python -X utf8 -m pytest -q -p no:cacheprovider -rfEs` | **3,443 passed, 0 failed**, 45 skipped (the 36 POSIX- and macOS-only skips plus the 9 new platform skips), 19 min 22 s |
| CLI integration suite (through the changed `safe_paths`) | `npm run integration` | **21 passed**; the final no-refusal test passed |
| Publishability, after the plan edits | `python -m pytest tests/test_publishable.py` | **20 passed** |
| Whitespace | `git diff --check`, plus a scan of the new and changed files | clean; each file keeps its line-ending convention |

**Not executed:**
- CI;
- Linux, macOS and Python 3.10 runs (the POSIX modes, macOS cases and junction-free platforms first run in CI);
- `subst`;
- a real Windows case-sensitive folder;
- `scripts/check_cli_contract.py`;
- Batch 0B probes.

#### Batch 1 — architecture review remediation (2026-10-16)

**Status: remediated and verified locally on Windows. Not staged, not committed, not pushed; no CI run** (§19). Batch 1 stays implemented locally, pending the owner's approval. Its prerequisite decisions (US-D1, D3, D5, D6, D7, D23, D24, D26, D34) keep their §16.1 status, PROPOSED or OPEN: nothing was marked approved. The review's recommendations, and this section's, are not owner decisions.

| | |
| --- | --- |
| Review | the Batch 1 architecture and security review, read-only: **FAIL**. High: H1, H2. Medium: M1, M2, M3. Low: L1–L9 |
| Authorized | 2026-10-16, the owner's narrow remediation brief: fix H1 and M1–M3; investigate H2 without weakening any protection; fix L2, L3, L6, L7, L8 and L9; assess L1, L4 and L5 |
| Files changed | `bugpilot/core/storage.py`, `tests/test_storage_identity.py`, `tests/test_storage_safety.py`, `tests/fixtures/storage_cli_contract.json` and this plan. `safe_paths.py`, `ci.yml` and the ratchet record are as Batch 1 left them |
| Unchanged | every product caller (none uses `storage`), the CLI, MCP and the extension, goldens, baselines, the historical plan, the version 0.1.5, and every user configuration |

**Findings and fixes.**

| Finding | What is done now | Id | Tests |
| --- | --- | --- | --- |
| **H1**: a data root inside the repository was not prevented, so BugPilot's files could land in the checkout | A namespace whose data root and repository are not kept apart (R5) is refused for reads and writes alike, before anything is looked at or created. *Inside*: the canonical data root is the repository or below it (`BUGPILOT_HOME` in a checkout; a repository that is the home folder, which holds the default data root; a repository above it). *Contains*: the repository is inside the data root. Two comparisons, never a text prefix: the canonical paths component by component (folded with `normcase`), and file identity (device and file index) along the ancestors, which catches an alias the canonical path misses. Checked in `record_state()` and in every read lookup, so in `ensure()` and every write too. A pair found apart is remembered for the process. The refusal is one sentence, with display paths only | B1-11 | 9 tests, 13 cases on Windows: inside, equal, home folder, above, contains, a Windows case variant, a symbolic link or junction smuggling the root in, file identity alone (with `realpath` disabled), and siblings (`checkout-data`, `checkout.bugpilot`) accepted. Every access is tried: nothing is created in the repository or the data root |
| **M1**: the no-hard-link fallback checked `lexists` and then called `os.replace`, so a concurrent record could be overwritten | `os.link`, which fails on an existing name and never follows it. Where the file system has no hard links: on Windows `os.rename`, which raises instead of replacing (`MoveFileExW` without `MOVEFILE_REPLACE_EXISTING`); on POSIX a one-sentence refusal with nothing written, because POSIX has no portable rename that refuses to replace. No `os.replace` and no check-then-replace step anywhere. Any other link error propagates unchanged. Whatever is at the name afterwards is verified, so a concurrent publisher's record, identical or a collision's evidence, is kept | B1-14 | 7 tests, with `os.replace` made to fail the test: the hard-link publish; the Windows rename; the review's race injected (a conflicting record appears just before the rename and survives); the POSIX refusal (no record, no temp); an existing record untouched; another link error not disguised; a refused temp name publishing nothing. Also the two-process race over 50 namespaces |
| **M2**: the exact-root comparison refused a namespace after a Windows case-only rename of the same folder | On Windows only, a record whose `root` differs from the canonical root is accepted when the folded keys are equal **and** the recorded spelling still resolves to this very folder (same device and file index; an index of 0 proves nothing). The record is never rewritten. Two different folders whose keys collide, a recorded spelling that no longer resolves, and every difference on POSIX are still refused | B1-13 | 3 tests replace the letter-case test, which pinned the old refusal (behaviour changed by design): a case-only rename keeps the namespace and the record's bytes; a genuine folded-key collision is refused; a spelling that no longer resolves is refused |
| **M3**: a Windows sharing violation, on reading the record or removing the temp name, was reported as a corrupt record | `PermissionError` on the record's `lstat` and read is retried a bounded number of times (5 attempts, 20 ms apart). A record still unreadable raises `StorageError` "cannot read … right now": never "not a readable repository record", never "delete it", never a `StorageIdentityError`, and the record is not touched. The temp name is removed with the same bounded retries; its removal never raises and never replaces the publish's own outcome. If it stays, a stray `.repository.json.<random>.tmp` remains: never read, never published, safe to delete by hand | B1-15 | 6 tests: a temp name that cannot be removed; one removed on retry; a transient read retried; a permanently unreadable record reported as such by `ensure()`, `record_state()` and a read; a failed clean-up not masking the error on its way out; a component that is a file. Plus a reader polling 50 namespaces while two processes publish them: it sees `absent`, `missing-record` and `ok`, never `corrupt` (5 of 5 runs, no "in use"). The 12 genuinely corrupt records are still refused |
| **L2**: `display_path` cut the path by string length | Components compared one by one, folded, and shown as written | B1-17 | a fold that changes a component's length |
| **L3**: a repository that is a profile folder carried the account name in its ID | The slug is `home` for `C:\Users\<name>`, `/home/<name>`, `/Users/<name>` and `/root`, decided from the path alone; deeper folders keep their own slug | B1-16 | 5 profile spellings; 3 folders below or beside a profile |
| **L6**: the contract fixture was prose, not machine-readable | `entries` restates each of the 46 rows, in order, as typed fields: surface kind, commands, form, event, flags, direction, parent, keys, value kind, format, values, nullability, change, previous value, decisions and references. The prose arrays are kept byte for byte, and no semantics changed | B1-20 | a test ties every typed field to its prose row; 7 single-field corruptions were each caught |
| **L7**: `BUGPILOT_HOME` was returned as configured, not canonical | `data_root()` is canonical (`realpath`, non-strict); `display_path` accepts either form | B1-12 | the canonical root |
| **L8**: test gaps | the tests in this table | — | — |
| **L9**: reads did not check each component the way writes do | `_existing` checks every component (no separator, `.`, `..` or empty part) first | B1-18 | 4 invalid parts, with nothing created |
| *Found during the remediation* | Literal U+2028 and U+2029 characters in `storage.py`'s pattern source are now escapes; the pattern is unchanged | B1-19 | the existing control-character tests |

**H2, investigated; no permission behaviour changed.**
- **What was found.** Every folder is created with `mode=0o700`. On Windows, CPython applies that mode as an access list only from 3.10.15, 3.11.10, 3.12.4 and 3.13. The list is protected from inheritance and grants only SYSTEM (`S-1-5-18`), Administrators (`S-1-5-32-544`) and OWNER RIGHTS (`S-1-3-4`). Earlier patch releases ignore the mode, and the folder inherits its parent's list.
- **Who gets which.** The python.org Windows installers for 3.10 and 3.11 end at 3.10.11 and 3.11.9, so a typical 3.10 or 3.11 install on Windows inherits. Under the default data root, the parent is the user's profile, which is normally private already. A `BUGPILOT_HOME` elsewhere inherits whatever that folder grants.
- **Measured.** On 3.14.6, a new read-only test reads each created folder's list through Win32: the data root, `repositories`, the namespace, `work` and a work item. Each is protected and holds exactly those three entries, and the record inherits them. On a Python that ignores the mode, the test is skipped with that reason; none was run here. CI's Windows job (3.13) runs it.
- **What the POSIX tests prove.** The POSIX permission-bit tests (`0700`, `0600`, umask) prove nothing about Windows access lists, and are skipped there.
- **Handoff.** An owner-only list also excludes other local accounts. That includes sandbox principals an agent may run as. This matters to Batch 3's handoff and to 0B's probes.
- **Owner decision (Q1 below).** Options:
  - (a) apply an owner-only list through Win32 calls on Pythons that ignore the mode;
  - (b) refuse, or warn on, such Pythons on Windows;
  - (c) accept and document the inherited list on them;
  - (d) report the effective protection, read only, in Batch 2's `doctor`.

  No option was implemented. A uniform secure implementation needs new Win32 security code, which is a change of permission behaviour reserved for the owner.

**L1, L4 and L5, assessed (not changed).**
- **L1: no `fsync`.**
  - A crash or power loss after the record's publish can leave the name with no or partial content. The next run reads it as corrupt and refuses: it fails closed, and only the identity record is lost.
  - Measured on Windows: a small write with `fsync` 9.1 ms, without 1.1 ms. That is about 8 ms more on every first `ensure()`.
  - Real durability would also need a POSIX directory `fsync`, and `F_FULLFSYNC` on macOS.
  - Recommendation: leave it, and revisit in Batch 4 (Q5).
- **L4: the verification cache's signature has no `ctime`.**
  - The in-process cache is keyed by device, file index, size, modification time and root. A same-user process that rewrites the record in place, keeps its size and restores its modification time, would not be noticed within one process lifetime.
  - `ctime` would catch that on POSIX. On Windows `st_ctime` is the creation time, so it adds nothing there.
  - This is §10.3's same-user race; the record protects integrity, not secrecy.
  - Recommendation: add `st_ctime_ns` on POSIX in Batch 4, or accept (Q5).
- **L5: the identity cache can go stale.**
  - Identities (`lru_cache(128)`, keyed by spelling) and remembered containment pairs last as long as the process. A long-lived process, such as the MCP server, keeps a repository's namespace after the folder is moved, renamed or replaced.
  - The record check still refuses a foreign record.
  - Recommendation: Batch 2 decides whether the MCP server resolves per request (about 0.24 ms cold) or clears the caches per call (Q5).

**Each control bites.** 20 mutations of `storage.py`, run on copies outside the repository, were each caught. The six from "as built" were re-anchored, and fourteen are new:

| Mutation | Tests that failed |
| --- | --- |
| The record compared by folded key only | 2 |
| Reads skipping the record check | 16 |
| Reads following links | 4 |
| `~` expanded | 2 |
| The slug keeping `_` | 2 |
| Work-item IDs not validated | 33 |
| H1: containment never checked | 8 |
| H1: reads skipping the containment check | 8 |
| H1: canonical paths only, no file identity | 2 |
| H1: a text prefix instead of components | 4 |
| H1: a repository inside the data root allowed | 1 |
| M1: the rename fallback replacing (`os.replace`) | 2 |
| M1: a POSIX check-then-replace fallback | 1 |
| M2: a case-only rename accepted on folded strings alone | 3 |
| M3: an unreadable record called corrupt | 1 |
| M3: no retry | 2 |
| M3: a clean-up failure raising | 2 |
| L3: a profile folder keeping the account name | 5 |
| L7: the data root not canonical | 1 |
| L9: reads skipping the part check | 4 |

**Performance (§12).** Measured on Windows 11 with Python 3.14.6, in two runs on a quiet machine, outside the test guard, in a scratch data root. Values are medians.

| Measure | Before | Now | Why |
| --- | --- | --- | --- |
| Repository identity, cold / warm | 227 / 1.7 µs | 237 / 2.0 µs | unchanged |
| `ensure()`, first write of a namespace | 4.96 ms | **6.2–6.6 ms** | the first containment check for the pair (1.6–1.7 ms; later checks 2 µs) |
| A read lookup | 0.37 ms | **0.53 ms** | the canonical data root (L7): `data_root()`'s `realpath` costs 0.16 ms |
| `ensure()` on a ready namespace | 0.26 ms | 0.22 ms | — |
| `work_items()` over 1,001 work items | 103 ms | 94–96 ms | — |
| 0.1.5's first `.ai/<id>` creation, for comparison | 1.55 ms | 1.19–1.31 ms | — |

- **The cost of correctness.** The added time pays for refusing a data root in a repository and for a canonical root. The atomic publish is kept: nothing was made faster by making it unsafe.
- **Proposed targets.** These are PROPOSED for the owner, not approved:
  - the first `ensure()` below 10 ms on Windows;
  - < 2 ms on Linux and macOS, until CI's timing record gives their numbers;
  - read lookups judged end to end in Batch 2 (preparation within 2% of 0.1.5), since a command resolves its namespace once.

**Owner questions raised (none decided here; decided on 2026-10-16, see "Batch 1 — owner decision gate" below).**
- **Q1, H2:** Windows access lists on Pythons that ignore the mode. Options (a)–(d) above. Recommendation: (c) now, (d) in Batch 2, with (a) reconsidered in Batch 4 if uniformity is wanted.
- **Q2, global storage and H1:** `GlobalStorage` (the configuration folder, where the CLI keeps the Jira token) has no repository, so it cannot apply H1's check. A `BUGPILOT_HOME` inside a checkout would put the configuration there. Options:
  - Batch 2's callers apply the check with the current repository;
  - refuse a data root that has a `.git` ancestor;
  - document only.

  Recommendation: the first, in Batch 2.
- **Q3, H1 policy:** a repository that is the home folder is refused unless `BUGPILOT_HOME` is outside it, and a repository inside the data root is refused. Implemented as the brief proposed; the owner confirms or changes it.
- **Q4, M1 on POSIX without hard links:** refuse (implemented). The alternative is Linux `renameat2(RENAME_NOREPLACE)` through `ctypes`, which is Linux-only.
- **Q5:** L1, L4 and L5 as assessed above.
- **Q6:** the proposed performance targets above.
- **Q7, stray temp names:** whether Batch 2's `clean` removes `.repository.json.*.tmp` files older than a day.

**Local verification** (Windows 11, Python 3.14.6, Node 24.21; `PYTHONPATH` = the repository; `PYTHONDONTWRITEBYTECODE=1`; the test isolation active):

| Check | Result |
| --- | --- |
| The storage suites (`test_storage_identity.py`, `test_storage_safety.py`) | **230 passed, 9 skipped** (239 tests: 116 + 123). Skips: POSIX modes ×6, POSIX letter case, macOS, and `subst` (NOT VERIFIED). The Windows access-list test ran and passed |
| `safe_paths`, file safety, prompt boundary, goldens, publishability, isolation guard, ratchet, baselines (CI's safety-and-baselines file list) | **1,537 passed, 0 failed**, 45 skipped. The six suites that import `safe_paths`, apart from the two storage suites: **126 passed**, 35 skipped (POSIX-only) |
| Baselines | `python tests/storage_baseline.py --check`, twice: **baselines match**, both times |
| Inventory ratchet | `python tests/test_storage_inventory.py`: no change; the record is as Batch 1 left it |
| Python 3.10 syntax | the four Python files parse with `feature_version=(3, 10)`. No 3.10 interpreter here |
| Full Python suite | `python -X utf8 -m pytest -q -p no:cacheprovider -rfEs`: **3,488 passed, 0 failed**, 45 skipped, 19 min 27 s (45 more tests than "as built": the remediation's) |
| Extension: typecheck; unit tests; the required TypeScript job; integration | clean; **2,350 passed**; **27 passed**; **21 passed** |
| Goldens, fixtures, baselines, product files, protected local files | `git diff HEAD` over goldens, baselines, fixtures, `bugpilot/` and `extension/`: only Batch 1's `safe_paths.py`; no product module imports `storage`. The protected local files, the historical plan included, match their recorded SHA-256s. Version 0.1.5 |
| Publishability | passed (within the file list above, after this plan's edits) |
| Whitespace | `git diff --check` clean; the new files are LF with no trailing whitespace; `safe_paths.py` keeps its CRLF working copy |

**Not executed:**
- CI;
- Linux, macOS and Python 3.10 runs (the POSIX permission bits, the POSIX branch of M1 on a real file system without hard links, and macOS cases first run in CI);
- a Python that ignores `mode` on Windows;
- `subst`;
- a real Windows case-sensitive folder;
- a real file system without hard links (exercised by fault injection only);
- Batch 0B probes.

#### Batch 1 — owner decision gate (2026-10-16)

**Status.** The owner ratified Batch 1's architecture decisions and the Q1–Q7 policies, and authorized recording them, two focused test and fixture adjustments, and local verification **only**. Batch 1 stays implemented and verified locally: **not staged, not committed, not pushed; no CI run** (§19). Its commit, push and CI run each need a separate authorization. Batch 0B and Batches 2–5 have not started.

**Decisions ratified** (recorded in §16.1):

| Decision | Owner status | Approved | Remaining condition or open part |
| --- | --- | --- | --- |
| US-D1 | APPROVED | the unified layout, version 1; no `cache/` | — |
| US-D3 | APPROVED | `BUGPILOT_HOME` defines the entire data root | the handling of the deprecated `BUGPILOT_CONFIG_DIR` (the review's warning and `doctor`'s `legacy_config_dir_variable`) remains Batch 2 work |
| US-D5 | APPROVED — with conditions | the §7.2 identity algorithm, with Batch 1's accepted refinements B1-2 (slug edges), B1-13 (a Windows case-only rename of the same folder) and B1-16 (a profile folder's slug is `home`) | Batch 1's cross-platform CI passes before activation |
| US-D6 | APPROVED | the deterministic identity record, published without replacement (B1-14) | — |
| US-D7 | APPROVED | distinct git worktrees use distinct namespaces | — |
| US-D23 | APPROVED — with conditions | private folder creation (`0o700`); existing permissions unchanged; Windows privacy claimed only after verification | Q1's verified access-list check before any credential-bearing write (G-3) |
| US-D24 | APPROVED | a mismatched or corrupt record is refused, never repaired; temporary unreadability is distinguished (B1-15) | — |
| US-D26 | APPROVED — in part | §8.10's defined contract semantics and the fixture's typed `entries` | still OPEN: the `STORAGE_UNAVAILABLE` code. Not approved by this: the rows that follow US-D4 (OPEN), US-D16 (OPEN), US-D18 (PROPOSED), US-D25 (PROPOSED) and US-D3's Batch 2 handling |
| US-D34 | APPROVED — with conditions | canonical root validation, and containment in both directions | the G-1/G-2 activation gate (§14.3) |

No other decision changed.

**Owner policies Q1–Q7.** Approved policy, set apart from what exists today and from what is still to be built:

| | Approved policy | In Batch 1 today | Not yet implemented |
| --- | --- | --- | --- |
| **Q1** Windows privacy | Before any credential-bearing configuration is written, its folder's effective access list is verified; unknown or insufficient protection fails closed. Access lists are never broadened for agents. | Every folder is created `0o700`. Where Python applies that mode (3.10.15+, 3.11.10+, 3.12.4+, 3.13+), the owner-only list is measured, `config/` included. Nothing claims privacy. | the verified access-list check and its refusal (G-3); `doctor`'s report of the effective protection |
| **Q2** global storage | Before global storage is activated, `storage.py` itself, not its consumers alone, keeps BugPilot's data out of git working trees. G-1 and G-2 are resolved, and the detection's limits documented. | Global path resolution is repository-independent. `GlobalStorage.ensure_config_dir()` has **no** containment check (G-2), and H1's check is relative to the folder BugPilot runs in (G-1). | the check at `storage.py`'s own creation and lookup points, for reads and writes; its tests (a checkout subdirectory, global config writes, a home folder that is a git repository); the documented limits (for example dotfiles kept as a bare repository whose git folder is elsewhere, or another version-control system) |
| **Q3** containment | A data root and a repository may not overlap in either direction. | implemented and tested (B1-11) | its extension to git working trees is Q2's |
| **Q4** publication | Hard-link publication that never replaces; on Windows, a rename that cannot replace; on POSIX without hard links, a refusal. | implemented and tested (B1-14) | — |
| **Q5** durability and caches | `fsync` is deferred. Before activation, a long-running consumer re-resolves, or invalidates, every storage and containment cache. | three process-lifetime caches: identities, verified records, containment pairs | the re-resolution or invalidation, in Batch 2 |
| **Q6** performance | First `ensure()`: median < 10 ms on Windows local NTFS; 2 ms on Linux and macOS, a provisional reference; preparation end to end within 2% of 0.1.5 in Batch 2; atomicity never reduced for speed (§12). | Windows: 6.2–6.6 ms | Linux and macOS measurements (CI's timing record); Batch 2's end-to-end measurement |
| **Q7** temporary records | No automatic clean-up of stale temporary records in Batch 2. A later clean-up needs explicit age, ownership and concurrency safeguards. | none exists; a stray `.repository.json.<random>.tmp` may remain | — |

**Findings of the decision-gate review** (read-only, 2026-10-16; no Critical or High finding makes committing the unused foundation unsafe):

| Id | Severity | Finding | Status |
| --- | --- | --- | --- |
| G-1 | Medium | H1's check is relative to the folder BugPilot runs in (US-D4), not to the git working tree around it. A scratch probe (with the test isolation active) accepted: a namespace inside a checkout when run from its `src` subfolder, with `BUGPILOT_HOME` elsewhere in that checkout; global `config/` inside that checkout; and the default data root inside a home folder that is itself a git repository, when run from a project below it. Run at the checkout's root, the namespace is refused as tested. | open: activation blocker 1 |
| G-2 | Medium | `GlobalStorage.ensure_config_dir()` has no containment check (Q2) | open: activation blocker 1 |
| G-3 | Medium | On Windows, folders made by a Python that ignores the mode, and existing folders, keep inherited access lists | open: activation blocker 2 |
| G-4 | Low | The storage objects' public folder fields would let a caller skip the checked methods | open: activation blocker 7 |
| G-5 | Low | The access-list test did not cover `config/`; no dedicated test of "a repository inside the data root" through an alias | the `config/` part is resolved at this gate (below); the alias test is still missing |
| G-6 | Low (process) | The first Linux, macOS and Python 3.10 run of the storage suites, including POSIX permission tests that have never run | open: activation blocker 4 |

**Changes made at the gate:**
- **Fixture:** only the `status` value of `tests/fixtures/storage_cli_contract.json`. It changed from "PROPOSED (US-D26) …" to "APPROVED IN PART (US-D26, by the owner, 2026-10-16) …", which names what stays unapproved. The 46 prose rows, the 46 typed entries and the open choices are unchanged byte for byte.
- **Contract test:** `test_the_contract_fixture_is_well_formed` asserts the new status. It also checks that the status names every decision a row depends on (US-D3, D4, D16, D18 and D25), and that `STORAGE_UNAVAILABLE` stays an open choice.
- **Access-list test:** it now also checks `config/`, which will hold credentials. It is skipped on a volume that keeps no access lists (FAT, exFAT), and its docstring names what it does not cover: a Python that ignores the mode, a network share, and a folder that already existed. A scratch probe confirmed that it bites: a folder made without the mode inside an owner-only parent inherits the same three entries but is not protected, so the test's `protected` assertion fails on it.

**Local verification at the gate** (Windows 11, Python 3.14.6; `PYTHONPATH` = the repository; `PYTHONDONTWRITEBYTECODE=1`; the test isolation active):

| Check | Result |
| --- | --- |
| The storage suites | **230 passed, 9 skipped** (239 tests: 116 + 123; the skips are platform-only, plus `subst`, NOT VERIFIED) |
| Contract fixture tests | **3 passed** |
| The Windows access-list test | **passed**, `config/` included. It ran: Python 3.14.6 applies the mode, and the temporary folder's volume keeps access lists |
| CI's safety-and-baselines file list (publishability, isolation guard, goldens, file safety, prompt boundary) | **1,537 passed, 0 failed**, 45 skipped |
| Inventory ratchet | no change |
| Baselines | `python tests/storage_baseline.py --check`: **baselines match** |
| Plan structure | 0 problems. 39 decisions: 11 APPROVED, 13 OPEN, 11 PROPOSED, 4 DEFERRED; only the nine ratified rows' status and approval columns changed |
| Whitespace | `git diff --check` clean; the changed files are LF with no trailing whitespace |
| Goldens, 0.1.5 baselines, product files, protected local files | unchanged against `HEAD` (in `bugpilot/`, only Batch 1's `safe_paths.py`; `storage.py` is new and unused). The protected local files, the historical plan included, match their recorded SHA-256s. Version 0.1.5 |

#### Batch 1 — acceptance and CI evidence (2026-10-16)

**Status: COMPLETED, CI-verified and integrated into `main`; NOT activated.** No product module imports `storage`: the CLI, MCP and the extension keep 0.1.5's behaviour, and the version stays 0.1.5.
- **Commit:** `5222da79de4dc72335b4e17be15038cf5cf08163`, `feat(storage): add the unused 0.1.6 storage foundation`. It holds exactly the eight-file allowlist, its parent is `64056ca`, and author and committer use the noreply identity.
- **Verification branch:** `verify/0.1.6-batch1`, created at `64056ca` and pushed (no force). The branch is kept.
- **CI on the branch:** workflow `CI` (`.github/workflows/ci.yml`), run 39003264436, started by the owner through `workflow_dispatch`, because a push to a branch other than `main` does not start the workflow. Head `5222da7`, attempt 1. Conclusion: **success**.
- **Integration:** `git merge --ff-only verify/0.1.6-batch1` on `main`: one commit, no merge commit, and the diff `64056ca..5222da7` is exactly the eight files. Pushed normally as `64056ca..5222da7`.
- **CI on `main`:** run 39004684594, started by that push on the same commit. Conclusion: **success**.

**The nine required checks, run 39003264436** (counts from the jobs' published annotations; each Python job also deselects the one test that needs the private word list):

| Check | Result |
| --- | --- |
| Safety and baselines (ubuntu-latest, Python 3.13) | success: 1,535 passed, 33 skipped, 1 deselected |
| Safety and baselines (ubuntu-latest, Python 3.10) | success: 1,535 passed, 33 skipped, 1 deselected |
| Safety and baselines (macos-latest, Python 3.13) | success: 1,537 passed, 31 skipped, 1 deselected |
| Safety and baselines (windows-latest, Python 3.13) | success: 1,534 passed, 47 skipped, 1 deselected |
| Extension evidence boundary (ubuntu-latest) | success: 27 passed |
| Full Python suite (ubuntu-latest) | success: 3,480 passed, 39 skipped, 1 deselected (3 min 9 s) |
| Full Python suite (macos-latest) | success: 3,482 passed, 37 skipped, 1 deselected (7 min 18 s) |
| Full Python suite (windows-latest) | success: 3,485 passed, 47 skipped, 1 deselected (16 min 34 s) |
| Extension unit tests (ubuntu-latest) | success: 2,348 passed, 2 skipped |

**The nine required checks, run 39004684594** (`main`, the same commit):

| Check | Result |
| --- | --- |
| Safety and baselines (ubuntu-latest, Python 3.13) | success: 1,535 passed, 33 skipped, 1 deselected |
| Safety and baselines (ubuntu-latest, Python 3.10) | success: 1,535 passed, 33 skipped, 1 deselected |
| Safety and baselines (macos-latest, Python 3.13) | success: 1,537 passed, 31 skipped, 1 deselected |
| Safety and baselines (windows-latest, Python 3.13) | success: 1,534 passed, 47 skipped, 1 deselected |
| Extension evidence boundary (ubuntu-latest) | success: 27 passed |
| Full Python suite (ubuntu-latest) | success: 3,480 passed, 39 skipped, 1 deselected (2 min 45 s) |
| Full Python suite (macos-latest) | success: 3,482 passed, 37 skipped, 1 deselected (6 min 34 s) |
| Full Python suite (windows-latest) | success: 3,485 passed, 47 skipped, 1 deselected (17 min 13 s) |
| Extension unit tests (ubuntu-latest) | success: 2,348 passed, 2 skipped |

**What this first cross-platform run established** (from the skip lists and the observation records):

| Area | Observed |
| --- | --- |
| Python 3.10 | the safety-and-baselines job on Python 3.10.22 passed, the storage suites included |
| POSIX permission bits | the `0700`/`0600` tests under four umasks, the restrictive umask and the existing-root mode **ran and passed** on Linux (3.13 and 3.10) and macOS; they are skipped only on Windows |
| Windows access lists | the access-list test, `config/` included, **ran and passed** on Windows with Python 3.13.16. It is skipped elsewhere, where POSIX bits prove nothing about it |
| Identity on Linux and macOS | the golden vectors and canonicalization tests passed. Two case-distinct folders gave two IDs on Linux; macOS's case-insensitive volume skipped that test as designed, and its `getcwd()`/`/private/var` test passed |
| Publication and concurrency | the hard-link publish and the two-process race over 50 namespaces passed everywhere; the reader-during-publication test passed |
| No hard links on POSIX | the fail-closed refusal test passed on every system. The two Windows rename tests are skipped elsewhere, because POSIX's `rename` would replace |
| Containment | every H1 test passed everywhere; the Windows case-variant test is skipped elsewhere |
| Baselines | the byte-for-byte comparison passed on Linux (3.10 and 3.13), macOS and Windows |
| Extension and release controls | extension unit tests and the evidence boundary passed; the release-workflow and publishability tests ran in every safety job |

**Timing record** (`storage_timing_*`, from the jobs' annotations; one run each, record only; §12, Q6):

| System | First `ensure()` | Read lookup | Identity cold / warm |
| --- | --- | --- | --- |
| Linux, Python 3.13.16 | 0.36 ms | 58 µs | 19 / 0.5 µs |
| Linux, Python 3.10.22 | 0.55 ms | 81 µs | 36 / 2.4 µs |
| macOS, Python 3.13.16 | 0.72 ms | 68 µs | 25 / 0.5 µs |
| Windows, Python 3.13.16 | 2.83 ms | 358 µs | 182 / 1.8 µs |

Linux and macOS are below Q6's provisional 2 ms reference, and Windows below its 10 ms target. Preparation end to end is Batch 2's measurement.

**Findings.** CI produced no new findings:
- no test failed;
- every annotation was notice-level: summaries, skips and platform observations;
- no Critical or High finding is open. The decision gate's Medium findings G-1, G-2 and G-3 remain open as activation blockers.

GitHub's runner notices were repeated: the `ubuntu-latest` label moves to Ubuntu 26 from 2026-10-19, and macOS arm64 jobs may queue longer.

**Still not verified:**
- a `subst` drive (D0A-5), mapped network drives and NFC/NFD spellings;
- a real Windows case-sensitive folder;
- a real file system without hard links (fault injection only);
- a Python that ignores `mode` on Windows;
- every live agent behaviour (Batch 0B, NOT STARTED).

**Still open, and not resolved by this run:**
- G-1 and G-2: data in a git working tree, and global config writes;
- G-3: the verified Windows access-list check;
- cache freshness for long-running consumers;
- the other §14.3 blockers.

**Version:** 0.1.5, unchanged. **Decisions:** as ratified at the decision gate; none changed here. US-D5's CI condition is met, and its status is left for the owner. **Batch 0B and Batch 2:** NOT STARTED.

**The documentation commit's own run** (observed after it was pushed; recorded with Batch 2A, 2026-10-17): run 39005917365, push to `main` on `6f8e0b2`: **success, 9/9**. §19 records it.

### 14.3 Batch 2 — Python CLI, MCP and prompts on the new layout

This batch moves implementation paths, **not user data**: nothing is copied, imported, renamed or deleted, and no legacy reader is added.

**1. Scope.** Every Python reader and writer of F01–F17 and F21–F25 moves to `storage`, and every agent-facing and human-facing Python string (§5.5 A and B) changes. Specifically:

- the JSON contract, exactly as §8.10 and its fixture state;
- `doctor`'s `storage` object and the `unified-storage` capability;
- the `--feedback-file` flag (US-D18);
- the Python launch gate (T-S12);
- the removal of the gitignore probe (US-D16);
- the goldens.

**2. Files.**

| Area | Files |
| --- | --- |
| Paths | `config.py`, `user_config.py`, `instructions.py`, `verification.py`, `ai_behavior.py`, `project_settings.py`, `repository_profile.py`, `fix_mode_store.py`, `fix_mode_state.py`, `cleanup.py`, `memory.py`, `attachments.py` (docstring), `identity.py` (docstring) |
| Pipeline and text | `workflow.py`, `prompts.py`, `handoff.py`, `context.py`, `email_notify.py`, `jira.py`, `issue.py`, `retrieval.py`, `run.py`, `review_report.py`, `verification_report.py`, `fix_report.py`, `task_preview.py`, `context_preview.py`, `agent_runner.py`, `copilot.py` |
| Diagnostics | `git_ops.py`, `doctor.py` |
| Entry points | `cli.py`, `cli_json.py`, `mcp_server.py` |
| Guards (comments only, US-D15) | `search.py`, `review_changes.py`, `verification.py` lint |
| Non-Python | `skills/bugpilot-investigate/SKILL.md`, `scripts/send-via-outlook.ps1`, `scripts/check_cli_contract.py` |
| Tests | the modules listed in §11.4 and §11.5, about 50; the goldens (§11.6); `tests/fixtures/repository_profile_contract.json`; the new suites `test_repository_pollution.py`, `test_no_legacy_data.py`, `test_storage_contract.py` |
| Records | `tests/storage_inventory.json` (shrunk); this plan |

**3. Preconditions.**

- Batch 1 is on `main`. The owner approved §8.10 and its fixture **in part** on 2026-10-16 (US-D26); their open parts are decided before they are built (blocker 5 below).
- **Batch 1 activation blockers** (owner, 2026-10-16). They are mandatory before any caller switches to `storage`. **Only blocker 4 is met** (2026-10-16, run 39003264436; §14.2 "Batch 1 — acceptance and CI evidence"). The others are not:
  1. **G-1 and G-2** are resolved in `storage.py`: no BugPilot data inside a git working tree, for reads and writes, global and repository alike. Tests cover a checkout subdirectory, global config writes and a home folder that is a git repository, and the detection's limits are documented (Q2). *(The storage side is committed and CI-verified (Batch 2A: `e78a678`, runs 39057483843 and 39062906366). The blocker stays listed until Batch 2B's consumers reach the data root only through the checked methods.)*
  2. **G-3** is resolved: a verified Windows access-list check before any credential-bearing write, failing closed (Q1). *(The storage side, the privacy check and `write_config_file()`, is committed and CI-verified (Batch 2A). The blocker stays listed until Batch 2B's credential writer uses `write_config_file()`.)*
  3. **Cache freshness:** long-running consumers (the MCP server) re-resolve, or invalidate, the identity, verified-record and containment caches (Q5). *(The storage side is committed and CI-verified (Batch 2A). Still open: the consumer side, one request scope per CLI command and per MCP tool call (Batch 2B).)*
  4. **Batch 1's cross-platform CI** passes: Linux, macOS and Windows, and Python 3.10. This is also US-D5's condition. **Met:** run 39003264436 on `5222da7`, all 9 required checks green.
  5. **The outstanding Batch 2 consumer contract decisions** are approved: the open parts of US-D26 (§8.10).
     *(2026-10-19: still open. Batch 2B-2 would switch callers while `STORAGE_UNAVAILABLE` is OPEN. This is Q-1 of §14.3, "Batch 2B-2 — decision gate"; nothing is implemented until the owner answers it.)*
     *(Later on 2026-10-19: Q-1 was approved in principle, as an internal classification with no new code. Blocker 5 is met for 2B-2 only, once C-1 is answered. The public `STORAGE_UNAVAILABLE` code stays OPEN, and is needed before 2B-4 (§14.3, "Batch 2B-2 — final contract resolution").)*
     *(C-1 answered later that day: M-1 is approved, so blocker 5 is met for 2B-2 only. `STORAGE_UNAVAILABLE` stays OPEN.)*
  6. **Batch 0B's live-agent evidence** stays the gate for every function that needs it.
  7. **Source and behavioural tests** fail on any unguarded write under the data root (G-4). *(The static half is committed and CI-verified (Batch 2A). Still open: the end-to-end write witness (Batch 2B).)*
  8. **0.1.5 behaviour is preserved** until the authorized integration batch.
- Batch 0B is complete for the probes this batch depends on: P1, P2, P3 and P8, each recorded as PASS, FAIL or UNKNOWN (§9.7).
  - *(2026-10-19, D-7: the global-configuration slice, 2B-2, needs no live-agent probe. This waives nothing else: P1, P3 and P8 stay NOT EXECUTED, and P2 stays FAIL. Whether this precondition applies per slice is Q-3.)*
  - *(Q-3, approved with conditions on 2026-10-19: the precondition applies per slice, but missing evidence is never a pass. P1, P2, P3 and P8 stay gates for the slices that depend on them, and for activation.)*
- **The critical handoff decisions are resolved by the owner.** A storage-changing Batch 2 does not begin while any of these is OPEN:
  - US-D10 (handoff), decided on the 0B evidence *(APPROVED with conditions on 2026-10-18 as a design, with the probe gap accepted for design only: §9.5.1)*;
  - US-D28 (captured review), decided on P2 *(APPROVED with conditions on 2026-10-18, as a design contract: §16.5.11)*;
  - US-D14 (the protected staging rule), decided among §16.4's options *(APPROVED with conditions on 2026-10-18, as Refined Option A′: §16.4.1)*.
- These decisions are approved: US-D2, D4, D8, D9, D13, D15, D16, D18, D21, D22, D25, D27, D29, D30, D31.
  - *(2026-10-19, Batch 2B-2 decision gate: US-D2 APPROVED with conditions; US-D29 and US-D22 APPROVED in part. The others in this list stay OPEN or PROPOSED. Whether the list applies to the whole of Batch 2 or per slice is Q-3.)*
  - *(Q-3, approved with conditions on 2026-10-19: each slice needs the decisions its own scope touches (the per-slice prerequisites of §14.3, "Batch 2B-2 — final contract resolution"). Every decision in the list stays required for activation.)*
- The owner has approved creating `verify/0.1.6-storage` from `main` (§15.2).
  - *(2026-10-19, D-1: approved, based on `73ee57e`. It is not created yet; creating it is part of an authorized implementation (§14.3, "Batch 2B-2 — decision gate").)*
  - *(C-5 (a), approved on 2026-10-19: instead, the branch is created from the verified `main` commit that carries the documentation-only record of this decision, and only when the owner authorizes it.)*

**4. Explicit exclusions.**

- no extension source change (the extension is knowingly broken on this branch until Batch 3; §15);
- no retrieval, ranking or Context Quality change;
- no protected-rule text change beyond what US-D14 decides;
- no new CLI command other than the `--feedback-file` option, unless US-D21 adds one;
- no data migration and no legacy reader.

**5. Steps.**

1. Route `config.issue_dir`, `writable_issue_dir`, `memory_dir` and `writable_memory_file` through `storage`, and replace the 12 direct joins (§4.2).
2. Settings modules: path accessors, `display_path`, link checks with the new base. Fix Mode store: `scope_dir`, plus error text in display form (SF-3).
3. `user_config`:
   - the folder becomes `config/` (US-D2);
   - `BUGPILOT_HOME` replaces `BUGPILOT_CONFIG_DIR` (US-D3), which is no longer honoured. US-D3's safe warning: one stderr line in text mode, plus `doctor`'s `legacy_config_dir_variable`; the variable's value is never read;
   - the private write is unchanged.
4. Memory: `memory/<id>.md`; the entry text and the `search_memory` `file` field.
5. `clean` on the data-root base (§8.4).
6. `list`: `storage.work_items()`, with `work_dir` and `modified`.
7. Texts per §9.8:
   - `task.md`'s protected sections;
   - the retry prompt, the review prompt and the `context.md` sentence;
   - MCP INSTRUCTIONS, `next_step` and the tool descriptions;
   - `handoff.py` and SKILL.md;
   - the protected staging rule exactly as US-D14 decided (§16.4). Under option B, its wording and tests get their own review and approval *before* any golden is regenerated.

   Then regenerate the goldens and run the scripted diff check (§11.6).
8. Contract (§8.10; the fixture is the reference):
   - the JSON fields, the JSON-lines events and MCP;
   - `doctor`'s `storage` and the capability;
   - remove `ai_artifacts_ignored*` (US-D16).
9. `bug --retry --feedback-file <path>`. It copies the file into `user_feedback.md` with the atomic writer, and refuses a link at the source.
10. `agent_runner`: the plain-prompt rule before launch (T-S12).
11. Every message in display form (US-D22), and the `--launch-agent` retry sentence fixed (SF-9).
12. `send-via-outlook.ps1`: takes the draft path (SF-10).
13. Tests: path updates; the new suites; the ratchet shrunk to the Python residue.

**6. Acceptance.**

- The pollution and no-legacy-data suites are green.
- The ratchet holds only the Python residue.
- The goldens differ only as §11.6 lists (scripted).
- The protected-rules digest is as US-D14 decides.
- The task-size gate holds as US-D30 decides.
- Recall@5 9/9, MRR 0.944, Context Quality unchanged; both oracles report 0 escapes.
- Read-only commands leave the data root byte-identical (snapshot).
- §12 budgets are met.
- **Every Python test passes**: the full suite on Windows locally, and on Ubuntu 3.13 and 3.10, macOS and Windows through owner-dispatched CI on `verify/0.1.6-storage`. No Python failure is accepted.
- **Extension failures are ledgered** (§15.4). Each one that follows *solely* from the unimplemented Batch 3 contract is listed individually in §18: test, contract item, message, commit.
  - Any failure not on the ledger is a regression.
  - No test is skipped, deleted, loosened or marked expected-to-fail to hide one.
  - A red required job is reported as red.
- The version is still 0.1.5. Nothing is pushed beyond the branch, and nothing is fast-forwarded.

**7. Security tests.** T-S2, T-S5, T-S7, T-S10, T-S11, T-S12 (Python), T-S13, T-S14, T-S15, T-S20, T-S21 (golden text), T-S22, end to end.

**8. Regression.** All of §11.4, with the expected changes listed there.

**9. Cross-platform.** CI on the four Python configurations; the POSIX mode tests on the new tree.

**10. Rollback.** The branch is not merged; reset the branch or revert commits. `main` is unaffected.

**11. Dependencies.** Batch 1 (the API and the contract fixture), Batch 0A (isolation), Batch 0B (the probes behind US-D10 and US-D28).

**12. Stop and approval gate.**

- **Stop if:**
  - a golden changes outside the designed lines;
  - an MCP key would have to change;
  - a protected-rule text change is needed that US-D14 did not approve;
  - the size gate cannot meet US-D30's choice;
  - a writer into the repository remains that the plan cannot remove;
  - a test would have to be skipped, deleted or weakened to pass;
  - a Python test fails;
  - an extension failure does not follow solely from the Batch 3 contract.
- **Gate:** the owner reviews the ledger and approves continuing with Batch 3 on the same branch.

#### Batch 2A — storage security foundation (as built, 2026-10-17)

**Status: implemented and verified locally on Windows. Not staged, not committed, not pushed; no CI run** (§19). *(Committed, CI-verified and integrated into `main` on 2026-10-17: see "Batch 2A — acceptance and CI evidence" below.)* The foundation is still **not activated**: no product module imports `storage`. Batch 2B (the switch of callers) and Batch 0B have NOT STARTED, and Batch 2 as a whole is not complete.

| | |
| --- | --- |
| Authorized | 2026-10-17, the owner's Batch 2A brief, on `main` at `6f8e0b2`: G-1/G-2, G-3, cache freshness, checked global accessors, the API boundary tests and local verification only |
| Version | 0.1.5, unchanged |
| Product behaviour | unchanged: no CLI, MCP or extension caller is switched, the 0.1.5 storage is untouched, and no user data was read |
| Goldens, fixtures, baselines | unchanged, the frozen 46-entry contract fixture included; the ratchet record is unchanged |
| Accounts | none: no Jira, no agent, no live probe |

**Files.**

| File | Change |
| --- | --- |
| `bugpilot/core/storage.py` | the Git working-tree rule, the credentials gate, request scopes, the re-checked identity cache, checked global accessors, private folder fields, `diagnostics()` |
| `bugpilot/core/private_folder.py` | **new**: `verify_private(path, role) -> PrivacyVerdict`, read only. Windows through `ctypes`, every call with declared types; POSIX through the owner and the permission bits |
| `tests/test_storage_identity.py` | cache-freshness tests; the folder fields are private now |
| `tests/test_storage_safety.py` | the G-1/G-2 scenarios (markers and real git), scope and retarget regressions, diagnostics, the credentials gate; the CI timing record extended |
| `tests/test_private_folder.py` | **new**: the Windows and POSIX rules as tables on every system; real folders; descriptors built from SDDL |
| `tests/test_storage_api_boundary.py` | **new**: the static boundary |
| `.github/workflows/ci.yml` | the two new modules join `safety-and-baselines`, with a header comment. Job names, pins and permissions unchanged; nine checks |
| this plan | this section; §8.3, §10.2 (T-S27 to T-S29), §12, §14.0, §14.2, the §14.3 blockers, §18, §19 |

**G-1 and G-2: never inside a Git working tree.** `_git_tree_problem` judges the **data root** only. It runs in `RepositoryStorage._check_containment`, so before every repository read and write, and in every `GlobalStorage` method, reads included. Only `diagnostics()` skips it.
- **Rule 1.** A `.git` entry, folder or file, in the canonical data root or any folder above it, up to the top of the volume. One `lstat` per component, never a text prefix. `realpath` has already resolved links and junctions, so an alias is judged where it lands. An empty or broken `.git` folder counts.
- **Rule 2.** `GIT_WORK_TREE`, when not blank (it is stripped): a relative value is resolved against the working directory, as Git resolves it, then `realpath`; the data root may not lie inside it (a component comparison). A control character, a value that cannot be resolved, or a relative value whose working directory is gone, refuses.
- **Fail closed.** An `lstat` error other than "not there" refuses: "cannot tell".
- **Order.** H1's repository containment is checked first, so a data root inside the repository itself keeps its more specific message.
- **US-D4 unchanged.** The repository's identity and scope stay the folder BugPilot runs in, and no `git` command runs.
- **Known gaps, stated in the code:** a work tree that no `.git` marks and no `GIT_WORK_TREE` names (a bare repository used with `--work-tree` or `core.worktree`); `GIT_DIR` alone; other version-control systems.
- **Tests:** a subfolder run (markers and real git), global configuration, a home folder that is a Git repository, a linked worktree and `--separate-git-dir` (real git), a `.git` file or empty folder, symbolic-link and junction aliases, `GIT_WORK_TREE` absolute, relative, through a link, blank, malformed and unresolvable, a folder that cannot be examined, data roots beside checkouts and repositories that are checkouts (accepted), and a `.git` made later. Every refused access creates nothing, and no message holds a path.

**G-3: credentials only where they are private.**
- **The check** (`private_folder.verify_private`): three answers, `private`, `not-private` or `unverifiable`. The reasons name kinds of account, never a name or a SID. It only reads.
- **Roles.** The data root: a trusted owner, and no one else may write to it. `config/`: owned by this user (or, on Windows, SYSTEM or Administrators), and no one else has any access to it or to what is created in it. The credentials file: a regular file, not a link, with no one else having any access.
- **Windows.** The volume must keep access lists (`FILE_PERSISTENT_ACLS`), otherwise unverifiable. The owner and DACL come from `GetNamedSecurityInfoW`. Trusted: this user, SYSTEM, Administrators and OWNER RIGHTS. The CREATOR OWNER placeholder, deny entries and grants of nothing but SYNCHRONIZE, READ_CONTROL and FILE_READ_ATTRIBUTES are passed over. Inherited entries, and entries that reach only new files, count. A NULL DACL is not private. Any other entry type, an unreadable SID, a missing owner or an API failure is unverifiable. Handles and buffers are freed in `finally`. The answer comes from the disk, so it is version-independent: on Python 3.10 and 3.11, which ignore `mode`, a folder under the user's profile inherits a private list and passes, and a shared drive's list fails.
- **POSIX.** The owner (the effective user; root too for the data root) and the bits: the data root may not be writable by group or others, with no sticky-bit exception; `config/` and the file may have no group or other bits at all.
- **The gate.** `GlobalStorage.config_file(create=True)` checks the data root, `config/` and an existing `config.toml`. `write_config_file(text)` writes with `atomic_write_text(private=True)` and checks the file again afterwards. Not private or unverifiable: refused, and nothing written. Nothing is ever loosened or tightened, and the text never appears in a message. Reads (`create=False`) are not gated. `instructions.md` and `fix_modes/` are not credentials and are not gated, but keep every other check.
- **Stated gaps:** macOS extended ACLs; the folders above the data root; a network share, which answers with what its server reports, or is unverifiable. FAT and exFAT are always unverifiable, so credentials cannot be written there.

**Cache freshness.**
- **Identities.** At most 128 spellings, each with its canonical folder's device and file index. Every hit `stat`s the spelling again (following links) and compares. A different folder, a missing one or an index of 0 is resolved afresh, and an unstable one is never cached. A folder replaced at the same path keeps its path-based ID, by design (§7.2).
- **Verdicts.** Containment, Git working-tree and verified-record verdicts are kept only within `request_scope()`. Outside one, every check looks at the disk. An inner scope joins the outermost; every public storage operation opens one; Batch 2B opens one per CLI command and one per MCP tool call. Batch 1's process-lifetime pair cache and its verified-record dictionary are gone.
- **The record's signature** adds `st_ctime_ns` on POSIX. On Windows that field is the creation time and would add nothing.
- **Regressions:**
  - the bypass the preflight reproduced (a retargeted symbolic-link or junction root, writing into a folder that holds the data root) is refused, and nothing is created;
  - a retarget to another repository gets that repository's namespace;
  - a `.git` made later is seen at once outside a scope, and by the next scope;
  - a record rewritten in place, same size and modification time, is refused by the next scope, and on POSIX within the same scope.

**Checked accessors and private fields.** These supersede the public folder fields of §8.2's sketch:
- `GlobalStorage` keeps only `_data_root` and `_config_dir`.
- `RepositoryStorage` keeps `identity` public and `_data_root` and `_directory` private. Its `settings_dir`, `work_root` and `memory_dir` fields are gone; the accessors derive them.
- New: `GlobalStorage.config_file(create=)`, `write_config_file(text)`, `user_instructions_file(create=)`, `user_fix_modes_dir(create=)` and `diagnostics()`; `RepositoryStorage.diagnostics()`; `request_scope()`. `diagnostics()` returns §8.10's `doctor` key names as text, and checks or creates nothing.

**The storage API boundary** (`tests/test_storage_api_boundary.py`):
- no production module imports `storage`; `APPROVED_IMPORTERS` is empty, and Batch 2B fills it by name;
- `private_folder` is used by `storage` alone;
- no production module touches storage's private fields or helpers, or spells the layout's strings;
- the dataclasses expose no folder, and diagnostics create nothing;
- the scanners are shown to bite.

The module states its limits: computed names, and what a caller does with a path it was given, are left to Batch 2B's write witness.

**Deviations from the preflight design, recorded:**

| Id | What | Why |
| --- | --- | --- |
| D2A-1 | Verified-record verdicts are scope-bound, not only re-signed | "never trusted because an earlier version was cached" then holds on Windows too, where `st_ctime_ns` adds nothing |
| D2A-2 | The data root is judged on write access only; `config/` and the file on any access | others may list the data root; for the credentials, only swapping its folders matters |
| D2A-3 | POSIX data root: no sticky-bit exception, and no folder above it checked | the stricter reading of "not writable by untrusted users"; no parent-folder policy was approved |
| D2A-4 | `write_config_file()` is the one writer of credentials, and checks after the write too | a checked path written with weaker protection would otherwise pass |
| D2A-5 | `diagnostics()` gives paths only; `state` and `problem` stay `doctor`'s (Batch 2B) | paths need no check; states do |
| D2A-6 | `RepositoryStorage` loses its `settings_dir`, `work_root` and `memory_dir` fields | private fields where practical: fewer handles that bypass the accessors |
| D2A-7 | Reads of the credentials file are not gated | refusing to read a file already exposed protects nothing; `doctor` reports privacy in Batch 2B |
| D2A-8 | Every refusal stays a `StorageError` (`INVALID_INPUT`) | `STORAGE_UNAVAILABLE` is still OPEN (US-D26) |

**Each control bites.** 24 mutations of `storage.py` and `private_folder.py` were each run on a copy outside the repository, against the four storage test files. 23 were caught on Windows. The `st_ctime_ns` mutation matters only on POSIX, and its test first runs in CI. Two mutations of the first attempt were replaced as equivalent, because nothing reachable could tell them apart: resolving a relative `GIT_WORK_TREE` without the explicit join (`realpath` joins the working directory anyway), and caching verdicts outside a scope (every public operation opens one). Their replacements are in the table. An early run's failures of two Git tests, caused by long scratch paths on Windows, were removed by shorter scratch names.

| Mutation | Tests that failed (Windows) |
| --- | --- |
| G-1: a .git marker found is ignored | 12 |
| G-1: only the data root itself is looked at, not the folders above | 12 |
| G-1: a folder that cannot be examined is passed over (fail open) | 1 |
| G-1: GIT_WORK_TREE ignored | 5 |
| G-1: a relative GIT_WORK_TREE is ignored | 2 |
| G-1: a malformed GIT_WORK_TREE is accepted | 1 |
| G-2: global configuration skips the Git check when created | 17 |
| G-2: global reads skip the Git check | 18 |
| G-1: repository namespaces skip the Git check | 3 |
| G-3: the credentials gate removed | 4 |
| G-3: an existing credentials file is not checked | 1 |
| G-3: unverifiable is accepted (fail open) | 1 |
| G-3: no check after the write | 1 |
| rule: grants that only reach new files are ignored | 3 |
| rule: an unknown access entry is passed over | 3 |
| rule: no access list (NULL DACL) is accepted | 2 |
| rule: a foreign owner is accepted (Windows) | 3 |
| rule: POSIX group access to config/ ignored | 2 |
| rule: a link at the credentials file accepted (POSIX) | 1 |
| cache: an identity hit is trusted without re-checking the folder | 6 |
| cache: every scope shares one dictionary (verdicts outlive their scope) | 6 |
| cache: a cached record is trusted whatever changed | 1 |
| cache: an inner scope starts afresh instead of joining | 3 |
| cache: st_ctime_ns left out of the record signature (POSIX only) | **0 on Windows**: POSIX-only, its test runs in CI |

**Performance** (Windows 11, Python 3.14.6, local NTFS; two runs, shown as run 1 / run 2; the scratch data root is 13 components deep, where the default `~/.bugpilot` is about 4; medians; outside the test guard, in a scratch data root):

| Measure | Median |
| --- | --- |
| identity, uncached (realpath + SHA-256 + stat) | 344 µs / 350 µs |
| identity, cached hit (re-checked with one stat) | 41 µs / 41 µs |
| Git working-tree check, outside a scope (13 components) | 908 µs / 911 µs |
| the same, per component looked at | 70 µs / 70 µs |
| Git working-tree check, remembered in a scope | 1.5 µs / 1.7 µs |
| data_root() (realpath), for comparison | 195 µs / 185 µs |
| ensure(), first write of a namespace | 8.43 ms / 8.87 ms |
| ensure() repeated, outside a scope | 3.46 ms / 3.53 ms |
| ensure() repeated, in one scope | 534 µs / 520 µs |
| record verification (read + parse), outside a scope | 456 µs / 477 µs |
| read lookup work_item_dir(create=False), outside a scope | 3.61 ms / 3.55 ms |
| read lookup, in one scope | 636 µs / 640 µs |
| containment check, outside a scope | 1.56 ms / 1.53 ms |
| privacy check, data root | 2.46 ms / 2.41 ms |
| privacy check, config/ | 2.68 ms / 2.33 ms |
| config_file(create=True): Git check + 2 privacy checks | 6.97 ms / 6.64 ms |
| write_config_file(): + atomic private write + file check | 15.55 ms / 16.32 ms |

- **Against the targets (Q6).** The first `ensure()` stays below the 10 ms Windows target, but rose from Batch 1's 6.2–6.6 ms. The Git working-tree walk costs about 70 µs per folder on the way up: about 0.9 ms here, about 0.3 ms at the default depth (an estimate from the per-folder figure). Linux and macOS numbers come from CI's timing record, which now includes the Git check and the privacy check.
- **Outside a scope every operation looks at the disk again:** a repeated `ensure()` or read lookup costs about 3.5 ms, against about 0.5–0.65 ms within one scope (Batch 1's read lookup: 0.53 ms). Batch 2B must therefore open one scope per CLI command and per MCP tool call: for freshness, and for these numbers.
- **A privacy check costs about 2.4 ms on Windows** (the access-list, volume and account queries). Only a credentials write pays it, three times: about 7 ms to make the path ready and about 16 ms for the whole write. That is rare (setting up Jira), so nothing is cached.
- **Atomicity unchanged:** the record is still published by hard link, and the credentials file by the private atomic writer.

**Local verification** (Windows 11, Python 3.14.6, Node 24.21; `PYTHONPATH` = the repository; `PYTHONDONTWRITEBYTECODE=1`; the test isolation active):

| Check | Result |
| --- | --- |
| The four storage suites | **339 passed, 17 skipped**: `test_storage_identity.py` 120 passed, 3 skipped; `test_storage_safety.py` 157 passed, 10 skipped; `test_private_folder.py` 53 passed, 4 skipped; `test_storage_api_boundary.py` 9 passed. Every skip is a POSIX-only case, a macOS or POSIX letter-case case, or `subst` (NOT VERIFIED). The real-git worktree and `--separate-git-dir` cases ran |
| CI's safety-and-baselines file list (28 files, run exactly as `ci.yml` lists them) | **1,645 passed, 0 failed**, 53 skipped, 1 deselected (the private word list) |
| `safe_paths` regressions (the five suites that import it, apart from storage's) | **126 passed**, 35 skipped (POSIX-only) |
| Isolation guard, ratchet, release workflow, CI report, publishability, unwired symbols | **132 passed**; all also in the safety list above |
| Inventory ratchet | no change: `tests/storage_inventory.json` was not updated |
| Baselines | `python tests/storage_baseline.py --check`, twice: **baselines match** both times |
| Full Python suite | `python -X utf8 -m pytest -q -p no:cacheprovider -rfEs`: **3,597 passed, 0 failed**, 53 skipped, 22 min 3 s (117 more tests than Batch 1's 3,533) |
| Extension | typecheck clean; unit tests **2,350 passed**; the required TypeScript job **27 passed**; the isolated integration suite **21 passed** |
| Goldens, fixtures, baselines, product files | unchanged against `HEAD`, the 46-entry contract fixture included; in `bugpilot/` only `storage.py` changed, and `private_folder.py` is new; no product module imports either; version 0.1.5 |
| Python 3.10 syntax | the six Python files parse with `feature_version=(3, 10)`; no 3.10 interpreter here |
| Whitespace | `git diff --check` clean; the new and changed files are LF with no trailing whitespace |

**Still open before Batch 2B can activate** (§14.3's blockers):
- **1–3:** the storage side is implemented here, but is satisfied only once it is committed and CI-verified, and the consumers open their scopes (2B).
- **4:** met.
- **5:** open. The consumer contract decisions: `STORAGE_UNAVAILABLE` (OPEN), US-D4's `below_git_toplevel` (OPEN), US-D16's `ai_artifacts_ignored*` removal (OPEN), US-D3's deprecated-variable handling (Batch 2 work), US-D18's `--feedback-file`, which must refuse a source inside `config/` (PROPOSED), and US-D25's `run.json` (PROPOSED).
- **6:** open.
- **7:** the static half is here; the write witness is 2B's.
- **8:** holds.

**Not executed:**
- CI;
- Linux, macOS and Python 3.10 (the POSIX privacy cases, the POSIX `ctime` test and the POSIX mode tests first run in CI);
- a FAT or exFAT volume;
- a network share;
- a Windows Python that ignores `mode` (the rule tables cover it);
- macOS ACLs;
- Batch 0B.

#### Batch 2A — acceptance and CI evidence (2026-10-17)

**Status: COMPLETED, CI-verified and integrated into `main`; NOT activated.** No product module imports `storage` or `private_folder`; the CLI, MCP and the extension keep 0.1.5's behaviour; the version stays 0.1.5.
- **Commit:** `e78a6789fe5dcc4144bc6e21b5427e552bc0bb5b`, `fix(storage): harden unified storage safety and cache freshness`. It holds exactly the eight-file allowlist, its parent is `6f8e0b2`, and author and committer use the noreply identity.
- **Verification branch:** `verify/0.1.6-batch2a`, pushed without force and kept.
- **CI on the branch:** run 39057483843 (`CI`, `workflow_dispatch` by the owner), head `e78a678`, attempt 1: **success, 9/9**.
- **Integration:** `git merge --ff-only verify/0.1.6-batch2a` on `main` gave one commit and no merge commit, exactly the eight files. Pushed normally as `6f8e0b2..e78a678`.
- **CI on `main`:** run 39062906366, started by that push on the same commit: **success**.

**The nine required checks, run 39057483843** (counts from the jobs' published annotations; each Python job also deselects the one test that needs the private word list):

| Check | Result |
| --- | --- |
| Safety and baselines (ubuntu-latest, Python 3.13) | success: 1,632 passed, 47 skipped, 1 deselected |
| Safety and baselines (ubuntu-latest, Python 3.10) | success: 1,632 passed, 47 skipped, 1 deselected |
| Safety and baselines (macos-latest, Python 3.13) | success: 1,634 passed, 45 skipped, 1 deselected |
| Safety and baselines (windows-latest, Python 3.13) | success: 1,643 passed, 55 skipped, 1 deselected |
| Extension evidence boundary (ubuntu-latest) | success: 27 passed |
| Full Python suite (ubuntu-latest) | success: 3,577 passed, 53 skipped, 1 deselected |
| Full Python suite (macos-latest) | success: 3,579 passed, 51 skipped, 1 deselected |
| Full Python suite (windows-latest) | success: 3,594 passed, 55 skipped, 1 deselected |
| Extension unit tests (ubuntu-latest) | success: 2,348 passed, 2 skipped |

**The nine required checks, run 39062906366** (`main`, the same commit):

| Check | Result |
| --- | --- |
| Safety and baselines (ubuntu-latest, Python 3.13) | success: 1,632 passed, 47 skipped, 1 deselected |
| Safety and baselines (ubuntu-latest, Python 3.10) | success: 1,632 passed, 47 skipped, 1 deselected |
| Safety and baselines (macos-latest, Python 3.13) | success: 1,634 passed, 45 skipped, 1 deselected |
| Safety and baselines (windows-latest, Python 3.13) | success: 1,643 passed, 55 skipped, 1 deselected |
| Extension evidence boundary (ubuntu-latest) | success: 27 passed |
| Full Python suite (ubuntu-latest) | success: 3,577 passed, 53 skipped, 1 deselected |
| Full Python suite (macos-latest) | success: 3,579 passed, 51 skipped, 1 deselected |
| Full Python suite (windows-latest) | success: 3,594 passed, 55 skipped, 1 deselected |
| Extension unit tests (ubuntu-latest) | success: 2,348 passed, 2 skipped |

**The counts agree with Batch 1's CI.** Windows gained 117 tests (109 passed, 8 skipped), as many as Batch 2A added. Linux and macOS gained 111 (97 and 14), because six link-parametrized tests run once on POSIX (a symbolic link) and twice on Windows (a symbolic link and a junction).

**Evidence, and how direct it is.** Per-test results are not published, and the job logs need administrator rights. "Ran and passed" below therefore means: absent from that job's published skip list, in a job whose summary reports 0 failures and 0 errors.

| Area | Observed |
| --- | --- |
| POSIX privacy | On Linux 3.13, Linux 3.10 and macOS the storage suites skipped only Windows-only tests. The POSIX real-folder privacy tests of `test_private_folder.py` (owner-only, a link, another owner, a path that cannot be examined) and the POSIX credentials-gate test (3 cases) ran and passed: their first observed runs |
| `st_ctime_ns` | `test_on_posix_an_in_place_rewrite_is_seen_even_within_one_scope` ran and passed on Linux 3.13, Linux 3.10 and macOS, and is skipped only on Windows, as designed. That the mutation removing `st_ctime_ns` is caught on POSIX is **inferred**: CI does not run the mutation harness, which caught the other 23 mutations on Windows |
| Python 3.10 | The Ubuntu 3.10.22 safety job passed, with exactly the 3.13 job's skips, so all four Batch 2A test files ran on 3.10. The full suite runs on 3.13 only |
| Windows access lists | On Python 3.13.16 the Windows jobs skipped only the 17 POSIX-only storage tests. The owner-only access-list test (`config/` included), the real-folder grant tests, the 7 SDDL descriptor cases, the volume and API-failure cases and the two icacls credentials-gate cases ran and passed |
| Junction retargeting | The junction cases of the retarget, alias and link tests, and of the identity-retarget test, ran on Windows. This is a strong inference: the code adds them on Windows only, none was skipped, and the 117 / 111 counts differ by exactly those six |
| Baselines, goldens, ratchet | The commit touches no golden, baseline, fixture or `storage_inventory.json`. The storage-baseline, inventory, task-golden and prompt-boundary suites appear in no skip list and passed in all four safety jobs |
| Extension | The evidence boundary passed 27 of 27, and the unit tests 2,348 with 2 skipped, both unchanged |

**Timing record** (`storage_timing_*`, from the annotations of run 39057483843; one sample per job, under the test guard, recorded and never asserted; §12, Q6):

| System | First `ensure()` | Read lookup, outside / in a scope | Git working-tree check | Privacy check |
| --- | --- | --- | --- | --- |
| Linux, Python 3.13.16 | 0.89 ms | 0.48 / 0.14 ms | 0.18 ms | 0.04 ms |
| Linux, Python 3.10.22 | 0.68 ms | 0.32 / 0.08 ms | 0.13 ms | 0.04 ms |
| macOS, Python 3.13.16 | 0.93 ms | 0.38 / 0.09 ms | 0.16 ms | 0.03 ms |
| Windows, Python 3.13.16 | 2.15 ms | 0.88 / 0.18 ms | 0.37 ms | 0.60 ms |

- **Against Q6:** every first `ensure()` is within its target, below 10 ms on Windows and below the provisional 2 ms on Linux and macOS.
- **Against Batch 1's run:** the first write rose on Linux and macOS (Linux 3.13: 0.36 to 0.89 ms) and fell on Windows (2.83 to 2.15 ms).
- **Outside a scope, reads cost far more** (Linux: 58 to 483 µs), because nothing is kept across operations any more. So Batch 2B must open one request scope per CLI command and per MCP tool call, for freshness and for speed. The local Windows figures are in "Batch 2A — as built".

**Findings.** CI produced no new findings. No test failed, every annotation was notice-level, and no Critical or High finding is open. GitHub's runner notices were repeated (the `ubuntu-latest` move to Ubuntu 26 from 2026-10-19; macOS arm64 queue times).

**Missing evidence:**
- per-test names and the job logs (administrator rights needed);
- artifact downloads, which need authentication (their records also appear in the annotations, which were read);
- the mutation harness on POSIX;
- the full suite on Python 3.10;
- the extension integration suite, which CI does not run (local only: 21 passed).

**Still not verified:**
- FAT, exFAT and network data roots;
- a Windows Python that ignores `mode` (the rule tables cover it);
- macOS extended ACLs;
- unmarked Git work trees, which are a stated gap;
- `subst` (D0A-5);
- every live agent behaviour (Batch 0B, NOT STARTED).

**Activation blockers (§14.3).** The storage sides of 1, 2, 3 and 7 are committed and CI-verified. Each blocker stays listed until Batch 2B's consumers use the checked methods and open request scopes, and the end-to-end write witness exists. Blocker 4 is met. Blocker 5 is open: `STORAGE_UNAVAILABLE`, US-D4's `below_git_toplevel`, US-D16, US-D3's handling, US-D18 (refusing a source in `config/`) and US-D25. Blocker 6 is open, and 8 holds.

**Version:** 0.1.5, unchanged. **Decisions:** none changed. **Batch 0B and Batch 2B:** NOT STARTED.

#### Batch 2B-1 — inactive consumer-switch preparation (as built, 2026-10-17)

**Status: implemented and verified locally on Windows. Not staged, not committed, not pushed; no CI run** (§19). *(Committed as `7b8914d`, fixed by `40865cf` after its first CI run, CI-verified and integrated into `main` on 2026-10-17: see "Batch 2B-1 — acceptance and CI evidence" below.)* Nothing is activated: no product module imports `storage`, and the CLI, MCP and the extension keep 0.1.5's behaviour. Batch 2B-2 to 2B-6 (the switch of callers) and Batch 0B have **NOT STARTED**, and Batch 2 as a whole is not complete.

| | |
| --- | --- |
| Authorized | 2026-10-17, the owner's Batch 2B-1 brief, on `main` at `3f8be69`. In scope: C-1, C-2's storage-side invariants, storage-owned deletion, non-raising diagnostics, the test-only write witness, and local verification only. Out of scope: the MCP dispatcher, `errors.py` (no `STORAGE_UNAVAILABLE`), and every CLI, MCP, workflow, doctor, `user_config` and extension module |
| Version | 0.1.5, unchanged |
| Product behaviour | unchanged: no caller is switched, the 0.1.5 storage is untouched, and no user data was read |
| Goldens, fixtures, baselines | unchanged, the frozen 46-entry contract fixture included; the ratchet record (`tests/storage_inventory.json`) is unchanged |
| Batch 0A's child loader | `tests/isolation_child/sitecustomize.py` is **not modified**. Python children are witnessed through the witness's own runner instead (below) |
| Accounts | none: no Jira, no agent, no live probe |

**Files.**

| File | Change |
| --- | --- |
| `bugpilot/core/storage.py` | C-1: the identity cache under one lock. C-2: request scopes owned by the thread that opened them. `StorageUnavailable`. `StorageCheck` and `check()` on both storages. `remove_work_item()` and `remove_memory_file()`. `_existing()` takes the refusal's wording. The module docstring |
| `tests/test_storage_identity.py` | the C-1 tests: 6 functions, 7 cases (a junction case on Windows) |
| `tests/test_storage_scope.py` | **new**: C-2's invariants, 14 tests |
| `tests/test_storage_safety.py` | checked deletion (40 cases) and the checks (11 cases) |
| `tests/_storage_witness.py` | **new**: the write witness and its child runner (test-only) |
| `tests/test_storage_witness.py` | **new**: the witness, proven on itself, 17 tests |
| `.github/workflows/ci.yml` | `test_storage_scope.py` and `test_storage_witness.py` join `safety-and-baselines`. Job names, pins and permissions unchanged; nine checks |
| this plan | this section; the header, §14.0, §18 and §19 (including the result of run 39064298339) |

**C-1: the identity cache under concurrency.**
- **The finding.** The MCP server runs every tool in a worker thread, and its read-only tools take no lock of their own. `repository_identity()`'s cache hit read an entry with `get()` and then reordered it with `move_to_end()`. Another thread's removal (a spelling that stopped resolving) or eviction between the two raised `KeyError`. An unlocked publication could also store an identity resolved before a retarget.
- **The fix.** One `threading.Lock` guards every access to the cache: lookup, validation and reordering as one step, removal, insertion, eviction, and the re-check before publication.
  - The lock is never held across `realpath`, the SHA-256 or another lock, so it cannot deadlock against anything.
  - An identity is published only if, at that moment and under the lock, a fresh `stat` of the spelling still names the folder it was computed for. Otherwise the entry is dropped and the identity is returned uncached.
  - The cache stays bounded (`_IDENTITY_CACHE_LIMIT`).
- **Tests** (`test_storage_identity.py`; every thread is joined with a timeout, and a thread still running fails the test as a deadlock):

| Test | What it shows |
| --- | --- |
| `test_a_removal_can_never_fall_between_a_lookup_and_its_reordering` | **the deterministic race regression.** An `OrderedDict` subclass pauses thread A inside its cache lookup, until thread B has finished or 0.5 s pass. B finds the spelling gone and removes the entry. Without the lock, B's removal lands while A waits, and A's `move_to_end` raises `KeyError` (mutations 1 and 2 below). With it, B waits for A: A returns the right identity, and B's removal comes after A's reordering |
| `test_parallel_cached_reads_agree` | 8 threads × 200 cached reads: one identity, no error |
| `test_eviction_and_lookups_running_together_stay_consistent_and_bounded` | 3 threads insert twice the limit while 3 threads look up a hot spelling: always the right identity; the size stays within the limit |
| `test_lookups_while_a_link_is_retargeted_never_mix_namespaces_and_end_on_its_last_target` (symbolic link; junction on Windows) | 60 retargets under 3 looking threads. Every result is one of the two folders (Windows: or the transient folder below); the final lookup, and the cache entry, are the last target |
| `test_an_identity_resolved_before_a_retarget_is_never_published` | a retarget between resolution and publication: nothing stale is stored, and the next lookup gives the new target |
| `test_repeated_concurrent_access_finishes` | no deadlock: 10 threads × 150 mixed hits, misses, evictions and refusals finish |

- **Observed while testing, a Windows limit (not a defect of this slice).** Windows makes a directory link in two steps: an empty folder, then its reparse point (`CreateSymbolicLinkW` and `_winapi.CreateJunction` alike).
  - A lookup in that instant resolves the link's spelling to that empty folder: the namespace of the link's own name, not of either target.
  - Under the same race, `ntpath.realpath` can also keep the `\\?\` prefix, which gives a different ID.
  - Neither identity is cached past the link's completion: its file ID changes, so the next lookup resolves afresh. It is what the spelling named at that instant, not another folder's namespace. Retargeting the repository folder under a running server is not a supported setup.

**C-2: request scopes are never shared.**
- **The finding.** A request scope lived in a `ContextVar` as a dictionary. A context copied into a worker thread carries the very same dictionary: `contextvars.copy_context().run`, which `anyio.to_thread.run_sync` uses for every MCP tool call. Had a scope been open where requests are copied from, every request would have read and filled one shared set of verdicts.
- **The fix.** A scope is now a `_Scope`: its verdicts, plus the thread that opened it. `_active_scope()` returns it only in that thread. Anywhere else it counts as no scope at all: the checks look at the disk again, and a `request_scope()` opened there starts its own. Every reader of the scope goes through `_active_scope()`: `_scoped`, the record verdict and the witness.
- **The invariants,** each tested in `test_storage_scope.py` (14 tests):

| Invariant | Tests |
| --- | --- |
| Every outermost scope is new and empty, and none is reused | `test_every_request_gets_a_new_empty_scope_and_none_is_reused`, `test_a_verdict_is_computed_once_per_scope_and_every_time_outside_one` |
| A nested scope in the same thread joins the outer one; the outer one decides its lifetime; public operations join the caller's | `test_a_nested_scope_joins_the_outer_one_and_the_outer_one_decides_its_lifetime`, `test_public_operations_share_the_callers_scope` |
| An exception or a cancellation releases the scope | `test_an_exception_releases_the_scope`, `test_an_exception_in_a_nested_scope_leaves_the_outer_one_intact`, `test_a_cancelled_request_releases_its_scope` (asyncio) |
| Concurrent requests never share | `test_requests_in_copied_contexts_on_worker_threads_get_separate_scopes` (6 at once), `test_asyncio_tasks_started_without_a_scope_get_separate_ones` |
| A scope in a base context is not shared by requests copied from it | `test_a_scope_open_in_a_base_context_is_not_shared_by_requests_copied_from_it` (the copy holds the same object, and it counts as no scope there), `test_anyio_worker_threads_copy_the_context_and_still_start_without_a_scope` |
| A worker thread starts without a scope, whether or not threads inherit the context (`sys.flags.thread_inherit_context`) | `test_a_thread_started_inside_a_request_starts_without_a_scope` |
| Building the MCP server leaves no scope in the calling context | `test_building_the_mcp_server_leaves_no_scope_behind` |
| The documented limit: asyncio tasks in one thread that copy a context with an open scope join it | `test_asyncio_tasks_started_inside_an_open_scope_join_it_which_is_why_a_server_must_not_open_one` |

- **What this does not show.** `mcp_server.py` does not use `storage` and opens no scope, so "one scope per MCP tool call" is **not integrated**. These unit tests prove the storage side only.
- **Mandatory gate for Batch 2B-5** (the MCP switch). It is not met by this slice:
  1. Every tool body opens `storage.request_scope()` itself, inside the worker thread that runs it, never around `call_tool` in the event loop.
  2. No scope is opened in `build_server`, `main`, a lifespan or any other context that requests are copied from.
  3. A test drives concurrent tool calls through the real dispatcher and shows a separate scope per call. A second test shows that a `.git` created, or a link changed, between two calls is seen by the second.
  4. Each `bugpilot` CLI command opens one scope and closes it before `bug --launch-agent` starts the agent: no scope may span the agent's run.

  If isolation then needs a change to the MCP dispatcher, that change is reviewed as part of 2B-5.
- **Limit.** Two asyncio tasks in one thread that inherit a context in which a scope is open share it: that is nesting, by design. BugPilot's MCP tools are all synchronous, so they run in worker threads, where the thread check separates them.

**Checked deletion: the storage side of `clean`.**
- **The API.** `RepositoryStorage.remove_work_item(id)` deletes `work/<id>` and everything in it, and `remove_memory_file(id)` deletes `memory/<id>.md`.
  - Each returns `True` when it deleted something, and `False` when nothing was there, a namespace that was never made included. Nothing is created either way.
  - The id is validated before any path is built, so only `work/<id>` and `memory/<id>.md` can be addressed. Never the data root, `config`, `repositories`, the namespace, its record, `settings`, `work` or `memory`, and never anything in a repository.
- **Checks, in order, in one request scope,** each failing closed:
  1. The repository and the data root are kept apart, and the data root is outside every Git working tree (`_check_containment`).
  2. Every component down to the target's folder is a real folder, never a link or junction (`_existing`, with the deletion's own wording).
  3. The namespace's identity record is this repository's. A record that is missing, names another repository or is unreadable refuses, so one repository can never delete another's files.
  4. The target, looked at with `lstat`, is not a link and has the expected kind.
  5. The target resolves exactly to `<canonical data root>/repositories/<id>/<rest>`.

  Only then does `safe_paths.remove_owned_path` delete it. Links inside a work folder are removed as links, never followed.
- **Errors.**
  - A refusal is a `StorageError`, one sentence ending "Nothing was deleted.", naming the target relative to the namespace (`work/JR-12345`), never a full path.
  - A target that cannot be examined, or a deletion the file system stops part way, is a `StorageUnavailable` (new, a `StorageError`), not a refusal. A partial deletion says "part of it may remain"; a retry finishes it.
- **Tests:** 40 cases in `test_storage_safety.py`. They cover:
  - the target and nothing else (a full before-and-after tree of the data root), the second call `False`, and a never-made namespace creating nothing;
  - 15 invalid ids (`..`, `settings`, `config`, `work`, `memory`, separators, a drive, NUL and others) deleting nothing;
  - a symbolic link or junction at `work/<id>`, `work`, `memory` or the namespace, with the decoy untouched even when it holds a valid record;
  - a file link at the memory file;
  - a link inside a work folder removed as a link;
  - a missing, foreign or unreadable record;
  - a data root inside the repository, or inside a Git working tree made since;
  - a target of the wrong kind, and a target that does not resolve to its own place;
  - legacy 0.1.5 folders in the repository untouched;
  - a target that cannot be examined;
  - a file held open on Windows (the deletion stops, then the retry completes);
  - a failure part way, with no path shown.
- **Limits:**
  - A same-user process racing the deletion between the checks and the removal is §10.3's stated limit.
  - A hard link at the memory file is removed as a name only; the other name keeps the content.
  - §8.4 planned `clean` to remove paths it builds itself, which the Batch 2A boundary forbids: the 2B slice that switches `clean` calls these methods instead.

**Diagnostics that never raise.** `GlobalStorage.check()` and `RepositoryStorage.check()` return a `StorageCheck(state, problem)`:

| State | Meaning |
| --- | --- |
| `usable` | it exists and passed every check |
| `uninitialized` | nothing is wrong, but it was never made (no `config/`; no namespace, or no record yet). The first write makes it |
| `refused` | a policy refusal: the data root in the repository or in a Git working tree, a link on the way, a record naming another repository or unreadable as one, or (global) a place that is not private |
| `unavailable` | the file system did not answer: a file in use, no permission, an I/O error (`StorageUnavailable` or `OSError`) |
| `unverifiable` | (global) privacy could not be proven, so credentials would not be written |

- **Behaviour.** A check never raises for a refusal or a file-system failure. It creates, writes and changes nothing: each test runs it under the write witness, which records no event at all, and compares the data root before and after. `problem` is one sentence in display form, `None` when usable or uninitialized.
- **The global check** judges the data root as every accessor does. It then puts the data root, `config/` and `config.toml`, as far as each exists, to the credentials gate's privacy check.
- **Tests:** 11 cases, one or more for each state.
- **Still open: mapping these states onto `doctor`'s JSON** (`state`, `problem`, and an error code for `unavailable`). It is a Batch 2B-5 decision, with US-D26's open `STORAGE_UNAVAILABLE`. §8.10 and the contract fixture are unchanged.

**The write witness** (`tests/_storage_witness.py`, test-only). It closes blocker 7's end-to-end half for the 2B consumer slices. It observes and judges, and never blocks.
- **Mechanism.** A Python audit hook, added after Batch 0A's guard's, that never raises: a failure inside it is recorded, and `assert_clean()` then fails.
- **How a write-like event under the data root is judged:**

| Verdict | When |
| --- | --- |
| `storage` | the outermost `storage.py` frame on the stack is one of storage's public methods (`ensure`, `write_config_file`, `remove_work_item`, an accessor with `create=True`, …). Storage's atomic publishing (the record's hard link, the private credentials write, `mkstemp` temporaries) is covered this way, method by method, not by a blanket exemption. A private helper called from elsewhere is not storage's |
| `granted` | a checked accessor called with `create=True` in a request scope granted it to that scope. A folder accessor grants what is strictly inside the folder, never the folder itself. A file accessor grants the file and the atomic writer's `.<name>.<random>.tmp` siblings. `config.toml` is never granted: credentials are written by `write_config_file()` only. Only the outermost accessor call grants. A lookup without `create` grants nothing |
| `violation` | anything else: an unchecked path built by hand, another repository's folder, a grant used after its scope or in a later scope, a write through a private field or helper, an `rmtree` of a granted folder itself |
| `unresolved` | a path relative to a directory descriptor (POSIX `dir_fd`), which cannot be placed |

- **Events observed:** opens for writing, `mkdir`, `rename` and `replace`, `remove`, `rmdir`, `link`, `symlink`, `rmtree`, `copyfile`, `copytree`, `move`, `truncate`, `chmod`, `utime`, and on Windows `CopyFile2` and `CreateJunction`.
- **Python children** are observed when started through the witness's runner (`python tests/_storage_witness.py <report.json> -m <module> …` or `-c <code>`), which writes a JSON report.
- **Tests:** 17 (16 passed and 1 skipped here, the POSIX `dir_fd` case): the allowed cases, each kind of violation, a nested call that grants nothing, the guard still refusing while the witness watches, a witness failure recorded rather than raised, one witness at a time with the accessors restored, and a Python child through the runner.
- **Limits, stated in its docstring:**
  - Only operations that raise an audit event are seen: not native code, a write through an open descriptor or `mmap`, or a non-Python process (git, an agent, Node).
  - Paths are compared as written (absolute and case-folded), not through `realpath`.
  - A `dir_fd`-relative path is unresolved.
  - Children are covered only through the runner.
  - Audit hooks cannot be removed: the hook does nothing while no witness is active.
  - One witness at a time.
- **Batch 0A's loader was not modified.** The runner observes Python children without touching `tests/isolation_child/sitecustomize.py`, which still loads first in every child and is byte-identical (hash checked). Changing the loader would have widened the guard's trusted base for no gain the runner does not give. Batch 2B's consumer slices run their CLI children through the runner.

**Batch 0A guard integrity.**
- The witness runs alongside the guard: `test_the_isolation_guard_still_refuses_while_the_witness_watches` shows a protected write still refused, and nothing written.
- `test_isolation_guard.py` (child isolation and the guard's mutation checks) passed: see the local verification table.
- The loader and `tests/_isolation.py` are unchanged.

**Mutation check** (scratch copies of the package and the tests, one mutation each; the repository is never touched; Windows only, so a POSIX-only control is not exercised here):

| Mutation | Caught by |
| --- | --- |
| C-1: a cache hit is looked up and reordered without the lock | `test_a_removal_can_never_fall_between_a_lookup_and_its_reordering` (A gets `KeyError`) |
| C-1: a removal is made without the lock | the same test (`KeyError`) |
| C-1: an identity is published without re-checking the spelling | `test_an_identity_resolved_before_a_retarget_is_never_published` |
| C-1: the cache is never trimmed | `test_the_identity_cache_is_bounded`, `test_eviction_and_lookups_running_together_stay_consistent_and_bounded` |
| C-2: a scope copied into another thread counts as that thread's | `test_a_scope_open_in_a_base_context_is_not_shared_by_requests_copied_from_it`, `test_anyio_worker_threads_copy_the_context_and_still_start_without_a_scope` |
| C-2: an exception leaves the scope open | 9 tests, among them `test_scopes_nest_and_end` and `test_a_grant_expires_with_its_scope` |
| C-2: a nested scope starts afresh instead of joining | 5 tests, among them `test_a_nested_scope_joins_the_outer_one_and_the_outer_one_decides_its_lifetime` and `test_public_operations_share_the_callers_scope` |
| delete: the containment and Git checks are skipped | `test_a_data_root_kept_with_the_repository_deletes_nothing`, `test_a_data_root_that_is_now_inside_a_git_working_tree_deletes_nothing` |
| delete: the components on the way are not link-checked | `test_a_link_on_the_way_to_what_is_deleted_refuses_and_the_target_is_untouched` |
| delete: the identity record is not required | `test_a_namespace_not_shown_to_be_this_repositorys_deletes_nothing` (all three records) |
| delete: a link at the target is not refused | `test_a_link_at_the_memory_file_itself_is_refused`, `test_a_link_on_the_way_to_what_is_deleted_refuses_and_the_target_is_untouched` |
| delete: the target's kind is not checked | `test_a_target_of_the_wrong_kind_deletes_nothing` |
| delete: the canonical place is not compared | `test_a_target_that_does_not_resolve_to_its_own_place_deletes_nothing` |
| delete: the id is not validated | `test_an_id_that_is_not_a_work_item_id_deletes_nothing` |
| check: a file-system error escapes | `test_checks_report_a_file_system_that_does_not_answer_as_unavailable` |
| check: unavailable reported as a refusal | the same test |
| check: a place that is not private passes | `test_global_check_reports_a_place_that_is_not_private_as_refused` |
| check: unverifiable privacy passes | `test_global_check_reports_privacy_it_cannot_prove_as_unverifiable` |
| check: a missing record counts as usable | `test_repository_check_reports_uninitialized_then_usable` |
| witness: a grant is valid in any scope | `test_a_grant_expires_with_its_scope` |
| witness: credentials may be written under a folder grant | `test_credentials_are_written_only_by_write_config_file` |
| witness: a folder grant covers the folder itself | `test_a_granted_folder_itself_is_not_granted` |
| witness: any `storage.py` frame counts as storage's own write | `test_writes_through_private_fields_or_private_helpers_are_violations` |
| witness: a lookup without `create` grants | `test_a_lookup_without_create_grants_nothing` |

**All 24 mutations are caught**, each by the test written for it. The race regression is deterministic: with the lock it passed 10 runs of 10; with the lock replaced by one that locks nothing, all 10 runs reproduced the original `KeyError`.

**Performance** (Windows 11, Python 3.14.6, local NTFS; a scratch data root 13 components deep; medians in µs unless stated; outside the test guard; synthetic folders only):

| Measure | Median, run 1 / run 2 |
| --- | --- |
| identity, uncached (realpath + SHA-256 + stat) | 452 / 374 µs |
| identity, cached hit, one thread (the lock + one `stat`) | 41.1 / 42.9 µs (Batch 2A, without the lock: 41 / 41 µs) |
| identity, cached hits from 8 threads at once: per call; all calls per second | 176 / 176 µs; 40,300 / 40,600 per s (one thread: 20,700 / 22,300 per s) |
| a verdict remembered in a scope (with the thread check) | 0.6 / 0.5 µs |
| `request_scope()` opened and closed | 1.6 / 1.8 µs |
| `RepositoryStorage.check()`, usable, outside a scope | 3.29 / 3.23 ms |
| `GlobalStorage.check()`, usable (three privacy checks) | 8.88 / 9.13 ms |
| `remove_work_item()`, 3 files and 2 folders, outside a scope | 6.68 / 6.72 ms |
| the same inside a caller's scope (`clean`'s loop) | 3.97 / 3.80 ms |
| `shutil.rmtree` of the same folder, no checks, for comparison | 2.29 / 2.31 ms |
| `remove_memory_file()`, outside a scope | 4.95 / 4.68 ms |
| `remove_work_item()` of an id that is not there | 3.39 / 3.24 ms |

- **The lock costs nothing measurable** on one thread (41–43 µs, as in Batch 2A). Eight threads together make about twice the calls per second of one: the `stat` dominates and runs outside the lock; only the dictionary step is serialized.
- **Checked deletion** adds about 4.4 ms per item outside a scope: containment, the Git walk (13 components here, about 4 at the default depth), the record, the per-component `lstat`s and two `realpath`s. Inside one scope, as `clean` will run, it adds about 1.5–1.7 ms over a bare `rmtree`. That is the price of failing closed; `clean` deletes a handful of items at a time.
- **A check costs what the accessors' checks cost** (3.2 ms for a repository, about 9 ms for the global one, which runs three Windows access-list checks). `doctor` runs each once.

**Local verification** (Windows 11, Python 3.14.6, Node 24.21; `PYTHONPATH` = the repository; `PYTHONDONTWRITEBYTECODE=1`; the test isolation active):

| Check | Result |
| --- | --- |
| The focused suites (storage identity, safety, scope, witness, privacy, API boundary, isolation guard) | **453 passed, 0 failed, 18 skipped**: `test_storage_identity.py` 127 passed, 3 skipped; `test_storage_safety.py` 208 passed, 10 skipped; `test_storage_scope.py` 14 passed; `test_storage_witness.py` 16 passed, 1 skipped; `test_private_folder.py` 53 passed, 4 skipped; `test_storage_api_boundary.py` 9 passed; `test_isolation_guard.py` (Batch 0A's child isolation and guard checks) 26 passed. Every skip is a POSIX-only, macOS, letter-case or `subst` case, as in Batch 2A, plus the POSIX `dir_fd` witness case |
| New tests | 89 (7 identity, 51 safety, 14 scope, 17 witness), of which 88 run here |
| C-1 race regression, repeated | with the lock: 10 passed of 10; with a lock that locks nothing: `KeyError` in 10 of 10 |
| Mutation check | 24 of 24 caught (above) |
| CI's safety-and-baselines file list (30 files, run exactly as `ci.yml` lists them) | **1,733 passed, 0 failed**, 54 skipped, 1 deselected (the private word list); Batch 2A: 1,645 and 53 |
| Full Python suite | `python -X utf8 -m pytest -q -p no:cacheprovider -rfEs`: **3,685 passed, 0 failed**, 54 skipped, 22 min 44 s (89 more tests than Batch 2A's 3,597 + 53) |
| Extension | typecheck clean; unit tests **2,350 passed**; the required TypeScript job **27 passed**; the isolated integration suite **21 passed** |
| Baselines | `python tests/storage_baseline.py --check`, twice: **baselines match** both times |
| Inventory ratchet | 4 passed; `tests/storage_inventory.json` not updated (a docstring naming the 0.1.5 folders was reworded instead) |
| Unwired symbols, API boundary | passed (`StorageCheck`, `StorageUnavailable` and the new methods live in `storage.py`; no product module imports it) |
| Publishability | 20 passed. The check read the module-qualified name of the standard library's thread-local class as an internal host name (it ends in a dot and `local`); the witness imports that class under another name instead, with no exemption added |
| Goldens, fixtures, baselines, protected files | unchanged against `HEAD`, the 46-entry contract fixture included; `tests/isolation_child/sitecustomize.py` and `tests/_isolation.py` unchanged; the protected local files (the historical plan, `.vscode/extensions.json`, `.bugpilot/`, `.ai/`, `.ai_memory/`) hash-identical to the start; in `bugpilot/` only `storage.py` changed; version 0.1.5 |
| Python 3.10 syntax | the six Python files parse with `feature_version=(3, 10)`; no 3.10 interpreter here |
| Whitespace | `git diff --check` clean; the new and changed files are LF with no trailing whitespace |

**Open decisions and blockers.** No decision changed, and none was approved here: US-D29 and every OPEN or PROPOSED entry stay as they were.
- **§14.3 activation blockers:**
  - 1–3: the storage sides are committed and CI-verified (Batch 2A). C-1 and C-2 are fixed here, uncommitted. The consumer sides (one scope per CLI command and per MCP tool call, the credential writer through `write_config_file()`) are 2B-2 to 2B-6 work.
  - 4: met.
  - 5: open. `STORAGE_UNAVAILABLE` and the `doctor` mapping of `StorageCheck`, US-D4's `below_git_toplevel`, US-D16, US-D3's handling, US-D18 and US-D25.
  - 6: open (Batch 0B).
  - 7: the end-to-end witness exists. Running the consumers under it is 2B's.
  - 8: holds.
- **Before 2B-2 to 2B-6:**
  - Batch 0B (P1, P2, P3, P8), and US-D10, US-D28 and US-D14;
  - US-D29 (the integration branch);
  - the 2B-5 MCP gate above;
  - the CLI scope rule for `--launch-agent`;
  - `clean` through the delete methods;
  - `user_config` through `write_config_file()` (§14.3 step 3 as written would bypass G-3).
  - *(2026-10-19, the Batch 2B-2 decision gate, for 2B-2 only: US-D29 is approved in part; the MCP gate's items 1–3 are brought forward for the reach of 2B-2's configuration change; the `--launch-agent` scope rule and `write_config_file()` are specified. Batch 0B is addressed by D-7 and Q-3, and `clean` stays 2B-4's. See "Batch 2B-2 — decision gate" below.)*

**Git status at the end of the batch:**
- `main` at `3f8be69`, equal to `origin/main`; nothing staged.
- **Modified:** `.github/workflows/ci.yml`, `bugpilot/core/storage.py`, this plan, `tests/test_storage_identity.py`, `tests/test_storage_safety.py`.
- **New, untracked:** `tests/_storage_witness.py`, `tests/test_storage_scope.py`, `tests/test_storage_witness.py`.
- **Untouched local changes:** the historical plan (`docs/bugpilot_prototype_development_plan.md`, modified), `.bugpilot/` and `.vscode/extensions.json` (untracked). They are not part of this batch and must not be staged.

**Not executed:**
- CI, so Linux, macOS and Python 3.10 have not run any of this. The six Python files parse with `feature_version=(3, 10)`; no 3.10 interpreter is here.
- The POSIX `dir_fd` witness case.
- The mutation check on POSIX.
- The real MCP dispatcher under concurrent tool calls (2B-5).
- Batch 0B.

#### Batch 2B-1 — CI run 39085417171 and its remediation (2026-10-17)

**Status: the verification commit's first CI run FAILED, 3 of 9 checks green. A remediation is implemented and verified locally on Windows. It is not staged, committed or pushed, and no new CI run has been dispatched.** Batch 2B-1 is not CI-verified and not integrated. *(Committed as `40865cf` on 2026-10-17, CI-verified 9/9 on the verification branch and on `main`: see "Batch 2B-1 — acceptance and CI evidence" below.)* `main` is unchanged at `3f8be69`. Batch 0B and Batch 2B-2 to 2B-6 have NOT STARTED.

- **Commit:** `7b8914d20decff215c9aa4160dfc4b4f01ccddf3` on `verify/0.1.6-batch2b1`. It holds the eight-file allowlist, its parent is `3f8be69`, and it uses the noreply identity. Pushed on 2026-10-17, branch only.
- **CI:** run 39085417171 (`CI`, `workflow_dispatch` by the owner), head `7b8914d`, attempt 1: **failure, 3/9**.

| Check | Result |
| --- | --- |
| Safety and baselines (ubuntu-latest, Python 3.13) | failure: 1 failed, 1,712 passed, 48 skipped, 1 deselected |
| Safety and baselines (ubuntu-latest, Python 3.10) | failure: 1 failed, 1,712 passed, 48 skipped, 1 deselected |
| Safety and baselines (macos-latest, Python 3.13) | failure: 1 failed, 1,714 passed, 46 skipped, 1 deselected |
| Safety and baselines (windows-latest, Python 3.13) | failure: 1 failed, 1,730 passed, 56 skipped, 1 deselected |
| Extension evidence boundary (ubuntu-latest) | success: 27 passed |
| Full Python suite (ubuntu-latest) | failure: 1 failed, 3,657 passed, 54 skipped, 1 deselected |
| Full Python suite (macos-latest) | failure: 1 failed, 3,659 passed, 52 skipped, 1 deselected |
| Full Python suite (windows-latest) | success: 3,682 passed, 56 skipped, 1 deselected |
| Extension unit tests (ubuntu-latest) | success: 2,348 passed, 2 skipped |

Each failing job failed exactly one test, according to the jobs' published annotations. There were two distinct signatures. Per-test logs need administrator rights.

**F-1, the five POSIX jobs:** `tests/test_storage_witness.py::test_storage_writes_its_own_files_through_public_methods` failed with `AssertionError: ['os.chmod: TypeError: expected str, bytes or os.PathLike object, not int']`.
- **Root cause** (in the test-only witness, not in storage):
  - On POSIX the atomic writer sets its temp file's mode with `os.fchmod(descriptor, 0o600)` (`artifact_io._owner_only`, `_keep_permissions`).
  - The audit event is `os.chmod` with the arguments `(descriptor, mode, -1)`. Its "path" is an integer, and `-1` means "no `dir_fd`".
  - The hook took any integer `dir_fd` for a directory descriptor and called `os.fsdecode()` on the integer path. The witness recorded its own error, so `assert_clean()` failed.
  - Windows' writer skips that step, which is why the local Windows run never raised the event.
- **Related gaps found on the way:**
  - An operation on a descriptor (`os.fdopen` for writing, `os.ftruncate`) was silently passed over, because `_observe` returned on an integer.
  - A name relative to the working directory, with `dir_fd` -1, was recorded as unresolved instead of judged.
- **Reproduced locally.** Python 3.14 on Windows has `os.fchmod`. Forcing the writer's POSIX branch (`artifact_io._POSIX = True`) gave exactly CI's message.
- **The fix is in `tests/_storage_witness.py` only.** What an event names is told apart explicitly:
  - **A path:** judged as before. A `dir_fd` of `-1` means none, so a relative name is judged against the working directory.
  - **An open descriptor:** placed through the descriptor itself: `/proc/self/fd` on Linux, `F_GETPATH` on macOS, `GetFinalPathNameByHandleW` on Windows. The name must still be that very file (`fstat` against `lstat`). It is then judged at that path by the same rules: storage's own write, a grant, or a violation.
  - **A pipe, socket or device:** not a file in any folder, so it is passed over.
  - **Anything that cannot be placed:** recorded as `unresolved`, reported and never authorized. That covers a deleted file, a system with no way to ask, a name relative to a real directory descriptor, and an argument that is neither a path nor a descriptor. `WriteWitness.unresolved()` lists these events.

  No exception is suppressed beyond the hook's existing rule (record, never raise). `chmod` stays observed, and storage gets no exemption. The docstring now also states two more limits: writing through a descriptor raises no audit event (only the open or `fdopen` for writing is judged), and the event for `os.open` with `dir_fd` does not carry the descriptor.
- **Regression tests,** in `tests/test_storage_witness.py`: 8 new functions, 14 cases on Windows here, 16 on POSIX. They cover:
  - the exact CI path (`write_config_file`, then `os.fchmod` on the temp file), judged as storage's own write;
  - a descriptor `chmod` in a granted folder, judged as granted;
  - each descriptor operation the system has, on an unchecked file opened before the witness started, judged as a violation;
  - a pipe, passed over;
  - an unplaceable descriptor, unresolved and never granted;
  - a deleted file's descriptor, unresolved (POSIX only);
  - a working-directory-relative `mkdir`, judged as a violation;
  - an argument that is neither a path nor a descriptor, unresolved.

  The descriptor operations covered: `fdopen` and `ftruncate` everywhere, `fchmod` and `chmod` on a descriptor where Python has them (POSIX, and Windows from 3.13), and `utime` on a descriptor on POSIX.
- **Before and after.** On the committed witness, the 12 new cases that run on Windows fail, and so does the forced-POSIX reproduction. On the fixed witness, the suite gives 29 passed and 2 skipped here; the skips are the POSIX-only `dir_fd` and deleted-file cases.

**F-2, the Windows safety job:** `tests/test_storage_identity.py::test_a_removal_can_never_fall_between_a_lookup_and_its_reordering` failed with `assert (408.4142181 - 407.9143177) >= 0.5`, an elapsed time of 0.4999 s.
- **Root cause: a fragile assertion at the timeout boundary, not a lock defect.**
  - With the lock in place, B cannot finish while A holds the lock, so A's `b_done.wait(timeout=0.5)` always ran to its timeout.
  - The test then asserted that at least 0.5 s had passed: the timeout itself. On Windows a timed wait can return a fraction of a millisecond early as measured by `time.monotonic`; here it was 0.1 ms early.
  - The assertions before it all passed in that run: no `KeyError`, the right identity, and B without error. The same test passed in the Windows full-suite job.
  - The test proved "B was held off" with the clock instead of observing it. That was an incorrect synchronization assumption in the test.
- **The fix is in `tests/test_storage_identity.py` only; `storage.py` is unchanged.** The happens-before is now observed, not timed:
  - The cache's own lock is wrapped (`ReportingLock`) so that it reports a thread that finds it held and has to wait. The cache (`RecordingCache`) records A's reordering and B's removal.
  - A pauses inside its lookup until B has made its move. With the lock, B finds it held; without the lock, B has already removed the entry.
  - The assertions: A gets the right identity (no `KeyError`); B is the thread that was held off; and the order is A's reordering, then B's removal.
  - Every wait is bounded at 30 s, a limit reached only by a deadlock. Both threads are released and joined in `finally`. There is no sleep and no elapsed-time assertion.
  - Also, the barriers in two other C-1 tests now have a 30 s timeout, and the retarget test sets its stop event in `finally`, so no thread can be left waiting.
- **Evidence:**
  - With the lock: 30 of 30 runs pass, across thread switch intervals of 1 µs, 5 ms and 200 ms.
  - With the lock replaced by one that locks nothing (a disposable test plugin): 30 of 30 runs raise the original `KeyError`.
  - The test now takes milliseconds instead of 0.5 s.
  - Both lock-removal mutations are caught (below).

**Mutation check** (scratch copies, one mutation each, Windows):

| Mutation | Result |
| --- | --- |
| C-1: a cache hit is looked up and reordered without the lock | caught: the reworked race test (A gets the original `KeyError`) |
| C-1: a removal is made without the lock | caught: the same test (`KeyError`) |
| the other 22 controls of the Batch 2B-1 table above (C-1 publication and trimming, C-2, deletion, checks, the witness's grant rules) | all caught again, each by the test written for it |
| witness: an operation on a descriptor is passed over (the old behaviour) | caught by 10 cases: the exact CI path, the granted descriptor `chmod`, the violation and the unplaceable-descriptor cases |
| witness: a `dir_fd` of `-1` counts as a directory descriptor | caught by `test_a_path_relative_to_the_working_directory_is_judged` |
| witness: a descriptor that cannot be placed is passed over silently | caught by `test_a_descriptor_whose_file_cannot_be_placed_is_unresolved_never_granted` (4 cases) |

**All 27 mutations are caught**: Batch 2B-1's 24 and 3 new ones for the descriptor handling.

**One unexplained intermittent failure, recorded rather than hidden.** During the harness run, the copy mutating the folder-grant rule also failed `test_a_reader_during_publication_never_sees_a_partial_or_foreign_record`.
- That is Batch 1's multi-process record-publication test (review finding M3). Its child processes never load the witness, and nothing in Batch 2B-1 or this remediation touches the code it exercises.
- The harness kept only the summary, so the message was lost.
- It was not reproduced in 69 targeted reruns: 25 alone, 8 within the storage test set, 6 more runs of that mutation's copy, and 30 under three-way concurrent load.
- Its cause is unknown. It has passed in every CI run so far.
- The harness now keeps pytest's output, so a recurrence can be diagnosed. It stays an open item to watch in CI. It is not attributed to the remediation, and not dismissed.

**Local verification** (Windows 11, Python 3.14.6; `PYTHONPATH` = the repository; the test isolation active):

| Check | Result |
| --- | --- |
| The two tests that failed in CI | 2 passed. The witness test also passed with the writer's POSIX branch forced, the path that failed in CI |
| Focused suites | **466 passed, 0 failed, 19 skipped**: `test_storage_witness.py` 29 passed, 2 skipped; `test_storage_identity.py` 127 passed, 3 skipped; `test_storage_scope.py` 14 passed; `test_storage_safety.py` 208 passed, 10 skipped; `test_private_folder.py` 53 passed, 4 skipped; `test_storage_api_boundary.py` 9 passed; `test_isolation_guard.py` 26 passed. Every skip is a POSIX-only, macOS, letter-case or `subst` case |
| The race test, repeated | with the lock: 30 of 30 runs passed, across switch intervals of 1 µs, 5 ms and 200 ms; with the lock disabled: the original `KeyError` in 30 of 30 |
| Mutation check | 27 of 27 caught (above) |
| CI's safety-and-baselines file list (30 files, run exactly as `ci.yml` lists them) | **1,746 passed, 0 failed**, 55 skipped, 1 deselected; at `7b8914d`: 1,733 and 54 |
| Full Python suite | **3,698 passed, 0 failed**, 55 skipped, 22 min 2 s; at `7b8914d`: 3,685 and 54. The difference is the 14 new witness cases (13 run here, 1 POSIX-only) |
| Baselines | `python tests/storage_baseline.py --check`, twice: **baselines match** both times |
| Inventory ratchet | 4 passed; `tests/storage_inventory.json` unchanged |
| Goldens, fixtures, baselines, the Batch 0A loader and guard | unchanged against `7b8914d`; so are `bugpilot/`, `extension/` and `.github/` |
| Extension | not rerun: no extension, CLI or MCP file changed. At `7b8914d`: typecheck clean; 2,350 unit, 27 evidence-boundary and 21 integration tests passed |
| Publishability, plan check, whitespace | publishability passes; the plan check finds 0 problems; `git diff --check` is clean; the changed files are LF |
| Protected local files | the historical plan, `.vscode/extensions.json`, `.bugpilot/`, `.ai/` and `.ai_memory/` are hash-identical to the start |

**Platform coverage.**
- Everything above ran on Windows only. No POSIX runtime is available here: WSL has no distribution installed, and there is no Docker.
- **Pending cross-platform CI:**
  - the Linux (`/proc/self/fd`) and macOS (`F_GETPATH`) descriptor resolvers;
  - the POSIX deleted-file, `dir_fd` and descriptor-`utime` cases;
  - the original failing test on Linux and macOS;
  - Python 3.10, which has no `os.fchmod` on Windows before 3.13 (those cases skip there; on Linux 3.10 they run);
  - the reworked race test on the Windows runner.
- `storage.py`, the CLI, MCP, the extension, CI and the Batch 0A loader are unchanged.
- The remediation needs its own commit on `verify/0.1.6-batch2b1` and a new owner-dispatched run. Both need the owner's authorization.

#### Batch 2B-1 — acceptance and CI evidence (2026-10-17)

**Status: COMPLETED, CI-verified and integrated into `main`; NOT activated.**
- No product module imports `storage`, and the CLI, MCP and the extension keep 0.1.5's behaviour.
- The MCP per-tool-call request scope is **NOT INTEGRATED** (the mandatory 2B-5 gate).
- The version stays 0.1.5.
- Batch 2 as a whole is not complete.

**Commits and runs:**
- **Commits:**
  - `7b8914d20decff215c9aa4160dfc4b4f01ccddf3`, `fix(storage): prepare safe consumer integration and write witness`: the eight-file allowlist, parent `3f8be69`.
  - `40865cffbf7cc1fc44bd4ad220d82108ffafabf7`, `test(storage): fix cross-platform witness and race regressions`: the four-file remediation, parent `7b8914d`.

  Both use the noreply identity.
- **Verification branch:** `verify/0.1.6-batch2b1`, pushed without force and kept.
- **CI on the branch:**
  - run 39085417171 on `7b8914d`: **failure, 3/9**, from two test defects (above, "CI run 39085417171 and its remediation");
  - run 39096347226 (`CI`, `workflow_dispatch` by the owner) on `40865cf`, attempt 1: **success, 9/9**.
- **Integration:** `git merge --ff-only verify/0.1.6-batch2b1` on `main` brought in both commits in order, with no merge commit; the tree equals the verified tip. Pushed normally as `3f8be69..40865cf`.
- **CI on `main`:** run 39097757625 (`CI`, push), started by that push on the same commit, attempt 1: **success, 9/9**.

**The nine required checks** (counts from the jobs' published annotations; each Python job also deselects the one test that needs the private word list). Both successful runs gave the same counts:

| Check | Run 39096347226 (verification branch) and run 39097757625 (`main`) |
| --- | --- |
| Safety and baselines (ubuntu-latest, Python 3.13) | success: 1,729 passed, 48 skipped, 1 deselected |
| Safety and baselines (ubuntu-latest, Python 3.10) | success: 1,729 passed, 48 skipped, 1 deselected |
| Safety and baselines (macos-latest, Python 3.13) | success: 1,731 passed, 46 skipped, 1 deselected |
| Safety and baselines (windows-latest, Python 3.13) | success: 1,744 passed, 57 skipped, 1 deselected |
| Extension evidence boundary (ubuntu-latest) | success: 27 passed |
| Full Python suite (ubuntu-latest) | success: 3,674 passed, 54 skipped, 1 deselected |
| Full Python suite (macos-latest) | success: 3,676 passed, 52 skipped, 1 deselected |
| Full Python suite (windows-latest) | success: 3,695 passed, 57 skipped, 1 deselected |
| Extension unit tests (ubuntu-latest) | success: 2,348 passed, 2 skipped |

**The counts against Batch 2A's CI (run 39057483843):**
- Windows gained 103 tests (101 passed, 2 skipped): exactly the 103 Batch 2B-1 adds there. The 2 skipped are the two POSIX-only witness cases.
- Linux and macOS gained 98 (97 passed, 1 skipped). Link-parametrized cases run once on POSIX and twice on Windows, POSIX adds the two `utime`-on-a-descriptor cases, and the open-file deletion case is skipped there.

**Evidence, and how direct it is.** Per-test results are not published, and the job logs need administrator rights. "Ran and passed" below therefore means: absent from that job's published skip list, in a job whose summary reports 0 failures and 0 errors.

| Area | Observed |
| --- | --- |
| F-1, the original POSIX failure | `test_storage_writes_its_own_files_through_public_methods` ran and passed on Linux 3.13, Linux 3.10 and macOS, where run 39085417171 failed it |
| POSIX descriptor handling | The deleted-file case and the `dir_fd` case ran and passed on Linux 3.13, Linux 3.10 and macOS; they are skipped only on Windows, as designed. The descriptor-operation cases (`fdopen`, `ftruncate`, `fchmod`, `chmod` and `utime` on a descriptor) assert the judged path by name, so they can pass only if the descriptor was placed. That the Linux (`/proc/self/fd`) and macOS (`F_GETPATH`) resolvers worked is therefore a strong inference from the tests' design, not a per-test result |
| Python 3.10 | The Ubuntu 3.10.22 safety job passed with exactly the 3.13 job's skips. So the witness, scope, identity and safety files ran on 3.10, `os.fchmod` included. The full suite runs on 3.13 only |
| C-1 race regression | The reworked test ran and passed in the Windows safety and full jobs of both successful runs, where the old timing assertion had failed. It also ran and passed on Linux and macOS |
| C-2 request scopes | `test_storage_scope.py` has no skips anywhere: all 14 ran and passed on every system, the anyio and asyncio cases included |
| Checked deletion, diagnostics | Ran and passed on every system. On POSIX the only skips are the Windows-only cases (the open-file deletion, the access lists) |
| Batch 0A guard | `test_isolation_guard.py` passed in every Python job. Its skips are the earlier ones: `Path.copy` before Python 3.14, and junctions on POSIX |
| Multi-process record publication | `test_a_reader_during_publication_never_sees_a_partial_or_foreign_record` ran and passed in every Python job of both successful runs. That does not explain the single local failure seen during the remediation's mutation check, which stays open (below) |
| Baselines, goldens, ratchet | Neither commit touches a golden, baseline, fixture or `storage_inventory.json`. The storage-baseline, inventory, task-golden and prompt-boundary suites appear in no skip list and passed in all four safety jobs of both runs |
| Mutation check | Not run in CI. It ran on Windows only: 24 of 24 for `7b8914d`, and 27 of 27 for `40865cf`. POSIX mutation coverage is not claimed |
| Extension | The evidence boundary passed 27 of 27, and the unit tests 2,348 with 2 skipped, as before |

**Timing record** (`storage_timing_*`; one sample per job, under the test guard, recorded and never asserted; §12, Q6). Each cell is run 39096347226 / run 39097757625:

| System | First `ensure()` | Read lookup, outside / in a scope | Git working-tree check | Privacy check |
| --- | --- | --- | --- | --- |
| Linux, Python 3.13.16 | 0.61 / 0.89 ms | 0.31 / 0.085 ms; 0.49 / 0.143 ms | 0.12 / 0.18 ms | 0.03 / 0.04 ms |
| Linux, Python 3.10.22 | 1.01 / 0.69 ms | 0.50 / 0.135 ms; 0.33 / 0.084 ms | 0.19 / 0.13 ms | 0.06 / 0.04 ms |
| macOS, Python 3.13.16 | 1.30 / 0.97 ms | 0.39 / 0.091 ms; 0.33 / 0.071 ms | 0.16 / 0.13 ms | 0.03 / 0.03 ms |
| Windows, Python 3.13.16 | 3.54 / 3.88 ms | 1.64 / 0.376 ms; 1.68 / 0.389 ms | 0.77 / 0.80 ms | 1.16 / 1.22 ms |

- **Against Q6:** every first `ensure()` is within its target, below 10 ms on Windows and below the provisional 2 ms on Linux and macOS.
- **Linux and macOS** are in line with Batch 2A's run. The two samples per system differ by up to about 50%, which is ordinary runner variance.
- **Windows** is higher than Batch 2A's run on every measure (first write 2.15 to 3.5–3.9 ms; privacy check 0.60 to 1.2 ms). The privacy check and the Git check, whose code Batch 2B-1 does not touch, rose in the same proportion. So this is read as a slower runner, not a regression. It is recorded as an observation to compare with later runs, not as a finding.
- **Locally,** the identity cache's lock costs nothing measurable, and a remembered verdict costs about 0.5 µs ("Batch 2B-1 — inactive consumer-switch preparation", Performance).

**Findings.** CI produced no new findings. No test failed in either successful run, and every annotation was notice-level. GitHub's runner notices were repeated: the `ubuntu-latest` move to Ubuntu 26 from 2026-10-19, and macOS arm64 queue times.

**Still open:**
- **The unexplained intermittent failure:** Batch 1's multi-process publication test failed once during the remediation's mutation check. Its message was lost, and it did not reproduce in at least 96 later local runs or in any CI job. The cause is unknown. The mutation harness now keeps every run's output, so a recurrence can be diagnosed.
  - *(2026-10-18: CI run 39194849242 found a race in creating the data root, `_ensure_root`, that this test's two racers also exercise against a fresh, absent data root. That race is a likely explanation, but it stays unproven because the message was lost. See "Batch 2B-1 follow-up — concurrent data-root creation".)*
- **The witness's visibility limits:**
  - only audit events are seen: no native code, writes through an open descriptor, `mmap` or non-Python process;
  - `os.open` with `dir_fd` is judged against the working directory;
  - a descriptor that cannot be placed is unresolved;
  - Python children are covered through its runner only.
- **Consumer gates for 2B-2 to 2B-6:**
  - the MCP per-tool-call scope, inside the worker thread (2B-5; NOT INTEGRATED);
  - each CLI command's scope closed before `--launch-agent` starts the agent;
  - `clean` through `remove_work_item()` and `remove_memory_file()`;
  - `user_config` through `write_config_file()`;
  - the `doctor` mapping of `StorageCheck`, together with US-D26's `STORAGE_UNAVAILABLE`, which stays OPEN; the public contract is unchanged, and `StorageUnavailable` is internal and consumed by no product path.
- **Activation blockers (§14.3):**
  - the storage sides of 1, 2, 3 and 7 are committed and CI-verified, the end-to-end witness and the thread-safe cache and scopes included; every consumer side is open;
  - 4 is met;
  - 5 is open: `STORAGE_UNAVAILABLE`, US-D4's `below_git_toplevel`, US-D16, US-D3's handling, US-D18 and US-D25;
  - 6 is open (Batch 0B);
  - 8 holds.
- **Not run:** the mutation check on POSIX; FAT, exFAT and network data roots; `subst` (D0A-5); every live agent behaviour.

**Version:** 0.1.5, unchanged. **Decisions:** none changed; US-D29 is unresolved. **Batch 0B and Batch 2B-2 to 2B-6:** NOT STARTED.

#### Batch 2B-1 follow-up — concurrent data-root creation (2026-10-18/19)

**Status.**

- **Done:** implemented and verified locally on Windows, then committed on the verification branch `verify/0.1.6-batch2b1-root-race` (the commit that carries this section; parent `7a2a1f4`).
- **Not done:**
  - It is not on `main`.
  - It is **not CI-verified**: the CI workflow runs only on a push or a pull request to `main`, or a manual dispatch, and none of those is authorized yet.
  - Nothing is activated.
- *(Updated 2026-10-19, after verification and integration:*
  - *Branch CI: run 39285763641 (`workflow_dispatch`, owner-authorized, dispatched once), on `147e1bd`: **success, 9/9**.*
  - *Integrated into `main` by fast-forward `7a2a1f4..147e1bd` (owner-approved). The verified commit is unchanged, and there is no merge commit.*
  - *Main CI: run 39305575297 (push), on `147e1bd`: **success, 9/9**, with the same test counts as the branch run.*
  - ***Batch 2B-1, with this follow-up, is COMPLETED.** Storage is still not activated.)*

**The failure.**

- **The run:** main CI run 39194849242, on `7a2a1f4` (the six-decision documentation checkpoint).
- **The result: FAILED, 8 of 9 jobs passed.** The run stays failed; this record does not change that.
- **The failed job:** `Full Python suite (ubuntu-latest)`, with 1 failed, 3,673 passed and 54 skipped.
- **The failed test:** `tests/test_storage_identity.py::test_two_processes_ensuring_the_same_namespaces_end_with_identical_records_and_no_error`.
- **The same test passed** in the run's other 8 jobs, including both Ubuntu "Safety and baselines" jobs, and on the two earlier main runs of the same storage code.

**The recovered exception.** The owner recovered it from the job log; it is not in the CI annotations, which keep only pytest's one-line summary.

```text
bugpilot.core.storage.StorageError: BugPilot cannot use BUGPILOT_HOME as its data folder: it is not a folder.
```

It was raised in `_ensure_root` (`storage.py:480`), called from `RepositoryStorage.ensure()` (`storage.py:1326`), in one of the test's two child processes.

**The root cause: a check-then-check race (TOCTOU) in `_ensure_root`.** It was confirmed from the traceback, the code and the test's preconditions, and then reproduced deterministically (below).

- **Two looks before the attempt.** `_ensure_root` looked twice before trying to create the root:
  - `os.path.isdir(root)` at line 477;
  - `os.path.lexists(root)` at line 479, refusing at line 480 if that second look found anything.
- **The root starts absent.** Each test gets a fresh home whose `BUGPILOT_HOME` (`<home>/.bugpilot`) starts absent (`tests/conftest.py`). So both child processes create it on their first `ensure()`.
- **The interleaving:**
  1. Process A's `isdir` finds no root.
  2. Process B creates the root with `mkdir`.
  3. Process A's `lexists` finds B's new folder, and A refuses a real folder as "not a folder".
- **Only the pre-check was wrong.** The `FileExistsError` branch already judged what was there after the attempt.
- **Both callers were exposed:** `RepositoryStorage.ensure()` and `GlobalStorage.ensure_config_dir()`.
- **The effect:** a false, fail-closed refusal when two processes first use an absent data root at the same moment. Nothing is written, deleted or corrupted, and a retry succeeds. No user was affected, because storage is inactive.

**The change** (`bugpilot/core/storage.py`, `_ensure_root` only).

- The pre-check (`if os.path.lexists(root): raise …`) is removed.
- A three-line comment says why what is at the name is judged only after the attempt.
- Unchanged:
  - the fast path for an existing folder;
  - the `mkdir`;
  - the `FileExistsError` handler and its re-check;
  - the `FileNotFoundError` handling.
- Not added: no sleep, no retry, no broad exception handling, no permission change. Record publication and every other storage operation are untouched.

| What is at the root's name | Before | After |
| --- | --- | --- |
| a real folder | used (line 477) | unchanged |
| nothing | created (`mkdir`) | unchanged |
| nothing, then another process's new folder | **refused as "not a folder"** | `mkdir` raises `FileExistsError`, the re-check finds a folder: **used** |
| a regular file | refused | `mkdir` raises `FileExistsError`, the re-check: **refused**, the file untouched |
| a dangling link or junction, or a link to a file | refused | `mkdir` raises `FileExistsError` and never follows the name; the re-check: **refused**, nothing created through it |
| a link or junction to a folder (B4-2) | used | unchanged |
| a missing parent | refused, never created | unchanged |
| an existing root's mode | never changed | unchanged |

`data_root()` stays canonical, so a configured link reaches `_ensure_root` already resolved (B4-2). The link policy is not changed.

**Regression evidence.**

- **Three deterministic race tests** (`tests/test_storage_identity.py`).
  - **How they work:** they wrap `os.path.isdir` for one path only, the data root, and for its first call only. That call finds no root, and then "another process" creates it with the real `mkdir`. Every other call goes to the real function, and `monkeypatch` restores it.
  - **What they cover:** `_ensure_root` itself, `RepositoryStorage.ensure()` and `GlobalStorage.ensure_config_dir()`.
  - **Before the change:** all three failed with the exact CI exception at `storage.py:480`.
  - **After the change:** all three pass.
    - Each confirms the simulated interleaving really happened.
    - The root is a real folder.
    - The namespace record reads `ok`, and the config folder exists.
- **Five tests on the root's name itself** (`tests/test_storage_safety.py`):

  | Test | Windows result |
  | --- | --- |
  | An existing folder is used as it is, its contents untouched | passed |
  | A missing root is created as a real folder | passed |
  | A dangling link (symlink, and junction on Windows) is refused, nothing is created through it, and the link is left as it was | passed (symlink and junction) |
  | A link to a file is refused and the file kept | skipped (POSIX; Windows needs the file-symlink privilege) |
  | A root that cannot be created raises `PermissionError` and creates nothing | skipped (POSIX, not root) |

  The two skipped tests run only on the Linux and macOS jobs, and are not yet observed there.
- **The existing data-root tests still pass:**
  - a file at the root is refused;
  - a root behind a link works (B4-2);
  - a missing parent is refused, never created;
  - an existing root's mode is never changed (POSIX).

**Local verification (Windows 11, Python 3.14.6).**

- **Targeted storage suites: 459 passed, 21 skipped.** They are `test_storage_identity`, `test_storage_safety`, `test_storage_witness`, `test_storage_scope`, `test_storage_api_boundary`, `test_private_folder`, `test_storage_inventory` and `test_storage_baseline`. This includes the original two-process test and the reader-during-publication test. The skips are documented platform cases, plus `subst` (D0A-5).
- **First full-suite run: 1 failed, 3,704 passed, 57 skipped.**
  - The failure was `tests/test_cli_json.py::test_the_cli_writes_utf8_json_through_a_pipe_whatever_the_code_page`, with `No module named bugpilot`.
  - That run used a *relative* `PYTHONPATH=.`, while the test's child process runs `python -m bugpilot` with its working directory set to `tmp_path`.
  - The run was not repeated to hide the failure. It was stopped and reported to the owner.
- **Corrected full-suite run** (authorized by the owner; run once): an absolute `PYTHONPATH`, naming the checkout's own folder, with the import of `bugpilot` from this checkout checked first. **Result: 3,705 passed, 57 skipped, 0 failed (29 min 5 s), the code-page test included.**
  - The corrected run supports the invocation explanation for the first run's failure: the same test passes once the path is absolute.

**Not yet verified:**

- Linux and macOS: the POSIX-only tests above, and the multi-process tests on those systems.
- CI on all nine checks for this commit.
  - *(Verified 2026-10-19, branch run 39285763641 and main run 39305575297, each 9/9. Compared with the same jobs in run 39194849242:*
    - *Linux and macOS: all eight new tests ran and passed (+8 passed, +0 skipped).*
    - *Windows: seven ran and passed, and the two POSIX-only tests were skipped as designed (+7 passed, +2 skipped).*
    - *The two-process test and the reader-during-publication test passed in every pytest job.)*

**Still open:**

- **CI coverage:** the verification branch has no CI run. Dispatching the workflow, or opening a pull request, needs the owner's authorization.
  - *(Done 2026-10-19: run 39285763641, success 9/9.)*
- **Integration into `main`:** needs the owner's approval.
  - *(Done 2026-10-19, owner-approved: fast-forward `7a2a1f4..147e1bd`, then main run 39305575297, success 9/9.)*
- **Batch 2B-1's earlier unexplained failure:** `test_a_reader_during_publication_never_sees_a_partial_or_foreign_record` failed once in Batch 2B-1's remediation, and its message was lost. That test also runs two racers against a fresh, absent data root, so this race is a likely explanation, but it stays unproven.
- **A raw `PermissionError`:** `_ensure_root` still raises one, not a `StorageError`. This is unchanged and belongs with US-D26's `STORAGE_UNAVAILABLE`.
- **Activation:** the gates of §14.3, the six design decisions' conditions, the 2B-5 gate, and Batch 0B.

**Version:** 0.1.5, unchanged. **Decisions:** none changed. **Batch 0B:** not complete. **Batch 2B-2 to 2B-6:** NOT STARTED.

#### Batch 2B-2 — decision gate and implementation specification (2026-10-19)

*(Later on 2026-10-19 the owner answered Q-1 to Q-6, and a re-check corrected parts of this specification:*

- *the error mapping;*
- *the rule for reading user instructions;*
- *the designed differences and the generator;*
- *the allowlist.*

*"Batch 2B-2 — final contract resolution" below governs where the two differ.)*

**Status.** The owner's decision gate D-1 to D-9 is recorded, and the slice is specified for implementation.

- **Nothing is implemented.** No branch is created, nothing is committed, and no CI run is dispatched. Unified Storage is NOT activated.
- **Implementation needs a separate owner authorization.** It also needs answers to the open questions Q-1 to Q-6 below.
- The plan stays the authority. Where this section and an earlier contract differ, the difference is listed under "Conflicts", not resolved here.

**The decisions** (owner, 2026-10-19). They are design directions, subject to detailed contract verification.

| Id | Direction | Recorded as |
| --- | --- | --- |
| D-1 | `verify/0.1.6-storage`, based on `73ee57e`, is the isolated integration branch for the remaining consumer work. It is not created yet, and no partial consumer migration is merged into `main` without separate authorization. | US-D29 **APPROVED — in part**: the branch. The CI-dispatch and post-Batch-4 fast-forward terms stay OPEN. |
| D-2 | The layout is `<root>/config/config.toml`, with user instructions and user Fix Modes at `GlobalStorage`'s places. No migration, fallback or deletion. Users re-run `setup` once the feature is activated. | US-D2 **APPROVED — with conditions**: this specification and Q-1 to Q-6. |
| D-3 | `BUGPILOT_CONFIG_DIR` is retired as a configuration source. Its value is never read, used or shown. At most one concise stderr warning per CLI invocation; machine-readable stdout unchanged; the `doctor` field deferred to its slice. | US-D3 stays APPROVED. Its Batch 2 handling is resolved in part: the warning's direction. The text is Q-4, and `legacy_config_dir_variable` stays open. |
| D-4 | Low-level OS exceptions are kept at the storage layer where existing safety contracts need them. Unavailability is mapped to the approved public error contract at the CLI and MCP boundaries. No tracebacks or sensitive paths, and no suppression, misclassification or retry of unsafe failures. | US-D26 unchanged (APPROVED in part). `STORAGE_UNAVAILABLE` stays **OPEN**. The mapping below is proposed, pending Q-1 and Q-2. |
| D-5 | The MCP safety work moves into 2B-2, as far as global configuration makes MCP an early storage consumer. MCP work-item paths, prompt fields and tool descriptions are not migrated. | 2B-5 gate items 1–3 are brought forward for 2B-2's reach; the rest of 2B-5 is unchanged. |
| D-6 | Batch 0A files stay byte-identical, with a deterministic designed-difference check for 2B-2's intended changes. No golden regeneration; US-D30 is kept. | the mechanism below |
| D-7 | The global-configuration slice needs no live-agent probe. This waives nothing elsewhere: P1, P3 and P8 stay NOT EXECUTED, and P2 stays FAIL. | recorded |
| D-8 | The blanket ban on production imports of storage is replaced by an explicit allowlist of 2B-2's consumers. | the mechanism below |
| D-9 | The display-path rules apply to 2B-2's configuration messages. No JSON contract expansion. | US-D22 **APPROVED — in part**: 2B-2's configuration messages. The rest of US-D22 stays PROPOSED. |

**Conflicts found.** They are recorded here, not silently resolved.

1. **Blocker 5 against D-4.**
   - §14.3 says the open parts of US-D26 are approved before *any* caller switches to `storage`.
   - 2B-2 switches callers while `STORAGE_UNAVAILABLE` stays OPEN.
   - Handling: implementation waits for Q-1.
2. **§8.6 against the frozen contract.**
   - §8.6 says a `StorageError` reaches JSON as `INVALID_INPUT`.
   - The fixture's open choice says a data root that cannot be created or written uses "the existing generic code" until a separate code is chosen.
   - Today `errors.error_code_for` reports `StorageUnavailable`, a `ValueError` subclass, as `INVALID_INPUT`.
   - Handling: Q-2.
3. **§14.3's batch-wide preconditions against a per-slice start.**
   - 2B-2 would begin with US-D4, D8, D9, D15, D16, D18, D21, D25, D27 and D31 unapproved.
   - §14.3 also lists Batch 0B probes P1, P2, P3 and P8 for the batch.
   - Handling: Q-3. D-7 records that this slice needs none of the probes.
4. **§14.3 step 3 as written would bypass G-3.** This was already recorded by Batch 2B-1. This specification follows G-3: `config.toml` is written only through `write_config_file()`.

**Scope (exact).**

- The user `config.toml` is read through `global_storage().config_file(create=False)` and written only through `write_config_file()`.
- User instructions use `global_storage().user_instructions_file()`.
- User Fix Modes use `global_storage().user_fix_modes_dir()`.
- `BUGPILOT_CONFIG_DIR` is retired, with its warning.
- Each CLI invocation gets one `storage.request_scope()`, closed before `bug --launch-agent` starts the agent.
- Each MCP tool call gets one scope (D-5).
- The error mapping applies to these consumers (D-4), and their messages use the display form (D-9).
- The designed-difference check (D-6) and the import allowlist (D-8).

**Not in this scope:** project-scope settings (2B-3), and anything else listed under "Exclusions".

**Allowlist.**

*Base (reviewed 2026-10-19):*

| File | Change |
| --- | --- |
| `bugpilot/core/user_config.py` | its folder and file from `GlobalStorage`; writes only through `write_config_file()`; `BUGPILOT_CONFIG_DIR` no longer consulted, except a presence check for the warning |
| `bugpilot/core/setup.py` | its saved-path message in the display form |
| `bugpilot/core/instructions.py` | **user scope only**: `user_instructions_file()`. Project scope unchanged |
| `bugpilot/core/fix_mode_store.py` | **user scope only**: `user_fix_modes_dir()`; the comment at `:271`. Project scope unchanged |
| `bugpilot/core/config.py` | only the comment and any message that names the configuration location (`:130`) |
| `bugpilot/cli.py` | one scope per invocation, closed before an agent launch; the warning; configuration messages in the display form |
| `tests/conftest.py` | The autouse per-test fixture changes in three ways:<ul><li>it removes `BUGPILOT_CONFIG_DIR` for the test, because the session isolation still sets it and the warning must not appear in unrelated tests;</li><li>it returns `<BUGPILOT_HOME>/config` and **creates nothing**;</li><li>a new, non-autouse helper makes that folder through `global_storage().ensure_config_dir()`, for tests that place a user file there. A plain `mkdir` would leave the data root without its private mode, and the credential write's privacy check would then refuse it.</li></ul> |
| `tests/test_storage_api_boundary.py` | the import allowlist (D-8) |
| `tests/test_storage_baseline.py` | the designed-difference check (D-6) |
| `tests/test_setup.py`, `test_jira_site.py`, `test_instructions.py`, `test_fix_mode_custom.py`, `test_fix_mode_selection.py`, `test_cli_json.py`, `test_mcp_server.py`, `test_core_robustness.py`, `test_ai_behavior.py`, `test_project_settings.py`, `test_protected_rules.py`, `test_context_preview.py`, `test_task_preview.py`, `test_batch4_file_safety.py`, `test_file_safety_baseline.py` | each touched only where it asserts or prepares the configuration location, or names it in a message; no assertion is loosened |
| `tests/test_task_golden.py` | **only** `test_the_matrix_is_rendered_from_inputs_resolved_like_a_run`: it puts its private instruction at the new place. Otherwise it would pass without testing anything (see "Test-suite findings"). The goldens are unchanged. |
| new `tests/test_global_config_storage.py` | the slice's own tests |
| `tests/storage_inventory.json` | shrinks only |
| `docs/bugpilot_0.1.6_unified_storage_plan.md` | the record |

*Expansion (needs separate owner approval, Q-5):*

| File | Why |
| --- | --- |
| `bugpilot/mcp_server.py` | D-5: one scope per tool call, and nothing else |
| `bugpilot/core/errors.py` | D-4: one classification arm, if Q-2 is approved; no new code |
| `tests/storage_baseline.py` | D-6: the comparison only; the generator unchanged |
| new `tests/baselines/0.1.6-batch2b2/designed_differences.json` | D-6 |
| new `tests/test_mcp_request_scope.py` | D-5 |

*Never touched by 2B-2:*

- `tests/_isolation.py`, `tests/isolation_child/`;
- `tests/baselines/0.1.6-batch0/` and every other frozen record;
- goldens and contract fixtures;
- `.github/`, `scripts/`, `skills/`, `extension/`;
- `doctor.py`, `workflow.py`, `prompts.py`, `handoff.py`, and every other production module.

**Per-module changes.**

- **`user_config.py`:**
  - `user_config_dir()` and `user_config_path()` return the paths `global_storage()` computes. Resolving creates nothing.
  - `load_user_config()`:
    - a missing file means "not configured", as today;
    - any other `OSError` while reading becomes `StorageUnavailable` (D-4);
    - the 0.1.5 `<root>/config.toml` is never read (R4).
  - `save_user_config` and `save_jira_site` write through `write_config_file()` only (G-3: privacy check, atomic private write). The module's own writer and link check give way to storage's.
  - `_shown_config_path()` uses `storage.display_path`.
  - The module's sentences keep their wording; only the path they show changes (D-9). Its check for a link at the file's own path (O4) stays in front of `write_config_file()`, so that refusal reads as today.
- **`instructions.py`:**
  - the user-scope path comes from `user_instructions_file(create=)`, and writes go there through the existing writer;
  - the 0.1.5 `<root>/instructions.md` is never read;
  - project scope is untouched.
- **`fix_mode_store.py`:**
  - the user-scope folder comes from `user_fix_modes_dir(create=)`;
  - the 0.1.5 `<root>/fix_modes/` is never read;
  - project scope is untouched.
- **`setup.py` and `config.py`:** display-form path text only.
- **`cli.py`:**
  - `main()` opens one `storage.request_scope()` per invocation, around dispatch.
  - `bug --launch-agent` prepares inside the scope and starts the agent after the scope has closed (2B-5 gate item 4).
  - In text mode, when `BUGPILOT_CONFIG_DIR` is present (a presence check; the value is never read), it prints the US-D3 sentence once to stderr before dispatch (Q-4).
  - JSON modes print no warning, and stdout is unchanged.
- **`mcp_server.py`** (expansion): see "MCP scope" below.
- **`errors.py`** (expansion): `error_code_for` puts `StorageUnavailable` before the `ValueError` arm, if Q-2 is approved. No new code.

**MCP scope (D-5).** This is the minimum safe change.

1. Each tool function is wrapped by one decorator. The decorator enters `storage.request_scope()` *inside the tool body*, in the worker thread the SDK runs the synchronous tool in. It is never placed around `call_tool` in the event loop.
2. No scope is opened in `build_server`, `main`, a lifespan, or any context that requests are copied from.
3. The decorator keeps the tool's signature and docstring, which the SDK reads.
4. `bound.lock` is unchanged. Scopes are thread-owned (C-2), so concurrent calls share no scope state.
5. **It fails closed:** an exception ends the scope (`finally`) and reaches the client as today's `ToolError`, under D-4's mapping.
6. **Tests** (`tests/test_mcp_request_scope.py`, through the SDK's real in-process dispatch):
   - each call runs inside a scope, and none survives the call;
   - two calls forced to overlap with a barrier see different scope objects, in different worker threads;
   - a change between two calls (a `.git` entry above the data root, or a replaced configuration file) is seen by the second;
   - building the server leaves no scope (the existing test is kept);
   - a storage failure inside a tool is a `ToolError` with the one-sentence message and no absolute path.
7. **Not in 2B-2:**
   - MCP work-item paths;
   - the `issue_dir`, `agent_task` and `next_step` values;
   - INSTRUCTIONS and tool descriptions.

   These stay 2B-5's.

**Error mapping (D-4).** Implementation waits for Q-1 and Q-2.

| Failure | Storage layer | 2B-2 consumer layer | CLI text | CLI JSON and MCP |
| --- | --- | --- | --- | --- |
| A policy refusal: a link, not a folder, a Git working tree, a mismatched or corrupt identity | `StorageError` or `StorageIdentityError` (unchanged) | passed through | `ERROR: <sentence>` (unchanged) | `INVALID_INPUT` and the sentence (unchanged) |
| Cannot be read now (a permission or sharing failure on a record read), or a failed deletion | `StorageUnavailable` (unchanged) | passed through | `ERROR: <sentence>` | the generic code `INTERNAL_ERROR` (Q-2; today `INVALID_INPUT`) |
| Creating the data root or a folder fails with `PermissionError` or another `OSError` (not `FileExistsError` or `FileNotFoundError`) | raw `OSError`, unchanged; the follow-up test pins `PermissionError` | wrapped as `StorageUnavailable`: one sentence, the display path, the exception's class name only | `ERROR: <sentence>`, no traceback | `INTERNAL_ERROR` and the sentence |
| Record publication: an `os.link` error other than `EEXIST` | raw `OSError`; the "not disguised" test is unchanged | wrapped as above | same | same |
| Reading the configuration file fails, except a missing file | — | `StorageUnavailable` | same | same |
| The configuration file is missing | — | "not configured", as today | the existing message | `JIRA_NOT_CONFIGURED` where it applies today |

Rules:

- no retry beyond storage's existing bounded retries for transient errors;
- no suppression;
- `str(OSError)`, which names the path, is never echoed;
- no environment variable's value appears in any message.

**Answers to D-4's five questions** (proposed):

1. **Which failures become `StorageUnavailable`:**
   - at the storage layer: the existing cases only;
   - at the 2B-2 consumer layer: every `OSError` from these consumers' storage and configuration-file operations, except a missing configuration file.
2. **Which stay raw internally:**
   - creating the data root and its folders;
   - `mkstemp`, and an `os.link` error other than `EEXIST`, in record publication;
   - the atomic writer's errors.
3. **The public code:** the existing generic `INTERNAL_ERROR` in the existing failure envelope (`cli_json.failure`: `schema_version`, `"ok": false`, `command`, `"error": {"code": "INTERNAL_ERROR", "message": "<one sentence>"}`), and the existing `ToolError` text with `[INTERNAL_ERROR]`. `STORAGE_UNAVAILABLE` stays OPEN (Q-1).
4. **The "not disguised" regression test stays unchanged.**
5. **The `_ensure_root` `PermissionError`** stays raw in `storage`, and 2B-2's consumers report it as `StorageUnavailable` and the generic code.

**Designed-difference check (D-6).**

- **The frozen records stay as they are.** The four compared Batch 0A records are byte-identical, and their SHA-256 values are recorded in `designed_differences.json` and checked.
- **The comparison:** `storage_baseline.differences()` regenerates today's records, then for each one:
  1. loads the frozen record;
  2. checks every listed entry's `from` value at its JSON pointer;
  3. replaces it with the entry's `to` value;
  4. requires the result to equal the regenerated record exactly.
- Any other difference fails, and a listed entry that did not happen fails too.
- No normalization is added beyond what the generator already does.
- **Expected entries:**
  - `cli_paths.json` → `instructions show --json path fields` → `user`: `BUGPILOT_CONFIG_DIR/instructions.md` becomes `BUGPILOT_HOME/config/instructions.md`;
  - `pollution.json` → `user_configuration_written`, which changes with the configuration folder.

  Each `to` value is fixed in the implementation commit and approved by the owner in its review (Q-6). An entry beyond these two stops the batch.
- **Unchanged and without entries:** `handoff.json` and `task_size.json`, because 2B-2 changes no prompt and regenerates no golden (US-D30 kept).

**Import allowlist (D-8).** `test_no_production_module_imports_the_foundation_yet` becomes `test_only_the_batch_2b2_consumers_import_the_foundation`. It checks three things with an AST scan of every production module:

- a direct import of `bugpilot.core.storage`, in any form, appears only in `core/user_config.py`, `core/instructions.py`, `core/fix_mode_store.py`, `cli.py` and `mcp_server.py`;
- no production module outside `storage.py` uses a private storage name;
- `request_scope` is called only in `cli.py` and `mcp_server.py`.

Indirect imports through these modules, such as `workflow` → `config` → `user_config`, are expected. They are covered by the write witness and the no-legacy tests.

**Test and acceptance matrix.**

| Requirement | Test | Systems |
| --- | --- | --- |
| Configuration lands at `<root>/config/config.toml`, private (POSIX `0600`; the Windows access-list check, G-3) | new | all |
| A 0.1.5 `<root>/config.toml`, `instructions.md` or `fix_modes/` is never read and never deleted | new | all |
| `BUGPILOT_CONFIG_DIR`: a sentinel value appears nowhere; exactly one stderr line in text mode; JSON stdout parses and is unchanged; nothing when unset | new | all |
| User instructions and user Fix Modes at `GlobalStorage`'s places; project scope unchanged | new and updated | all |
| Read-only commands create nothing (a snapshot of the data root before and after) | new | all |
| Every write goes through a checked method (the write witness) | new | all |
| One scope per CLI invocation, none spanning `--launch-agent` | new | all |
| MCP tests a–e | new | all |
| The error-mapping rows | new (permission failures on POSIX; other cases monkeypatched everywhere) | all |
| G-1/G-2: a home folder inside a Git working tree refuses configuration writes | existing (2A) plus a consumer case | all |
| The designed differences and the frozen hashes | updated `test_storage_baseline` | all |
| The import allowlist | updated | all |
| Unchanged: the storage safety, identity, scope and witness suites; the isolation guard; publishability; protected rules (v2 digest); task golden; the inventory (shrinking only) | existing | all |
| The full suite | once locally on Windows with an absolute `PYTHONPATH`; then owner-dispatched CI 9/9 on `verify/0.1.6-storage` (Ubuntu 3.13 and 3.10, macOS, Windows) | all |

**Test-suite findings** (from reading the suite, 2026-10-19; nothing was run):

1. The session isolation (`tests/_isolation.py`, unchanged) sets `BUGPILOT_CONFIG_DIR` for the whole session. Unless the per-test fixture removes it, every text-mode CLI test would print the warning. The session value stays: it is harmless once the product ignores the variable, and the isolation guard's collection-time checks keep passing.
2. Eight test files use the fixture's folder directly, to place `instructions.md` or custom Fix Modes there: `test_ai_behavior`, `test_context_preview`, `test_instructions`, `test_project_settings`, `test_protected_rules`, `test_task_preview`, `test_fix_mode_custom` and `test_mcp_server`. Once that folder is no longer created for them, they use the helper, never a plain `mkdir`.
3. `test_task_golden.py` sets `BUGPILOT_CONFIG_DIR` and places a private instruction there, to prove it never reaches a golden. Once the variable is ignored, that test would pass without testing anything, so the instruction moves to the new place.
4. `test_batch4_file_safety.py` keeps decision B4-2: the configuration folder may sit behind a link. Two of its tests point `BUGPILOT_CONFIG_DIR` at a linked folder and at macOS's `/tmp`.
   - The data root is resolved with `realpath`, so the same cases are expected to hold with `BUGPILOT_HOME`.
   - A link at `config/` itself is refused, as US-D2's uniformly checked tree intends.
   - The tests are rewritten for `BUGPILOT_HOME`. If the macOS case no longer holds, that is a stop condition, not a skip.
5. Its refusal-message assertion names `BUGPILOT_CONFIG_DIR/config.toml`, and becomes the display form.

**Expected compatibility changes** (on the branch only, until activation):

- configuration, user instructions and user Fix Modes move, and the old files are ignored, so users re-run `setup` and re-enter the site (US-D2);
- `BUGPILOT_CONFIG_DIR` is ignored, with one warning. A user who pointed it at a linked or synchronized folder points `BUGPILOT_HOME` there instead: the data root may be reached through a link, but `config/` inside it may not;
- a home folder inside a Git working tree refuses configuration writes (G-1/G-2), and `BUGPILOT_HOME` is the remedy;
- unavailable storage is reported as one sentence, under Q-2's code;
- `instructions show --json`'s user `path` has a new display value, with no new field;
- extension failures that follow from the 0.1.5 configuration locations are ledgered under §15.4, for Batch 3.

**Exclusions:**

- no migration, legacy reader, fallback or deletion;
- no work-item, memory, project-settings, `doctor`, contract-field, golden, prompt, task-text or handoff change;
- no extension change;
- no change to `_isolation.py` or any frozen record;
- no new error code or JSON field;
- no version change and no activation;
- no real-agent probe;
- nothing pushed or fast-forwarded to `main`.

**Stop conditions:**

- a file outside the approved allowlist must change;
- a test would have to be skipped, deleted or loosened, or would pass without testing anything;
- a frozen record, golden or contract fixture would change;
- a designed difference beyond the two expected entries;
- any Python test fails;
- an extension failure does not follow solely from the configuration locations;
- the write witness sees an unchecked write;
- an absolute path, or an environment variable's value, appears in a message.

**Acceptance:** every row of the matrix above passes; all nine CI checks pass on the branch; the plan records the batch; the owner reviews it.

**The rest of Batch 2B** (proposed; each slice needs its own authorization):

- **2B-3:** repository settings (US-D9).
- **2B-4:**
  - work items, memory, `clean` (through the delete methods) and `list` (`work_items()`);
  - the task, retry and review text and the goldens (US-D13, D14, D25, D30, and US-D10's wording).
- **2B-5:** the MCP values, INSTRUCTIONS and descriptions (US-D27, D31), plus the 2B-5 gate's remaining items.
- **2B-6:**
  - `doctor`'s `storage` object and capability, and the contract fields (US-D21, US-D26);
  - `--feedback-file` (US-D18);
  - the Python launch gate (US-D12);
  - `.gitignore` editing (US-D16);
  - scripts.

**Open questions for the owner, before implementation:** *(answered on 2026-10-19; see "Batch 2B-2 — final contract resolution" below)*

- **Q-1:** blocker 5. Either decide `STORAGE_UNAVAILABLE` now, or amend blocker 5 for this slice so that the generic code stands until it is decided.
- **Q-2:** confirm the classification. Unavailability uses `INTERNAL_ERROR`, the fixture's rule; policy refusals keep `INVALID_INPUT`, §8.6's rule.
- **Q-3:** confirm that §14.3's decision list and Batch 0B precondition apply per slice: each slice needs the decisions and probes its scope touches.
- **Q-4:** the warning's text. Proposed: US-D3's own sentence, "BUGPILOT_CONFIG_DIR is no longer used; set BUGPILOT_HOME to choose BugPilot's data folder", in text mode only.
- **Q-5:** approve the allowlist expansion: `mcp_server.py`, `errors.py`, `tests/storage_baseline.py` and two new test files.
- **Q-6:** each designed difference's `to` value is approved in the implementation review.

**Version:** 0.1.5, unchanged. **Decisions:** US-D2 approved with conditions; US-D29 and US-D22 approved in part; nothing else changed. **Batch 0B:** not complete. **Batch 2B-2 to 2B-6:** NOT STARTED.

#### Batch 2B-2 — final contract resolution (2026-10-19)

**Status.** This section is documentation only.

- The owner answered Q-1 to Q-6. This section reconciles Q-1 and Q-2 with the frozen contract, and specifies the MCP request scope and the designed-difference procedure.
- It also corrects the decision-gate specification above, where a re-check against the code found it wrong. The text above is kept as the owner reviewed it; where the two differ, this section governs.
- Nothing is implemented, branched, committed, pushed or dispatched, and storage is not activated.
- Implementation needs a separate owner authorization and answers to C-1 to C-5 below. *(The owner approved C-1 to C-5 later on 2026-10-19: "Owner approval of C-1 to C-5", at the end of this section. Implementation still needs its own authorization.)*

**Owner answers** (2026-10-19):

| | Answer | Recorded as |
| --- | --- | --- |
| Q-1 | APPROVED IN PRINCIPLE: define the classification and its boundary behaviour. No new public error code is authorized. | "Classification U" below. US-D26's `STORAGE_UNAVAILABLE` code stays OPEN. |
| Q-2 | REQUIRES CONTRACT RECONCILIATION. Keep `INVALID_INPUT` for invalid inputs and explicit policy refusals, and present the exact mapping and its compatibility. | the comparison below; the choice is C-1, approved as M-1 |
| Q-3 | APPROVED WITH CONDITIONS. Prerequisites apply per independently testable slice, but every mandatory activation gate and live-agent dependency stays, and missing evidence is never a pass. | "Per-slice prerequisites" below |
| Q-4 | APPROVED: "BUGPILOT_CONFIG_DIR is no longer used; set BUGPILOT_HOME to choose BugPilot's data folder". Text mode only, on stderr, at most once per invocation; presence only, the value never read or shown. | US-D3: the warning is decided; `legacy_config_dir_variable` stays open |
| Q-5 | APPROVED as scope, not as implementation authorization: `bugpilot/mcp_server.py`, `bugpilot/core/errors.py`, `tests/storage_baseline.py`, `tests/baselines/0.1.6-batch2b2/designed_differences.json`, `tests/test_mcp_request_scope.py` | the allowlist |
| Q-6 | APPROVED WITH CONDITIONS. The Batch 0A records stay byte-for-byte. Differences are exact JSON-pointer from/to comparisons, each independently justified and reviewed before the implementation is finalized. | "Designed differences" below |

**Corrections to the decision-gate specification above** (found by re-checking it against the code):

1. **The error mapping.** The gate proposed reporting `storage.StorageUnavailable` as `INTERNAL_ERROR` through a new arm in `errors.py`.
   - That breaks the frozen rule "`StorageError` and `StorageIdentityError` report `INVALID_INPUT`" (§8.10, and the fixture's approved `unchanged.storage_errors_report`).
   - That rule was frozen in `5222da7`, the commit that added `StorageUnavailable` as a `StorageError`.
   - The proposal is withdrawn; see the comparison below.
2. **Reads of user instructions.** "Every `OSError` from these consumers becomes `StorageUnavailable`" was wrong for them. `instructions.read_text_document` never raises for a file's own state: an unreadable file is left out with a visible problem. That contract is kept.
3. **0.1.5's codes differ by command.**
   - `instructions set` and the `fix-mode` writes already report a write failure as `INVALID_INPUT`, through their own handlers.
   - The configuration commands report `INTERNAL_ERROR` (the last resort), or a traceback in text mode.
4. **The designed differences.** The gate predicted two entries and an unchanged generator. Both predictions were wrong.
   - The generator must give each session its own data root once `BUGPILOT_CONFIG_DIR` is ignored. Otherwise the pollution session's user instructions reach the handoff and cli sessions.
   - A third entry follows from a message that names the configuration file (in `handoff.json`).
5. **The allowlist.** That message is `jira.ERROR_MESSAGES["missing_env"]` in `bugpilot/core/jira.py`, which is not on the approved list (C-3). The CLI's help texts and the `jira-site set` confirmation also name the old place; they are in `cli.py`, which is on the list.
6. **Links.** Storage refuses a link at `config/instructions.md` for reads too (`_file`, §8.3). 0.1.5 left a linked user instructions file out with a problem (C-2).
7. **The open questions.** Q-1 to Q-6 are answered; the remaining choices are C-1 to C-5.

**Q-1 and Q-2: the frozen contract, statement by statement.**

| # | Statement | Source | Status |
| --- | --- | --- | --- |
| F1 | The envelope (`schema_version`, `ok`, `command`, `error.code`, `error.message`) is unchanged. | §8.10; fixture `unchanged.envelope` | approved (US-D26, in part) |
| F2 | `StorageError` and `StorageIdentityError` report `INVALID_INPUT`. | §8.6, §8.10; fixture `unchanged.storage_errors_report` | approved; frozen in `5222da7`, when `StorageUnavailable` was already a `StorageError` |
| F3 | Until `STORAGE_UNAVAILABLE` is chosen, a data root that cannot be created or written uses "the existing generic code". | §8.10; fixture `open_choices`. B1-7 read it as: the system `OSError` is not translated, so it reaches `INTERNAL_ERROR`. | an open choice, not approved; it describes current behaviour |
| F4 | Adding a code is a contract change, and codes are never renamed or repurposed. The message may be reworded freely; the extension branches on the code and never parses the message. | `errors.py`; `extension/src/errors.ts` (`diagnose`) | in force |
| F5 | `StorageUnavailable`'s code "is still open". | its docstring in `storage.py` | conflicts with F2's letter; no product path raises it to a client yet |
| F6 | 0.1.5 behaviour is preserved until the authorized integration batch. | §14.3, blocker 8 | approved |

**Classification U, "storage unavailable"** (Q-1, approved in principle; internal, with no new code):

- **U** is an operation on BugPilot's own data folder that the file system refused or failed, and that may succeed later without the user changing BugPilot's configuration. It covers:
  - permission denied;
  - a file in use, after storage's bounded retries;
  - a read-only file system;
  - no space or quota;
  - an I/O error;
  - any other `OSError` from such an operation that is not listed below.
- **Not U:**
  - **Policy refusals (P)** are `StorageError` or `StorageIdentityError`, reported as `INVALID_INPUT` (F2). They are:
    - the data root inside a Git working tree or `GIT_WORK_TREE`, including the fail-closed "cannot be examined";
    - a link or junction on the way or at the file;
    - not a folder, or not a regular file;
    - a credentials place that cannot be proven private;
    - a mismatched or corrupt identity record.
  - **Invalid configuration (I):** a `BUGPILOT_HOME` that cannot be used as given, including a missing parent folder (B1-7). It is a `StorageError`, reported as `INVALID_INPUT`.
  - **Absent (A):** an optional file that does not exist: no `config.toml` (not configured), no instructions, no custom Fix Modes. Not an error.
- **A read of an optional user document** (instructions, or a Fix Mode file) keeps 0.1.5's rule for U: the document is left out with a visible problem or catalog issue. It is never silent, and never an error.

**The carrier.** In 2B-2, U at the consumer boundary is raised as a new internal class, `errors.StorageAccessError(OSError)`.

- It carries one sentence: the action, the display path, and the original exception's class name. It is raised `from None`, so no traceback carries the original path.
- **It is an `OSError` on purpose.** Every handler that handles an `OSError` today handles it the same way, so no command's code or control flow changes. `error_code_for` gets one explicit arm for it, giving `INTERNAL_ERROR`, which is what its last arm returns today.
- `storage.StorageUnavailable` is not used by 2B-2 and stays unchanged. It is raised only for identity records and deletions, which 2B-2 does not reach.

**The mapping, compared.** The table shows the code each surface reports for U. P and I are `INVALID_INPUT` under every option.

| Surface | 0.1.5, for the same failure | **M-1, code-preserving (recommended; approved as C-1)** | M-2: `StorageUnavailable` reports `INTERNAL_ERROR` | M-3: the generic code everywhere |
| --- | --- | --- | --- | --- |
| Reading `config.toml` (every command that loads the configuration; MCP `prepare_*`) | JSON: `INTERNAL_ERROR`, with the `OSError` text. Text: a traceback. MCP: `[INTERNAL_ERROR]`, with the `OSError` text. | JSON: `INTERNAL_ERROR`, one sentence. Text: `ERROR: <sentence>`. MCP: `[INTERNAL_ERROR]: <sentence>`. | `INTERNAL_ERROR` where the last resort classifies it, but `INVALID_INPUT` wherever a local `except ValueError` hardcodes that code | `INTERNAL_ERROR` |
| Writing `config.toml` (`setup`, `jira-site set`) | `INTERNAL_ERROR`, or a traceback | `INTERNAL_ERROR`, one sentence | as above | `INTERNAL_ERROR` |
| `instructions set --scope user` | `INVALID_INPUT` from its own handler: "The text could not be read: …" | `INVALID_INPUT`, the same handler, with the sentence inside it | `INVALID_INPUT` (its `except ValueError`) | `INTERNAL_ERROR`: **a code change** |
| `fix-mode create`, `update`, `duplicate`, `delete` with `--scope user` | `INVALID_INPUT` from its own handler: "Fix Mode storage is not writable: …" | `INVALID_INPUT`, the same handler, with the sentence inside it | **escapes its `except OSError` handler**; `INTERNAL_ERROR` at the top level: **a code and control-flow change** | `INTERNAL_ERROR`: **a code change** |
| Reading user instructions or a user Fix Mode file | not an error: a visible problem or catalog issue | unchanged | unchanged | unchanged |
| Frozen rules touched | — | none | F2, so the fixture, §8.10 and their anchoring test change | none in letter; F6 (the 0.1.5 codes) for two surfaces |
| Files beyond Q-5 | — | none: `errors.py` holds the carrier | `tests/fixtures/storage_cli_contract.json`, `tests/test_storage_identity.py` | none |

**What M-1 changes for clients.**

- **Codes:** no `error.code` changes on any 2B-2 surface, compared with 0.1.5.
- **Messages:** one sentence in the display form, with no `OSError` text and no absolute path. F4 allows the rewording.
- **Text mode:** `ERROR: <sentence>` replaces a traceback.
- **New refusals:** storage's policy refusals and invalid configuration (P and I) are new to these commands, and report `INVALID_INPUT` (F2).
- **One exception:** a write that races with the folder's removal. 0.1.5 reported it as `ARTIFACT_NOT_FOUND`, only because it was a `FileNotFoundError`. Under M-1 it reports the surface's U code.

**Left for the `STORAGE_UNAVAILABLE` decision.** This must be decided before 2B-4 switches identity-record reads or deletion:

- the two `INVALID_INPUT` surfaces above report U as invalid input, in 0.1.5 and under M-1;
- `storage.StorageUnavailable` reports `INVALID_INPUT` under F2, and local handlers that hardcode `INVALID_INPUT` for a `ValueError` would keep doing so, whatever `errors.py` says;
- the extension's advice for `INTERNAL_ERROR` points to a trace, which a U failure no longer has.

**Remaining owner choices** (before implementation; all five decided on 2026-10-19, see "Owner approval of C-1 to C-5" below):

- **C-1 (Q-2):** M-1 (recommended), M-2 or M-3. **Approved: M-1.**
- **C-2:** a link at the user instructions file, or on the way to the user scope.
  - (a, recommended; **approved**) Storage's refusal stands: the command stops with `INVALID_INPUT`, as §8.3 and US-D2's checked tree say. No existing user is affected: the 0.1.5 files are ignored, so a link at the new place would be a new one.
  - (b) Keep 0.1.5's non-fatal problem for a link at the file itself. That needs a change to a storage accessor, and `storage.py` is outside the allowlist.
- **C-3:** the not-configured message names `~/.bugpilot/config.toml`.
  - (a, recommended; **approved**) Add `bugpilot/core/jira.py` to the allowlist for that one string, which becomes `~/.bugpilot/config/config.toml`.
  - (b) Compute the display form when the message is produced. This is a larger change to `jira.py`.
  - (c) Leave it. The message would then point to the wrong file, which is a stop condition.
- **C-4:** the designed-difference procedure below, including the generator's per-session data root (a change within the approved `tests/storage_baseline.py`), and the predicted entries. **Approved with conditions** (below).
- **C-5:** where this decision record lands.
  - (a, recommended; **approved**) A docs-only commit on `main`, with the branch based on it.
  - (b) `73ee57e`, with the record as the branch's first commit.

**MCP request-scope contract (D-5).**

1. **Where:** one decorator, `_request_scoped`, in `mcp_server.py`. It is applied under `@server.tool()` to each of the nine tools:
   - `prepare_jira_bug`, `prepare_bug_description`, `refine_investigation`;
   - `check_results`, `summarize_results`, `search_memory`, `get_status`;
   - `list_fix_modes`, `show_fix_mode`.

   Every tool is wrapped, whether or not it reaches storage today, so reachability never has to be tracked.
2. **When:** the SDK (`mcp` 2.1.1) runs a synchronous tool in a worker thread (`anyio.to_thread.run_sync`).
   - The decorator opens `storage.request_scope()` there, as the first thing the body does, and closes it when the body returns or raises.
   - Nothing is opened in the event loop, `build_server`, `main`, a lifespan, or the `fix_bug` prompt (which only builds text).
3. **Signature:** the decorator uses `functools.wraps`. The function stays synchronous, and its parameters and docstring are unchanged, because the SDK builds the tool's schema from them. A marker attribute lets a test check every registered tool.
4. **Concurrency:** each call has its own scope, in its own thread.
   - Scopes are thread-owned (2B-1's C-2), so a context copied from the event loop carries none, and a pooled thread starts the next call without the last call's verdicts.
   - `bound.lock` is unchanged. A mutating call's scope starts before it takes the lock, and its verdicts cover the whole call, as a CLI command's do.
5. **Lifetime:** no scope outlives its call. A call that the client cancels ends its scope when the worker thread's function ends; threads are not interrupted.
6. **Fail closed:** an exception ends the scope (`finally`) and reaches the existing handler unchanged. A refusal is never turned into success, nothing is retried, and no verdict survives into another call.
7. **No long-lived state:** `global_storage()` is computed on every call. The server keeps only its bound repository root and its lock.
8. **Tests** (`tests/test_mcp_request_scope.py`), all through `MCPServer.call_tool`, the SDK's own dispatch:
   - every registered tool carries the marker, and the prompt is not wrapped;
   - inside a tool body, `storage._active_scope()` is a scope. After the call, the event-loop thread has none, and the next call gets a new scope object;
   - two calls held at a `threading.Barrier` overlap in different threads, with different scope objects;
   - a `.git` folder created above the data root between two calls makes the second call refuse, so no verdict was cached;
   - a storage refusal and a U failure inside a tool both reach the client as a `ToolError` with the one-sentence message and no absolute path, and the scope is gone afterwards;
   - building the server opens no scope.
9. **The CLI side (2B-5 gate item 4):** one scope per invocation, and `bug --launch-agent` closes it before the agent starts. The test replaces the launcher with a stand-in that checks no scope is active.

**Designed differences (D-6, Q-6).**

*The file:* `tests/baselines/0.1.6-batch2b2/designed_differences.json`. It holds:

- `base_commit`;
- `frozen`: each compared record's SHA-256, over its LF-normalized bytes;
- `differences`: one entry per difference, with:
  - `id`, `record`, and `pointer` (RFC 6901);
  - `from` and `to`;
  - `decision`, and `evidence` (an independent test);
  - `approved`: the owner's approval date, written only after the approval.

*The check* (`storage_baseline.differences()`, used by `test_storage_baseline.py`):

1. Each frozen record's hash matches, and `git diff` of `tests/baselines/0.1.6-batch0/` is empty.
2. Every pointer is well formed. No pointer is listed twice, and none lies inside another.
3. For each entry, the frozen value at the pointer equals `from` exactly, value and type, and is replaced by `to` in memory.
4. The patched record, serialized with the generator's own `_dump`, equals the regenerated bytes exactly. A record without entries must match byte for byte, as today.
5. **Anything else fails:**
   - any other difference;
   - a listed difference that did not happen;
   - a stale `from`;
   - an entry without `approved`;
   - a record outside `COMPARED`.

There are no wildcards, no patterns and no added normalization. The mechanism's own tests use synthetic records: a listed difference passes, each failure above fails, and the `~0` and `~1` escapes work.

*The generator change* (C-4):

- each `Session` gets its own data root, `<base>/data`, through `BUGPILOT_HOME`, with a `<data>` normalization label;
- `BUGPILOT_CONFIG_DIR` stays set. The pre-2B-2 product ignores `BUGPILOT_HOME`, so the same generator reproduces the frozen records on it;
- `user_configuration_written` still lists the `BUGPILOT_CONFIG_DIR` folder.

*The procedure:*

1. **Neutrality first.** On the branch, before any product change, apply only the generator change and the mechanism, with an empty `differences` list. It must report zero differences.
2. **Product change.** Then regenerate into a scratch folder, never into `tests/baselines/0.1.6-batch0/`, and list every differing pointer with its frozen and regenerated values, verbatim.
3. **Match against the prediction.** Each observed difference must be exactly one of DD-1 to DD-3. Anything else stops the batch, and no entry is added for it.
4. **Independent evidence.** Each entry's `evidence` test asserts the new value from first principles, never from a baseline.
5. **Owner review.** The table of observed differences and their evidence goes to the owner before any commit. `approved` is filled in only after the approval, and a later change to an entry needs a new approval.

*The predicted entries* (C-4 approved them as expected categories, not as observed or verified values. Each exact `from` and `to` value, and its independent evidence, is reviewed by the owner before the implementation commit):

| Id | Record | Pointer | From (frozen, exact) | To (predicted) | Decision | Evidence |
| --- | --- | --- | --- | --- | --- | --- |
| DD-1 | `cli_paths.json` | `/instructions show --json path fields/user` | `"BUGPILOT_CONFIG_DIR/instructions.md"` | `"BUGPILOT_HOME/config/instructions.md"` | D-2, D-9 | `instructions show --json`'s user `path` equals `storage.display_path` of `user_instructions_file()` |
| DD-2 | `handoff.json` | `/cli_text/bug/0` | ``"WARN: Jira is not configured: no Jira site, email and API token were found in the environment or in ~/.bugpilot/config.toml. Run `bugpilot setup`, or set JIRA_BASE_URL, JIRA_EMAIL and JIRA_TOKEN. Using mock/demo Jira data."`` | the same string with `~/.bugpilot/config/config.toml` (C-3 a) | D-2, D-9; C-3 | the not-configured message names the file that `load_user_config` reads |
| DD-3 | `pollution.json` | `/user_configuration_written` | `["instructions.md"]` | `[]` | D-2, D-3: the retired variable's folder gets nothing | after `instructions set --scope user`, the `BUGPILOT_CONFIG_DIR` folder is empty and `<root>/config/instructions.md` exists |

`task_size.json` has no entry: there is no prompt or golden change, so US-D30 is kept.

**Per-slice prerequisites** (Q-3, approved with conditions). A slice may start when its own decisions and evidence are in place. Every row below stays an activation gate.

| Slice | Decisions it needs | Live-agent evidence it needs |
| --- | --- | --- |
| 2B-2 | US-D2 (with conditions); US-D3 (approved; its warning approved by Q-4); US-D22 (in part); US-D26 (in part), with this contract (M-1, approved as C-1); US-D29 (in part) | none (D-7) |
| 2B-3 | US-D9 | none known |
| 2B-4 | US-D4, D8, D13, D14, D15, D18, D25, D30, and US-D10's wording; `STORAGE_UNAVAILABLE` (the residue above) | P1 and P3 (US-D10) for the task and handoff text; P2 (US-D28) for the captured review |
| 2B-5 | US-D27, D31, and the rest of the 2B-5 gate | P8 (US-D27) |
| 2B-6 | US-D12, D16, D18, D20, D21, and US-D26's remaining rows | none known |
| Activation | everything above, all eight of §14.3's blockers, and every live-agent dependency | Batch 0B complete for P1, P2, P3 and P8. P2 is FAIL, and P1, P3 and P8 are NOT EXECUTED: none of them counts as a pass. |

For 2B-2, blockers 1, 2, 3 and 7 are met only on the consumer side 2B-2 reaches. Blocker 5 is met for 2B-2 only, now that C-1 is answered (M-1). US-D26's `STORAGE_UNAVAILABLE` stays OPEN.

**The allowlist, as now proposed.**

- the decision gate's base list;
- the Q-5 files, whose roles are now:
  - `errors.py`: the carrier class and its arm;
  - `tests/storage_baseline.py`: the comparison, and the generator's per-session data root;
- `bugpilot/core/jira.py`: the not-configured string only (C-3 (a), approved).

The contract fixture, `tests/test_storage_identity.py` and `storage.py` stay untouched under M-1 and C-2 (a), both approved.

**Added tests.**

- **The carrier:** for each surface in the mapping table, the code M-1 names, one sentence, no absolute path, no traceback in text mode.
- **The warning:** exactly Q-4's sentence, once, in text mode; nothing in JSON modes or in MCP; the variable's value never appears, checked with a sentinel; an empty value counts as present.
- **The MCP tests** above.
- **The designed-difference mechanism tests**, and the neutrality run.

**Version:** 0.1.5, unchanged. **Decisions:** no register status changed. **Batch 2B-2 to 2B-6:** NOT STARTED.

**Owner approval of C-1 to C-5** (2026-10-19):

| Choice | Decision | What it means |
| --- | --- | --- |
| C-1 | **M-1 approved** | Existing public error codes are preserved. U is carried internally by `errors.StorageAccessError(OSError)`. This does not decide US-D26's `STORAGE_UNAVAILABLE`, which stays OPEN. |
| C-2 | **(a) approved** | Storage's refusal of a link at the user instructions file, or on the way to the user scope, stands, reported as `INVALID_INPUT`. No storage check is loosened. |
| C-3 | **(a) approved** | During implementation, only the Jira not-configured message changes, to `~/.bugpilot/config/config.toml`. `bugpilot/core/jira.py` joins the allowlist for that string only. |
| C-4 | **approved with conditions** | The designed-difference mechanism and the per-session data roots are used. DD-1 to DD-3 are approved as expected categories, not as observed or verified values. Each exact `from` and `to` value, and its independent evidence, is reviewed by the owner before the implementation commit. |
| C-5 | **(a) approved** | This record is committed to `main` as documentation only, before `verify/0.1.6-storage` exists. The branch is created from the resulting verified `main` commit, and only when the owner authorizes it. That commit differs from D-1's base, `73ee57e`, only in this plan. |

**State after the approvals:**

- **Batch 2B-1:** COMPLETED, NOT ACTIVATED.
- **Batch 2B-2:** the design and the implementation contract are approved. Implementation has NOT STARTED and is not yet authorized, and the integration branch is not created.
- **Error codes:** M-1 preserves every existing public error code, and no new code exists.
- **US-D26:** still APPROVED only in part. `STORAGE_UNAVAILABLE` stays OPEN and must be decided before 2B-4. The rows that follow US-D4, D16, D18 and D25, and US-D3's `legacy_config_dir_variable`, stay open too.
- **Batch 0B and activation:** Batch 0B is not complete. Its evidence (P1, P3 and P8 NOT EXECUTED; P2 FAIL) and all eight of §14.3's activation blockers stay mandatory, and missing evidence is never a pass.
- **Designed differences:** DD-1 to DD-3 need exact-value verification, and the owner's review, before the implementation commit.
- **Unchanged:** the version (0.1.5) and every register status. Batch 2B-3 to 2B-6 have NOT STARTED.

### 14.4 Batch 3 — Extension and Agent Handoff

**1. Scope.**

- The extension stops computing `.ai` and `.bugpilot` paths (US-D17).
- `user_feedback.md` goes through the CLI (US-D18).
- Reset Session uses only `bugpilot clean`.
- History uses `list`'s fields.
- Open Artifacts Folder uses `revealFileInOS`.
- The watchers and the policy editor move to the CLI-given paths.
- The gitignore UI goes (US-D16).
- The capability check: `unified-storage`.
- The handoff per §9.5, including the gate fallback (US-D12). The gate is unchanged. *(As approved on 2026-10-18, §9.9.1: the character set is unchanged, while Unicode whitespace handling and exact prompt preservation are tightened.)* A launch without a shell (§9.9) is included only if the owner separately approved it after P11.
- MCP and handoff live verification (as P6 and P8, with real 0.1.6 artifacts, separately owner-approved), with any text corrections it finds.
- **Restore the complete CLI–extension contract** (§15.1) and **close the expected-failure ledger** (§15.4).

**2. Files.**

| Area | Files (under `extension/`) |
| --- | --- |
| App | `src/app/controller.ts`, `src/app/sessionReset.ts`, `src/app/nextAction.ts`, `src/app/agents.ts`, `src/app/progress.ts`, `src/app/artifacts.ts`, `src/app/form.ts`, `src/app/environment.ts`, `src/app/verificationPolicy.ts`, `src/app/aiBehaviorPolicy.ts`, `src/app/jiraConnection.ts`, `src/app/gitignore.ts` (removed if US-D16) |
| Host | `src/host/ports.ts`, `src/host/bugpilotFiles.ts` |
| Views and panel | `src/app/results.ts`, `src/views/trees.ts`, `src/panel/html.ts`, `media/panel.js` |
| Entry | `src/executable.ts`, `src/extension.ts` |
| Tests | `test/*.test.ts` per §11.3; `test/cliArgvContract.test.ts`, which regenerates `tests/fixtures/extension_cli_argv.json`; `test-integration/cli.integration.test.ts` |
| Records | `tests/storage_inventory.json`; this plan |

**3. Preconditions.**

- Batch 2 is on the branch, and its ledger is recorded.
- These decisions are approved: US-D11 (the review recommends deferring), D12, D17 and D19.
- Batch 0B records exist for P6, P7, P9 and P10, and for P11 if it ran, each as PASS, FAIL or UNKNOWN.

**4. Explicit exclusions.**

- no default permission flag;
- no change to the managed runtime's location;
- no Settings redesign;
- no Copilot adapter (none exists today).

**5. Steps.**

1. Fetch `repository_dir` and `unified-storage` with `doctor`, per root, and refresh them on a root change.
2. One composition helper (§8.9), with a shared fixture test. Remove `#itemFile`'s `.ai`, `preparedContextPath`, and the `ports.ts` joins and guard.
3. Retry through `--feedback-file`; delete `writeWorkItemFile`.
4. Reset Session through `clean` only.
5. History from `list` (`work_dir`, `modified`); the probe reads `run.json` under `work_dir`.
6. Watchers (artifact and policy) on the external folders, per P7; Open Artifacts Folder through `revealFileInOS`.
7. Policy Edit: open the CLI-given `path`; `bugpilotFiles` with the new base.
8. Handoff:
   - the templates, with the CLI path in forward-slash form;
   - the gate unchanged, with its fallback to manual handoff, a notice, and the fallback recorded as FALLBACK;
   - the guidance sentence;
   - `--add-dir` only if US-D11 is approved, which the review recommends against for 0.1.6;
   - no sandbox or permission change.
9. Remove the gitignore notice, quick fix and tests (US-D16).
10. UI strings (§5.5 B; the US-D9 wording).
11. Tests, the integration suite (isolated), and the ratchet down to the final residue.

**6. Acceptance.**

- Typecheck and unit tests are green; the required TypeScript job includes the new files.
- The integration suite is green locally and isolated.
- No TypeScript code writes or deletes under `repository_dir`. This is enforced by a test over the `FilesPort` calls and by the ratchet.
- A real VS Code pass in a disposable profile with an isolated `BUGPILOT_HOME`:
  - prepare (Jira mock and hand-written), Fix with AI (Claude and, where authorized, Codex), retry, review (captured and terminal), verification;
  - History, Reset Session;
  - settings Edit, Reset and Preview (all six layers);
  - Open task.md, Open Artifacts Folder;
  - a home with a space in its path;
  - after all of it, the repository's `git status` is clean.
- **The contract is complete:**
  - the §15.4 ledger is empty: every ledger test passes, asserting what it asserted apart from the designed contract change;
  - the full extension suite, the cross-language tests and the TypeScript contract test against §8.10's fixture are green.
- The live MCP verification (A8) and the handoff aspects exercised in the real pass are recorded as PASS, FALLBACK, FAIL or UNKNOWN. Release-grade end-to-end evidence is Batch 5's (§9.10).

**7. Security tests.** T-S7 (the extension composes only under the CLI's base), T-S12 (the TypeScript gate and fallback), T-S16 (only if US-D11), T-S20 (the extension writes nothing in the repository).

**8. Regression.** The extension suite; the cross-language tests; the argv contract; the required TypeScript job's existing files.

**9. Cross-platform.**

- Extension unit tests on Ubuntu in CI.
- The real VS Code pass on Windows (this machine).
- macOS and Linux extension behaviour is unit-tested only. That is recorded as a residual risk, unless the owner provides a machine.

**10. Rollback.** The branch, as Batch 2.

**11. Dependencies.** Batch 2's JSON contract and flag.

**12. Stop and approval gate.**

- **Stop if:**
  - an out-of-workspace watcher does not fire (P7). The owner chooses between polling on focus and a manual refresh;
  - the gate fallback cannot be made clear;
  - an agent cannot complete a workflow with A;
  - a ledger test can pass only by weakening what it asserts.
- **Gate:** the owner approves Batch 4.

### 14.5 Batch 4 — Security and cross-platform validation

**1. Scope.**

- Prove §10.3 on Linux, macOS, Windows and Python 3.10, and run every T-S test.
- Reassess the prompts, the CLI and MCP output, and path privacy (US-D22).
- SF-1 (US-D39) and SF-5.
- A final security review before commit, in §44's format.
- Fix gaps without unrelated refactoring.
- Then, only with the owner's explicit merge approval, fast-forward `verify/0.1.6-storage` to `main` (US-D29, §15.4). Nothing is automatic.

**2. Files.** Only what a finding requires, plus `projectSettings.ts` and `repositoryProfile.ts` (SF-1, if approved), the tests and this plan.

**3. Preconditions.** Batches 2 and 3 are complete on the branch, with an empty §15.4 ledger, and US-D39 is decided.

**4. Explicit exclusions.** No new feature; no refactor beyond a finding's fix.

**5. Steps.**

1. Owner-dispatched CI on the branch: all nine jobs green.
2. The T-S matrix (§10.2), each threat mapped to a test that has run on the OS it concerns.
3. A **mutation check** on scratch copies of the package, as §44.22 did. Each control is removed in turn, and a test must catch the removal:
   - link refusal at each component;
   - the record check;
   - id validation;
   - resolution creating nothing;
   - the gates (Python and TypeScript);
   - the pollution guard;
   - the no-legacy guard.
4. Privacy review: every CLI command's text and JSON output, and every MCP tool result, with an isolated home whose name is distinctive. Only designated fields hold it.
5. SF-1 and SF-5.
6. Review of `docs/safety.md` claims against behaviour (the docs themselves are written in Batch 5).
7. Owner-dispatched CI on the exact commit to be merged: all nine required checks green.
8. The owner explicitly approves the merge. Only then, the fast-forward to `main`, done or authorized by the owner, never automatically.
9. CI on `main` after the fast-forward.

**6. Acceptance.**

- every T-S test green on its OS;
- no Critical or High finding open;
- the ratchet at its final residue;
- every mutation caught;
- all nine required CI checks green on the branch, at the commit merged;
- the owner's explicit merge approval recorded in §19;
- CI green on `main` after the fast-forward;
- the version still 0.1.5.

**7. Security tests.** All of §10.2.

**8. Regression.** All of §11.4.

**9. Cross-platform.** Required on all four configurations; POSIX modes and macOS paths are verified, not inferred.

**10. Rollback.** Before the fast-forward: the branch. After it: revert commits on `main`. No data is affected, because no migration ran.

**11. Dependencies.** Batches 2 and 3.

**12. Stop and approval gate.**

- **Stop if:**
  - a guarantee of §10.3 cannot be met on an OS;
  - a mutation survives;
  - any of the nine checks is red.
- **Gate:**
  - the owner explicitly approves the merge, after seeing all nine checks green;
  - there is no automatic push or fast-forward;
  - then the owner approves Batch 5.

### 14.6 Batch 5 — Final UX, packaging and release readiness

**1. Scope.**

- Storage status and diagnostics: `doctor`, and the panel's Diagnostics, including §7.1's subfolder line. No legacy-presence line unless the owner later approves US-D20, which the review recommends deferring.
- The §9.10 real interactive end-to-end runs, for every combination the owner lists as supported.
- Documentation (§13): README, `extension/README.md`, `docs/architecture.md` (§6 rewritten), `docs/safety.md`, `docs/development.md`, `docs/mcp_setup.md`, `docs/skill_setup.md`, `docs/notifications.md`, `docs/adapter_design.md` (the storage references only).
- The changelog entries: "Unreleased — 0.1.6 candidate", then the dated entry at the bump.
- Clean installs; the real VS Code pass; live handoff probes against the candidates.
- Packaging and publishability; final CI; the readiness report.
- The version bump only after the release review (as §44.13).

**2. Files.** Docs; `CHANGELOG`s; any UI text from the real pass; the version files at the bump (`bugpilot/__init__.py`, `extension/package.json`, and their lockstep tests); this plan.

**3. Preconditions.**

- Batch 4 is on `main` with green CI.
- The owner has listed the supported agent and provider combinations (§9.10).
- The owner has separately approved the account-using end-to-end runs.

**4. Explicit exclusions.**

- no behaviour change beyond diagnostics text;
- no publish without the owner (PyPI through the release workflow's protected environment; Marketplace by the owner).

**5. Steps.**

1. Diagnostics UX (US-D21), including the §7.1 subfolder line. The legacy notice only if US-D20 is approved.
2. Docs and changelog; the owner reviews external-facing text.
3. Clean installs: pipx, a wheel in a new venv, the managed runtime from local files and offline. A fresh home, plus a home with 0.1.5 files present: they stay untouched, 0.1.6 starts empty, and `doctor` explains it.
4. The real VS Code pass: four themes, three widths, for the changed UI; the Batch 3 workflow list on the candidates.
5. The §9.10 end-to-end runs on the candidates.
   - Every applicable aspect (A1–A9) of every owner-listed combination (H1–H7), using synthetic repositories and disposable data folders.
   - Each result is recorded in §18 with the §9.7 fields, as PASS, FALLBACK, FAIL or UNKNOWN. Only an observed result counts. FALLBACK and UNKNOWN are not PASS.
   - P1–P11 are re-run where they add evidence.
6. Packaging inspection (wheel, sdist and VSIX contents); publishability; `check_cli_contract.py`.
7. Release review, then the version bump to 0.1.6 in lockstep, the candidates, CI, and the readiness report (§20).

**6. Acceptance.** Every item of §20.

**7. Security tests.** The full suite on the bumped tree; the privacy review re-run on the candidates.

**8. Regression.** Everything; CI on `main`.

**9. Cross-platform.** CI on all three systems; the managed-runtime smoke on Windows. A Linux or macOS smoke is recommended if a machine is available (§44.10's recommendation).

**10. Rollback.**

- Before publication: revert.
- After publication: a follow-up release. PyPI versions are immutable.
- No user data needs restoring: 0.1.5 data was never touched.

**11. Dependencies.** Batch 4.

**12. Stop and approval gate.**

- **Stop if:**
  - any new Critical or High finding;
  - a doc claim that does not match behaviour;
  - a required aspect of an owner-listed combination is not PASS, and the owner has not moved that combination to "unsupported or limited" in the release notes.
- **Gate:** the owner approves the version bump from 0.1.5, then publication.

---

## 15. Batch dependencies and integration strategy

### 15.1 What cannot be split

These change both sides of a shared contract, so a commit that changes only one side breaks `main`:

| Contract | Python side (Batch 2) | Extension side (Batch 3) |
| --- | --- | --- |
| Where artifacts are | every writer moves to the data root | the extension reads `<root>/.ai/<id>` itself (§4.2); History, Results, Reset Session and retry all break |
| The handoff templates | `handoff.py`, `cli.py:1824` | `controller.ts:3349-3351`, `nextAction.ts:206-208`; cross-language tests (`controller.test.ts:1636-1659`, `nextAction.test.ts:254-262`) parse the Python source |
| JSON field values | `bug`, `list`, `status`, `--retry`, settings `path` | the consumers |
| `--feedback-file` | the CLI flag | the retry flow; the argv contract fixture |
| `doctor` | the `storage` object, the capability, the removed `ai_artifacts_ignored*` | environment check, gitignore UI |

A partial migration is therefore **not safe on `main`**. In particular, an extension at Batch 2's state would show an empty History and recreate `.ai/` on retry (SF-2).

### 15.2 Strategy (US-D29, APPROVED in part on 2026-10-19: the integration branch, §14.3 "Batch 2B-2 — decision gate"; review: accept the isolated integration branch)

| | Recommended | Alternative |
| --- | --- | --- |
| Batches 0A and 1 | commit to `main` (test-only, and additive) | same |
| Batch 0B | no commit; records in this plan only | — |
| Batches 2–4 | on **`verify/0.1.6-storage`**, created from `main` after Batch 1 with the owner's approval. They stay there until integration is complete (§15.4). One commit series per batch, after its gates. CI by owner-dispatched `workflow_dispatch` on the branch: the workflow runs on pushes to `main` only, as found and used for `verify/0.1.5-batch4` (§44.22). The branch moves to `main` only by an owner-approved fast-forward after Batch 4. | Batches 2 and 3 committed on local `main` and pushed together after both pass. This honours the owner's "commit directly on main" preference, but local `main` is broken in between and no CI can run before the push. |
| Batch 5 | on `main` | same |
| Feature flag (an environment switch between layouts) | **rejected**: a temporary compatibility path R4 rules out in spirit, and a doubled test matrix | — |

The only accepted failures on the branch are listed in §15.4's ledger. Nothing else that fails on the branch is excused.

### 15.3 Temporary scaffolding versus legacy compatibility

| | Status | Examples |
| --- | --- | --- |
| **Allowed: temporary implementation scaffolding within 0.1.6** | **allowed**; removed or settled by Batch 4 | `config.issue_dir` and its siblings keeping their signatures while delegating to `storage`; `safe_paths`'s old messages kept until the last repository-local caller goes; the ratchet's intermediate allowlists |
| **Not allowed: legacy compatibility with 0.1.5 data** | **not allowed** (R4) | any reader of `.ai/`, `.ai_memory/`, `.bugpilot/`, or `~/.bugpilot/{config.toml, instructions.md, fix_modes}`; any copy or import; any alias making `BUGPILOT_CONFIG_DIR` mean the new root; any fallback "if the new file is absent, try the old one" |

### 15.4 Integration gates on `verify/0.1.6-storage`

**Batch 2 on the branch.**

- **The whole Python suite passes**: locally on Windows, and in owner-dispatched CI on Ubuntu 3.13 and 3.10, macOS and Windows. That includes:
  - the cross-language tests' Python side;
  - the contract tests against §8.10's fixture;
  - every new storage suite.
- **No Python failure is accepted** on the branch, for any reason.

**Extension failures between Batches 2 and 3: the expected-failure ledger.**

- **What may fail.** Only extension tests whose failure follows *solely* from the Batch 3 contract not yet being implemented. The cross-language handoff tests (`controller.test.ts:1636-1659`, `nextAction.test.ts:254-262`) are examples.
- **Each such failure is listed individually** in a ledger in §18. Each entry gives:
  - the test file and test name;
  - the contract item it depends on (§15.1);
  - the observed failure message;
  - the commit at which it was first seen.

  A failure not on the ledger is a regression and stops the batch.
- **No masking.** Ledger tests are not skipped, deleted, loosened or marked expected-to-fail. They keep failing honestly until Batch 3 makes them pass.
- **The required jobs are not hidden either.** If a required job (for example the extension job) is red on the branch, CI is red and is reported as red. The ledger explains why; it does not turn red into green.

**Batch 3 closes the ledger.**

- Batch 3 restores the complete CLI–extension contract (§15.1).
- Its gate requires an **empty ledger**: every ledger test passes, unchanged in what it asserts, apart from the designed contract change in the same commit.

**Batch 4 and the merge.**

- **All nine required CI jobs** are green on the branch, in an owner-dispatched run on the commit to be merged.
- **The owner explicitly approves the merge.**
- **Nothing is automatic:** no push or fast-forward without the owner's approval at that moment.
- **The fast-forward** is followed by CI on `main`, which must also be green.

**Throughout:**

- the version stays 0.1.5 until Batch 5's approved bump;
- nothing is published from the branch.

---

## 16. Risks, assumptions and open decisions

### 16.1 Decision log

**How to read it.**

- **Owner status** is the decision's state: APPROVED, PROPOSED, OPEN or DEFERRED.
  - Beyond the requirements R1–R8, the APPROVED decisions are US-D32 and US-D33, for Batch 0A's scope (2026-10-15), and nine Batch 1 decisions ratified at the Batch 1 decision gate (2026-10-16): US-D1, D3, D5, D6, D7, D23, D24, D26 and D34. On 2026-10-18 the owner approved US-D28 with conditions, as an amended design contract (§16.5.11), US-D14 with conditions, as Refined Option A′ (§16.4.1), US-D13 with conditions, as the hybrid task-document contract (§9.8.1), US-D30 with conditions, as Option D (§9.8.2), US-D10 with conditions, as Option D for the agent handoff, with the probe gap accepted for design only (§9.5.1; "Accepted evidence gaps" below), US-D12 with conditions, as Option C, the prompt gate kept and tightened (§9.9.1), and US-D17 with conditions, as Option B, the CLI as the only path resolver (§8.9.1). On 2026-10-19, at the Batch 2B-2 decision gate, the owner approved US-D2 with conditions, and US-D29 and US-D22 in part (§14.3, "Batch 2B-2 — decision gate"). No other decision is approved.
  - An approval may be qualified, in the status column:
    - **APPROVED — with conditions**: the decision stands; the named conditions must be met before the gate the row names (for Batch 1's decisions: activation in Batch 2, §14.3). Code may exist before then; it is not activated.
    - **APPROVED — in part**: only the stated part is approved. Every other part stays OPEN or PROPOSED, is named in the row, and is listed in "Open parts of approved decisions" below. It is decided on its own, before it is built.
  - A status changes only on the owner's explicit word, recorded in the last column with its date.
- **Review recommendation (2026-10-15)** is the architecture review's technical advice. It is advice, not an approval.

| Review recommendation | Meaning |
| --- | --- |
| *Accept* | adopt as written |
| *Accept conditionally* | adopt once the stated condition is met |
| *Keep open* | do not decide yet; needs evidence or a separate owner choice |
| *Defer* | out of 0.1.6 |

- **Needed before** names the batch that cannot start without the decision.

**Counts.**

| | Count | Decisions |
| --- | ---: | --- |
| APPROVED by the owner | **21** | <ul><li>US-D32, US-D33 (Batch 0A's scope, 2026-10-15)</li><li>US-D1, D3, D6, D7, D24; with conditions US-D5, D23, D34; in part US-D26 (Batch 1 decision gate, 2026-10-16)</li><li>with conditions US-D28 (an amended design contract), US-D14 (Refined Option A′), US-D13 (the hybrid task-document contract), US-D30 (Option D), US-D10 (Option D, design only), US-D12 (Option C) and US-D17 (Option B), 2026-10-18</li><li>with conditions US-D2; in part US-D29 and US-D22 (Batch 2B-2 decision gate, 2026-10-19)</li></ul> |
| Await the owner | **14** | 7 OPEN, 7 PROPOSED |
| DEFERRED | **4** | US-D35 to US-D38 |
| Review: *Accept* | 28 | |
| Review: *Accept conditionally* | 2 | US-D5, US-D26 |
| Review: *Keep open* | 3 | US-D10, US-D14, US-D28 |
| Review: *Defer* | 2 | US-D11, US-D20 |

| Id | Decision | Owner status | Review recommendation (2026-10-15) | Basis; alternatives | Needed before | Owner approval |
| --- | --- | --- | --- | --- | --- | --- |
| US-D1 | Layout: `config/` and `repositories/<id>/{repository.json, settings/, work/, memory/}`; `memory/<id>.md`; no `cache/` | **APPROVED** | **Accept** | §6.1; alt: the brief's draft with `memory/bugs/` and `cache/` | 1 | 2026-10-16: approved by the owner at the Batch 1 decision gate: the unified layout, version 1; no `cache/` |
| US-D2 | Global config moves into `<root>/config/`. Users re-run `setup`; extension users re-enter the site. | **APPROVED** — with conditions | **Accept** (move) | a clean, uniformly checked tree, which resolves the B4-2 inconsistency; alt: keep the 0.1.5 files at the root (no reconfiguration, but 0.1.5 files are then loaded) | 2 | 2026-10-19: approved with conditions by the owner at the Batch 2B-2 decision gate (D-2): `<root>/config/config.toml`, with user instructions and user Fix Modes at `GlobalStorage`'s places; no migration, fallback or deletion; users re-run `setup` once the feature is activated. Conditions: §14.3, "Batch 2B-2 — decision gate" (its specification, and Q-1 to Q-6). Q-1 to Q-6 were answered later that day, which leaves choices C-1 to C-5 (§14.3, "Batch 2B-2 — final contract resolution"). The owner approved C-1 to C-5 the same day; DD-1 to DD-3's exact values are reviewed before the implementation commit. The extension's half, re-entering the site, is Batch 3's (§15.4) |
| US-D3 | `BUGPILOT_HOME` names the data root; `BUGPILOT_CONFIG_DIR` is no longer honoured | **APPROVED** | **Accept**, with a **safe warning**: when `BUGPILOT_CONFIG_DIR` is set, text mode prints one line on stderr ("BUGPILOT_CONFIG_DIR is no longer used; set BUGPILOT_HOME to choose BugPilot's data folder"), and `doctor --json` sets `storage.legacy_config_dir_variable` (§8.10). The variable's *value* is never read, shown or used, and nothing goes to `--json` stdout except that field. | §8.2, §13.2; alt: `BUGPILOT_DATA_DIR`; no warning | 1 | 2026-10-16: approved by the owner at the Batch 1 decision gate: `BUGPILOT_HOME` defines the entire data root. The handling of the deprecated `BUGPILOT_CONFIG_DIR` remains Batch 2 work. 2026-10-19 (D-3, Batch 2B-2 decision gate): the warning's direction is set: at most one stderr line per CLI invocation; the value never read, used or shown; machine-readable stdout unchanged. Its exact text awaits Q-4, and `legacy_config_dir_variable` is deferred to the `doctor` slice. Later that day, Q-4 approved the text: "BUGPILOT_CONFIG_DIR is no longer used; set BUGPILOT_HOME to choose BugPilot's data folder", in text mode only |
| US-D4 | The repository root stays the directory BugPilot runs in, with no git top-level discovery | OPEN | **Accept**, plus the diagnostic of §7.1 (`doctor`'s `below_git_toplevel`; one panel line in Batch 5). No git-root discovery, no relocation. | §7.1; alt: git top-level for identity only | 2 | — |
| US-D5 | Identity algorithm: `realpath(strict)`, `normcase` on Windows only, a versioned SHA-256 prefix, `<slug≤24>-<16 hex>`; prefer split over merge | **APPROVED** — with conditions | **Accept conditionally**: pending the cross-platform verification of §7.3's unverified rows (CI observations in Batch 0A, tests in Batch 1). A row that behaves otherwise returns US-D5 to the owner. | §7.2, §7.3; alt: git remote; inode; full-length hash | 1 | 2026-10-16: approved with conditions by the owner at the Batch 1 decision gate: the canonical identity algorithm, with Batch 1's accepted refinements (B1-2, B1-13, B1-16). Condition: Batch 1's cross-platform CI passes before activation |
| US-D6 | `repository.json` records the canonical root path | **APPROVED** | **Accept** | §7.4; alt: digest only | 1 | 2026-10-16: approved by the owner at the Batch 1 decision gate: the deterministic identity record, published without replacement (B1-14) |
| US-D7 | One namespace per git worktree | **APPROVED** | **Accept** | §7.3; alt: key by `--git-common-dir` (merges worktrees) | 1 | 2026-10-16: approved by the owner at the Batch 1 decision gate: distinct git worktrees use distinct namespaces |
| US-D8 | A moved or renamed repository starts a new namespace; no relocation tooling in 0.1.6 | PROPOSED | **Accept** (relocation DEFERRED) | §7.1, §7.3 | 2 | — |
| US-D9 | Repository settings become per-user per-repository, with no team sharing through the repository. Section names are kept; intro and help wording stop claiming "shared" or "committed". | OPEN | **Accept** (team sharing DEFERRED) | §13.3; alt: rename to "Repository Instructions" everywhere (more golden and doc churn) | 2 | — |
| US-D10 | Agent handoff: Option D. <ul><li>The agent starts in the repository root and is told `Read <WORK>/task.md and complete the workflow.`; the retry is `Read <WORK>/agent_retry_prompt.md and continue the workflow.`.</li><li>`<WORK>` is resolved and validated by the CLI (US-D13, US-D17), with forward slashes.</li><li>The CLI, the extension and the retry prompt use the same wording; MCP follows US-D27.</li><li>No new permission mode, grant, sandbox bypass or shell-free launch (no US-D11 grant).</li><li>US-D12's gate is kept until US-D12 is decided. No rejected prompt reaches a shell. A refused, unlaunchable or bridge handoff uses the clipboard with an accurate notice.</li><li>Storage failures fail closed, with no legacy fallback.</li></ul>(§9.5.1) | **APPROVED** — with conditions | **Keep open** until the Batch 0B probes (§9.7) and the §9.10 acceptance criteria are met; Option D is the provisional recommendation | §9.5, §9.10; alt: B (inline only); C by default (violates R8) | 2 | 2026-10-18: approved with conditions by the owner, as Option D with amendments, as a design decision (§9.5.1). <ul><li>The owner accepts the Batch 0B real-agent evidence gap for design approval only (§9.7; "Accepted evidence gaps" below).</li><li>No agent combination is declared supported.</li><li>Conditions: §9.5.1's implementation conditions and release gates.</li></ul>This is not an approval to implement, verify or activate. |
| US-D11 | An opt-in `--add-dir <work folder>` grant | OPEN | **Defer** past 0.1.6. Never automatic (R8); reconsider after Batch 5's live measurement. | §9.4 C, §9.5 point 8 | 3 | — |
| US-D12 | The prompt gate keeps its character set (ASCII letters and digits, the ASCII space, `. , : # / _ -`), never broadened, and is tightened. <ul><li>No string passes through JavaScript's `\s` alone, and the handoff starts with its expected literal text.</li><li>The complete prompt is validated.</li><li>**Exact prompt preservation:** both the generated prompt and the final argument are validated, nothing is collapsed, trimmed, normalized or escaped into a different path, and the handoff is refused if preservation can't be guaranteed.</li><li>**Parity:** Python's `--launch-agent` gets an equivalent gate, checked against one shared corpus.</li><li>The gate stays on the terminal paths, the bridges and the captured review (US-D28). There is none on MCP JSON, Copy Handoff Prompt or the body of `task.md`, which rely on path validation (US-D13, US-D17) instead.</li><li>A refused handoff starts nothing and falls back to US-D10's manual handoff. A bridge copies and notifies without revealing its view.</li><li>No relaxation for any transport.</li></ul>(§9.9.1) | **APPROVED** — with conditions | **Accept**: retain the gate. Investigate a launch without a shell for native executables (§9.9, P11) without weakening the gate; adopting one needs P11 PASS on three systems and a separate owner approval; shims never | §9.5, §9.9; alt: widen the gate (per-shell quoting; security-sensitive) | 3 | 2026-10-18: approved with conditions by the owner, as Option C with the exact-prompt-preservation and cross-language-parity amendments, as a design decision (§9.9.1). <ul><li>No per-transport relaxation; P10 stays PASS only for the tested Windows configuration, and P11 stays NOT EXECUTED.</li><li>Conditions: §9.9.1's tests and release conditions.</li></ul>This is not an approval to implement or activate. |
| US-D13 | `task.md` and the retry prompt use a hybrid path contract: <ul><li>the canonical, CLI-resolved work folder stated absolutely (Execution Location; the retry prompt's Required Reading);</li><li>other files by name relative to that folder;</li><li>the report's output destination absolute, with §9.6's cannot-write sentence;</li><li>US-D14's note in both;</li><li>the agent's cwd stays the repository;</li><li>forward-slash rendering on every OS;</li><li>a path unsafe to render is rejected, never altered;</li><li>fail closed, with no `.ai/` fallback;</li><li>Protected Rules v2 unchanged.</li></ul>(§9.8.1) | **APPROVED** — with conditions | **Accept** | §9.8; alt: absolute everywhere (token cost); relative only (an ambiguous write target) | 2 | 2026-10-18: approved with conditions by the owner, with amendments, as a design decision (§9.8.1). <ul><li>Amendments: the path counts are template observations; rendering validation is uniform and non-destructive; implementation waits for US-D30 and for separate golden and ratchet approvals.</li><li>Conditions: §9.8.1's implementation and activation conditions.</li></ul>This is not an approval to implement, activate or ship. |
| US-D14 | Protected rule `stage-intended-files-only` stays unchanged (rules v2: id, title, text, `PROTECTED_RULES_VERSION` 2, `VERSION_2_SHA256`). A separate informational note, near `task.md`'s Execution Location and the retry prompt's Required Reading, says that a `.ai/`, `.ai_memory/` or `.bugpilot/` folder inside the source repository is legacy BugPilot data that 0.1.6 does not use. The note is not a staging rule and not an enforcement mechanism. Neither adds a repository write. BugPilot introduces no Git staging, commit, hook, cleanup or automatic `.gitignore` edit; the existing "Add to .gitignore" feature is US-D16's (OPEN) (§16.4.1). | **APPROVED** — with conditions | **Keep open**: the owner chooses among §16.4's options before Batch 2. The review does not authorize a protected-rule change; the rule's meaning (no BugPilot or legacy artifact is staged) is preserved under every option. | §16.4 | 2 | 2026-10-18: approved with conditions by the owner, as Refined Option A′ with two amendments (US-D16 independence; staging safety), as a design decision (§16.4.1). Conditions: §16.4.1's implementation conditions. This is not an approval to implement, to activate, or for BugPilot to stage anything. |
| US-D15 | Keep the F22 guards (Code Search exclusion, review pathspec, lint) | PROPOSED | **Accept** | they exclude, never read; alt: remove (left-behind `.ai/` content becomes evidence) | 2 | — |
| US-D16 | Remove the repository-local gitignore editing: the notice, the "Add to .gitignore" quick fix and `doctor`'s `ai_artifacts_ignored*` | OPEN | **Accept** (remove) | it is the only repository write left; alt: keep as advice for left-behind folders | 2 | — |
| US-D17 | The CLI is the only resolver (Option B, §8.9). <ul><li>`storage.py` is the authoritative Python resolver (data root, repository identity and namespace, work-item location, layout); the CLI, workflow, MCP and `task-preview` use it.</li><li>The extension takes base paths only from frozen CLI fields:<ul><li>`doctor` `storage.repository_dir`;</li><li>item `work_dir`, `issue_dir` and `agent_task`;</li><li>`list` `work_items[].work_dir` and `.modified`;</li><li>settings `show --json` `path`.</li></ul></li><li>It validates them before use (amendment A).</li><li>It composes only fixed artifact names under a validated `work_dir`, and `<repository_dir>/work/<id>` for a validated id, through one helper with a shared fixture.</li><li>History comes from `list --json`, with no scan; settings come from `show --json` `path`.</li><li>The extension reads, opens and watches only. It never creates, overwrites, deletes, moves or re-permissions storage (amendment B).</li><li>A cache mismatch triggers re-resolution, otherwise it fails closed. `state: error` composes, reads and watches nothing. No legacy fallback.</li></ul>(§8.9.1) | **APPROVED** — with conditions | **Accept** | §8.9; alt: the CLI returns every file path (slow History) | 3 | 2026-10-18: approved with conditions by the owner, as Option B with the five clarifications and two security amendments (validated CLI path consumption; a read-only extension boundary), as a design decision (§8.9.1). <ul><li>The frozen CLI contract is unchanged.</li><li>Conditions: §8.9.1's implementation conditions and release gates.</li></ul>This is not an approval to implement or activate. |
| US-D18 | `user_feedback.md` is written by the CLI (`bug <id> --retry --feedback-file`) | PROPOSED | **Accept** | §5.3 F04, §8.10; alt: the extension writes into the CLI-given folder | 2 | — |
| US-D19 | The extension's VS Code-owned storage (runtime, attachment staging, scratch) stays in `globalStorageUri` | PROPOSED | **Accept** | §6.2; alt: move attachment staging under the data root | 3 | — |
| US-D20 | `doctor` reports *whether* legacy paths exist (`lstat` only, never read) | OPEN | **Defer**: no legacy-presence probing in 0.1.6. The change is explained by §13's documentation instead. | §6.3; alt: one `doctor` line | 5 | — |
| US-D21 | Diagnostics surface: `doctor`'s `storage` object (and the panel's Diagnostics); no new command | OPEN | **Accept** | §8.10; alt: a read-only `bugpilot storage` command | 2 | — |
| US-D22 | Absolute paths only in designated JSON fields, the handoff and `task.md`'s work line; the display form (`~/.bugpilot/…`) everywhere else | **APPROVED** — in part (Batch 2B-2's configuration messages) | **Accept** | §8.8, §8.10 | 2 | 2026-10-19: approved in part by the owner at the Batch 2B-2 decision gate (D-9): the display form for 2B-2's configuration messages; no environment variable's value in any message; no unrelated message change; no JSON contract expansion. The rest stays PROPOSED |
| US-D23 | New folders `0700`; an existing data root's mode is never changed | **APPROVED** — with conditions | **Accept** | §8.3; alt: `chmod` the root (touches a legacy folder) | 1 | 2026-10-16: approved with conditions by the owner at the Batch 1 decision gate: private folder creation, existing permissions unchanged. Condition: Windows privacy is claimed only after verification, and credential-bearing writes need Q1's verified access-list check (G-3, §14.3) |
| US-D24 | An identity record that mismatches or is corrupt is refused, never repaired | **APPROVED** | **Accept** | §7.5; alt: overwrite | 1 | 2026-10-16: approved by the owner at the Batch 1 decision gate: mismatched or corrupt records refused without repair; temporary unreadability distinguished (B1-15) |
| US-D25 | `run.json` `generated_files` and JSON-lines `path` are relative to the namespace; `schema_version` stays 1 | PROPOSED | **Accept** | §8.10; alt: absolute; a schema bump | 2 | — |
| US-D26 | The storage JSON contract | **APPROVED** — in part (the `STORAGE_UNAVAILABLE` code is OPEN) | **Accept conditionally**: only once the exact, independently testable contract (§8.10, frozen as `tests/fixtures/storage_cli_contract.json` in Batch 1) is approved at the Batch 1 gate | §8.10 | 2 | 2026-10-16: approved in part by the owner at the Batch 1 decision gate: §8.10's defined contract semantics and the fixture's typed entries. Still OPEN: `STORAGE_UNAVAILABLE`. Not approved by this: the rows that follow US-D4, US-D16, US-D18, US-D25 and US-D3's Batch 2 handling. 2026-10-19 (D-4, Batch 2B-2 decision gate): `STORAGE_UNAVAILABLE` stays OPEN; the direction for errors is recorded, and its mapping waits for Q-1 and Q-2. Later that day, Q-1 was approved in principle (an internal classification, with no new code), and the 2B-2 mapping became choice C-1 (§14.3, "Batch 2B-2 — final contract resolution"). C-1 then approved M-1, which keeps every existing public code; `STORAGE_UNAVAILABLE` stays OPEN |
| US-D27 | MCP keys unchanged; values absolute (`issue_dir`, `agent_task`, `next_step` paths); `search_memory` relative | PROPOSED | **Accept**: preserve the keys | §8.10; alt: return the task text inline | 2 | — |
| US-D28 | Captured review reads `context.md`, `retrieval.json` and `fix_report.md` by absolute, CLI-resolved, validated work-folder paths, under the unchanged read-only restrictions. There is no automatic inline fallback. A separately identified, developer-initiated Partial Review uses at most 2,400 characters of `fix_report.md` (§16.5.11). | **APPROVED** — with conditions | **Keep open** until probe P2 (Batch 0B) | §9.5 point 5; §16.5 (P2 evidence, the decision review and the approved contract) | 2 | 2026-10-18: approved with conditions by the owner, with amendments, as a design contract (§16.5.11). The review's narrow Option C was not approved verbatim. Conditions: §16.5.11's activation gates. This is not an approval to implement, activate or ship. |
| US-D29 | Integration: Batches 0A and 1 on `main`; Batches 2–4 on `verify/0.1.6-storage` until integration is complete; owner-dispatched CI; owner-approved fast-forward after Batch 4 | **APPROVED** — in part (the integration branch) | **Accept** the isolated integration branch, with §15.4's gates | §15.2, §15.4; alt: push Batches 2 and 3 together from `main` | 2 | 2026-10-19: approved in part by the owner at the Batch 2B-2 decision gate (D-1): `verify/0.1.6-storage`, based on `73ee57e`, is the isolated integration branch. It is not created yet, and no partial consumer migration reaches `main` without separate authorization. Still OPEN: the owner-dispatched CI and the fast-forward after Batch 4. Later that day (C-5 (a)): the branch is based instead on the verified `main` commit that carries this record |
| US-D30 | The task-size gate with an absolute work path. <ul><li>Measure: the 17-case matrix, `round(chars / 4)` and the fixed `<work>` normalization.</li><li>Task gate: `median ≤ 3,096 + A`, plus `normalized size ≤ frozen 0.1.5 size + that golden's approved delta` for every golden.</li><li>Retry: per-golden deltas under a separate A_retry, with no median gate and no shared allowance.</li><li>A and A_retry are fixed only from the owner-approved golden diff, and never recomputed (estimates about 116 and 108, not final).</li><li>Sizes with real paths are reported, not gated.</li><li>Frozen baselines stay byte-identical; a new reviewed budget record holds the numbers.</li></ul>(§9.8.2) | **APPROVED** — with conditions | **Accept** the normalized measurement (§9.8 (a)), keeping meaningful size-regression coverage: the median gate, a per-golden growth bound, a count of absolute-path occurrences, and the raw size reported | §9.8; alt: (b) re-baseline; (c) trim protected wording | 2 | 2026-10-18: approved with conditions by the owner, as Option D with amendments, as a design decision (§9.8.2). <ul><li>The allowance changes the future ceiling; it does not mean the original 20 % reduction still holds.</li><li>Conditions: §9.8.2's golden-diff prerequisites, the reviewed budget record, the reconciled compared-record test, and separately approved ratchet residue.</li></ul>It approves no golden change and no residue, and is not an approval to implement or activate. |
| US-D31 | Batch outline deviation: MCP code and text switch in Batch 2; Batch 3 keeps MCP live verification | PROPOSED | **Accept** | §14.0 | 2 | — |
| US-D32 | Test isolation: session-wide isolation before collection, plus a guard that fails closed (§11.1) | **APPROVED** (Batch 0A scope) | **Accept** the goal and the **revised design**. The r1 real-home listing is withdrawn; no default run lists or reads the real home. | §11.1; as built: §14.1.A; alt: per-test isolation only | 0A | 2026-10-15: approved by the owner for Batch 0A's scope |
| US-D33 | CI keeps the nine blocking checks under their names; the isolated storage and isolation tests are added to the existing required jobs; `HOME` is set in the job environment | **APPROVED** (Batch 0A scope) | **Accept** | §11.7; as built: §14.1.A; alt: a new job (would change the pinned check names) | 0A | 2026-10-15: approved by the owner for Batch 0A's scope |
| US-D34 | `BUGPILOT_HOME` validation: absolute, no control characters, `~` not expanded | **APPROVED** — with conditions | **Accept** (strict) | §8.3; alt: expand `~` | 1 | 2026-10-16: approved with conditions by the owner at the Batch 1 decision gate: canonical root validation and two-way containment. Condition: the G-1/G-2 activation gate (§14.3) |
| US-D35 | Credentials stay file-based in `config/config.toml` (the `TokenStore` seam) | DEFERRED (an OS credential store) | Defer | — | — | — |
| US-D36 | A `cache/` directory | DEFERRED (no consumer) | Defer | — | — | — |
| US-D37 | XDG or platform-native data folders | DEFERRED | Defer | — | — | — |
| US-D38 | Retention and pruning of orphaned namespaces | DEFERRED | Defer | — | — | — |
| US-D39 | SF-1: route the project-settings and repository-profile payloads through `scratchFile.ts` | OPEN | **Accept**: include in Batch 4 | the same class 0.1.5 fixed; alt: leave as is | 4 | — |

**Open parts of approved decisions** (Batch 1 decision gate, 2026-10-16; US-D28, US-D14, US-D13, US-D30, US-D10, US-D12 and US-D17, 2026-10-18; US-D2, US-D29 and US-D22, 2026-10-19):

| Approved decision | Part not approved | Its own status | Needed before |
| --- | --- | --- | --- |
| US-D3 | `doctor`'s `legacy_config_dir_variable` (§8.10), deferred to the `doctor` slice. The warning is decided: its direction by D-3 and its text by Q-4 (2026-10-19) | Batch 2 work | 2B-6 |
| US-D26 | a separate `STORAGE_UNAVAILABLE` error code | OPEN as a public code. The classification was approved in principle (Q-1), and the 2B-2 mapping as M-1 (C-1), both on 2026-10-19 | the code: before 2B-4 |
| US-D26 | removing `ai_artifacts_ignored*` | follows US-D16 (OPEN) | 2 |
| US-D26 | `below_git_toplevel` | follows US-D4 (OPEN) | 2 |
| US-D26 | `--feedback-file` | follows US-D18 (PROPOSED) | 2 |
| US-D26 | `run.json`'s relative `generated_files`, `schema_version` 1 | follows US-D25 (PROPOSED) | 2 |
| US-D5, US-D23, US-D34 | their conditions: cross-platform CI; Q1's access-list check; the G-1/G-2 gate | conditions, §14.3 | activation |
| US-D28 | <ul><li>its conditions: the activation gates of §16.5.11</li><li>the contract's open implementation questions</li></ul> | conditions, §16.5.11 | <ul><li>implementation: the questions</li><li>activation: the gates</li></ul> |
| US-D14 | <ul><li>its conditions: §16.4.1's implementation conditions (US-D13's wording, US-D30, the approved golden diff, frozen goldens and baselines unchanged, the v2 tests and digest unchanged, the note in both prompts, file safety and the path inventory)</li><li>the note as approved path-inventory residue</li></ul> | conditions, §16.4.1 | implementation |
| US-D13 | <ul><li>its conditions: §9.8.1's implementation conditions (US-D30; the separately approved task, retry and context golden changes and the path-literal residue; US-D10's retry wording; US-D26's error contract; US-D29)</li><li>its activation conditions</li></ul> | conditions, §9.8.1 | implementation; activation |
| US-D30 | <ul><li>its conditions: §9.8.2's golden-diff prerequisites (final US-D13 text, US-D14's note, US-D10's retry wording, any US-D22 wording, the approved golden diff)</li><li>the reviewed budget record (A, A_retry, per-golden deltas)</li><li>the reconciled compared-record test</li></ul> | conditions, §9.8.2 | implementation |
| US-D10 | <ul><li>its conditions: §9.5.1's implementation conditions (US-D12, US-D17, US-D22, US-D27 and US-D26's error code decided; US-D29; US-D13's and US-D30's conditions)</li><li>its release gates: real-agent evidence per supported combination, §9.10, §14.3</li></ul> | conditions, §9.5.1 | implementation; activation |
| US-D12 | <ul><li>its conditions: §9.9.1's implementation conditions (the reviewed shared corpus, the tightened TypeScript and the equivalent Python validators, exact preservation and explicit line joins, the refusal paths)</li><li>its tests, and Windows, Linux and macOS validation</li></ul> | conditions, §9.9.1 | implementation; activation |
| US-D17 | <ul><li>its conditions: §8.9.1's implementation conditions (US-D18, US-D22, US-D27 and US-D26's error code decided; US-D29)</li><li>its required tests</li><li>Batch 3's real-window checks and Batch 4's cross-platform validation</li></ul> | conditions, §8.9.1 | implementation; activation |
| US-D2 | its conditions: §14.3, "Batch 2B-2 — decision gate" (the specification as corrected by its final contract resolution, with C-1 to C-5 approved; DD-1 to DD-3's exact values are reviewed before the implementation commit). The extension's half, re-entering the site, is Batch 3's (§15.4) | conditions | 2B-2's implementation |
| US-D29 | the owner-dispatched CI on the branch, and the owner-approved fast-forward after Batch 4 | OPEN | the branch's CI; integration |
| US-D22 | everything beyond Batch 2B-2's configuration messages | PROPOSED | 2B-3 to 2B-6; Batch 3 |

**Decisions that block Batch 2 on their own:**

| Decision | Waiting for |
| --- | --- |
| US-D10 | Decided: APPROVED with conditions on 2026-10-18 as a design, with the probe gap accepted for design only (§9.5.1). It no longer holds Batch 2 back under §14.3's OPEN rule, but its implementation conditions and release gates remain. |
| US-D14 | Decided: APPROVED with conditions on 2026-10-18, as Refined Option A′ (§16.4.1). It no longer holds Batch 2 back under §14.3's OPEN rule, but its implementation conditions remain. |
| US-D28 | Decided: APPROVED with conditions on 2026-10-18, as a design contract (§16.5.11). It no longer holds Batch 2 back under §14.3's OPEN rule, but its activation gates remain. |
| US-D26 | approved in part on 2026-10-16; still: the `STORAGE_UNAVAILABLE` code, and the rows that follow other decisions (below). For Batch 2B-2 this was Q-1 (§14.3, "Batch 2B-2 — decision gate"): approved in principle on 2026-10-19, and the mapping approved as M-1 (C-1). |

Every other Batch 2 decision may be approved on the review's advice alone, if the owner chooses.

**Accepted evidence gaps.** §9.7 says a decision that depends on an UNKNOWN probe stays OPEN, unless the owner explicitly accepts the gap and this log records it.

| Decision | Probes not observed | Accepted for | Not accepted for | Date |
| --- | --- | --- | --- | --- |
| US-D10 | <ul><li>P1, P3, P5 and P9: blocked or unverified, because no operating-system isolation is available</li><li>P4, P6 and P8: not executed</li></ul>P11 (not executed) informs US-D12, not US-D10. | design approval only (§9.5.1) | <ul><li>implementation verification</li><li>claims that an agent is supported</li><li>production activation</li></ul> | 2026-10-18 |

### 16.2 Risks

| Id | Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- | --- |
| RK-1 | Agents' permission prompts make Fix with AI feel worse than 0.1.5 | high | medium | US-D10 guidance text; Batch 0B probes; §9.10 acceptance; US-D11 as a later option |
| RK-2 | An agent refused an outside write writes `fix_report.md` into the repository | medium | medium (R5) | the §9.6 sentence (T-S21); probe P1; aspect A3's `git status` check (§9.10) |
| RK-3 | A test run writes into, or reads, a developer's real `~/.bugpilot` | medium before Batch 0A | high | Batch 0A first: isolation before collection, plus the fail-closed guard, demonstrated against a decoy (§11.1; T-S24, T-S25) |
| RK-4 | Teams relying on a committed `.bugpilot/` lose shared settings without noticing | medium | medium | §13.3; release notes (the legacy-presence notice is deferred, US-D20) |
| RK-5 | Users with a non-plain home (non-ASCII, `(`, `'`) lose one-click launch | medium (outside ASCII locales) | low (the paste fallback works, recorded as FALLBACK) | US-D12 notice; the `BUGPILOT_HOME` remedy; §9.9's direct launch only after P11 and approval |
| RK-6 | VS Code watchers outside the workspace are unreliable | low–medium | low (stale views) | probe P7; refresh on focus |
| RK-7 | Platform `realpath` surprises (`subst`, network drives, macOS case) | medium | medium (split namespaces) | prefer-split rule; Batch 0A CI observations (`subst` NOT VERIFIED, D0A-5); US-D5 conditional; §7.6 |
| RK-8 | Task-size gate pressure leads to protected-text edits | medium | high | US-D30 normalized measurement, with a per-golden growth bound |
| RK-9 | Credentials next to evidence (SF-4) | low | high | T-S9; narrow handoff; `config/` separate |
| RK-10 | Windows `MAX_PATH` with long attachment names | low | low | slug ≤ 24; test; the limit documented |
| RK-11 | Scripts or tools outside BugPilot that read `.ai/` break | low | low | changelog (§13) |
| RK-12 | The Codex Windows `elevated` sandbox cannot read the profile folder | unknown | medium (Codex handoff) | probe P4; Option B fallback |
| RK-13 | Merge pain: Batches 2–3 on a branch while `main` moves | medium | low | short-lived branch; rebase before each batch |
| RK-14 | Disk growth from orphaned namespaces | high over time | low | documented; US-D38 later |
| RK-15 | The isolation guard misses an access path: non-Python children, children started with `-I`/`-E`, metadata probes | medium | medium | environment isolation as a second layer; Batch 0A lists every `-I`/`-E` call; the limits are stated (T-S24, T-S25) |
| RK-16 | Probe evidence is unavailable for an agent (no account, platform or version) | medium | medium | UNKNOWN is recorded, never PASS; the decision stays OPEN or the owner records the gap; release notes name unsupported combinations (§9.10) |
| RK-17 | A stale legacy `.ai/<id>/task.md` in the repository confuses an agent | low–medium | medium | the Execution Location wording names the work folder; §16.4 option A′; F22 guards keep it out of evidence |
| RK-18 | Owner decisions that block Batch 2 (US-D26; US-D28, US-D14 and US-D10 were decided on 2026-10-18) wait on evidence or review | medium | schedule | Batch 0A and Batch 1 proceed meanwhile; Batch 0B can run in parallel |
| RK-19 | A red required CI job on the branch is normalized as "expected" | low | high | §15.4: only ledger entries are excused, CI is still reported red, and the ledger must be empty before Batch 3's gate |

### 16.3 Assumptions

| Id | Assumption |
| --- | --- |
| AS-1 | Vendor documentation describes the installed agent versions. The Batch 0B probes confirm this for the versions in use, and the plan names versions when it records them. |
| AS-2 | `os.path.realpath(strict=True)` behaves on Windows, macOS and Linux with Python 3.10–3.14 as §7.3 states. Batch 0A's CI observations confirm it. |
| AS-3 | Users accept a one-time reconfiguration (R4 is approved). |
| AS-4 | The managed runtime keeps the extension and the CLI at one version, so mixed versions are an edge case. |
| AS-5 | The 0.1.5 Marketplace publication and the post-release records are closed by the owner independently of this plan. |
| AS-6 | No user relies on `BUGPILOT_CONFIG_DIR` in production other than for tests; it was documented as "keeps tests hermetic". |
| AS-7 | Python's audit hooks report the file events §11.1 lists on every supported version (3.10–3.14). Batch 0A confirms this against each version's audit-event table before relying on the guard. |

### 16.4 US-D14 — the protected staging rule: options for the owner

**Decided on 2026-10-18.** The owner approved US-D14 as **Refined Option A′** with two amendments: **APPROVED — with conditions** (§16.4.1).

- The text from "The rule today" to "Owner decision required before Batch 2" is the review that preceded the decision, kept as written.
- Its inaccuracies are marked *(Corrected 2026-10-18)* where they occur and explained in §16.4.2.

**The rule today** (protected rules v2, `protected_rules.py:185-191`, SHA-pinned at `tests/test_protected_rules.py:55`):

> Stage only intended source, test, or documentation files: never `.ai/`, `.ai_memory/`, `issue.json`, `jira_field_report.md`, or files containing `JIRA_TOKEN`, `password`, `api_key`, `secret`, `access_token`, `refresh_token`, or `key=...`.

**The goal to keep.** Neither BugPilot-generated nor legacy artifacts are ever unintentionally staged.

**What changes after the storage switch:**

- BugPilot's own files are no longer inside the repository. The agent cannot stage them unless it copies them in, and the Execution Location text forbids that.
- `.ai/` and `.ai_memory/` exist only as **legacy leftovers** from 0.1.5 or earlier. They may hold a stale `.ai/JR-12345/task.md` for the very work item the agent is fixing.
  - *(Corrected 2026-10-18: the repository-local `.bugpilot/` is legacy data too under R4, and unlike `.ai/` it may be tracked; §16.4.2, item 4.)*
- The rule's title, "Never stage BugPilot artifacts or secrets", plus the bare folder names, could suggest to an agent that BugPilot's *current* files live in `.ai/`. An agent might then read a stale legacy task or context, instead of the work folder named in Execution Location (RK-17).
  - *(Corrected 2026-10-18: rule titles do not appear in agent task text, so in the task only the bare folder names could suggest this; §16.4.2, item 1.)*
- The risk is about *reading* stale files, not about staging. The rule itself still achieves its staging goal.

**The options.** The owner chooses before Batch 2. The review **does not** choose Option B, and authorizes no protected-rule change now.

| | **A — keep rules v2 unchanged** | **A′ — v2 unchanged, plus a legacy note outside the rule registry** | **B — legacy-aware wording, rules v3** |
| --- | --- | --- | --- |
| Text | as today | the rule stays as today. The Execution Location sentence (rewritten anyway for US-D13, and not part of the SHA-pinned registry) adds: "A `.ai/` or `.ai_memory/` folder in the repository is left from an older BugPilot: it is not this work item's files." | the rule is reworded, for example: "Stage only intended source, test, or documentation files: never BugPilot's files (this work item's are outside the repository; a `.ai/`, `.ai_memory/` or `.bugpilot/` folder left by an older BugPilot is not yours to stage either), `issue.json`, `jira_field_report.md`, or files containing …". Exact wording to be reviewed separately. |
| Staging goal | kept | kept | kept; adds `.bugpilot/` |
| Misleading-folder risk (RK-17) | remains | addressed where the agent learns where its files are | addressed inside the rule |
| `PROTECTED_RULES_VERSION` | 2 | 2 | **3** |
| Digest | unchanged | unchanged | a new pinned `VERSION_3_SHA256` |
| Tests | none for the rule | none for the rule; the Execution Location line in goldens (changing anyway) | `test_protected_rules.py` (new digest, v2 kept as history), `task_golden.py` `RULE_PATTERNS` (`stage_ai_artifacts`, `:259`), `test_fix_mode_prompts.py:69`, `:352`, `test_task_preview.py:354` (`rules_version`), and the independent oracles over every golden |
| Goldens | no rule-line change | the Execution Location line only | one rule line in all 17, checked by script, plus owner approval of the golden diff |
| Token cost (US-D30) | 0 | about +25 tokens per task | about +20 tokens |
| Change control | none | ordinary text review | a protected-rule change: separate review, its own approval, and a record like D1's in 0.1.5 |

*(Corrected 2026-10-18:*

- *B's Tests and Goldens rows understate its reach (§16.4.2, item 2).*
- *A′'s Text row places the note in Execution Location only, but the retry prompt needs it too (§16.4.2, item 3).)*

**The review's assessment.**

- **Option A** is the smallest change, but leaves RK-17.
- **Option A′** addresses RK-17 without touching the SHA-pinned registry. That is why unchanged rule text is the *safer* change-control path, as long as the misleading-folder concern is handled where the agent learns where its files are.
- **Option B** is the most accurate wording, at the cost of a protected-rules version bump and its review.
- **The review leans to A′, but it is the owner's choice.** If the owner picks B, its wording and tests are reviewed and approved as a separate step inside Batch 2, before any golden is regenerated.

**Owner decision required before Batch 2:** A, A′ or B. *(Decided on 2026-10-18: Refined Option A′ with two amendments, §16.4.1.)*

#### 16.4.1 Owner decision (2026-10-18): the approved US-D14 contract

**Decision.** US-D14 is **APPROVED — with conditions**, as **Refined Option A′** with two amendments.

- It is a design approval only.
- It does not authorize:
  - implementation;
  - production activation;
  - Git staging by BugPilot;
  - any change to another decision.

**1. The protected rule is unchanged.** `stage-intended-files-only` stays exactly as it is. These are preserved:

- the rule's id, title and text;
- `PROTECTED_RULES_VERSION = 2` and `VERSION_2_SHA256`;
- the existing Delivery Safety semantics;
- the existing explicit-approval and branch-check requirements.

There is no protected-rules v3, and `protected_rules.py` is not changed.

**2. An informational note about legacy folders.** A separate note goes in two places:

- near `task.md`'s Execution Location section;
- near the retry prompt's Required Reading section.

The proposed text (the owner's):

> "A `.ai/`, `.ai_memory/` or `.bugpilot/` folder inside the source repository is legacy BugPilot data. It is not the current work item's storage location, and BugPilot 0.1.6 does not use it."

The note:

- is informational, not a protected staging rule;
- does not repeat or replace `stage-intended-files-only`;
- does not instruct an agent to delete, move, read or migrate legacy folders;
- does not imply that those folders are necessarily untracked;
- is not treated as an enforcement mechanism;
- stays consistent with R4 (§2) and the breaking storage-switch contract.

Its final wording is reviewed alongside US-D13 before implementation.

**Amendment 1: US-D16 stays independent.**

- US-D14 does not decide the `.gitignore` editing behaviour.
- The existing 0.1.5 "Add to .gitignore" feature has not been removed. US-D16 remains OPEN, and any change to that feature requires a separate owner approval.
- Neither the rule nor the note introduces a new repository write.

**Amendment 2: staging safety.** The note alone does not stop an agent from staging legacy `.bugpilot/` files. The existing safety requirements stay:

- The agent stages only intended changes.
- Explicit owner approval is required.
- Branch checks remain required.
- Staged changes and file contents are reviewed for unintended artifacts or secrets.
- `git add -A` is not treated as automatically safe.
- BugPilot itself does not introduce Git staging or commit operations.

The decision adds no Git hooks, no cleanup behaviour, no automatic staging and no automatic `.gitignore` edits.

**Implementation conditions.** All of these must hold before the note is implemented:

- US-D13's wording is approved.
- The US-D30 token-budget decision is resolved. *(Design approved with conditions on 2026-10-18, §9.8.2.)*
- The owner approves the exact allowed golden diff.
- The frozen 0.1.4 retry goldens and the Batch 0A baselines remain unchanged.
- The Protected Rules v2 tests and digest remain unchanged.
- The note is verified in both the normal `task.md` and the retry prompt.
- The existing file-safety and path-inventory requirements remain enforced.

**Activation conditions.** The plan's existing conditions apply unchanged; this decision adds none:

- §17's checks "The protected rules are as US-D14 decided (§16.4)" and "Each rule appears once";
- the Batch 4 end state of the path-literal ratchet (§11.2);
- §14.3's activation preconditions.

**Consequence for implementation (open).** The note puts new `.ai/`, `.ai_memory/` and `.bugpilot` literals into the prompt code.

- `tests/test_storage_inventory.py` fails on any new occurrence.
- The approved residue in the end state lists "the protected rule's text", not this note.
- So the implementing batch needs the owner to approve the note as residue, together with the golden diff.

**Dependencies.**

| Item | Relation |
| --- | --- |
| US-D13 (PROPOSED) | The note's final wording is reviewed with its Execution Location text. Blocks implementation. *(US-D13 was approved with conditions on 2026-10-18 (§9.8.1). The note's wording is unchanged.)* |
| US-D30 (OPEN) | The note's token cost in both prompts. Blocks implementation. *(US-D30 was approved with conditions on 2026-10-18 (§9.8.2). The note's cost falls inside the approved allowances once the golden diff is approved.)* |
| US-D16 (OPEN) | Independent (Amendment 1). |
| R4 (approved) | Makes `.ai/`, `.ai_memory/` and `.bugpilot/` legacy data; the note must stay consistent with it. |
| US-D9 (OPEN) | User-facing wording about repository settings only; does not affect the note. |
| US-D29 (OPEN) | Where the golden change lands. *(US-D29 was approved in part on 2026-10-19: the integration branch (§14.3, "Batch 2B-2 — decision gate").)* |
| §14.3 | US-D14 no longer holds a storage-changing Batch 2 back under the OPEN rule. Every other §14.3 precondition still applies. |

#### 16.4.2 Corrections to the review above (2026-10-18)

The review's text above is kept as written. Four statements in it were inaccurate or incomplete.

1. **Rule titles do not appear in agent task text.**
   - `rule_bullet` (`protected_rules.py:206-208`) renders only a rule's text. `task.md` (`prompts.py:400`) and the retry prompt (`workflow.py:2030`) carry only that text.
   - Titles appear only in `bugpilot protected-rules` (text and JSON, `prompts.py:545`) and in the extension's rules page.
   - So the title "Never stage BugPilot artifacts or secrets" cannot mislead an agent through the task. RK-17's trigger there is the bare folder names alone.
2. **Option B affects more than the 17 task goldens.** The rule's text is also in:
   - the 3 retry goldens (`tests/golden/retry/`);
   - the 3 frozen 0.1.4 retry goldens (`tests/golden/retry_0.1.4/`);
   - the frozen Batch 0A baseline `tests/baselines/0.1.6-batch0/handoff.json`;
   - `tests/test_fix_mode_prompts.py`.

   Frozen files are never regenerated, so under B they would need designed diff transforms.
3. **Under A′, the retry prompt needs the note too.** The retry prompt has no Execution Location section, but it carries the rule through Delivery Safety. A note placed only in `task.md`'s Execution Location would not reach a retry session. The approved contract therefore places the note near the retry prompt's Required Reading as well.
4. **The repository-local `.bugpilot/` is legacy data too.**
   - Under R4, 0.1.6 never reads or writes `<repo>/.bugpilot/`; its contents' new home is `settings/` (§6.1).
   - Unlike `.ai/`, it may be tracked, because 0.1.5 designed its files to be committed.
   - The original A′ text named only `.ai/` and `.ai_memory/`.

### 16.5 US-D28 — Decision Review / Proposal

**Decided on 2026-10-18.** The owner approved US-D28 with amendments, as a design contract: **APPROVED — with conditions** (§16.5.11).

- The narrow Option C proposed in §16.5.4 and §16.5.8 was **not** approved verbatim.
- §16.5.1–§16.5.10 are kept as the review that preceded the decision. Where they differ from §16.5.11, §16.5.11 governs.

**What §16.5.1–§16.5.10 are.** They prepared the owner's decision. They were written on 2026-10-18 from probe P2's recorded evidence and the shipped code; no agent was run for them. **They decide nothing.**

- When they were written, US-D28 was **OPEN** in §16.1, and they changed no decision's state.
- The review suggested an intermediate state, PROPOSED (decision review ready). The owner decided directly instead (§16.5.11).
- The probe states are unchanged:
  - P2: FAIL against the owner's criteria.
  - P7 and P10: PASS for the tested Windows configuration.
  - P1, P3–P6, P8, P9 and P11: NOT EXECUTED.
- Batch 0B is not complete. Batch 2B-2 to 2B-6 are NOT STARTED. Unified Storage is NOT activated.

**Labels.**

- **O**: observed in P2's single run (one Windows machine, one model, Claude Code 2.1.214).
- **V**: documented, in the 2.1.214 `--help` saved as `cli-help.txt` or in the vendor pages §9.2 cites.
- **A**: inferred, not observed.

#### 16.5.1 The question

In 0.1.5 the review prompt (`_build_final_review_prompt`, `workflow.py:2391`) names three files, relative to the repository:

- `.ai/<id>/context.md`;
- `retrieval.json`, if present;
- `fix_report.md`, if present.

The repository is also the reviewer's working directory, so every read stays inside it. After the storage switch, those files are in the work folder under the data root, outside the repository. The reviewer keeps the repository as its working directory, and it keeps `CLAUDE_CAPTURED_REVIEW`'s flags (`agents.ts:199-252`). US-D28 decides how the reviewer sees the three files.

**Today's flow.** This review leaves it unchanged:

1. `review-package --json` returns the prompt, byte for byte as the CLI builds it.
2. `#resolveSelectedAgent` applies the shared prompt gate, `isPlainPrompt` (`agents.ts:278`), to that prompt. This happens **before** BugPilot knows which reviewer will run.
3. For a Claude CLI with a captured review, a second call, `review-package --json --include-changes`, adds the current `git status` and `git diff`. The diff is capped at `MAX_DIFF_CHARS` (60,000).
4. The prompt and the changes go on stdin to `claude -p --output-format json …`, with the repository as cwd.
5. `capturedReviewOutcome` (`reviewRun.ts`) reads the one `type: "result"` object:
   - `is_error`, a subtype other than `success`, or a non-zero exit counts as an error;
   - stdout is capped at `MAX_STDOUT_CHARS`;
   - the run times out after 15 minutes and can be cancelled.
6. The answer becomes a Review Result **draft**. It is never saved automatically and never posted.

#### 16.5.2 The P2 evidence, re-read

The evidence was re-read from `C:/bp-0b/run-p2/evidence/` (`p2-prompt.txt`, `p2-stream.jsonl`, `p2-analysis.json`, `cli-help.txt`). Claude was not run again, and no credential file was opened.

| # | Observation | Label | What it shows | What it does not show |
| --- | --- | --- | --- | --- |
| E1 | `Read` of `C:/bp-0b/run-p2/work/JR-12345/context.md` and `fix_report.md`, each named by an absolute forward-slash path outside the working directory, succeeded. There was no prompt, and `permission_denials` was empty. | O | Option A's read works on this configuration. | <ul><li>`retrieval.json` (the probe's prompt did not name it)</li><li>macOS and Linux</li><li>other Claude Code versions</li><li>a developer's real configuration, or a managed policy</li><li>network paths</li><li>a denial</li></ul> |
| E2 | The session had exactly three tools: `Glob`, `Grep` and `Read`. The model requested `Bash` once, and Claude Code refused it ("not enabled in this context"). | O | `--tools` decides which tools exist, and it held. | That a model will not *ask* for a tool it lacks. This one did. |
| E3 | The `fix_report.md` marker reached the model in the tool result. The model declined to reproduce it, calling it an instruction embedded in the reviewed file. | O | This model, on this run, treated artifact text as data. | Any guarantee for other models or other content. |
| E4 | `memory_paths.auto` pointed at `<config>/projects/<repository slug>/memory/`, despite `--setting-sources ""`. The model tried to `Read` `MEMORY.md` there; the file was absent. The CLI created the empty folder. | O | Auto-memory is active under the captured-review flags. | What happens when `MEMORY.md` exists (A; §16.5.5). |
| E5 | The run wrote `remote-settings.json`, `policy-limits.json`, `.last-cleanup` and a `.claude.json` backup into the configuration folder. It kept no transcript. | O | `--no-session-persistence` holds for transcripts, but the configuration folder is still written. | — |
| E6 | The synthetic files were unchanged, and the repository's `git status` was clean. | O | The review wrote nothing. | — |
| E7 | The `stream-json` result event carries `is_error`, `subtype`, `num_turns` and `permission_denials`. | O | The runtime can report a denial. | That `--output-format json`, which BugPilot uses, carries the same `permission_denials` field (A). No fixture records it. |

**Observation and inference, kept apart.**

- That no real file was read rests on the transcript, which names only kit paths (O).
- The bare `Read` allow permits any path the developer can read (V).
- So confinement comes from the model's behaviour. Nothing enforces it.

**P2 stays FAIL** against the owner's criteria: the marker condition and the no-unauthorized-tool condition were not met as written. This section does not re-score P2. It uses E1–E7 only as evidence for US-D28.

#### 16.5.3 The options

**Option A — direct absolute-path review.** The CLI renders the three paths as absolute forward-slash paths, from the work folder it resolved (US-D17). The reviewer reads them with `Read`, under `dontAsk` and the bare `Read` allow. The flags do not change.

- *For:*
  - P2 observed it working (E1).
  - It is the smallest change: one builder, rendering paths only.
  - The prompt stays small.
  - The reviewer sees what it sees in 0.1.5, from a different folder.
  - The paths are rendered the same way as in Option D's handoff (§9.5 point 1).
- *Against:*
  - It depends on how Claude Code applies the bare `Read` allow, which BugPilot cannot pin.
    - Most network paths are excepted (V).
    - A managed policy could deny outside reads (A).
  - If a read is denied, the review covers the diff alone. Only the review's own wording says so, unless BugPilot detects the denial (E7, A).
  - The absolute path passes through the prompt gate (§16.5.1, step 2), even though the prompt travels on stdin.
    - A path with a character outside the gate's class makes Review with AI refuse, with the existing command-line error. Such characters include any non-ASCII letter, an apostrophe, parentheses, `&`, `~` and `@`.
    - The remedy is §9.5 point 3's: a `BUGPILOT_HOME` without such characters. US-D12 keeps the gate.

**Option B — inline review context.** BugPilot puts the files' contents into the stdin prompt:

- `fix_report.md` is quoted as earlier AI output, through the existing machinery:
  - `PREVIOUS_ATTEMPT_NOTE`;
  - `evidence_block(..., info="text earlier-ai-output fix-report")`;
  - the text is cut before it is fenced, and marked `[truncated by bugpilot]`;
  - the cap is `_PREVIOUS_REPORT_LIMIT`, 2,400 characters.
- `context.md` and `retrieval.json` go in as data blocks of the same kind.

- *For:*
  - Nothing depends on reads outside the working directory, or on how network paths and policies behave.
  - BugPilot knows exactly what the reviewer was given.
  - It reuses 0.1.5's quoting machinery.
- *Against:*
  - The prompt grows on every run.
  - `context.md` and `retrieval.json` would need caps and quoting of their own. Any cap drops content the reviewer would otherwise read in full, and a 2,400-character report excerpt is small for a final review.
  - Two more artifact kinds need quoting, with goldens.
  - Inline text can never pass the prompt gate. It must be appended **after** the gate, as the changes are, and never placed in `review-package`'s `prompt`, which the clipboard and terminal reviews share.
  - It does not take `Read` away from the reviewer: the model can still open any path (V), the work folder included.
  - It does nothing about auto-memory (§16.5.5).

**Option C — hybrid.** A is the default, and the inline `fix_report.md` excerpt is used under a defined condition.

- This is what §9.5 point 5, §9.6 and US-D28's current wording describe: "otherwise the fix-report excerpt goes inline".
- That wording leaves the condition undefined: BugPilot cannot know, before the run, that a read will be denied.

There are three ways to define the condition:

- **C1, always inline as well.**
  - It is deterministic and needs no detection.
  - It costs about 2,400 characters more on every run.
  - The model may lean on the truncated excerpt instead of reading the full report.
- **C2, a condition checked before launch,** such as a data root on a network path. It covers only what BugPilot can see in advance.
- **C3, after a detected denial.** It is precise, but it needs a second run and a signal from the runtime (E7, A).

**Trade-offs.**

| | A | B | C, narrow form (recommended below) |
| --- | --- | --- | --- |
| P2 evidence | observed (E1) | not exercised: P2 inlined nothing but the changes | A's path observed; the fallback not exercised |
| Prompt size | as 0.1.5, plus longer paths | grows with every artifact; needs new caps | as A; the fallback run adds at most 2,400 characters |
| What reaches the model | what the model chooses to read | everything inlined, plus what it reads | as A; in the fallback, the excerpt too |
| Depends on the Claude runtime to see the files | yes (bare `Read`) | no | the normal path does; the fallback does not |
| Works when outside reads are denied | no: the review covers only the diff | yes | yes, after the developer re-runs |
| Change surface | one Python builder, with goldens | <ul><li>the builder</li><li>new quoting and caps</li><li>goldens</li><li>a contract field</li></ul> | <ul><li>A's</li><li>denial detection</li><li>one panel action</li><li>one CLI option</li><li>goldens</li></ul> |
| Prompt gate | the path is inside the gate; non-plain paths are refused | inline text goes after the gate | as A; the excerpt goes after the gate |
| Error visibility | depends on the review saying so | not applicable | a detected denial is shown in the panel |
| Auto-memory exposure | unchanged from 0.1.5 | unchanged | unchanged |

#### 16.5.4 Recommendation: Option C in its narrow form

*(Not approved verbatim: see §16.5.11.)*

In short: A first, fail visibly, and go inline only when the developer asks.

1. **Primary path (A).** `review-package`'s prompt names three files by the absolute forward-slash path of the CLI-resolved work folder:
   - `context.md`;
   - `retrieval.json`, if present;
   - `fix_report.md`, if present.

   The paths are composed only from validated ids (US-D17). `CLAUDE_CAPTURED_REVIEW` does not change.
2. **Fail visibly.** The prompt's Rules gain one line: if a listed file cannot be read, say so in Validation Notes.
   - The result may report a denied `Read` of the work folder. This uses `permission_denials`, if the `json` output carries it (§16.5.9).
   - When it does, the panel says the reviewer could not read this work item's BugPilot folder, and the draft is labelled as a review of the changes only.
3. **One fallback, started by the developer.** After a detected denial, the panel offers **Review again with the report included**.
   - That is one new captured run. Its stdin carries the bounded `fix_report.md` excerpt inline, quoted as earlier AI output by the existing machinery and appended after the gate, like the changes.
   - Nothing re-runs automatically.
   - The existing recoveries stay: copy the review prompt for an interactive agent, and Paste Review Output. Both count as FALLBACK under §9.10.
4. **Nothing is widened.** No `--add-dir`, no settings file, no `--bare`, no `--safe-mode`, no new tool, no change of permission mode, no gate change.
5. **Auto-memory** is recorded as a residual risk and disclosed (§16.5.5). It does not decide between the options, because none of them changes it.

**Why this option and not the others.**

- A is what P2 observed working, and it is the smallest change.
- B pays on every run for a failure P2 did not see. It still lets `Read` open any path, and it needs new caps that cut what the reviewer would otherwise read.
- Plain A leaves the reviewer blind, with no signal, when a read is denied.
- The narrow form of C keeps A's normal path. It makes US-D28's "otherwise inline" operational, and it spends a second AI run only when the developer asks for one.

#### 16.5.5 Auto-memory privacy review

**Observed (E4).** Under the captured-review flags, with `--setting-sources ""`:

- the session's `memory_paths.auto` pointed at the configuration's per-repository memory folder;
- the model tried to read `MEMORY.md` there;
- the CLI created the folder, empty. There was nothing to read.

**Documented (V, 2.1.214 help):**

- `--bare` skips "auto-memory" and "CLAUDE.md auto-discovery". But its Anthropic authentication "is strictly ANTHROPIC_API_KEY or apiKeyHelper … (OAuth and keychain are never read)".
- `--exclude-dynamic-system-prompt-sections` lists "memory paths" as part of the default system prompt.
- `--safe-mode` disables "CLAUDE.md, skills, plugins, hooks, MCP servers, … and more", while "Auth, model selection, built-in tools, and permissions work normally". It does not name auto-memory, and it is described as a troubleshooting mode.

**Inferred (A), not observed:**

- With the developer's real configuration, this folder is the per-repository auto-memory that the developer's interactive Claude Code sessions in that repository also use.
  - When `MEMORY.md` exists, its content may be loaded into the review's context at the start.
  - The topic files it points to can be opened through the bare `Read` allow.
- 0.1.5's captured review uses the same flags, so this exposure exists today. Neither the storage switch nor any US-D28 option introduces it.
- `CLAUDE.md` files (the developer's user-level file and the repository's): P2 had none, so whether they load under `--setting-sources ""` is UNKNOWN. `--bare`'s help implies that auto-discovery happens without it.

**Not done, by design.** No real auto-memory was copied, opened or listed. This review does not assume that `--setting-sources ""` disables memory.

**Mechanisms considered.** None is adopted, and none is to be tried without a separately authorized probe.

| Mechanism | Disables auto-memory | Cost | Review |
| --- | --- | --- | --- |
| `--bare` | yes (V) | API-key authentication only: a claude.ai sign-in stops working | Rejected as a default. A switch by authentication method would need BugPilot to inspect the developer's authentication. |
| a separate `CLAUDE_CONFIG_DIR` | in effect, yes (A) | a second sign-in and a second credential store for each developer | Rejected. |
| `--safe-mode` | not stated: V names `CLAUDE.md`, not auto-memory | a troubleshooting mode whose scope may change | A candidate only; it needs its own probe. |
| a settings key or environment variable for auto-memory, if the installed version documents one | unverified | `--setting-sources ""` may stop a settings-based switch from loading (A) | A candidate only; it needs its own probe. |
| `--exclude-dynamic-system-prompt-sections` | no: it moves the memory paths, it does not remove them (V) | — | Not applicable. |

**Residual risk.** The owner decides whether to accept it.

- With a developer's real Claude Code configuration, a captured review may load or read Claude Code's auto-memory for the repository, and possibly `CLAUDE.md` files (UNKNOWN).
- The content is the developer's own. It goes to the same provider account as the developer's interactive sessions; BugPilot adds no recipient.
- It can appear in the review draft. It is kept only if the developer saves the draft, as `review_report.md` in the work folder, and BugPilot does not post or send that file anywhere.
- BugPilot has no verified way to switch auto-memory off for users signed in with claude.ai.
- Whether personal data in a developer's memory needs a data-protection note is for the owner and the DPO to decide, not this review.

**Proposed safeguards:**

- **Disclosure,** one sentence in each of two places:
  - `docs/safety.md`, whose captured-review line already says `Read` can open any file the developer can, but does not mention auto-memory;
  - Review with AI's notice.
- **No automatic save** of the draft. This already exists.
- **No write tool,** so the review cannot change memory (E2, O).

A mechanism to disable auto-memory is a follow-up for a later, separately authorized probe. It is not a 0.1.6 blocker for US-D28.

#### 16.5.6 Tool restrictions: verified and assumed

| Restriction | Status | Note |
| --- | --- | --- |
| `--tools Read Grep Glob`: only these tools exist | **O** (E2) | The model still asked for Bash. |
| No write tool, so the model writes no file | **O** for the kit (E6) | Claude Code itself writes its configuration folder (E5). |
| `dontAsk` with `--allowedTools`: allowed reads run without a prompt | **O** (E1) | — |
| `dontAsk`: anything else is denied, not asked about | **V** | No denial occurred in P2. |
| The bare `Read` allow reaches external paths | **O** for kit paths; **V** in general | It is not confined to the work folder. Most network paths are excepted (V). |
| `--setting-sources ""`: no user, project or local settings, allow rules or hooks | **V** | The kit had none to load, so this was not observed. |
| `--setting-sources ""` does **not** stop auto-memory | **O** (E4) | — |
| `--strict-mcp-config`: no MCP servers | **O** (`mcp_servers` empty) | — |
| `--no-session-persistence`: no transcript | **O** (E5) | The configuration folder is still written. |
| `CLAUDE.md` loading | UNKNOWN | P2 had no `CLAUDE.md` file. |
| Managed (policy) settings | **A**: they apply regardless | P2 fetched `policy-limits.json` (E5). |

None of these is to be loosened. Nothing in this proposal adds a tool, an allow rule, a directory or a mode.

#### 16.5.7 Safety requirements

**BugPilot can enforce:**

- `CLAUDE_CAPTURED_REVIEW`'s fixed argv, pinned by tests;
- the prompt on stdin, never on a command line;
- paths only from the CLI resolver (US-D17): built from validated ids, absolute, with forward slashes, and never taken from work-item text;
- the prompt gate before resolution (US-D12, unchanged), with inline text added only after it;
- the excerpt quoted as earlier AI output, cut before fencing, marked when truncated, and capped;
- the existing limits: a 60,000-character diff, `MAX_STDOUT_CHARS` for stdout, a 15-minute timeout, and Cancel;
- an error on `is_error`, on a subtype other than `success`, or on a non-zero exit;
- a draft that is never saved automatically, with nothing posted;
- no automatic second run, no grant, no settings file and no mode change;
- nothing written into the repository;
- the disclosure text.

**Depends on the Claude runtime:**

- `--tools` meaning that only those tools exist;
- `dontAsk` denying instead of prompting;
- the bare `Read` allow reaching the work folder, with its network-path exception;
- whether auto-memory and `CLAUDE.md` files load;
- writes into the agent's configuration folder;
- whether the `json` result carries `permission_denials`;
- the model reading only what it is asked to, treating artifacts as data, and saying when it could not read;
- managed policy on the developer's machine.

#### 16.5.8 Owner decision proposal

**Option:** C, in its narrow form (§16.5.4).

**Proposed decision text** for US-D28's row. It was not approved verbatim; the approved contract is in §16.5.11:

> Captured review names `context.md`, `retrieval.json` and `fix_report.md` by the absolute, CLI-resolved work-folder path (forward slashes) and reads them through the bare `Read` allow; `CLAUDE_CAPTURED_REVIEW`'s flags and the prompt gate are unchanged. If the run reports a denied read of the work folder, the panel says so and offers one developer-initiated re-run whose prompt carries the bounded `fix_report.md` excerpt inline, quoted as earlier AI output; nothing re-runs automatically. Claude Code's auto-memory is a documented residual risk with no verified switch for claude.ai sign-in; it is disclosed in `docs/safety.md` and Review with AI's notice.

**Security.**

- No permission is widened.
- The reviewer can still reach any file the developer can read. That is unchanged from 0.1.5 and stays documented.
- The work-folder path comes only from the CLI.
- Inline text is quoted as data and never passes through the gate.

**UX.**

- **Normal path:** as in 0.1.5; the developer sees no difference.
- **Denial detected:** one notice and one action. The draft says it covers only the changes.
- **Gate refusal** for a data-root path outside the plain character class: the existing command-line error, with the `BUGPILOT_HOME` remedy (§13).

**Errors.**

| Case | Behaviour |
| --- | --- |
| `fix_report.md` or `retrieval.json` is absent | The prompt lists it "if present", as today. |
| A denied read, detected | A notice, a labelled draft, and the re-run offered. |
| A denied read, not detected | The review's Validation Notes say what it read (the new prompt rule), and the developer judges the draft. |
| The data-root path is outside the gate's class | Review with AI is refused, with the existing message and remedy. |
| Storage is unavailable | `review-package` fails, and its error is shown as today. The error code falls under US-D26's open `STORAGE_UNAVAILABLE`. |
| A timeout, `is_error`, a non-zero exit, or Cancel | Unchanged from 0.1.5. |
| The data root is on a network path | Expected to be denied (V), and handled as a denial. |

**Platforms.**

- Windows was observed (E1), and forward-slash Windows paths were read correctly (O).
- macOS and Linux rest on documentation (V) until the Batch 4 and Batch 5 runs.

**Implementation conditions:**

- The builder change lands with the CLI prompt slice of the Batch 2B consumer switch, on `verify/0.1.6-storage` (US-D29), with goldens for the prompt.
- The re-run's inline excerpt comes from the CLI, as a `review-package` option, reusing `PREVIOUS_ATTEMPT_NOTE` and `evidence_block`. Any envelope field it adds is frozen in the storage contract (US-D26).
- Denial detection, the notice, the action and the disclosure land in Batch 3, with unit tests built from a recorded `json` result.
- Tests pin `CLAUDE_CAPTURED_REVIEW`'s argv, and that no inline text reaches the gate.

**Activation conditions.** These are US-D28's part of activating Unified Storage:

- the owner approves the decision text;
- a live `json` run shows whether a denial appears in `permission_denials` (Batch 4, owner-authorized). If it does not, the owner chooses what to do instead;
- H5 reaches A5 PASS on every platform the owner supports, from Batch 5's end-to-end runs (§9.10);
- the disclosure text is reviewed and shipped.

**Non-goals:**

- disabling auto-memory;
- changing the flags, the tools or the gate;
- `--add-dir` or any other grant;
- parsing `stream-json` in the extension;
- reviewers other than the Claude CLI;
- reading a verdict out of the review;
- retrying P2.

#### 16.5.9 Open questions for the owner

1. Approve the narrow form of C, or choose plain A (no inline fallback, recoveries only) or B?
2. Does `--output-format json` carry `permission_denials`? If a live run shows it does not, should the re-run action be offered on every draft, or dropped?
3. Accept the auto-memory residual risk with disclosure? And is a later probe of a disable mechanism (`--safe-mode`, or a documented setting) wanted?
4. Should the inline variant also serve a data-root path that the gate refuses? The review says no for 0.1.6: keep one remedy, `BUGPILOT_HOME`, as US-D12 does.
5. Are network-path data roots supported at all? If not, §13 should say so.
6. Is the re-run's excerpt cap 2,400 characters, as for retries, or larger for a final review?
7. Should `CLAUDE.md` loading under the captured-review flags be observed in a later authorized probe?

#### 16.5.10 Dependencies

| Item | State | Relation to US-D28 |
| --- | --- | --- |
| US-D10 (handoff, Option D) | OPEN | <ul><li>The same absolute-path rendering, decided separately.</li><li>P2 covers only H5/A5.</li><li>Both block a storage-changing Batch 2 (§14.3).</li></ul> |
| US-D12 (prompt gate) | PROPOSED | <ul><li>The gate stays.</li><li>The review prompt, with its absolute path, passes through it; inline text never does.</li><li>US-D28 must not be read as loosening it.</li></ul> |
| US-D13 (`task.md` paths) | PROPOSED | The same rendering rule (absolute, forward slashes), with separate text. |
| US-D17 (the CLI is the only resolver) | PROPOSED | The only source of the work-folder path in the prompt. |
| US-D26 (storage JSON contract; `STORAGE_UNAVAILABLE` OPEN) | APPROVED in part | <ul><li>Any `review-package` field for the re-run is a contract change.</li><li>It also governs the error path when storage is unavailable.</li></ul> |
| US-D27 (MCP values absolute) | PROPOSED | Consistent rendering; not on the captured-review path. |
| US-D29 (integration branch) | OPEN | Where the CLI and extension changes land. |
| 2B-5 (MCP per-tool-call scope) | NOT INTEGRATED | Not on this path, because the extension runs the CLI as a process. But the whole 2B consumer switch, `review-package` included, waits for the 2B gates. |
| Batch 3 (extension) | NOT STARTED | Denial detection, the notice, the re-run action and the disclosure. |
| Batch 4 (security, cross-platform) | NOT STARTED | <ul><li>The live `json` denial check.</li><li>Reads on macOS and Linux.</li><li>Network paths.</li></ul> |
| Batch 5 | NOT STARTED | A5 PASS end-to-end, for the release (§9.10). |

**Owner decision required before a storage-changing Batch 2** (§14.3): approve the proposed text, amend it, or choose A or B. *(Decided on 2026-10-18: approved with amendments, §16.5.11.)*

#### 16.5.11 Owner decision (2026-10-18): the approved US-D28 contract

**Decision.** The owner approved US-D28 **with amendments**, as a **design decision**. Its status in §16.1 is **APPROVED — with conditions**.

- The review's narrow Option C (§16.5.4, and the text proposed in §16.5.8) was **not** approved verbatim. The contract below replaces it.
- This approves the design only. It does not approve implementing it, activating any storage consumer, or shipping it. It does not start Batch 2B-2 or any later batch.

**The approved contract** (the owner's text):

1. The normal Captured Review path uses absolute, CLI-resolved, validated work-folder paths for `context.md`, `retrieval.json` and `fix_report.md`.
2. Preserve the existing Claude Captured Review permission restrictions, including Read/Grep/Glob only, `dontAsk`, strict MCP configuration and disabled session persistence.
3. The agent may read these files directly. This is not an operating-system filesystem sandbox. Do not claim the agent can read only these three files.
4. Do not automatically fall back to inline review after a denied, missing, unsuccessful or ambiguous read.
5. If a work-folder read is reliably reported as denied, display that failure clearly. A successful process exit alone is not proof that all review inputs were read.
6. Support a separately identified, developer-initiated Partial Review retry using at most 2,400 characters from `fix_report.md`, explicitly marked as earlier AI output and incomplete source material.
7. Do not silently truncate larger reports and present the excerpt as a full review. Explain the limit and require an explicit user choice.
8. The Partial Review retry is never automatic. It must not be described as equivalent to a full Captured Review.
9. If JSON output does not reliably expose read denials, do not invent or infer them. The manual Partial Review action may be available independently, clearly identified as a reduced-input operation.
10. Retain the existing prompt gate. Do not use the inline retry as a way to bypass rejected data-root paths.
11. Retain the existing Claude tool restrictions even if the model attempts to invoke Bash. Do not broaden permissions to improve success rates.
12. Claude auto-memory is a documented residual privacy risk. The P2 probe demonstrated an auto-memory read attempt, not successful access to a real user's memory. Add an appropriate disclosure requirement for `docs/safety.md` and the Review with AI UI.
13. Do not claim `--setting-sources ""` disables auto-memory or that `--no-session-persistence` prevents every configuration-state write.
14. Network storage roots are not guaranteed supported without later validation.
15. Prompt content, tool output and agent-generated review text are untrusted data. Their embedded instructions must not override BugPilot's tool or security policy.

**Evidence basis.** It is unchanged; see §14.1.B, "Batch 0B — probe P2", and §16.5.2.

- P2 remains **FAIL** overall against the owner's acceptance criteria.
- The external reads of `context.md` and `fix_report.md` succeeded:
  - by absolute path;
  - under the unchanged flags;
  - on Windows, with Claude Code 2.1.214.
- These remain unverified:
  - `retrieval.json`;
  - actual read denials, and how the `json` output reports them;
  - behaviour on macOS and Linux.
- The auto-memory observation is an *attempt* to read the isolated configuration's memory file, which did not exist. Access to a real developer's memory was not observed.

**Rationale.**

- The normal path is the one P2 observed working. It keeps the restrictions that held in P2: the Bash request was refused because no Bash tool existed. Widening nothing keeps 0.1.5's read-only posture.
- The contract differs from the review's proposal in four ways:
  - **No automatic fallback.** Nothing is offered automatically as a consequence of a failed or ambiguous run (item 4). The proposal tied the reduced-input run to detection. The contract makes it a separately identified operation that the developer chooses, with the limit explained (items 6–9).
  - **No inferred denials.** A denial is shown only when the runtime reliably reports one. BugPilot does not infer a denial from the review's text or from a clean exit (items 5 and 9).
  - **No overclaiming.** What the reviewer can read, auto-memory and the session-persistence flag are all described without overclaiming (items 3, 12 and 13).
  - **Untrusted data and unvalidated roots.** Network roots stay unvalidated (item 14). All text given to the model or produced by it is data (item 15).

**Activation gates.** All of these are required before the captured review's storage path is activated in production. Approval of the design is not approval to ship it.

- a separately authorized check of how the JSON output reports denials;
- full captured-review integration tests on every supported platform;
- validation of the review's inputs, and error handling that fails closed;
- explicit Partial Review labelling, and the user's confirmation;
- the auto-memory privacy disclosure, in `docs/safety.md` and the Review with AI UI;
- regression tests that pin the tool restrictions;
- verification of how absolute paths are handled and how the prompt gate behaves.

These add to the gates that already apply; they do not replace them:

- §14.3's activation preconditions;
- §9.10's release rule: A5 PASS for H5 on every supported combination.

**Open implementation questions.** The implementing batch decides each one before it is built.

1. **The denial signal.** Which runtime field, if any, reliably reports a denied read in `--output-format json`? The candidate is `permission_denials` (E7). Until the authorized check answers this, no denial is shown (item 9).
2. **The Partial Review's input.**
   - Does its prompt keep the current changes?
   - Does it name the work-folder files at all? If it does, the reviewer may read them. If it does not, `Read` can still reach them (item 3).
   - Its label must stay accurate either way.
3. **When the Partial Review is offered.** Only after a reported denial, or always, as a separate action? Item 9 allows either.
4. **The explicit choice.**
   - How the developer confirms, and the wording that explains the 2,400-character limit.
   - What is said when `fix_report.md` is shorter than the limit. The review is still partial, because `context.md` and `retrieval.json` are absent.
5. **Labelling after the run.** How a Partial Review is marked in the Review Result draft, in a saved `review_report.md` and in History, so that it is never shown as a full captured review.
6. **Input validation, failing closed.**
   - What is checked before launch: the CLI-resolved work folder, whether the files are present, and the prompt gate.
   - Which failures stop the review.
   - The error code, which depends on US-D26's open `STORAGE_UNAVAILABLE`.
7. **The disclosure wording** for `docs/safety.md` and the Review with AI UI (item 12). It is reviewed before it ships.
8. **Network storage roots.** Validate them later, or document them as unsupported (§13; item 14)?
9. **Later probes.** Should a separately authorized probe examine a way to disable auto-memory, or how `CLAUDE.md` files load (§16.5.5)?

**Not authorized by this decision:**

- implementing the captured-review changes;
- switching any Unified Storage consumer;
- starting Batch 2B-2 or any later batch;
- any agent probe;
- staging, committing, pushing, or dispatching CI.

---

## 17. Acceptance criteria

0.1.6 is acceptable when every row holds on Linux, macOS and Windows (Python 3.10 and 3.13 in CI):

| Requirement | Verifiable criterion |
| --- | --- |
| R1 | Every BugPilot-written file is under `data_root()`, shown by the pollution suite and a full-tree diff of the data root. `Path.home()` (or `BUGPILOT_HOME`) is the only source of the root. |
| R2 | One root holds config, repositories, settings, work, memory and identity records. Temporary files appear only in the target's folder (atomic writes), OS temp and VS Code storage, and are gone after their command. |
| R3 | The two-repositories-same-id test passes for the CLI, MCP and the extension. The §7.3 rows are verified on their OS, or recorded with the reason they cannot be. Record mismatches are refused. |
| R4 | The canary suite proves no legacy read. Legacy files are byte-identical and mtime-unchanged after every workflow. No import or migration code exists (ratchet; review). §13 is published. |
| R5 | The pollution suite is green for every command and MCP tool. Every live run of §9.10 ends with a `git status` showing only intended source edits. No repository write remains in the extension (US-D16, if approved). |
| R6 | Every workflow in §11.5 passes, automated or in the real pass. The retrieval and Context Quality baselines are unchanged. |
| R7 | §11.4 is green. §10.2 is tested per OS. The mutation check catches every control. The `docs/safety.md` claims match behaviour. |
| R8 | No launch adds a permission flag or directory grant by default (unit test). The agent's cwd is the repository (unit test and live). Every outside access in live runs was the developer's choice in the agent's own UI. |
| Handoff (R6, R8) | §9.10: every applicable aspect of every owner-listed supported combination is PASS, from real interactive end-to-end runs on the candidates. FALLBACK and UNKNOWN never count as PASS. |
| Test isolation | `tests/test_isolation_guard.py` demonstrates fail-closed writes and reads against a decoy on every CI configuration. No default run lists or reads the real home (§11.1). |
| Integration | §15.4: the expected-failure ledger is empty; all nine CI checks are green on the branch and on `main` after the owner-approved fast-forward. |

---

## 18. Implementation progress log

| Date | Batch | Entry |
| --- | --- | --- |
| 2026-10-15 | — | **Plan created** by a read-only audit at `ee3fb00`. No product code, test, golden, fixture, workflow, version or user data changed. The only repository changes: this file (new, untracked) and a pointer section (§45) appended to `docs/bugpilot_prototype_development_plan.md`, which leaves its uncommitted 0.1.5 records as they were. Live agent probes P1–P10: **not run**. Platform behaviour in §7.3 marked "unverified": **not tested**. |
| 2026-10-15 | — | **Architecture review, revision r2 (documentation only).** <ul><li>**Decision log** (§16.1): owner status separated from the review's recommendation. 35 decisions await the owner (14 OPEN, 21 PROPOSED) and 4 are DEFERRED. The review recommends 28 Accept, 2 Accept conditionally (US-D5, US-D26), 3 Keep open (US-D10, US-D14, US-D28) and 2 Defer (US-D11, US-D20). **None is approved.**</li><li>**Test isolation redesigned** (§11.1): r1's listing of the real home is withdrawn. Isolation now comes before collection, an audit-hook guard fails closed for writes and reads, and verification is against a decoy. New threats T-S24 to T-S26.</li><li>**Batch 0** split into 0A (automated, no accounts) and 0B (live probes, separately authorized; PASS, FAIL or UNKNOWN) (§14.1).</li><li>**Repository scope** stated, with the subfolder diagnostic (§7.1).</li><li>**Exact JSON contract** (§8.10).</li><li>**Safer launch:** evaluation, with probe P11 added (§9.9).</li><li>**Handoff acceptance** by aspect and combination; FALLBACK never counts as PASS (§9.10).</li><li>**Integration gates** and the expected-failure ledger (§15.4).</li><li>**US-D14** options A, A′ and B (§16.4).</li><li>**Risks and assumptions:** RK-15 to RK-19 and AS-7 added; §14, §17 and §20 updated to match.</li><li>**Corrections:** §2's R5 reference (it named a section 12.3 that does not exist; now §10.2 and §11.3). Three table rows whose code spans held an unescaped `\|` (§9.2, §9.9, §10.2) are escaped so the tables render, with wording unchanged.</li><li>**Validation:** <ul><li>a structural check (headings, the 39 decision rows and their counts, internal section references, table cell counts, all seven batches NOT STARTED): 0 problems;</li><li>`git diff --check` clean; LF line endings; no trailing whitespace;</li><li>`tests/test_publishable.py`: 20 passed, after one draft line (a home-folder example the scanner flagged) was reworded;</li><li>`.bugpilot/`, `.vscode/extensions.json`, `docs/bugpilot_prototype_development_plan.md` (the 0.1.5 records), `bugpilot/__init__.py` and `extension/package.json` byte-identical to before the review;</li><li>version 0.1.5.</li></ul></li><li>**Not run:** any product test, CI, probe or agent session. No source, test, fixture, golden, workflow, version or user data changed.</li></ul> |
| 2026-10-15/16 | 0A | **Batch 0A implemented and verified locally (not committed; no CI run).** <ul><li>**Authorization:** the owner authorized Batch 0A only, and approved US-D32 and US-D33 for its scope. No other decision changed, and Batch 0B was not authorized.</li><li>**Built:** test isolation before collection; a fail-closed audit-hook guard (in-process and in Python children); TypeScript integration isolation; the path-literal ratchet (`tests/storage_inventory.json`); synthetic 0.1.5 baselines (`tests/baselines/0.1.6-batch0/`); CI changes keeping the nine checks.</li><li>**Isolation:** demonstrated against a decoy, 14 tests. The real home was never listed, read or probed.</li><li>**Inventory:** reconciled exactly with §5.1.</li><li>**Baselines:** regenerated twice, byte-identical on Windows. The records held Windows path separators (pre-commit review finding H-1, remediated in the next entry).</li><li>**Python:** full suite 3,243 passed, 0 failed, 36 skipped, after one publishability fix in new code.</li><li>**Extension:** 2,349 passed; the required TypeScript job 27 passed; the integration suite 21 passed.</li><li>**Unchanged:** production files, goldens (the frozen 0.1.4 sets included), fixtures, existing baselines, protected local files, the historical plan and the version 0.1.5.</li><li>**Deviations:** D0A-1 to D0A-6.</li><li>**Not run:** CI; POSIX, macOS and Python 3.10 runs; `check_cli_contract.py`; probes.</li><li>**Details:** §14.1.A, "Batch 0A — as built".</li></ul> |
| 2026-10-16 | 0A | **Pre-commit review, then the owner-authorized remediation (not committed; no CI run).** <ul><li>**Review:** independent and read-only. It recommended FAIL as built: no Critical finding, one High (H-1) and two Medium (M-1, M-2), plus Low findings, and no security exposure.</li><li>**Authorization:** the owner authorized remediating H-1, M-1 and M-2, correcting this plan, and explicitly regenerating the affected baseline. Batch 0B and Batch 1 were not authorized.</li><li>**H-1:** `pollution.json` held Windows path separators in its recorded commands, so 5 of the 9 required checks would have failed on Linux and macOS. Path arguments are now recorded with `/` on every platform (`portable_path`). Only `pollution.json` was regenerated: 7 command strings changed, `\` to `/` and nothing else. `--check` passed twice.</li><li>**M-1:** two tests replaced `PYTHONPATH`, so their Python children ran without the guard. They now use `child_pythonpath`, and the parent refuses any recognizable Python child that would start without the loader. `-I`, `-E` and `-S` children are exempt.</li><li>**M-2:** the integration suite's `discoverExecutable` test now gets the guarded spawn. A source check in the required extension job covers every way that suite can start a process.</li><li>**Plan:** `subst` marked NOT VERIFIED throughout, with its test deferred pending owner approval. The guard's coverage and limits are restated as built.</li><li>**Not changed:** L-2 and L-3 (still governed by diff review); L-5 (in files outside this remediation).</li><li>**Results:** <ul><li>full Python suite: 3,250 passed, 0 failed, 36 skipped;</li><li>extension: 2,350 passed; the required TypeScript job 27 passed; integration 21 passed;</li><li>goldens, product files, protected files and the other baseline records unchanged; version 0.1.5.</li></ul></li><li>**Not run:** CI; POSIX, macOS and Python 3.10 runs; `check_cli_contract.py`; the guarded start of an installed `bugpilot`, since none is on `PATH` here.</li><li>**Details:** §14.1.A, "Batch 0A — pre-commit review remediation".</li></ul> |
| 2026-10-16 | 0A | **Final diff review, then the owner-authorized final security remediation (not committed; no CI run).** <ul><li>**Review:** independent and read-only, with a separate reviewer agent. It recommended PASS WITH CONDITIONS: H-1, M-1 and M-2 were complete and every reported result reproduced. It found one new Medium (N-1) and Low findings L-1 to L-8.</li><li>**N-1:** on Windows, `shutil.copy2`, `Path.copy` and `Path.copy_into` copy through `_winapi.CopyFile2`, which the guard did not judge, and `_winapi.CreateJunction` was not judged either. Their arguments were measured on 3.14.6, and both events are now judged at source and destination.</li><li>**L-1:** the two module comments no longer claim agent variables are removed.</li><li>**L-2:** a refusal swallowed outside any test now fails the run, through a session-wide check plus an end-of-session backstop; each refusal is reported once.</li><li>**L-3:** the child loader fails closed (exit 70) when the guard is configured but cannot be installed.</li><li>**L-8:** a stale line reference was corrected.</li><li>**Tests:** 8 new tests; each fix was reverted in a scratch copy and its tests failed.</li><li>**Not changed:** L-4 to L-7, which are documented as limitations.</li><li>**Results:** <ul><li>full Python suite: 3,258 passed, 0 failed, 36 skipped;</li><li>extension: 2,350 passed; the required TypeScript job 27 passed; integration 21 passed;</li><li>baselines matched twice;</li><li>goldens, product files, protected files and baseline records unchanged; version 0.1.5.</li></ul></li><li>**Not run:** CI; POSIX, macOS and Python 3.10 runs; `check_cli_contract.py`; the guarded start of an installed `bugpilot`.</li><li>**Details:** §14.1.A, "Batch 0A — final security remediation".</li></ul> |
| 2026-10-16 | 0A | **Final local verification complete; commit and push approved; CI PENDING.** <ul><li>**Approval:** the owner approved committing and pushing Batch 0A to `main`, limited to its 26-file allowlist, and one CI run of the existing workflow.</li><li>**Excluded:** the historical plan (`docs/bugpilot_prototype_development_plan.md`), `.bugpilot/`, `.ai/`, `.ai_memory/` and `.vscode/extensions.json`.</li><li>**Not authorized:** publishing, tagging and a version bump. The version stays 0.1.5.</li><li>**Batch 0B and Batch 1:** NOT STARTED.</li><li>**CI verification:** PENDING. Its result is reported to the owner, and goes into §19 only through a separately authorized documentation commit.</li></ul> |
| 2026-10-16 | 0A | **Batch 0A COMPLETED: committed, pushed and CI-verified; accepted by the owner.** <ul><li>**Commit:** `8b6c567a074e4ddef6490ccc837e817cf7f48866` (`test: isolate BugPilot storage and record 0.1.5 baselines`), exactly the 26-file allowlist, noreply identity.</li><li>**Push:** a fast-forward `ee3fb00..8b6c567` to `main`.</li><li>**CI:** run 38942462918 (workflow `CI`, triggered by the push, no dispatch): **all 9 required checks succeeded**.</li><li>**Full Python suite:** Ubuntu 3,264 passed, 29 skipped; macOS 3,266 passed, 27 skipped; Windows 3,255 passed, 38 skipped; each with 1 deselected.</li><li>**Safety and baselines:** Ubuntu 3.13 and 3.10 each 1,319 passed, 23 skipped; macOS 1,321, 21; Windows 1,304, 38.</li><li>**Extension:** unit tests 2,348 passed, 2 skipped; evidence boundary 27 passed.</li><li>**First runs:** this was the first Linux, macOS and Python 3.10 run of the guard demonstrations, the ratchet and the byte-for-byte baselines. All passed, which confirms H-1 on POSIX and the guard's event coverage on 3.10.</li><li>**Platform observations:** recorded in §7.3.</li><li>**`subst`:** NOT VERIFIED.</li><li>**Findings:** no new CI finding. GitHub's notices: `ubuntu-latest` moves to Ubuntu 26 from 2026-10-19; macOS arm64 jobs may queue longer.</li><li>**Unchanged:** version 0.1.5; US-D32 and US-D33 remain APPROVED, and no other decision changed.</li><li>**Batch 0B, Batch 1 and later:** NOT STARTED.</li><li>**Plan:** this record is a documentation change, uncommitted, awaiting the owner's review.</li><li>**Details:** §14.1.A, "Batch 0A — acceptance and CI evidence".</li></ul> |
| 2026-10-16 | 1 | **Batch 1 (storage foundation) implemented and verified locally (not committed; no CI run).** <ul><li>**Authorization:** the owner's Batch 1 brief, on `64056ca`.</li><li>**Decisions:** Batch 1's prerequisites (US-D1, D3, D5, D6, D7, D23, D24, D34) remain PROPOSED or OPEN in §16.1. The brief directs their content, and their approval stays with the owner's review (B1-1). §8.10's open choices concern only Batch 2's consumers.</li><li>**Built:** `bugpilot/core/storage.py`, used by no product module; `safe_paths` `mode`/`boundary` and `is_link_stat`; two required suites (102 and 92 tests); the §8.10 contract fixture; the ratchet record for the new module; CI's file list.</li><li>**During the full run:** `test_no_unwired_symbols` flagged a test-only helper in `storage.py`. It was removed, and the tests clear the caches themselves.</li><li>**Deviations:** B1-1 to B1-10, among them an exact-root record check (B1-3), a hard-link record publish (B1-4) and `lstat`-only reads (B1-5).</li><li>**Results:** <ul><li>the new suites: 185 passed, 9 skipped (platform cases, `subst` NOT VERIFIED);</li><li>six mutations each caught;</li><li>full Python suite: 3,443 passed, 0 failed, 45 skipped;</li><li>extension: 2,350 passed; the required TypeScript job 27; integration 21;</li><li>baselines matched twice; the ratchet passed;</li><li>goldens, fixtures, baselines and product callers unchanged; version 0.1.5.</li></ul></li><li>**Performance (Windows):** <ul><li>met: identity 227 µs cold and 1.7 µs warm;</li><li>**not met:** the first `ensure()` takes 4.96 ms against a < 2 ms budget;</li><li>reads take 0.37 ms, against 0.1.5's bare join of 1.8 µs (an owner decision, §14.2 "as built").</li></ul></li><li>**Not run:** CI; Linux, macOS and Python 3.10; `subst`; a real Windows case-sensitive folder; probes.</li><li>**Batch 0B and Batches 2–5:** NOT STARTED.</li><li>**Details:** §14.2, "Batch 1 — as built".</li></ul> |
| 2026-10-16 | 1 | **Architecture and security review (FAIL), then the owner-authorized narrow remediation (not committed; no CI run).** <ul><li>**Review:** read-only. High: H1 (a data root inside the repository not prevented) and H2 (Windows access lists depend on the Python version). Medium: M1 (the no-hard-link fallback could overwrite a record), M2 (a Windows case-only rename refused) and M3 (sharing violations reported as corruption). Low: L1–L9.</li><li>**Fixed:** <ul><li>H1: the data root and repository are kept apart, checked by components and by file identity, for reads and writes alike (B1-11);</li><li>M1: a publish never replaces: hard link, else a Windows rename that cannot replace, else a POSIX refusal (B1-14, superseding B1-4);</li><li>M2: a case-only rename of the same folder is accepted on Windows, and the record is never rewritten (B1-13, revising B1-3);</li><li>M3: bounded retries; an unreadable record reported as such, never as corrupt; best-effort temp clean-up (B1-15);</li><li>L2, L3, L6, L7, L9, and literal line separators in the source (B1-12, B1-16 to B1-20).</li></ul></li><li>**Investigated:** H2, with a read-only Windows access-list test. No permission behaviour changed; options for the owner (Q1).</li><li>**Assessed, not changed:** L1, L4 and L5.</li><li>**A test changed by design:** the test that a letter-case difference is refused now holds only for different folders. On case-insensitive NTFS the case variant is the same folder, which M2 accepts. Three tests replace it.</li><li>**During verification:** the publishability guard flagged personal-looking account names in the new L3 test data; they are now the guard's generic names. Two new docstrings would have raised the ratchet's `home-bugpilot` count for `storage.py`; they were reworded, so the record is unchanged.</li><li>**Results:** <ul><li>the storage suites: 230 passed, 9 skipped;</li><li>20 mutations each caught; 7 fixture corruptions each caught;</li><li>full Python suite: 3,488 passed, 0 failed, 45 skipped;</li><li>safety and baselines: 1,537 passed;</li><li>extension: 2,350 passed; the required TypeScript job 27; integration 21;</li><li>baselines matched twice; the ratchet unchanged;</li><li>goldens, baselines, product callers and protected files unchanged; version 0.1.5.</li></ul></li><li>**Performance (Windows):** first `ensure()` 6.2–6.6 ms, from 4.96 ms; read lookups 0.53 ms, from 0.37 ms. Revised targets are PROPOSED, not approved.</li><li>**Owner questions:** Q1–Q7.</li><li>**Decisions:** none changed; Batch 1's prerequisites remain PROPOSED or OPEN.</li><li>**Batch 0B and Batches 2–5:** NOT STARTED.</li><li>**Details:** §14.2, "Batch 1 — architecture review remediation".</li></ul> |
| 2026-10-16 | 1 | **Decision-gate review (read-only), then the owner's ratification of Batch 1's decisions (not committed; no CI run).** <ul><li>**Review:** PASS WITH CONDITIONS for committing an unused foundation. New findings G-1 to G-6. G-1 (Medium): H1's check is relative to the folder BugPilot runs in, so a scratch probe accepted a data root inside the git working tree around it.</li><li>**Ratified:** US-D1, D3, D6, D7 and D24 APPROVED; US-D5, D23 and D34 APPROVED with conditions; US-D26 APPROVED in part. The register now holds 11 APPROVED, 13 OPEN, 11 PROPOSED and 4 DEFERRED. §16.1 defines the qualified statuses and lists the open parts of approved decisions. No other decision changed.</li><li>**Policies:** Q1–Q7, each set apart from the work still unimplemented (§14.2, "owner decision gate"); §12's first-write budget revised (Q6).</li><li>**Batch 2 activation blockers:** eight, in §14.3. None is satisfied.</li><li>**Changed:** the fixture's `status` value only; the contract test's status assertion; the access-list test now covers `config/` and skips a volume without access lists.</li><li>**Results:** <ul><li>the storage suites: 230 passed, 9 skipped;</li><li>safety and baselines: 1,537 passed, 0 failed;</li><li>the access-list test passed with `config/`;</li><li>the ratchet unchanged; baselines matched; the plan check 0 problems; `git diff --check` clean;</li><li>goldens, 0.1.5 baselines, product files and protected files unchanged; version 0.1.5.</li></ul></li><li>**Not run:** CI; Linux, macOS and Python 3.10; the full Python suite (the changes are confined to the storage suites, which ran, with the safety list).</li><li>**Batch 0B and Batches 2–5:** NOT STARTED.</li><li>**Details:** §14.2, "Batch 1 — owner decision gate".</li></ul> |
| 2026-10-16 | 1 | **Batch 1 COMPLETED: committed on a verification branch, CI-verified, fast-forwarded into `main`; NOT activated.** <ul><li>**Commit:** `5222da79de4dc72335b4e17be15038cf5cf08163` (`feat(storage): add the unused 0.1.6 storage foundation`), exactly the eight-file allowlist, noreply identity, on `verify/0.1.6-batch1` (owner-approved; the branch is kept).</li><li>**Verification CI:** run 39003264436, started by the owner (`workflow_dispatch`): **all 9 required checks succeeded**.</li><li>**Full Python suite:** Ubuntu 3,480 passed, 39 skipped; macOS 3,482 passed, 37 skipped; Windows 3,485 passed, 47 skipped; each with 1 deselected.</li><li>**Safety and baselines:** Ubuntu 3.13 and 3.10 each 1,535 passed, 33 skipped; macOS 1,537, 31; Windows 1,534, 47.</li><li>**Extension:** unit tests 2,348 passed, 2 skipped; evidence boundary 27 passed.</li><li>**First runs:** the POSIX permission tests, Python 3.10, and the storage suites on Linux and macOS all passed; the Windows access-list test, `config/` included, passed on 3.13.16.</li><li>**Integration:** `main` fast-forwarded `64056ca..5222da7` (owner-approved; no merge commit) and pushed. The push's CI run 39004684594: **9/9 success**.</li><li>**Timing (CI):** first `ensure()` 0.36 ms (Linux 3.13), 0.55 ms (Linux 3.10), 0.72 ms (macOS), 2.83 ms (Windows).</li><li>**Findings:** none new. G-1, G-2, G-3 and cache freshness stay open; of §14.3's blockers only the CI one is met.</li><li>**Unchanged:** version 0.1.5; no product caller switched; decisions as ratified.</li><li>**Batch 0B and Batch 2:** NOT STARTED.</li><li>**Details:** §14.2, "Batch 1 — acceptance and CI evidence".</li></ul> |
| 2026-10-17 | 2A | **Batch 2A (the storage security foundation) implemented and verified locally (not committed; no CI run).** <ul><li>**Authorization:** the owner's Batch 2A brief, on `6f8e0b2`, implementation and local verification only.</li><li>**Built:** the Git working-tree rule (G-1/G-2); the read-only privacy check and the credentials gate (G-3, the new `private_folder.py`); identities re-checked on every use and verdicts bound to request scopes (cache freshness); checked global accessors and private folder fields; the static API boundary.</li><li>**Not changed:** every product caller (none imports `storage`), the 0.1.5 storage, goldens, baselines, the contract fixture, the ratchet record and the version.</li><li>**Results:** full Python suite 3,597 passed, 0 failed, 53 skipped; the four storage suites 339 passed, 17 skipped; CI's safety list 1,645 passed; extension 2,350, the required TypeScript job 27, integration 21; baselines matched twice; the ratchet unchanged; 23 of 24 mutations caught on Windows, the remaining one (`st_ctime_ns`) being POSIX-only.</li><li>**Deviations:** D2A-1 to D2A-8.</li><li>**Batch 1's last run recorded:** 39005917365 on `6f8e0b2`, 9/9 success.</li><li>**Not run:** CI; Linux, macOS and Python 3.10; FAT, exFAT and network volumes; probes.</li><li>**Batch 0B and Batch 2B:** NOT STARTED.</li><li>**Details:** §14.3, "Batch 2A — as built".</li></ul> |
| 2026-10-17 | 2A | **Batch 2A COMPLETED: committed on a verification branch, CI-verified, fast-forwarded into `main`; NOT activated.** <ul><li>**Commit:** `e78a6789fe5dcc4144bc6e21b5427e552bc0bb5b` (`fix(storage): harden unified storage safety and cache freshness`), exactly the eight-file allowlist, noreply identity, on `verify/0.1.6-batch2a` (owner-approved; the branch is kept).</li><li>**Verification CI:** run 39057483843, started by the owner (`workflow_dispatch`): **all 9 required checks succeeded**. Full suite: Ubuntu 3,577, macOS 3,579, Windows 3,594 passed. Safety and baselines: Ubuntu 3.13 and 3.10 1,632 each, macOS 1,634, Windows 1,643. Extension 2,348 passed; evidence boundary 27.</li><li>**First observations:** the POSIX privacy tests and the POSIX `st_ctime_ns` test passed on Linux (3.13 and 3.10) and macOS; the Windows access-list, SDDL and junction-retarget tests passed on Windows 3.13.16.</li><li>**Integration:** `main` fast-forwarded `6f8e0b2..e78a678` (owner-approved; no merge commit) and pushed; the push's CI run 39062906366: **9/9 success**.</li><li>**Timing (CI):** first `ensure()` 0.68–0.93 ms on Linux and macOS, 2.15 ms on Windows; reads outside a scope cost several times more than in one, so Batch 2B opens a scope per CLI command and MCP tool call.</li><li>**Findings:** none new. The mutation coverage of `st_ctime_ns` on POSIX is inferred, not run; per-test logs were not accessible.</li><li>**Unchanged:** version 0.1.5; no product caller switched; decisions as before.</li><li>**Batch 0B and Batch 2B:** NOT STARTED.</li><li>**Details:** §14.3, "Batch 2A — acceptance and CI evidence".</li></ul> |
| 2026-10-17 | 2B-1 | **Batch 2B-1 (inactive consumer-switch preparation) implemented and verified locally on Windows (not committed; no CI run).** <ul><li>**Authorization:** the owner's Batch 2B-1 brief, on `3f8be69`: implementation and local verification only.</li><li>**Built:** C-1, the identity cache under one lock, with a deterministic race regression. C-2, request scopes owned by the thread that opened them; the MCP per-tool-call scope is recorded as a **mandatory 2B-5 gate, not integrated**. `remove_work_item()` and `remove_memory_file()`, checked and failing closed. `check()` on both storages (`StorageCheck`), with `StorageUnavailable`. The test-only write witness and its child runner.</li><li>**Unchanged:** Batch 0A's child loader, `errors.py`, every CLI, MCP, workflow, doctor, `user_config` and extension module, the goldens, baselines, contract fixture and ratchet record, and the version (0.1.5).</li><li>**Verification:** focused storage, scope, witness, privacy, boundary and isolation-guard suites 453 passed, 18 skipped; CI's safety list (30 files) 1,733 passed, 0 failed; full suite 3,685 passed, 0 failed, 54 skipped; extension typecheck clean, 2,350 unit, 27 evidence-boundary and 21 integration tests passed; baselines match twice; ratchet unchanged; publishability passes; 24 of 24 mutations caught; the C-1 race test deterministic (10 of 10 each way).</li><li>**Not run:** CI, so Linux, macOS and Python 3.10; the mutation check on POSIX; the real MCP dispatcher under concurrent calls; Batch 0B.</li><li>**Records:** the header, §14.0, §14.3 "Batch 2B-1 — inactive consumer-switch preparation" and §19, where the stale PENDING of run 39064298339 is resolved: success, 9/9.</li></ul> Batch 2B-2 to 2B-6 and Batch 0B: NOT STARTED. No decision changed; US-D29 not approved. |
| 2026-10-17 | 2B-1 | **Batch 2B-1's first CI run FAILED (3/9); remediation implemented and verified locally (not committed; no new CI run).** <ul><li>**Commit and run:** `7b8914d` on `verify/0.1.6-batch2b1` (owner-approved), CI run 39085417171 (owner-dispatched): 3 of 9 checks green.</li><li>**F-1, the five POSIX jobs:** the write witness crashed on `os.fchmod`'s audit event, whose path is a descriptor and whose `dir_fd` is `-1`. Fixed in `tests/_storage_witness.py`: descriptors are placed through the descriptor and judged; pipes are passed over; whatever cannot be placed is unresolved, never authorized; `-1` means no `dir_fd`.</li><li>**F-2, the Windows safety job:** the race test asserted an elapsed time equal to its own wait timeout (0.4999 s against 0.5). Not a lock defect. Fixed in `tests/test_storage_identity.py`: the happens-before is observed through a reporting lock and a recording cache, with no clock.</li><li>**Verification:** focused suites 466 passed, 19 skipped; CI's safety list 1,746 passed, 0 failed; full suite 3,698 passed, 0 failed, 55 skipped; 27 of 27 mutations caught; the race test passes 30 of 30 and, with the lock disabled, raises `KeyError` 30 of 30; baselines match twice; ratchet unchanged.</li><li>**Unchanged:** `storage.py`, the CLI, MCP, the extension, CI, the Batch 0A loader, goldens, fixtures, baselines, the version (0.1.5).</li><li>**Open:** POSIX and Python 3.10 verification of the fix (CI); one unexplained intermittent failure of Batch 1's multi-process publication test, seen once and not reproduced in 69 reruns.</li></ul> Batch 2B-1 is not CI-verified and not integrated; Batch 0B and Batch 2B-2 to 2B-6 NOT STARTED; no decision changed. |
| 2026-10-17 | 2B-1 | **Batch 2B-1 COMPLETED: CI-verified, fast-forwarded into `main`; NOT activated.** <ul><li>**Commits:** `7b8914d` (implementation) and `40865cf` (the fix for the two test defects that failed run 39085417171, 3/9), on `verify/0.1.6-batch2b1` (owner-approved; the branch is kept).</li><li>**Verification:** run 39096347226 on `40865cf` (owner-dispatched): 9/9.</li><li>**Integration:** `git merge --ff-only` on `main`, both commits in order, no merge commit; pushed `3f8be69..40865cf`. Run 39097757625 on `main`: 9/9, with the same counts.</li><li>**Evidence:** the original POSIX witness failure, the POSIX descriptor and `dir_fd` cases, Python 3.10, the reworked race test on Windows, the scope suite and the publication test all ran and passed (from skip lists and 0-failure summaries). The descriptor resolvers' success is inferred from the tests' design. Mutation testing ran on Windows only.</li><li>**Still open:** the MCP per-tool-call scope (2B-5, NOT INTEGRATED) and every consumer gate; the unexplained one-time local failure of Batch 1's publication test; the witness's visibility limits; activation blockers 5 and 6.</li></ul> Version 0.1.5. No decision changed; US-D29 unresolved. Batch 0B and Batch 2B-2 to 2B-6: NOT STARTED. |
| 2026-10-18 | 0B | **Batch 0B probe P10, narrowed: run on Windows; UNKNOWN overall (VS Code `sendText` not exercised).** <ul><li>**Authorization:** the owner's narrowed P10 brief: filter-accepted prompts only, inert recorders, no real agent, no account, no hostile-character matrix. An earlier, broader attempt that day was stopped before anything was created or run.</li><li>**Run:** BugPilot's own filter and command construction (`extension/src/app/agents.ts`, real `claude-cli` definition with the command renamed) and its own `run_agent()`, against npm-shaped stand-in shims, in kit `C:/bp-0b/run-p10/` with a stripped-down environment.</li><li>**Results:** 5 accepted prompts × PowerShell 7.6.6, Windows PowerShell 5.1, cmd and Git Bash 5.3.15: **20 of 20 PASS** (intact argument, one invocation, exit 0). Python launcher through a `.cmd` shim: **5 of 5 PASS**. The filter refused both refused-case strings. Multi-line prompts are accepted and flattened to one line by design; the Python launcher has no filter yet (T-S12).</li><li>**Not exercised:** VS Code `sendText`, an interactive console, developer profiles, macOS and Linux, native agent executables (P11), the `--session-id` shape.</li><li>**Isolation:** repository and protected files unchanged; the real `~/.codex` changed only through the developer's own running Codex processes, not the probe.</li><li>**Evidence:** `C:/bp-0b/run-p10/evidence/`, kept for review, outside the repository.</li></ul> No decision changed: US-D10 and US-D12 get evidence only. P1–P9 and P11 NOT EXECUTED; Batch 2B-2 onward NOT STARTED. |
| 2026-10-18 | 0B | **Batch 0B probe P7 attempted: UNKNOWN, no test ran.** <ul><li>**Authorization:** the owner's P7 brief: VS Code extension APIs on synthetic files outside the workspace, in a disposable VS Code with a minimal probe extension.</li><li>**What happened:** the disposable VS Code 1.140.0 exited with code 1 within 33 s, before its extension host started. The installer for VS Code 1.142.0 was running and held the `vscodesetup` mutex, which the installed build checks at start-up. No retry; the staged build was not launched.</li><li>**Isolation:** repository, protected files, the P10 kit, the external synthetic files and the developer's VS Code configuration unchanged.</li><li>**Kit:** `C:/bp-0b/run-p7/` kept for a rerun once no update is in progress.</li></ul> P7-A to P7-H UNKNOWN; US-D17 unchanged. P10 stays UNKNOWN overall; P1–P6, P8, P9 and P11 NOT EXECUTED; Batch 2B-2 onward NOT STARTED. |
| 2026-10-18 | 0B | **Batch 0B probe P7 retry after the VS Code update: P7-A to P7-H PASS on Windows; `revealFileInOS` UNKNOWN.** <ul><li>**Preflight:** the 1.142.0 installer had exited, its locks were released, and the installed `Code.exe` was 1.142.0.</li><li>**Run:** the first attempt's kit and probe extension, with two corrections (retry-specific evidence files that never overwrite; a P7-I `revealFileInOS` step with an OS-side check). Disposable VS Code 1.142.0, isolated profile and extensions folder, synthetic workspace; results after 31 s; closed by itself.</li><li>**Results:** read, write, open, show, watcher (create, modify, delete, atomic replace), save with its event, spaces in paths and the workspace boundary: 17 of 17 checks PASS. A new watcher missed events for up to about 10 s before becoming active; after that, events arrived in order within 82–204 ms; an atomic replace arrives as one `change` of the target. P7-I: Explorer opened at the folder's parent; the selection is unconfirmed.</li><li>**Isolation:** the repository (apart from this plan), protected files, the P10 kit, the first attempt's evidence and the developer's VS Code configuration unchanged; no window left open.</li><li>**Evidence:** `C:/bp-0b/run-p7/evidence/` (`p7-results-retry1.json`, `p7-run-retry1.json`).</li></ul> US-D17 gets evidence only and stays PROPOSED. P10 stays UNKNOWN overall; P1–P6, P8, P9 and P11 NOT EXECUTED; Batch 0B not complete; Batch 2B-2 onward NOT STARTED. |
| 2026-10-18 | 0B | **Batch 0B probe P10 completed: VS Code `sendText` 24 of 24 PASS; P10 PASS for the tested Windows configuration.** <ul><li>**Run:** a new kit `C:/bp-0b/run-p10-vscode/` and a disposable VS Code 1.142.0 (own profile, empty extensions folder, stripped-down environment). A minimal probe extension did what the extension host does: `createTerminal({name, cwd, env})`, `show()`, then `sendText(commandLine, true)` at once. The command lines came from BugPilot's own builder, the session-id form included. The stand-ins are the narrowed run's shims.</li><li>**Results:** 6 command lines × PowerShell 7.6.6, Windows PowerShell 5.1, cmd and Git Bash 5.3.15: every stand-in ran once with exactly the intended arguments; no extra record; every terminal closed on dispose. The refused strings were refused by the filter and never sent.</li><li>**Limits:** exit codes not observed (VS Code's shell-integration events did not fire); explicit `shellPath` instead of the default profile; profiles not loaded; Windows only; stand-ins, not real agents.</li><li>**Isolation:** repository (apart from this plan), protected files, the P10 and P7 kits and the developer's VS Code configuration unchanged.</li></ul> US-D10 and US-D12 get evidence only. P7 stays PASS on Windows with `revealFileInOS` UNKNOWN; P1–P6, P8, P9 and P11 NOT EXECUTED; Batch 0B not complete; Batch 2B-2 onward NOT STARTED. |
| 2026-10-18 | 0B | **Batch 0B probe P2 (captured review), one run: FAIL against the owner's acceptance criteria; the external read US-D28 needs worked.** <ul><li>**Authorization:** the owner accepted the residual read risk for this probe only, and signed in to an isolated `CLAUDE_CONFIG_DIR` in the kit `C:/bp-0b/run-p2/`.</li><li>**Run:** Claude Code 2.1.214; stripped environment; the captured-review flags with `stream-json --verbose`; BugPilot's final review prompt pointing at the synthetic external `context.md` and `fix_report.md`. Exit 0, 53 s, 9 turns; session tools exactly Read, Grep and Glob; no MCP; `dontAsk`.</li><li>**Observed:** both external files read with no prompt or denial. The marker reached the model, but it declined to reproduce it as an instruction embedded in the reviewed file. The model requested Bash once; Claude Code refused it (not enabled) and it never ran. An auto-memory read attempt inside the isolated configuration. No synthetic file changed; no transcript kept; no account detail in the output.</li><li>**Evidence:** `C:/bp-0b/run-p2/evidence/`.</li></ul> US-D28 gets evidence only and stays OPEN. P1, P3–P6, P8, P9 and P11 NOT EXECUTED; Batch 0B not complete; Batch 2B-2 onward NOT STARTED. |
| 2026-10-18 | 0B | **US-D28 decision review prepared (§16.5); no decision changed.** <ul><li>**Scope:** decision preparation only, from P2's recorded evidence and the shipped captured-review code. No agent run, no production change.</li><li>**Recommendation:** Option C in its narrow form. The primary path is absolute CLI-resolved paths read through the bare `Read` allow, as observed in P2. A detected denial is shown in the panel, and the developer may start one re-run with the bounded `fix_report.md` excerpt inline. The flags and the gate are unchanged.</li><li>**Auto-memory:** a documented residual risk. It is active under `--setting-sources ""` (P2), already present in 0.1.5, and has no verified switch for claude.ai sign-in. Disclosure is proposed.</li></ul> US-D28 stays OPEN; the suggested intermediate state is PROPOSED (decision review ready), set only by the owner. P2 FAIL, P7 PASS and P10 PASS are unchanged; Batch 0B is not complete; Batch 2B-2 onward NOT STARTED. |
| 2026-10-18 | — | **US-D28 APPROVED with conditions, as an amended design contract (owner decision).** <ul><li>**Decision:** the owner approved US-D28 with amendments (§16.5.11). The review's narrow Option C was not approved verbatim.</li><li>**The contract, in brief:**<ul><li>absolute, CLI-resolved, validated work-folder paths, under the unchanged restrictions;</li><li>no automatic inline fallback;</li><li>a reliably reported denial is shown, and a clean exit is not proof that the inputs were read;</li><li>a separately identified, developer-initiated Partial Review of at most 2,400 characters of `fix_report.md`, never automatic and never presented as a full review;</li><li>no inferred denials;</li><li>the prompt gate is retained;</li><li>auto-memory is disclosed as a residual risk;</li><li>network roots are not guaranteed;</li><li>prompt, tool and review text is untrusted data.</li></ul></li><li>**Register:** US-D28 moved from OPEN to **APPROVED** — with conditions. Its Decision cell now states the contract; it previously read "Captured review reads external files through the bare `Read` allow; otherwise the fix-report excerpt goes inline". No other decision changed.</li><li>**Also updated:** the counts, §9.5 point 5 and §9.6 (the automatic inline fallback is withdrawn), §14.0, §14.3, RK-18, and a dated note under the P2 record.</li><li>**Gates:** §16.5.11's seven activation gates, plus §14.3 and §9.10.</li></ul> This is a design approval only: nothing was implemented or activated. P2 stays FAIL; P7 PASS and P10 PASS are unchanged. Batch 0B is not complete, and Batch 2B-2 onward has NOT STARTED. |
| 2026-10-18 | — | **US-D14 APPROVED with conditions, as Refined Option A′ with two amendments (owner decision).** <ul><li>**Decision:** the protected rule `stage-intended-files-only` stays unchanged: rules v2, `VERSION_2_SHA256`, no v3, `protected_rules.py` untouched. A separate informational note about the legacy `.ai/`, `.ai_memory/` and `.bugpilot/` folders goes near `task.md`'s Execution Location and the retry prompt's Required Reading. It is not a staging rule and not enforcement (§16.4.1).</li><li>**Amendments:** US-D16 stays OPEN and independent, and the 0.1.5 "Add to .gitignore" feature is not removed by this. The staging-safety requirements are kept, and BugPilot adds no staging, commit, hook, cleanup or automatic `.gitignore` edit.</li><li>**Register:** US-D14 moved from OPEN to **APPROVED** — with conditions. Its Decision cell now states the contract; it previously read "Protected rule `stage-intended-files-only`". No other decision changed.</li><li>**Corrections** to §16.4's review, marked in place (§16.4.2):<ul><li>titles are not in agent task text;</li><li>B reaches beyond the 17 task goldens;</li><li>the retry prompt needs the note;</li><li>`.bugpilot/` is legacy too under R4.</li></ul></li><li>**Also updated:** the counts (13 APPROVED, 11 OPEN), §14.0, §14.1.B's gate note, §14.3, and RK-18.</li></ul> This is a design approval only: nothing was implemented. Batch 0B is not complete; Batch 2B-2 onward NOT STARTED. |
| 2026-10-18 | — | **US-D13 APPROVED with conditions, as the hybrid task-document contract with three amendments (owner decision).** <ul><li>**Contract:** the canonical, CLI-resolved work folder is stated absolutely in `task.md`'s Execution Location and the retry prompt's Required Reading. Other files are named relative to it, and the report destination is absolute, with §9.6's sentence. US-D14's note appears in both documents, unchanged. The cwd stays the repository, and nothing falls back to `.ai/` (§9.8.1).</li><li>**Amendments:**<ul><li>the absolute-path counts (two and three) are template observations;</li><li>rendering validation is uniform across root sources and non-destructive, with errors that don't leak private paths;</li><li>implementation waits for US-D30 and for separate golden and ratchet approvals.</li></ul></li><li>**Register:** US-D13 moved from PROPOSED to **APPROVED** — with conditions. Its Decision cell now states the contract; it previously read "`task.md` names the work folder once (Execution Location) and the report path absolutely; other files by name; the §9.6 sentence in Required Output Files". No other decision changed.</li><li>**Reconciled:**<ul><li>§8.8's stored-artifact rule (generated agent-facing documents vs persisted display and log fields; US-D22 stays PROPOSED);</li><li>§9.8's retry path count and rendering;</li><li>§11.6's omitted retry lines and canonical normalization.</li></ul></li><li>**Recorded:** the review's preliminary token estimates (median about 3,200 with the note, threshold 3,096; estimates only).</li></ul> This is a design approval only: nothing was implemented. US-D10, US-D26, US-D29 and US-D30 are unchanged. Batch 0B is not complete, and Batch 2B-2 onward has NOT STARTED. |
| 2026-10-18 | — | **US-D30 APPROVED with conditions, as Option D with amendments (owner decision).** <ul><li>**Contract:** the 17-case matrix, `round(chars / 4)` and the 0.1.3 reference (3,870, ceiling 3,096) stay. The task gate becomes `median(normalized) ≤ 3,096 + A`, with an approved delta recorded for every golden against the frozen 0.1.5 size. Retry prompts get per-golden deltas under a separate A_retry, with no median gate and no shared allowance (§9.8.2).</li><li>**Allowances:** A (estimate about 116) and A_retry (estimate about 108) are not final. They are fixed only from the owner-approved golden diff, after US-D13's final text, US-D14's exact note, US-D10's retry wording and any US-D22 wording, and are never recomputed.</li><li>**Baselines:** the 0.1.3 and Batch 0A records (including `task_size.json`) and the frozen 0.1.4 goldens stay byte-identical. A new reviewed budget record holds the numbers, and the compared-record test is reconciled without weakening integrity.</li><li>**Reporting:** sizes with the golden, Windows, Linux/macOS and long paths are reported, not gated. No runtime path limit.</li><li>**Register:** US-D30 moved from OPEN to **APPROVED** — with conditions. Its Decision cell now states the contract; it previously read "The task-size gate with an absolute work path". No other decision changed.</li></ul> This is a design approval only: no golden change or ratchet residue is approved, and nothing is implemented. Batch 0B is not complete; Batch 2B-2 onward NOT STARTED. |
| 2026-10-18 | — | **US-D10 APPROVED with conditions, as Option D with amendments; probe gap accepted for design only (owner decision).** <ul><li>**Contract:** the agent starts in the repository root and is told `Read <WORK>/task.md and complete the workflow.`; the retry is `Read <WORK>/agent_retry_prompt.md and continue the workflow.`. `<WORK>` is CLI-resolved (US-D13, US-D17) with forward slashes, and the wording is the same across the CLI, the extension and the retry prompt. MCP follows US-D27 (§9.5.1).</li><li>**Kept:** no new permission mode, grant, sandbox bypass, shell-free launch or automatic Git. US-D12's gate is kept, and US-D12 stays PROPOSED.</li><li>**Fallback and guidance:** a refused, unlaunchable or bridge handoff uses the clipboard, with an accurate notice. The approved permission guidance is "Your AI agent may need permission …". No denial is inferred without a reliable signal.</li><li>**Evidence:** the owner accepts the Batch 0B real-agent gap (P1, P3–P6, P8, P9) for design only, recorded in §16.1 "Accepted evidence gaps". The historical results are unchanged: P7 and P10 PASS, P2 FAIL overall, P11 NOT EXECUTED.</li><li>**Register:** US-D10 moved from OPEN to **APPROVED** — with conditions. Its Decision cell now states the contract; it previously read "Agent handoff: Option D (absolute path, the agent's own permissions, clipboard fallback, no automatic grant)". No other decision changed.</li></ul> This is a design approval only: no agent combination is supported, and nothing is implemented. Batch 0B is not complete; Batch 2B-2 onward NOT STARTED. |
| 2026-10-18 | — | **US-D12 APPROVED with conditions, as Option C with two amendments (owner decision).** <ul><li>**Contract:** the gate's character set is kept and never broadened. Its treatment of Unicode whitespace, leading and trailing whitespace and normalization is tightened before activation, and the complete prompt is validated (§9.9.1).</li><li>**Amendments:**<ul><li>exact prompt preservation: the generated prompt and the final argument are both validated, a path is never rewritten, and the handoff is refused if preservation can't be guaranteed;</li><li>TypeScript–Python parity: Python's `--launch-agent` gets an equivalent gate, with one shared, reviewed corpus.</li></ul></li><li>**Scope:** the gate stays on the terminal paths, the bridges and the captured review (US-D28); there is none on MCP JSON, Copy Handoff Prompt or the body of `task.md`. A bridge refusal copies and notifies only.</li><li>**Documentation:** §13.4's character list is corrected (colon, comma, hash), and the compatibility limitation is recorded.</li><li>**Register:** US-D12 moved from PROPOSED to **APPROVED** — with conditions. Its Decision cell now states the contract; it previously read "The prompt gate stays unchanged; a refused prompt falls back to manual handoff, with `BUGPILOT_HOME` as the remedy". No other decision changed.</li></ul> This is a design approval only: no relaxation, and nothing implemented. P10 stays PASS for the tested Windows configuration only, and P11 stays NOT EXECUTED. Batch 2B-2 onward NOT STARTED. |
| 2026-10-18 | — | **US-D17 APPROVED with conditions, as Option B with five clarifications and two security amendments (owner decision).** <ul><li>**Contract:** `storage.py` is the authoritative Python resolver. The extension takes base paths only from the frozen CLI fields (`doctor` `storage.repository_dir`; item `work_dir`, `issue_dir` and `agent_task`; `list` `work_items[].work_dir` and `.modified`; settings `show --json` `path`). It composes only fixed artifact names under a validated `work_dir`, and `<repository_dir>/work/<id>` for a validated id, through one helper with a shared fixture (§8.9.1).</li><li>**Amendments:**<ul><li>A: CLI paths are validated before use (field and type, `abs` syntax and kind, component-wise containment, links refused). An inconsistent path fails closed, the cache is invalidated and the path re-resolved.</li><li>B: the extension only reads storage. It never creates, overwrites, deletes, moves or re-permissions storage. Feedback goes through the CLI (US-D18), and Reset Session through `bugpilot clean`.</li></ul></li><li>**Kept:** History from `list --json` with no scan, settings from `show --json` `path`, watchers as hints only, and `state: error` composing, reading and watching nothing. No legacy fallback, no new JSON field, and the frozen contract unchanged.</li><li>**Register:** US-D17 moved from PROPOSED to **APPROVED** — with conditions. Its Decision cell now states the contract; it previously read "The CLI is the only resolver. The extension gets `repository_dir` and `work_dir` from the CLI, composes only validated ids below them, and reads, opens and watches there, but never writes or deletes.". No other decision changed.</li></ul> This is a design approval only: nothing implemented. P7 stays PASS for the tested Windows operations only, and `revealFileInOS` stays UNKNOWN. Batch 2B-2 onward NOT STARTED. |
| 2026-10-18/19 | 2B-1 | **Batch 2B-1 follow-up: the race in creating the data root fixed on a verification branch (not on `main`; no CI run).** <ul><li>**Trigger:** main CI run 39194849242 on `7a2a1f4` FAILED, with 8/9 jobs passing. `Full Python suite (ubuntu-latest)` failed the two-process namespace test with `StorageError: BugPilot cannot use BUGPILOT_HOME as its data folder: it is not a folder.` (`storage.py:480`, from `ensure()`), recovered by the owner from the job log.</li><li>**Cause:** a check-then-check race (TOCTOU) in `_ensure_root`. The `isdir` look found no root, another process created it, then the `lexists` look refused that real folder.</li><li>**Change:** the `lexists` pre-check is removed and a comment added. What is at the name is judged only after the `mkdir` attempt, by the existing `FileExistsError` re-check.</li><li>**Evidence:** three deterministic race tests failed before and pass after. Five tests on the root's name were added. Targeted storage suites: 459 passed, 21 skipped. The first full-suite run failed one CLI test because of a relative `PYTHONPATH`; the corrected run is recorded in the follow-up section.</li><li>**Commit:** on `verify/0.1.6-batch2b1-root-race`.</li></ul> CI run 39194849242 stays FAILED. No decision changed. Batch 2B-2 onward NOT STARTED. |
| 2026-10-19 | 2B-1 | **Batch 2B-1 follow-up integrated and CI-verified; Batch 2B-1 COMPLETED; NOT activated.** <ul><li>**Branch CI:** run 39285763641 (`workflow_dispatch`, owner-authorized, dispatched once) on `147e1bd`: 9/9 success. On Linux and macOS all eight new tests ran (+8 passed). On Windows seven ran, and the two POSIX-only tests were skipped as designed.</li><li>**Integration:** owner-approved fast-forward of `main`, `7a2a1f4..147e1bd`. It is the exact verified commit, with no merge commit, amendment or rewrite.</li><li>**Main CI:** run 39305575297 (push) on `147e1bd`: 9/9 success, with the same counts as the branch run.</li><li>**Still open:**<ul><li>the raw `PermissionError` from `_ensure_root`, which belongs with US-D26;</li><li>§14.3's activation gates;</li><li>the six design decisions' conditions;</li><li>the 2B-5 MCP scope gate;</li><li>Batch 0B.</li></ul></li></ul> No decision changed. Batch 2B-2 to 2B-6 NOT STARTED. |
| 2026-10-19 | 2B-2 | **Batch 2B-2 decision gate recorded and the slice specified; nothing implemented or activated (owner decision; plan only).** <ul><li>**D-1 to D-9:** design directions, subject to detailed contract verification.<ul><li>US-D2 APPROVED with conditions;</li><li>US-D29 and US-D22 APPROVED in part;</li><li>US-D3's warning direction set (its text is Q-4; `legacy_config_dir_variable` deferred);</li><li>US-D26's `STORAGE_UNAVAILABLE` stays OPEN.</li></ul></li><li>**Specified:** the scope, the allowlist (base, and a proposed expansion), the per-module changes, the MCP per-call scope, the error mapping, the designed-difference check, the import allowlist, the test matrix, the test-suite findings, the compatibility changes, exclusions, stop conditions and acceptance (§14.3, "Batch 2B-2 — decision gate").</li><li>**Conflicts recorded, not resolved:**<ul><li>blocker 5;</li><li>§8.6 against the frozen contract's generic code;</li><li>§14.3's batch-wide preconditions;</li><li>§14.3 step 3 against G-3.</li></ul></li><li>**Open questions:** Q-1 to Q-6.</li><li>**Counts:** 21 APPROVED, 7 OPEN, 7 PROPOSED, 4 DEFERRED.</li></ul> No branch was created, no test was run, and nothing was committed, pushed or dispatched. Batch 2B-2 to 2B-6 NOT STARTED. |
| 2026-10-19 | 2B-2 | **Batch 2B-2 final contract resolution recorded; nothing implemented or activated (owner answers; plan only).** <ul><li>**Answers:**<ul><li>Q-1 approved in principle (an internal classification, with no new code);</li><li>Q-2 needed reconciliation, which is now presented;</li><li>Q-3 approved with conditions (per slice; the activation gates stay; missing evidence is never a pass);</li><li>Q-4 approved (the warning's text);</li><li>Q-5 approved as scope only;</li><li>Q-6 approved with conditions.</li></ul></li><li>**Reconciled:** the frozen rule that `StorageError` reports `INVALID_INPUT` (§8.10, the fixture) holds. The recommended M-1 keeps every 2B-2 surface's 0.1.5 code, through an `OSError`-family carrier in `errors.py`.</li><li>**Corrected in the gate's specification:**<ul><li>the error mapping;</li><li>the rule for reading user instructions;</li><li>a third designed difference (`handoff.json`);</li><li>the generator's per-session data root;</li><li>`jira.py`'s message (C-3).</li></ul></li><li>**Specified:** the MCP request-scope contract, the designed-difference check and approval procedure, and the per-slice prerequisites.</li><li>**Open:** C-1 to C-5.</li></ul> No register status changed (§14.3, "Batch 2B-2 — final contract resolution"). Nothing was branched, committed, pushed, dispatched or run. Batch 2B-2 to 2B-6 NOT STARTED. |
| 2026-10-19 | 2B-2 | **C-1 to C-5 approved: the Batch 2B-2 design and implementation contract approved; implementation NOT STARTED (owner decision; plan only).** <ul><li>**C-1:** M-1. Existing public error codes are preserved, through `errors.StorageAccessError(OSError)`. US-D26's `STORAGE_UNAVAILABLE` stays OPEN.</li><li>**C-2:** (a). Storage's link refusal for the user scope stands, as `INVALID_INPUT`.</li><li>**C-3:** (a). Only the Jira not-configured message changes, to `~/.bugpilot/config/config.toml`.</li><li>**C-4:** approved with conditions. DD-1 to DD-3 are approved as expected categories, and their exact values and evidence are reviewed before the implementation commit.</li><li>**C-5:** (a). This record goes to `main` as a documentation-only commit. The branch is created from the resulting verified commit, only when authorized.</li><li>**Unchanged:**<ul><li>Batch 2B-1 is COMPLETED, NOT ACTIVATED;</li><li>Batch 0B and all activation gates stay mandatory;</li><li>no register status changed;</li><li>the version is 0.1.5.</li></ul></li></ul> (§14.3, "Batch 2B-2 — final contract resolution", "Owner approval of C-1 to C-5"). Batch 2B-2 to 2B-6 NOT STARTED. |

---

## 19. Commit and CI verification log

| Date | Batch | Branch | Commit | CI run | Result | Notes |
| --- | --- | --- | --- | --- | --- | --- |
| — | — | — | — | — | — | nothing committed for 0.1.6 yet; the starting point is `main` at `ee3fb00` (0.1.5) |
| 2026-10-16 | 0A | `main` (working tree) | **none**: nothing staged or committed | **none**: no CI run dispatched | — | Batch 0A awaits the owner's review. Commit and CI need the owner's separate authorization; the first CI run will also be the first POSIX, macOS and Python 3.10 run of the new tests. |
| 2026-10-16 | 0A | `main` (working tree) | **none**: nothing staged or committed | **none**: no CI run dispatched | — | After the pre-commit review's remediation (H-1, M-1, M-2), still uncommitted. The commit set now also includes `tests/test_cli_json.py` and `tests/test_mcp_stdio.py`. Commit, push and CI each still need the owner's separate authorization. |
| 2026-10-16 | 0A | `main` (working tree) | **none**: nothing staged or committed | **none**: no CI run dispatched | — | After the final security remediation (N-1, L-1, L-2, L-3, L-8), still uncommitted. The commit allowlist is the same 26 files, to be staged explicitly: `git add -A` would also take `.bugpilot/`, `.vscode/extensions.json` and the historical plan. Commit, push and CI each still need the owner's separate authorization. |
| 2026-10-16 | 0A | `main` | **the commit that carries this row**: the 26-file Batch 0A allowlist, owner-approved. A commit cannot hold its own SHA, so a later documentation commit records it. | **PENDING**: the push to `main` triggers `ci.yml` (the 9 required checks) | — | The owner approved the commit, the push and one CI run. Nothing published, tagged or bumped. Batch 0B and Batch 1 NOT STARTED. |
| 2026-10-16 | 0A | `main` | `8b6c567a074e4ddef6490ccc837e817cf7f48866` (fast-forward `ee3fb00..8b6c567`) | 38942462918 (`CI`, push) | **success: 9/9** | Full suite: Ubuntu 3,264, macOS 3,266, Windows 3,255 passed. Safety and baselines green on Ubuntu 3.13 and 3.10, macOS 3.13 and Windows 3.13. Extension 2,348 passed; evidence boundary 27. No new findings. Batch 0A COMPLETED. The previous row's PENDING is resolved here. |
| 2026-10-16 | 1 | `main` (working tree) | **none**: nothing staged or committed | **none**: no CI run dispatched | — | Batch 1 is implemented and awaits the owner's review, which includes its prerequisite decisions and the §8.10 fixture. Commit, push and CI each need the owner's separate authorization. The first CI run will be the first Linux, macOS and Python 3.10 run of the storage suites, and will record their timing. |
| 2026-10-16 | 1 | `main` (working tree) | **none**: nothing staged or committed | **none**: no CI run dispatched | — | After the architecture review (FAIL) and its narrow remediation, still uncommitted and pending the owner's approval. Commit, push and CI each still need the owner's separate authorization. The first CI run will also be the first run of the Windows access-list test on 3.13. |
| 2026-10-16 | 1 | `main` (working tree) | **none**: nothing staged or committed | **none**: no CI run dispatched | — | After the owner's decision gate, still uncommitted. The commit allowlist is eight files: `bugpilot/core/storage.py`, `bugpilot/core/safe_paths.py`, `tests/test_storage_identity.py`, `tests/test_storage_safety.py`, `tests/fixtures/storage_cli_contract.json`, `tests/storage_inventory.json`, `.github/workflows/ci.yml` and this plan. The historical plan, `.bugpilot/`, `.ai/`, `.ai_memory/` and `.vscode/extensions.json` are excluded. The commit, push and CI run each need a separate authorization. |
| 2026-10-16 | 1 | `verify/0.1.6-batch1` | `5222da79de4dc72335b4e17be15038cf5cf08163` (the eight-file allowlist; parent `64056ca`) | 39003264436 (`CI`, `workflow_dispatch` by the owner) | **success: 9/9** | Full suite: Ubuntu 3,480, macOS 3,482, Windows 3,485 passed. Safety and baselines green on Ubuntu 3.13 and 3.10, macOS 3.13 and Windows 3.13. Extension 2,348 passed; evidence boundary 27. The previous row's "none" is resolved here. |
| 2026-10-16 | 1 | `main` | `5222da79de4dc72335b4e17be15038cf5cf08163` (fast-forward `64056ca..5222da7`, no merge commit) | 39004684594 (`CI`, push) | **success: 9/9** | Batch 1 COMPLETED and integrated, NOT activated. Version 0.1.5. |
| 2026-10-16 | 1 | `main` | **the commit that carries this row**: this plan only (`docs: record BugPilot 0.1.6 Batch 1 CI acceptance`). A commit cannot hold its own SHA. | **PENDING**: its push to `main` starts `ci.yml` | — | Documentation only. Its run is recorded by a later documentation change. |
| 2026-10-17 | 1 | `main` | `6f8e0b2` (the documentation closure) | 39005917365 (`CI`, push) | **success: 9/9** | Observed after the push; the previous row's PENDING is resolved here. |
| 2026-10-17 | 2A | `main` (working tree) | **none**: nothing staged or committed | **none**: no CI run dispatched | — | Batch 2A is implemented and verified locally, awaiting the owner's review. Its commit, push and CI run each need a separate authorization; a verification branch is recommended. |
| 2026-10-17 | 2A | `verify/0.1.6-batch2a` | `e78a6789fe5dcc4144bc6e21b5427e552bc0bb5b` (the eight-file allowlist; parent `6f8e0b2`) | 39057483843 (`CI`, `workflow_dispatch` by the owner) | **success: 9/9** | Full suite: Ubuntu 3,577, macOS 3,579, Windows 3,594 passed. Safety and baselines green on Ubuntu 3.13 and 3.10, macOS 3.13 and Windows 3.13. Extension 2,348; evidence boundary 27. The previous row's "none" is resolved here. |
| 2026-10-17 | 2A | `main` | `e78a6789fe5dcc4144bc6e21b5427e552bc0bb5b` (fast-forward `6f8e0b2..e78a678`, no merge commit) | 39062906366 (`CI`, push) | **success: 9/9** | Batch 2A COMPLETED and integrated, NOT activated. Version 0.1.5. |
| 2026-10-17 | 2A | `main` | **the commit that carries this row**: this plan only (`docs: record BugPilot 0.1.6 Batch 2A CI acceptance`). A commit cannot hold its own SHA. | **PENDING**: its push to `main` starts `ci.yml` | — | Documentation only. Its run is reported to the owner, not recorded by another documentation commit. |
| 2026-10-17 | 2A | `main` | `3f8be69d671c8ff5192120cd6989685477aa182a` (the documentation closure) | 39064298339 (`CI`, push) | **success: 9/9** | Observed after the push; the previous row's PENDING is resolved here. Recorded by the Batch 2B-1 plan update (uncommitted). |
| 2026-10-17 | 2B-1 | `main` (working tree) | **none**: nothing staged or committed | **none**: no CI run dispatched | — | Batch 2B-1 is implemented and verified locally on Windows, awaiting the owner's review. Commit, push and CI each need a separate authorization; a verification branch with an owner-dispatched run is recommended, as for Batches 1 and 2A. |
| 2026-10-17 | 2B-1 | `verify/0.1.6-batch2b1` | `7b8914d20decff215c9aa4160dfc4b4f01ccddf3` (the eight-file allowlist; parent `3f8be69`) | 39085417171 (`CI`, `workflow_dispatch` by the owner) | **failure: 3/9** | Green: extension evidence boundary (27), extension unit tests (2,348), full suite on Windows (3,682). Red: the four safety jobs and the Linux and macOS full suites, one test each. F-1, POSIX: `test_storage_writes_its_own_files_through_public_methods` (the witness on `os.fchmod`). F-2, Windows safety: `test_a_removal_can_never_fall_between_a_lookup_and_its_reordering` (an elapsed-time assertion). `origin/main` unchanged. |
| 2026-10-17 | 2B-1 | `verify/0.1.6-batch2b1` (working tree) | **none**: the remediation is uncommitted | **none**: no new run dispatched | — | The remediation changes `tests/_storage_witness.py`, `tests/test_storage_witness.py`, `tests/test_storage_identity.py` and this plan, and is verified locally on Windows. Its commit, push and CI run each need the owner's authorization. |
| 2026-10-17 | 2B-1 | `verify/0.1.6-batch2b1` | `40865cffbf7cc1fc44bd4ad220d82108ffafabf7` (the four-file remediation; parent `7b8914d`) | 39096347226 (`CI`, `workflow_dispatch` by the owner) | **success: 9/9** | Full suite: Ubuntu 3,674, macOS 3,676, Windows 3,695 passed. Safety and baselines green on Ubuntu 3.13 and 3.10, macOS 3.13 and Windows 3.13. Extension 2,348; evidence boundary 27. The previous row's remediation is committed here. |
| 2026-10-17 | 2B-1 | `main` | `40865cffbf7cc1fc44bd4ad220d82108ffafabf7` (fast-forward `3f8be69..40865cf`: `7b8914d` and `40865cf`, no merge commit) | 39097757625 (`CI`, push) | **success: 9/9** | The same counts as run 39096347226. Batch 2B-1 COMPLETED and integrated, NOT activated. Version 0.1.5. |
| 2026-10-17 | 2B-1 | `main` | **the commit that carries this row**: this plan only (`docs: record BugPilot 0.1.6 Batch 2B-1 CI acceptance`). A commit cannot hold its own SHA. | **PENDING**: its push to `main` starts `ci.yml` | — | Documentation only. Its run is reported to the owner, not recorded by another documentation commit. |
| 2026-10-18 | 0B, US-D28 | `main` | `1bbf7795a1977378ff0ca52e9a215ebde85507f9` (`docs: record Batch 0B probes and US-D28 decision`; parent `1b1a310`) | 39178885275 (`CI`, push) | **success: 9/9** | documentation only |
| 2026-10-18 | US-D10/12/13/14/17/30 | `main` | `7a2a1f4863119e2dace915b4ced104fe9d2466d0` (`docs: record six Unified Storage design decisions`; parent `1bbf779`) | 39194849242 (`CI`, push) | **failure: 8/9** | `Full Python suite (ubuntu-latest)` failed the two-process namespace test: a race in creating the data root in `_ensure_root` (Batch 2B-1 follow-up). The commit itself was documentation only. |
| 2026-10-19 | 2B-1 follow-up | `verify/0.1.6-batch2b1-root-race` | **the commit that carries this row** (`fix(storage): handle concurrent data-root creation`; parent `7a2a1f4`) | **none**: the workflow runs only for `main` (push or pull request) or a manual dispatch | — | Branch CI, a pull request and integration each need the owner's authorization. |
| 2026-10-19 | 2B-1 follow-up | `verify/0.1.6-batch2b1-root-race` | `147e1bda1b37637562bbc12d11f0d79cc2035774` (parent `7a2a1f4`) | 39285763641 (`CI`, `workflow_dispatch`, owner-authorized) | **success: 9/9** | Linux and macOS +8 passed, +0 skipped; Windows +7 passed, +2 skipped (the POSIX-only tests) |
| 2026-10-19 | 2B-1 follow-up | `main` | `147e1bda1b37637562bbc12d11f0d79cc2035774` (fast-forward `7a2a1f4..147e1bd`, no merge commit) | 39305575297 (`CI`, push) | **success: 9/9** | Batch 2B-1 with its follow-up COMPLETED; not activated |
| 2026-10-19 | 2B-1 follow-up | `main` | **the commit that carries this row**: this plan only (`docs: record Batch 2B-1 data-root race fix integration`) | — | — | documentation only |
| 2026-10-19 | 2B-2 decision gate | `main` | recorded in the approval commit below | — | — | documentation only; nothing implemented, pushed or dispatched |
| 2026-10-19 | 2B-2 final contract resolution | `main` | recorded in the approval commit below | — | — | documentation only; nothing implemented, pushed or dispatched |
| 2026-10-19 | 2B-2 approvals (C-1 to C-5) | `main` | **the commit that carries this row**: this plan only (`docs: approve Batch 2B-2 design and implementation contract`), parent `73ee57e` | — (not pushed; no CI run) | — | documentation only; the branch not created; implementation NOT STARTED |

---

## 20. Final release-readiness checklist

To be completed in Batch 5. Every box needs evidence: a command and its output, a CI run, or a §18 probe or end-to-end record.

**Product**

- [ ] R1–R8 acceptance (§17), each with its evidence.
- [ ] Every decision in §16.1 is APPROVED or DEFERRED by the owner, with the date recorded. None is still OPEN or PROPOSED, and none was promoted from a review recommendation without the owner's word.
- [ ] The ratchet holds only the approved residue.
- [ ] The pollution and no-legacy-data suites are green on three systems.

**Security**

- [ ] §10.2 is tested per OS.
- [ ] The mutation check catches every control.
- [ ] There is no Critical or High finding.
- [ ] The final pre-commit security review is recorded.
- [ ] The privacy review of CLI and MCP output is done on the candidates.
- [ ] The `docs/safety.md` claims match behaviour, including the documented prompt-gate limitation (§9.9).

**Quality gates**

- [ ] The full Python suite is green (Windows locally; Linux, macOS and Windows in CI; Ubuntu 3.10).
- [ ] The test-isolation guard demonstration (§11.1) is green on every CI configuration.
- [ ] The extension typecheck and unit tests pass.
- [ ] The required TypeScript job passes.
- [ ] The integration suite passes locally, isolated through the spawn helper.
- [ ] The expected-failure ledger of §15.4 is empty and closed.
- [ ] All nine required CI checks are green on `main` at the release commit.
- [ ] The goldens differ only as §11.6 lists (scripted).
- [ ] The protected rules are as US-D14 decided (§16.4).
- [ ] Each rule appears once.
- [ ] Recall@5 9/9, MRR 0.944, Context Quality unchanged; both oracles report 0 escapes.
- [ ] The task-size measures of US-D30 hold.
- [ ] The §12 budgets are met.
- [ ] Publishability passes.
- [ ] `git diff --check` is clean.

**Real use**

- [ ] The real VS Code pass (four themes, three widths) covers the changed UI and every workflow in §11.5.
- [ ] The owner has listed the supported agent and provider combinations (§9.10).
- [ ] Every applicable aspect A1–A9 is **PASS** for each listed combination, from real interactive end-to-end runs on the candidates.
  - Each result is recorded in §18 with agent, version, OS, sandbox mode, outcome and evidence.
  - FALLBACK and UNKNOWN are not PASS.
  - Any combination that is not PASS is fixed, or named in the release notes as unsupported or limited.
- [ ] Every account-using run had its own owner approval.
- [ ] Clean installs pass: pipx; a wheel in a new venv; the managed runtime offline and from PyPI.
- [ ] A machine with 0.1.5 data present: those files are untouched, and 0.1.6 starts empty, as §13 explains.

**Docs and release**

- [ ] §13 is in the changelog, the README files and `docs/safety.md`, and the owner has reviewed it.
- [ ] Packaging contents have been inspected (wheel, sdist, VSIX).
- [ ] The version is bumped from 0.1.5 to 0.1.6 in lockstep, only after the release review and with the owner's approval.
- [ ] Nothing was pushed, fast-forwarded or published without the owner's approval at that moment.
- [ ] PyPI publishing goes through the protected release workflow; Marketplace publishing is done by the owner.
- [ ] §14.0, §18 and §19 are complete.
