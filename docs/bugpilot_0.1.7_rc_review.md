# BugPilot 0.1.7 — Release-Candidate Review

| | |
|---|---|
| **Reviewed commit** | `d05c0253943785b328fa12a280c34bef3b1554e5` (branch `verify/0.1.7-storage`), tree `0b80a3d05b693756612d61d554c12249d6b513af` |
| **Date** | 2026-10-29 |
| **Kind of review** | Release-candidate review, verification and documentation only. Nothing was changed in the product, staged, committed, pushed, merged, tagged, published or released. |
| **Technical classification** | **RC BLOCKED**: documentation defects in the shipped READMEs, and owner-only acceptance not done (§12, §14). *(Later on 2026-10-29: the owner's remediation batch — D-1 to D-6, S-1, S-2, U-1, ST-1, ST-2 — is fixed locally and verified on Windows, uncommitted (§15). Still **RC BLOCKED** until a corrected candidate commit passes cross-platform CI and its follow-up review.)* *(Later: the conditional commit approval's checks stopped on a new finding, S-8: no commit; a new owner decision is needed (§16).)* *(Later: the owner decided to fix S-8 in this commit; it is fixed, every condition is met, and the remediation is committed with this record and pushed for cross-platform CI (§17). Still **RC BLOCKED** until all nine CI jobs pass and the follow-up review is complete.)* |
| **Public-distribution authorization** | **UNRESOLVED**: release-governance decisions are the owner's (§13) |

This is an internal review by the developer's AI assistant. It is **not** an independent or external security audit, and no such audit has taken place.

## 1. Executive summary

**Technically, the candidate is in good shape.**
- **Cross-platform CI:** green, 9 of 9, on the exact reviewed commit.
- **Clean installs:** the artifacts, built from a clean export of that commit, all identify themselves as 0.1.7. They install cleanly:
  - the CLI from the wheel;
  - the MCP server from `bugpilot[mcp]`;
  - the VSIX into a disposable VS Code;
  - the extension's managed runtime, offline from the candidate wheel.
- **Storage:**
  - The implementation matches the storage contract on all twelve points reviewed.
  - Nothing is written into the user's repository in any flow exercised.
  - The 0.1.6 `.ai/` and `.bugpilot/` folders are never read, changed or deleted.
- **Compatibility:**
  - `EXTENSION_OUTDATED` refuses a 0.1.6 extension's runs before anything is created.
  - The extension × CLI matrix passes.
- **Real Claude Code check:** the one-word `--add-dir=<work folder>` grant lets Claude write `fix_report.md` there; without it the write is denied.
- **Security:** the review found **no Critical, High or Medium issue**.

**Why the RC is blocked anyway:**
1. **The shipped documentation is wrong in places a user meets first.** The README (the PyPI page) and the extension README (the Marketplace page) are packaged in the candidate artifacts.
   - The README still says BugPilot "writes its files" in the repository.
   - Three documents tell users to expect `bugpilot 0.1.5` after installing 0.1.7, a release that requires matching extension and CLI versions.
   - The `--add-dir` behaviour is overstated, and the architecture document still presents the pre-0.1.7 layout and a retired variable as current.

   These need a documentation commit, and therefore a new candidate tree and CI run (§10, §12).
2. **The owner must still run acceptance checks this environment cannot do:**
   - Fix with AI typed into a real terminal (no terminal host can start in this sandbox);
   - the webview's buttons and forms;
   - the agent and provider combinations the plan's release checklist requires (§9, §11).

**Low-severity items, recommended before release:**
- **S-1:** the Python launcher lacks the plain-prompt gate the threat model lists for it (T-S12).
- **U-1:** found in the real window. A Verification Policy edit saved while a policy reread is in flight is not reread, so the settings row stays stale until the next refresh.
- **ST-1, ST-2:** small storage hygiene items.

**Public distribution** is a separate, owner-only decision. The canonical plan records no explicit resolution of ownership or employment-policy questions, nor a qualified review of the 0.1.7 licence parameters (§13).

## 2. Exact reviewed commit and tree

| Item | Value | Verified by |
|---|---|---|
| Branch | `verify/0.1.7-storage` | `git branch --show-current` |
| HEAD | `d05c0253943785b328fa12a280c34bef3b1554e5` (parent `59db0b4`) | `git rev-parse HEAD` |
| Tree | `0b80a3d05b693756612d61d554c12249d6b513af` | `git rev-parse HEAD^{tree}` |
| Origin's branch | `d05c025`, the same commit | `git ls-remote origin` |
| Origin's `main` | `7feeaf7`, untouched | `git ls-remote origin` |
| Tags on origin; GitHub releases | none; none | `git ls-remote --tags`; the public API |
| Working tree | the reviewed commit, plus an uncommitted post-CI record in the canonical plan and the owner's three unrelated paths (not opened) | `git status` |
| Approved baselines | the 0.1.7 record holds U7-1 to U7-142 in order, every one `approved: 2026-10-29`. Since `59db0b4`, no file under `tests/baselines/`, `tests/golden/` or the baseline approval review changed. | the record, `git diff 59db0b4 d05c025` |
| The approval gate | passes (11 tests: approval, well-formedness, evidence, supersession) | `pytest tests/test_storage_baseline.py -k ...` |

## 3. CI evidence

CI run [40969753479](https://github.com/xsw7910/bugpilot/actions/runs/40969753479): `workflow_dispatch`, attempt 1, head `d05c025`, conclusion **success**. It was read through the public API: job conclusions and the jobs' own annotations.

| Job | Result | Change from the failed run on `59db0b4` (40936578232) |
|---|---|---|
| Full Python suite (ubuntu-latest) | success: 4,088 passed, 99 skipped | +1 passed (the new regression test) |
| Full Python suite (windows-latest) | success: 4,144 passed, 93 skipped | +1 passed |
| Full Python suite (macos-latest) | success: 4,092 passed, 95 skipped | **1 failed → 0 failed**; +2 passed |
| Safety and baselines (ubuntu-latest, Python 3.10) | success: 2,066 passed, 92 skipped | +1 passed |
| Safety and baselines (ubuntu-latest, Python 3.13) | success: 2,066 passed, 92 skipped | +1 passed |
| Safety and baselines (macos-latest, Python 3.13) | success: 2,070 passed, 88 skipped | +1 passed |
| Safety and baselines (windows-latest, Python 3.13) | success: 2,114 passed, 93 skipped | +1 passed |
| Extension unit tests (ubuntu-latest) | success: 2,373 passed, 2 skipped | unchanged |
| Extension evidence boundary (ubuntu-latest) | success: 27 passed | unchanged |

- No skip count changed, and the annotations are notices only.
- **Locally, on the same tree (Windows):**
  - Python: 4,147 passed, 91 skipped, 0 failed;
  - the extension: 2,374 passed, 1 skipped, 0 failed; typecheck clean.
- **CI scope:** CI ran on the verification branch, not on `main`. The release workflow refuses to build from anything but a CI-green `main` (`scripts/release_preflight.py`), so a release also needs the owner's merge and a green `main` run.

## 4. Release artifact verification

**How they were built.** From `git -c core.autocrlf=false archive d05c025`, 480 tracked files, exported to a scratch folder outside the repository:
- the wheel and sdist with `python -m build`;
- the VSIX with the release's own `npm run package` (build, then `check-package`, then `vsce package --no-dependencies`).

These are **candidate** builds for verification. The release workflow builds the PyPI files again on Linux, with pinned and hashed tools, so its hashes will differ.

| Artifact | Size (bytes) | SHA-256 | Members | Checks |
|---|---|---|---|---|
| `bugpilot-0.1.7-py3-none-any.whl` | 403,380 | `98c646ccf3a9286d45c90bac40ec8856ed9528fa3f65918e54745c22e72706bc` | 71 | `twine check --strict` PASSED |
| `bugpilot-0.1.7.tar.gz` | 376,057 | `bfa04e49e708daf9064e0561ce89bae82c5dfb948f039e0f69d165fd1effe319` | 77 | `twine check --strict` PASSED |
| `bugpilot-0.1.7.vsix` | 576,714 | `c64985aff96d9e03bd018346a61fb689030584ae6e92250d23af8d1d718116c2` | 89 | package check: all files current |

**Versions and metadata**

| Where | Value |
|---|---|
| Wheel `METADATA` / sdist `PKG-INFO` | `Version: 0.1.7`, `License-Expression: BUSL-1.1`, `Requires-Python: >=3.10`, no required dependencies; extras `test` (pytest, markdown-it-py) and `mcp` (`mcp>=2`); repository and issues URLs |
| `bugpilot/__init__.py` in the wheel | `__version__ = "0.1.7"` |
| Console scripts | `bugpilot = bugpilot.cli:main`, `bugpilot-mcp = bugpilot.mcp_server:main` |
| VSIX `package.json` / `extension.vsixmanifest` | version `0.1.7`, engines `vscode ^1.90.0`, `node >=22.18`, license `SEE LICENSE IN LICENSE.txt`, the repository URL |
| CLI | `bugpilot --version` and `python -m bugpilot --version`: `bugpilot 0.1.7` |
| MCP server | `initialize` answers `serverInfo {name: bugpilot, version: 0.1.7}` |
| `LICENSE`, `extension/LICENSE.txt` | Licensed Work "… Version 0.1.7."; the Change Date (2030-10-11), grant, Licensor and Change License as in 0.1.6 |

**Contents inspection.** Every text member was scanned with the repository's own publishability rules (`tests/test_publishable.py`: real names and the private word list, reported only as withheld). The scan also looked for credentials, e-mail addresses and local or user-specific paths:
- **No finding.** The one pattern hit is the README's generic example path under `/home/you/`.
- **No unwanted members:**
  - no tests or private word lists;
  - no `.bugpilot/`, `.ai/` or `.vscode/`;
  - no `node_modules`, `__pycache__`, source maps, logs, keys, or nested packages.
- **The sdist** holds the package, `LICENSE`, `README.md`, `MANIFEST.in`, `pyproject.toml` and `setup.cfg`.
- **The VSIX** holds the built `out/`, `media/` (the codicons font with its `ATTRIBUTION.md`), `THIRD_PARTY_NOTICES.md`, `LICENSE.txt`, the README and the changelog.

**Clean installs**

| # | What | Result |
|---|---|---|
| 1 | **CLI from the wheel**: new venv, `pip install --no-index` of the candidate wheel (installs exactly `bugpilot 0.1.7`, nothing else) | **PASS, 38 of 38** acceptance checks (below) |
| 2 | **MCP entry point**: new venv, `pip install "<wheel>[mcp]"` (`mcp 2.3.0` from PyPI) | **PASS, 11 of 11** |
| 3 | **VSIX** into a disposable VS Code (own profile, extensions folder and home; no BugPilot on `PATH`) | **PASS**: installs as 0.1.7 and activates |
| 4 | **Managed runtime**, offline: `PIP_NO_INDEX` and `PIP_FIND_LINKS` pointed at a folder holding only the candidate wheel | **PASS, 13 of 13**: Install Runtime finished in about 20 s, `runtime.json` records `bugpilot==0.1.7`, the runtime's CLI lists `unified-storage` |
| — | The managed runtime **from PyPI**, and a `pipx` install | **NOT TESTED**: 0.1.7 is not on PyPI before publication |

**The CLI acceptance (38 checks)** ran in an isolated home, data folder and synthetic repository, with the 0.1.6 legacy files planted untracked. It confirmed:
- **Versions:** the installed package is the one imported.
- **`doctor --json`:** version 0.1.7, the `unified-storage` capability, a canonical `BUGPILOT_HOME` data root, and nothing created.
- **Preparation:** a hand-written bug and a mock Jira item are both prepared under `<data>/repositories/<id>/work/`, and `task.md` names its work folder absolutely, never `.ai/`.
- **Commands:** eight read-only and settings commands answer, and the repository's legacy `.bugpilot/verification.md` is not read.
- **The `EXTENSION_OUTDATED` matrix:** see §7.
- **The Claude launcher's argument order:** see §6.
- **Repository untouched:** after everything, `git status` shows only the planted legacy files, which are unchanged, and there is no `.ai_memory/`.

**The MCP acceptance (11 checks).** Two sessions, one with a terminal's environment and one with an extension host's (`VSCODE_CRASH_REPORTER_PROCESS_TYPE=extensionHost`):
- **Basics:** `serverInfo` reports 0.1.7, and the nine tools are listed.
- **Preparation:** `prepare_bug_description` prepares a work item in the data folder, and `get_status` reads it back.
- **Missing Jira:** without credentials, `prepare_jira_bug` answers `JIRA_NOT_CONFIGURED` without crashing.
- **Extension-host environment:** it is not refused (the heuristic applies to the CLI's `doctor` and `bug` machine modes only).
- **Repository:** nothing is written into it.

## 5. Unified Storage assessment

An internal code-reading review compared the implementation with the canonical plan's contract. The 0.1.7 sections win where they differ from earlier ones, and the review says which it applied. Two of its findings were re-checked by hand (ST-1, ST-2). The end-to-end runs in §4 and §9 cover the observable behaviour.

| # | Contract point | Assessment | Key evidence |
|---|---|---|---|
| 1 | Data-root resolution and canonicalization | **MATCHES** | `storage.py` `data_root()` is a realpath. A blank `BUGPILOT_HOME` counts as unset; a non-absolute value or control characters are refused; a data root inside a Git working tree is refused. `test_storage_identity.py`, `test_storage_safety.py`. |
| 2 | Repository identity | **MATCHES** (§7.2 with the approved US-D5 refinements and F4) | `<slug>-<16 hex>` from the strict realpath, `normcase` on Windows, an identity record that is published and never replaced. `test_storage_identity.py`. |
| 3 | Global configuration | **MATCHES**: `config/` in the data root; nothing migrated from `~/.bugpilot/config.toml`, by design | `user_config.py`; `BUGPILOT_CONFIG_DIR` is retired, with one text-mode warning |
| 4 | Repository settings | **MATCHES**: `settings/` in the namespace, a closed set of names; the repository's `.bugpilot/` never read | `repository_settings.py`; the CLI and VS Code policy runs (§4, §9) |
| 5 | Work-item storage | **MATCHES**, except for the attachments folder's creation (ST-1) | `config.py` to `storage.py`; IDs validated before any path is built |
| 6 | Legacy `.ai/` behaviour | **MATCHES**: never read, migrated or deleted. What remains are search exclusions, the protected staging rule and text. | §4's planted-legacy checks; VS Code's legacy canaries (§9) |
| 7 | Path containment | **MATCHES**: by components, never by string prefix (Python and the extension) | `storage.py`, `safe_paths.py`, `workItemFiles.ts` |
| 8 | Symbolic links and junctions | **MATCHES**: writes check each folder before and after `mkdir`; files are refused if linked; reads use held folders or no-follow opens | `safe_paths.py`, `artifact_io.py`, `test_storage_held_read.py`, `test_write_boundaries.py` |
| 9 | Concurrent data-root creation | **MATCHES** | `storage.py` tolerates another creator; `test_storage_safety.py` |
| 10 | Safe reads and writes | **MATCHES** (replacement only of BugPilot's own files, as §8.3 keeps; the identity record never replaced) | `artifact_io.py`, `storage.py` |
| 11 | Failure handling | **MATCHES**: one sentence in display form; never a fallback to the repository (`DATA_FOLDER_UNKNOWN` in the extension) | `errors.py`, `config.py`, `dataFolder.ts` |
| 12 | No writes inside the user's repository | **MATCHES in behaviour**; the baseline's command list is narrower than the product (ST-7) | `pollution` baseline (22 commands); §4 and §9 end-to-end |

**The approved baselines.** The 142 U7 differences are unchanged. Each is approved, with evidence that names a test that exists, and both supersession pairs (DD-5 → U7-10, DD-9 → U7-12) are active. Every compared baseline matches today's behaviour on Linux, macOS and Windows (CI above), after the macOS normalizer fix. No golden or approved value was regenerated or altered for this review.

**Storage findings** (none is a write into the repository or a fallback to `.ai/`):

| ID | Severity | Finding | Impact | Smallest remediation |
|---|---|---|---|---|
| ST-1 | Low | `attachments.py:128-134` creates `attachments/` with a plain `mkdir(parents=True, exist_ok=True)`: the umask's mode, no comparison with the canonical path, and a link check on that folder only. §8.3 lists it among the folders created `0700`. | None in practice: its parent work folder is created private. A hygiene gap against the contract. | Use `RepositoryStorage.attachments_dir(id, create=True)`, which exists and is unused. |
| ST-2 | Low | Link refusals for files in a work folder (`artifact_io.py:123, 147`, `attachments.py`, `workflow.py:1702`) use `refuse_link()`'s default boundary, so the message says "inside this repository". | Wrong wording; the refusal itself is correct. | Pass `boundary=storage.DATA_ROOT_BOUNDARY`. |
| ST-3 | Low | The §8.10 contract tests (`tests/test_storage_contract.py`, `extension/test/storageContract.test.ts`) were never written. Several approved §8.10 keys are absent (`list --json` `work_dir` and `modified`; `doctor`'s `storage.repository_root`) without a recorded withdrawal. | A documentation and contract record gap; 0.1.7 documents its own field list. | Record the withdrawal (or emit the keys), and add one test of the product's output against the contract. |
| ST-4 | Informational | Global storage does not refuse a `BUGPILOT_HOME` inside a non-Git project folder (only the Git rule applies), so `setup` could write `config/`, credentials included, there. | Within the plan's stated gap (§14.3, the G-1 discussion). | Document it, or add the repository-relative check to the global storage. |
| ST-5 | Informational | A few existence checks on data-folder paths follow links (`cli.py`, `workflow.py`); two readers without production callers use `read_text`. | No file content exposed. | Route through storage's checks when touched. |
| ST-6 | Informational | The extension's `.gitignore` writer (`controller.ts`, `gitignore.ts`) remains, gated on a `doctor` field 0.1.7 no longer reports, so it is dormant. | None today. | Remove it, as already recorded as a follow-up. |
| ST-7 | Low | `pollution()` records 22 commands. `clean`, `bug --fresh`, the step commands, `summarize-results`, `memory`, `setup`, every MCP tool and the extension are not in its no-repository-write record. | A coverage gap. The behaviour is sound in every flow exercised here (CLI, MCP, VS Code). | Add the main missing commands and one MCP pass to the tree check. |
| R-1 | Informational | A failed `prepare_jira_bug` (here `JIRA_NOT_CONFIGURED`) leaves `work/<id>/run.json` (status `failed`) and an empty `issue.json` in the data folder. | As in 0.1.6, now in the data folder; it is how `get_status` reports a failed run. | None needed. |

## 6. Agent integration assessment

**The Claude launch arguments (CLI launcher, `--launch-agent claude`)** were checked against the installed candidate. The argument-echo stand-in records exactly what it receives; nothing reaches a model.

| Check | Result |
|---|---|
| Default `BUGPILOT_CLAUDE_ARGS`: argv = `--permission-mode acceptEdits`, then `--add-dir=<work folder>`, then the prompt | **PASS** |
| The grant is one `=` word, exactly once, for the work item's own existing folder: never the data folder | **PASS** |
| `BUGPILOT_CLAUDE_ARGS="--model sonnet"`: kept first and whole, the grant after them | **PASS** |
| A grant already in `BUGPILOT_CLAUDE_ARGS` (`--add-dir=<folder>`, or the two-word `--add-dir "<folder>"`) is not repeated | **PASS** (both forms) |
| `--launch-agent copilot`: no `--add-dir` | **PASS** |
| A missing, linked or invalid work folder: the agent is not started | unit tests only (`tests/test_agent_runner.py`); not re-exercised end to end |

**Real Claude Code**, a safe real-world check:
- **Setup:**
  - a synthetic repository, and beside it a folder standing in for the work item's, holding a synthetic marker file;
  - print mode, with Bash, edit, web and sub-agent tools disallowed;
  - the native Claude Code 2.1.139 executable.
- **Result:**

  | Run | Write into the work folder under `--permission-mode acceptEdits` |
  |---|---|
  | With BugPilot's exact one-word `--add-dir=<folder>` | **allowed**: the file was created |
  | Without the grant | **denied**: recorded in `permission_denials`; no file |

- **What this shows:**
  - The variadic option parses the one-word form without consuming the prompt.
  - The grant is what makes `fix_report.md` writable without a prompt.
- **Reads:** reads outside the repository succeeded with or without the grant, so the grant is about writes.
- **Account use:** these four print-mode runs used the owner's Claude account, under the review brief's "perform safe real-world tests where possible". The plan's §20 asks for an owner approval for each account-using run; that is noted here for the owner. No other run used an account.

**The extension (Fix with AI)**
- **Unit tests** (2,374 on the tree) cover:
  - the command line's shape: `claude --add-dir=<folder> [--session-id X] "<prompt>"`, and resume with the grant;
  - the flag probe;
  - the refusal of a folder or prompt outside the plain character class;
  - no grant for Codex, Copilot, custom agents or Review with AI.
- **Not covered by unit tests:** typing that line into a real terminal (§9).
- **In a real window** (§9), the handoff's folder is the work item's own and exists, the terminal is the work item's, and nothing is written into the repository.
- **Not reached:** the terminal itself never started here (no terminal host in this sandbox), so the argv the shell builds is **NOT TESTED**.

**Unsupported or unprobeable Claude installations (N-4)**
- **Why no grant:** an npm `claude.cmd` shim cannot be probed without a shell, so the extension gives it no `--add-dir`, and Claude asks before writing outside the repository.
- **On the review machine:** the npm shim (2.1.214) comes before the native executable on `PATH`, so this situation is the normal one there for a terminal that resolves `claude` by `PATH`.
- **Permissions:** no permission is broadened to compensate, as decided.

**Permissions for other agents.** Codex, Copilot, custom commands and Review with AI are unchanged: no grant (code and unit tests; the Copilot launcher check above). The captured review keeps its read-only tools, `--setting-sources ""` and `dontAsk`.

**Environments not tested:**
- Claude Code installed only through npm, in a real terminal;
- macOS and Linux terminals;
- remote, WSL and container hosts;
- Codex, Copilot and custom agents end to end.

## 7. Compatibility assessment

| Combination | Result | Evidence |
|---|---|---|
| 0.1.7 extension + 0.1.7 CLI | **PASS**: ready | the extension's own discovery against the installed candidate CLI; the VS Code runs (§9) |
| 0.1.7 extension + 0.1.6 CLI | **PASS**: refused as incompatible; tells the user to update `bugpilot` (it keeps work items in `.ai/`) | the released 0.1.6 CLI |
| 0.1.6 extension + 0.1.7 CLI | **PASS**: `doctor --json` and the run are refused with `EXTENSION_OUTDATED`; nothing is prepared in the data folder, and nothing in the repository's `.ai/` (no fallback) | compatibility matrix; the released 0.1.6 VSIX (its Marketplace build, SHA-256 `38131c90…`) in a real window |
| 0.1.6 extension + 0.1.6 CLI | **PASS**: answered as released | compatibility matrix |
| Terminal-only CLI 0.1.7 | **PASS**: unchanged | §4, 38 checks |
| MCP usage (terminal and extension-host environments) | **PASS**: never refused | §4, 11 checks |
| Other commands started inside VS Code without the marker | as designed: `doctor --json`, `bug --json` and `bug --json-lines` are refused; `list --json` and human-readable `bug` are not | §4 |

**`EXTENSION_OUTDATED` fails safely.**
- With an extension host's variable and no marker, `doctor --json`, `bug --json` and `bug --json-lines` exit 1 with the code. `--json-lines` ends with a `completed` event.
- The data folder's tree is byte-for-byte the same before and after, and the repository is unchanged.
- With `BUGPILOT_CLIENT_STORAGE=unified`, the same call prepares the item. The 0.1.7 extension sets that marker last in its environment (`runner.ts`).
- There is no silent fallback to legacy storage anywhere.

**The heuristic's limits (N-3, accepted and documented):**
- **False positive:** a refusal for any other tool that runs those three commands from inside a VS Code extension host without the marker, including an AI agent started by another extension.
- **False negative:** no protection in an extension host that does not set `VSCODE_CRASH_REPORTER_PROCESS_TYPE` (remote, WSL or container: not tested).
- **Scope:** it can only refuse, never widen.
- **0.1.6's display of the code (real window, the released 0.1.6 VSIX with the candidate CLI): PASS, 9 of 9.** 0.1.6 shows the CLI's own sentence, `FAILED (EXTENSION_OUTDATED): This bugpilot (0.1.7) keeps work items in BugPilot's data folder…`, then its generic "updating it may help" for a code it does not know.
- **Informational, a 0.1.6 behaviour 0.1.7 cannot change:** when the 0.1.7 CLI is configured only through `bugpilot.executablePath` and no `bugpilot` is on `PATH`, 0.1.6's Doctor falls back to its default `bugpilot` after the failed handshake and reports `spawn bugpilot ENOENT` instead of that sentence. The run is still refused, with nothing prepared. Worth one line in the upgrade notes: update the extension first.

## 8. Security findings

**Method:**
- an internal, read-only code review of the areas in the brief, without exploit code or hostile-character probes;
- the end-to-end checks above;
- the full test suites.

**Not an independent external security audit**, and none has taken place.

**No Critical or High problem was found.** Severity counts: Critical 0, High 0, Medium 0, Low 3 (S-1 to S-3), Informational 4 (S-4 to S-7). The storage items are in §5.

| ID | Severity | Class | Finding | Impact | Evidence | Smallest remediation |
|---|---|---|---|---|---|---|
| S-1 | Low | verified by code reading (not exercised) | **The Python launcher has no plain-prompt gate (T-S12).** With an npm `claude.cmd` shim, `--launch-agent claude` runs `cmd.exe /c claude.cmd … --add-dir=<absolute path> "Read <absolute path>/task.md …"`. `list2cmdline` quotes only arguments with spaces, so `&`, `%`, `^` or `!` in the user's home path or `BUGPILOT_HOME` are interpreted by `cmd.exe`. New in 0.1.7: the 0.1.6 prompt held only a validated id. | A broken launch, or a fragment of the user's own path run as a command. Not attacker-controlled (the slug and id are restricted; the path is the user's own). Only the deprecated, opt-in launcher. | `agent_runner.py` (`build_agent_command`, `_resolve_launch_command`); threat model T-S12 names "the plain-prompt gate on both sides (TypeScript, and Python `agent_runner`)", and Batch 2's item 10 planned it; `config.prompt_path` refuses only backticks and control characters. | Port `PLAIN_PROMPT` and `PLAIN_FOLDER` (`agents.ts`) into `build_agent_command`; on refusal return `skipped_reason`, so the existing manual-handoff text is printed. |
| S-2 | Low | theoretical | **The data root's privacy gates credentials only.** `GlobalStorage.check()` verifies the data root and `config/` (owner and access list, or owner and mode bits) before credentials are written. Preparing a work item, writing `task.md` and granting the work folder do not consult it, and `doctor`'s storage state does not report it. | With a user-chosen `BUGPILOT_HOME` that other local accounts can write to, another account could edit `task.md`, a policy file or a `.claude/` folder before the handoff. That is prompt injection into an `acceptEdits` agent across accounts, wider than N-2's same-user framing. `docs/safety.md` recommends a neutral `BUGPILOT_HOME` without a privacy note. | `storage.py` (`verify_private` callers), `doctor.py` | Report the data root's privacy in `doctor` and warn (or refuse) before the grant when it is not private; add a privacy sentence where `BUGPILOT_HOME` is recommended. |
| S-3 | Low | theoretical; not new (since 0.1.1) | **The managed runtime pins the version, not the hash:** `pip install --only-binary=:all: bugpilot==<version>` from whatever index pip is configured with; `-I` does not isolate `PIP_*`. | A compromised index or mirror, or a wheel added later to an existing release, would be installed and run. | `managedRuntime.ts` (the pip step) | Embed the wheel's SHA-256 at VSIX build time and install with `--require-hashes`. |
| S-4 | Informational | verified | `issue-details` puts an unvalidated key into the Jira REST path: `_refuse_for_manual` swallows the invalid-id refusal. | A GET on the same Jira origin; HTTPS, host and redirect rules hold; the input is the user's own. | `cli.py` (`issue-details`), `jira.py` | Validate the id in `fetch_issue`. |
| S-5 | Informational | verified by the review | No size limit on Jira responses; the ADF renderer recurses without a depth limit. | Local denial of service only. | `jira.py`, `jira_adf.py` | `read(limit + 1)`; a depth cap. |
| S-6 | Informational | verified; not new | `git status` (from `doctor`, on activation) runs without the `core.fsmonitor=false` prefix that `review_changes.py` uses. | Within VS Code's Workspace Trust model (`untrustedWorkspaces.supported: false`). | `git_ops.py` | Reuse the hardened prefix. |
| S-7 | Informational | verified by the review | The extension writes `user_feedback.md` with a plain `writeFile`: umask mode, not exclusive-create. | Mitigated by the private work folder; same-user only. | `ports.ts`, `sessionReset.ts` | Write it as the CLI does (atomic, `0600`). |

**Accepted limitations, checked against the code (unchanged, owner-accepted on 2026-10-29):**
- **N-1, the user name in agent prompts:** as documented. Messages and logs use the display form.
- **N-2, the grant and `.claude/`:**
  - The grant is exactly one folder and never the data root.
  - The threat model's conditional T-S16 control (refuse a grant when the folder holds a dot-entry) is not implemented. It is covered by the owner's acceptance of N-2, but it is cheap and would also blunt S-2.
- **N-3, the heuristic:** as documented; it only refuses.
- **N-4, no grant for an npm shim:** as documented; nothing is widened.

**Areas reviewed and found sound:**
- **The terminal handoff's gate and quoting:** the plain character class, JSON quoting, a session id only as a UUID, and a hex-only resume id.
- **IDs:** one ID pattern on both sides.
- **Executables:** found on absolute `PATH` entries only, never in the current folder.
- **Jira transport:** HTTPS only, same-origin redirects, and the token in the environment, never in argv.
- **Storage:** containment and link handling.
- **The credential gate:** owner and access list on Windows, owner and mode on POSIX.
- **Prompt boundaries:** fenced evidence, and repository content labelled as facts.
- **Logs:** an allowlist redaction.
- **Temporary files:** exclusive, `0600`.
- **The captured review and hint improvement:** restrictions in place.
- **Release integrity:** `main`-only release with a preflight, SHA-pinned actions, build tools installed with `--require-hashes`, the hash handed from build to publish, and CI on `pull_request`, not `pull_request_target`.

## 9. Manual acceptance results

**What was run.** A disposable, standalone VS Code: its own profile, extensions folder and home, no BugPilot on `PATH`, and no Jira variables. The candidate VSIX was installed, and the managed runtime was installed from the candidate wheel. The driver used VS Code's extension API: commands, editors, the output channel on disk, the clipboard, and a test host.

**What it cannot reach.** The webview's buttons and forms cannot be reached through that API. Terminals cannot start in this sandbox (no terminal host). PASS below means the scenario ran in a real window, not only in unit tests.

| Scenario | Result | Evidence |
|---|---|---|
| Bug description and Jira ticket input (panel form) | **NOT TESTED** (webview form) | The same preparation through the extension host's CLI: PASS (both work items prepared in the data folder) |
| Run workflow (panel's Run) | **NOT TESTED** (webview button) | — |
| Advanced Settings | **NOT TESTED** (webview) | — |
| Fix Mode (panel selection and editor) | **NOT TESTED** (webview) | Fix Mode commands are in the CLI record (`pollution`) |
| AI Behavior and Rules | **PASS** (file, editor and watcher), in both runs | Edit's own command writes `settings/ai_behavior.md` in the data folder; it opens in an editor from there; the watcher sees create, change and removal; the panel rereads it through the CLI (1 line flagged, then 2 after the editor's save) |
| Build Context | **PASS** through the extension host's CLI; the panel button **NOT TESTED** | `context.md` opens from the data folder |
| Fix with AI | **NOT TESTED** (no terminal host in this sandbox) | The command runs; the handoff terminal is the work item's; the folder given is the work item's own and exists, not the data folder; nothing is written into the repository. Whether `claude` receives `--add-dir=<folder>`, `--session-id`, then the prompt, from a real terminal: not observed. |
| Policy Edit and Reset buttons | **NOT TESTED** (button presses); their CLI commands **PASS** | `verification set --stdin --json` and `reset --json` (and AI Behavior's) write and remove the files in the data folder |
| Policy file watcher | **PASS, with one finding (U-1, Low)** | The watcher, on a folder outside the workspace, sees every create, change and removal of both files, and schedules a reread. After the Verification Policy's editor save, the change was seen but not reread: the settings row kept "1 line" while the CLI flags 2 for the saved text. Reproduced in 2 of 2 runs; see U-1 below. |
| Work-item navigation | **PASS** | Show Work Item, Open Artifact and Open task.md open the data folder's files; switching items works. Invalid and never-prepared ids are handled, create no folder and change nothing. Every editor opened is a work item's own file. |
| Copy Handoff Prompt | **NOT TESTED** (clipboard unavailable in this window today) | The command succeeds, but a plain clipboard round trip (`write` then `read`) returned nothing in this window. The sentence itself is verified through the CLI (§4); this passed against the s018 build. |
| Diagnostics and error messages | **PASS** (Doctor runs; `EXTENSION_OUTDATED` from the CLI; invalid references handled) | The released 0.1.6 extension shows the CLI's `EXTENSION_OUTDATED` sentence (9 of 9 with the CLI on `PATH`; see §7 for `executablePath` only) |
| Restart and recovery | **PASS** (restart); runtime install from an offline wheel **PASS**; a broken-runtime reinstall **NOT TESTED** in this review | After quitting VS Code, the work item shown before opens again from the data folder |
| The legacy canaries | **PASS** | The repository's planted 0.1.6 `.ai/` and `.bugpilot/` are never read, written or deleted; no `.ai_memory/`; `git status` shows only them |

**Finding from the real window:**

| ID | Severity | Finding | Impact | Evidence | Smallest remediation |
|---|---|---|---|---|---|
| U-1 | Low | **A policy change saved while a policy reread is in flight is not reread.** `#refreshPolicies()` hands every caller the read already in flight ("Callers meanwhile share the read in flight"). It reads instructions, then the Verification Policy, then AI Behavior. A watcher event for the Verification Policy that arrives after that read but before the refresh ends gets the stale refresh, and nothing reads the file again. | The settings row's lint count and Preview show the previous content until the next trigger: window focus, Run, Rebuild Context, Fix with AI or an environment check, each of which reads again first. Tasks are unaffected: the CLI reads the file itself when it prepares. Display only; timing-dependent; not new in 0.1.7 (the shared refresh predates it). | `controller.ts` (`#refreshPolicies`, `#policyFileChanged`); the output log shows "Policy reread scheduled (settings/verification.md changed)" and then no result, in 2 of 2 runs. The CLI flags 2 lines for the saved text. AI Behavior, read last, is unaffected. | When a change arrives during a refresh, mark the policies dirty and refresh once more after the one in flight, instead of sharing it. |

**Harness note.** Result files named after a runner (`policy.json` beside `policy/`) are found by Node's module resolution before the runner's `index.js`. The first reruns therefore failed to load ("not a valid extension test runner"); they were rerun with other names. This was a defect of the review harness, not of the product.

## 10. Documentation assessment

An internal read-only review checked the release documents against the code. The Medium items below were confirmed by hand.

| ID | Severity | Where | Problem | Smallest fix |
|---|---|---|---|---|
| D-1 | Medium | `README.md:65` | "Run BugPilot from the root of the repository you want to fix — it writes its files there". This contradicts the headline 0.1.7 behaviour and the README's own "BugPilot writes nothing into your repository". | "…It reads the repository there and keeps its own files in its data folder (below)." |
| D-2 | Medium | `README.md:48`, `extension/README.md:79`, `docs/architecture.md:18` | The install check expects `bugpilot 0.1.5`. 0.1.7 requires matching extension and CLI versions. | `bugpilot 0.1.7` |
| D-3 | Medium | `README.md:285` | "When BugPilot starts Claude Code (`--launch-agent claude`, or the extension's Claude CLI), it adds `--add-dir=<that folder>`". The extension adds it only when the probe lists the option, and never for an npm `claude.cmd` (N-4). No user document names the npm limitation for `--add-dir`. | Add the probe condition and the npm sentence here, in `extension/README.md` ("Fix with AI and Claude CLI") and in `docs/safety.md`. |
| D-4 | Medium | README "Where BugPilot keeps its files", extension README troubleshooting | The repository's folder is chosen by its path. After a move or rename, a re-clone, a subfolder or another `BUGPILOT_HOME`, work items look "missing". The same goes for 0.1.6 items after the upgrade. No troubleshooting entry, and the CLI message gives no hint. | One paragraph and one troubleshooting row. |
| D-5 | Medium | `extension/README.md`, CHANGELOG, `docs/safety.md:113` | A home path with any character outside ASCII letters, digits, spaces and `. , : # / _ -` makes Fix with AI refuse every CLI agent: the gate is owner-approved (US-D12), but the absolute path is new in 0.1.7. Only `safety.md` mentions it ("letters": the code allows ASCII letters only). US-D12's condition asks for the `BUGPILOT_HOME` remedy to be stated clearly. | One sentence in the extension README and the changelog; "ASCII letters" in `safety.md`. |
| D-6 | Medium | `docs/architecture.md` (linked from the README) | Still describes `.ai/<issue>/`, `.ai_memory/`, `<repo>/.bugpilot/` and `~/.bugpilot/config.toml` as current. `BUGPILOT_CONFIG_DIR` is listed as read (line 781; it is retired); the capability list lacks `unified-storage`. | Extend its status note: everything about those locations is historical; point to `storage.py` and the README. |
| D-7 | Low | README, CHANGELOG | The `BUGPILOT_CONFIG_DIR` retirement is missing from the upgrade notes. | One sentence. |
| D-8 | Low | CHANGELOG, extension README | The lists of no-longer-read files disagree with the README's (which adds `instructions.md` and `fix_modes/`). | Use the README's list. |
| D-9 | Low | `extension/README.md:325-326` | The watcher text mentions "switching branch or pulling", which can no longer change settings. | "…in an editor tab or by another tool". |
| D-10 | Low | README, CHANGELOG, extension README | The `.claude/` limitation (N-2) appears only in `docs/safety.md`. | One sentence. |
| D-11 | Low | README:97 | The `EXTENSION_OUTDATED` heuristic reads as a fact, not a requirement, and does not name the main false positive (an agent started by another extension). | Reword. |
| D-12 | Low | README (mixed-version paragraphs), extension README | Mixed-version behaviour of 0.1.2-era clients and shared repository files that 0.1.7 no longer reads. | Prefix "Before 0.1.7:" or remove. |
| D-13 | Low | `docs/safety.md:3, :59` | Says BugPilot hands off to an agent "by default" (prepare-only is the default), and that it creates a team file in a checkout. | Correct both. |
| D-14 | Low | `skills/bugpilot-investigate/SKILL.md`, `docs/skill_setup.md`, `docs/mcp_setup.md` | Nothing about the agent needing access outside the repository when started by hand. `mcp_setup.md` lists 7 of the 9 tools. Stale install and file names. | Update. |
| D-15 | Low | CHANGELOG | With the `.gitignore` warning gone, advise keeping the `.ai/` ignore rules until the old folders (which hold fetched Jira content) are deleted. | One sentence. |
| — | Informational | `extension/CHANGELOG.md:3` | The heading reads "0.1.7 — unreleased". | Finalize at release. |

**Accurately covered:**
- the new layout and `BUGPILOT_HOME`'s rules;
- no migration and no deletion of legacy folders;
- `EXTENSION_OUTDATED` and its signal;
- a 0.1.7 extension refusing an older CLI;
- N-1 and its remedy;
- `--add-dir`'s scope and refusal rules in `docs/safety.md`;
- the privacy and reset sections;
- consistent version, licence and repository metadata.

## 11. Known limitations and release risks

- **Owner-accepted for 0.1.7** (unchanged, re-checked in §8): N-1, N-2, N-3 and N-4. Also 0.1.6's RL-1 to RL-4 and its M3 waiver.
- **Owner-approved design limitation, US-D12:**
  - A home or data path outside the plain character class loses one-click Fix with AI. The prompt gate refuses it, safely, with a message naming `BUGPILOT_HOME` and Copy Handoff Prompt.
  - Because 0.1.7's prompts carry the absolute path, this now applies to such users in the default configuration.
  - This is a support risk in locales whose user names have non-ASCII letters (D-5).
- **Release risks from untested areas:**
  - the real-terminal handoff;
  - the webview;
  - Copilot, Codex and custom agents end to end;
  - macOS and Linux desktops;
  - remote, WSL and container hosts;
  - the managed runtime from PyPI (possible only after publication);
  - `pipx`.
- **The plan's own release checklist (§20) is open.** It requires, among others:
  - the owner's list of supported agent and provider combinations (§9.10);
  - A1–A9 from real interactive runs on the candidates;
  - a real VS Code pass over four themes and three widths;
  - an owner approval for each account-using run;
  - CI green on `main` at the release commit.

## 12. Recommended fixes

**Required before an RC can be approved** (documentation only; then a new candidate commit, cross-platform CI, and rebuilt artifacts):
1. D-1, D-2, D-3, D-5 and D-6, at least.
2. D-4, and the Low documentation items, which are cheap in the same pass.

**Recommended before release** (small code changes; the owner may instead accept and document them):
3. **S-1:** the plain-prompt gate in the Python launcher (T-S12, planned as Batch 2's item 10).
4. **S-2:** report the data root's privacy in `doctor`, warn before the grant when it is not private, and add a privacy note where `BUGPILOT_HOME` is recommended. T-S16's dot-entry check alongside it is optional.
5. **ST-1 and ST-2.**
6. **U-1:** reread after an in-flight policy refresh, with a unit test for the interleaving.

**Later:** S-3 (a hash-pinned managed runtime), S-4 to S-7, ST-3, ST-4, ST-5, ST-6 and ST-7.

**Owner acceptance runs, before release.** These cannot be done in this environment:
- Fix with AI in a real terminal, with an npm-only install and with the native executable;
- the webview's Run, Advanced Settings, Fix Mode, and the policy Edit and Reset buttons;
- Copy Handoff Prompt;
- the §20 real-use items.

## 13. Release-governance blockers

These are decisions for the owner. CI, artifact tests and this review do not authorize public distribution. Nobody outside was contacted.

| ID | Question | State in the canonical record |
|---|---|---|
| G-1 | **Ownership and employment policy.** Whether the owner holds the rights to distribute BugPilot publicly, and whether any employer policy (IP assignment, outside-work or open-source rules, use of employer equipment, accounts or data during development) applies. The repository's own guards exclude an employer's name and real ticket prefix, which shows the question is live. | **No explicit resolution recorded.** UNRESOLVED. |
| G-2 | **Confidentiality.** That no employer-confidential code, data, tickets or names are in the distributed artifacts or the public history. The artifacts pass the private word-list scan (§4). Earlier owner decisions risk-accepted GitHub's cached copies of orphaned commits with a work e-mail address. | Artifacts: clean. History: earlier risk acceptance; owner to confirm for 0.1.7. |
| G-3 | **Licence parameters (REL-2).** The Licensed Work lines say 0.1.7. The Licensor, Additional Use Grant, Change Date (2030-10-11) and Change License are unchanged. The plan asks for the owner's decision "with qualified review" for a new version's parameters. | The owner approved the 0.1.7 commit, which includes the change. **No qualified review recorded.** UNRESOLVED. |
| G-4 | **Third-party IP.** The codicons font and the bug icon (CC BY 4.0, with attribution shipped), and the Python and npm dependencies used at build or runtime. | Resolved earlier for the icons; no new third-party content found. No action unless the owner wants a dependency licence review. |
| G-5 | **Account-using runs.** §20 asks for an owner approval per run. This review made four print-mode Claude Code runs on synthetic files (§6). | For the owner's record. |
| G-6 | **Publication accounts.** The PyPI project and its protected `pypi` environment, and the Marketplace publisher, are the owner's. | Unchanged; publication remains manual and the owner's. |

**Public-distribution authorization: UNRESOLVED** until the owner explicitly resolves G-1 and G-3, and confirms G-2. Legal and employment questions need the owner's own qualified advice; this review gives none.

## 14. Final recommendation

- **Technical classification: RC BLOCKED.**
  - **Blocker:** the documentation defects in the shipped READMEs (D-1, D-2, D-3, D-5) and the stale architecture document (D-6). They need a documentation commit, then a new candidate tree with cross-platform CI and rebuilt artifacts.
  - **Also required:** the owner's acceptance runs in §12.
  - **No code or security blocker was found:** no Critical, High or Medium finding. Storage matches its contract; CI is green on all 9 jobs; the artifacts and clean installs pass.
  - **Recommended before release:** S-1, S-2, U-1, ST-1 and ST-2.
- **Public-distribution authorization: UNRESOLVED** (§13).
- **Next step:** the owner's decision on the fix scope (§12) and the governance items (§13). Nothing here was merged, tagged, published or released, and this review stops until the owner approves the next step.

## 15. RC remediation batch (2026-10-29)

**Status: FIXED LOCALLY AND VERIFIED ON WINDOWS — D-1 TO D-6, S-1, S-2, U-1, ST-1 AND ST-2; UNCOMMITTED; CROSS-PLATFORM CI AND THE FOLLOW-UP REVIEW PENDING. THE CLASSIFICATION STAYS RC BLOCKED.**
- The owner approved this batch and its scope on 2026-10-29; nothing beyond it was changed.
- None of these findings is marked resolved until a corrected candidate commit passes cross-platform CI and its follow-up review.

**Scope as approved.**
- D-1 to D-6;
- S-1, S-2 and U-1;
- ST-1 and ST-2.

The other findings (D-7 to D-15, S-3 to S-7, ST-3 to ST-7, R-1) are unchanged and remain open as listed above.

### S-1 — the CLI launcher and cmd.exe

- **Root cause:**
  - `--launch-agent` runs an npm batch file through `cmd.exe /c`. `cmd.exe` parses the whole command line, so `%`, `^`, `&`, `|`, `<`, `>`, parentheses, `!` and quotes are acted on, and `list2cmdline` quotes only words with spaces.
  - 0.1.7's prompt and grant carry the absolute data-folder path; T-S12's Python gate had never been written.
- **Fix:**
  - `run_agent` refuses before any process starts when the launch goes through `cmd.exe` and any word falls outside the plain-prompt gate's set:
    - the shim's own path, checked for cmd.exe's metacharacters;
    - every configured argument and the grant, checked against ASCII letters, digits, space, `. , : # / _ -` and `=`;
    - the prompt, checked against the same set without `=`, and opening like a sentence.
  - Nothing is rewritten: the CLI prints the existing manual-handoff line.
  - A native executable keeps its argument vector, which no shell reads, so valid paths with any character still launch. This follows the §9.9 table: Python `subprocess.run` is "native: yes; shim: no … the shim path keeps the gate (T-S12)".
- **Files:** `bugpilot/core/agent_runner.py` (`_cmd_exe_problem`, `_is_batch_shim`, the gate in `run_agent`).
- **Regression coverage** (`tests/test_agent_runner.py`):
  - each of `& % ^ ! ( ) ' é + @ ~` in the data folder's path refuses a shim launch, and launches a native one with every word unchanged;
  - `" < > |`, a line break, a tab, a no-break space, a line separator, a leading space, an option-like prompt, a configured `&` and a `%VAR%` in the grant are refused;
  - a plain path still launches through the shim;
  - Copilot's shim is held to the same rule, and the shim's own path is checked;
  - the CLI prints the manual handoff.
- **Mutation check:** with the gate switched off, 25 of these tests fail; the 3 that pass are the plain cases that must launch.
- **Remaining limitations:**
  - Native launches are not character-gated. Reading US-D12's parity clause as requiring the gate on every Python launch is an owner decision, and would make non-ASCII paths fail there too.
  - US-D12's shared TypeScript/Python corpus and the TypeScript `\s` tightening are not part of this batch.

### S-2 — the work folder is given only when it is private

- **Root cause:** storage's privacy check (`private_folder.verify_private`) guarded credentials only. Writing `task.md` and granting `--add-dir` never consulted it, so a user-chosen `BUGPILOT_HOME` another account could write to was handed to an `acceptEdits` agent.
- **Fix, using the existing storage API with no new path-security code:**
  - **The check:** `RepositoryStorage.check_private_for_agent(id)` applies `verify_private`'s `data-root` rule (owned by this user; no other account may write) to the data folder and every folder down to `work/<id>`. `unverifiable` is refused like `not-private`: fail closed.
  - **The CLI:** `--launch-agent claude` runs that check before the grant, and on a refusal starts nothing and prints the manual handoff.
  - **`doctor --json`:** its `storage` object gains `privacy` (`private`, `not-private` or `unverifiable`) and `privacy_problem`, through `RepositoryStorage.privacy()`. This is an additive field.
  - **The extension:** it asks the CLI (`doctor --json`) just before it gives Claude CLI the folder (a new `workFolderPrivacy` port), and again before Open AI Session starts a session that carries the grant. Anything but a clear `private` refuses the launch, in the CLI's words.
  - **Unchanged:** Codex, Copilot, custom commands, extension bridges and Review with AI are given no folder and are not asked. The data root is never granted, and credential protection is untouched.
- **Files:**
  - `bugpilot/core/storage.py`, `bugpilot/core/config.py` (`check_work_folder_private`), `bugpilot/core/agent_runner.py`, `bugpilot/core/doctor.py`;
  - `extension/src/app/dataFolder.ts` (`workFolderPrivacyOf`), `extension/src/app/agents.ts`, `extension/src/app/controller.ts`, `extension/src/extension.ts`.
- **Regression coverage:**
  - **Python:**
    - every folder from the data folder to `work/<id>` is checked with the `data-root` rule;
    - a not-private folder at the data root, the repository folder or the work folder is never granted;
    - an unprovable answer is refused;
    - Copilot is not asked;
    - a real folder opened to every account is refused, through a Windows access-list grant to Everyone, or POSIX `0777`;
    - `doctor` reports `privacy` and `privacy_problem`.
  - **The extension:**
    - a not-private, failing or missing answer refuses the launch;
    - the privacy question is not asked when no folder would be given;
    - Codex and custom commands are not asked;
    - Fix with AI asks once and starts nothing when the answer is no;
    - Open AI Session asks again and starts nothing until the answer is yes;
    - no question is asked for a session without a grant;
    - the report parser is tested.
- **Mutation check:** with the CLI's check switched off, 6 of its 7 tests fail; the one that passes calls storage directly.
- **Remaining limitations:**
  - The folders above the data folder are not checked, as for credentials. macOS extended ACLs are not read.
  - A volume without access lists answers `unverifiable`, so it gets no grant (fail closed).
  - The extension adds one `doctor --json` call before each grant, and Open AI Session's relaunch waits for it.

### U-1 — a policy change saved during a reread

- **Root cause:** `#refreshPolicies()` handed every caller the read already in flight. It reads instructions, the Verification Policy, then AI Behavior, so a Verification Policy save that landed after its read but before the refresh ended was never read.
- **Fix:** a request while a read is in flight queues one more read after it, shared by every request that arrives meanwhile (`#policyRefreshAgain`).
  - A burst costs at most two reads.
  - A refresh only reads, so it cannot trigger another; there is no loop.
- **Files:** `extension/src/app/controller.ts`.
- **Regression coverage** (`extension/test/controller.test.ts`):
  - **The interleaving that reproduced in the real window**, deterministic: the watcher and the debounce timer are driven by hand, and AI Behavior's read is held. The save is read once the read in flight ends: 2 reads, the "2 line(s)" state shown, no timer left and no further read.
  - **Several requests during one read in flight** share one follow-up.
- **Mutation check:** with the old shared read, both tests fail; with the fix, both pass.
- **Existing tests:** the watcher, Edit, Reset and settings tests pass unchanged.
- **Remaining limitations:** none known.

### ST-1 and ST-2 — storage hygiene

- **ST-1:**
  - **Root cause and fix:** a run's `attachments/` folder was made with a plain `mkdir`. It is now made by storage's own `attachments_dir(id, create=True)` (`0700`, each component checked before and after, compared with the canonical path), once, before the first file that is copied. A run whose files are all skipped still leaves no folder.
  - **Files:** `bugpilot/core/attachments.py` (a `folder` parameter; without it, the same checked creation under the target), `bugpilot/core/config.py` (`writable_attachments_dir`), `bugpilot/core/workflow.py`.
  - **Storage inventory:** `tests/storage_inventory.json` gains exactly one path-helper reference, in `attachments.py`, recorded with `--update`.
- **ST-2:**
  - **Root cause and fix:** link refusals for files in the data folder used `refuse_link`'s repository wording. `DATA_FOLDER_BOUNDARY` now lives in `safe_paths.py` (storage's `DATA_ROOT_BOUNDARY` is that constant), and the atomic writer, the attachments copy and the `.eml` draft pass it. `safe_paths`' defaults, and their byte-identical repository messages, are unchanged.
  - **Files:** `bugpilot/core/safe_paths.py`, `bugpilot/core/storage.py`, `bugpilot/core/artifact_io.py`, `bugpilot/core/attachments.py`, `bugpilot/core/workflow.py`.
- **Regression coverage:**
  - **`tests/test_write_boundaries.py`:**
    - a run's attachments folder is made by storage, once, and is private on POSIX;
    - no folder is made when nothing could be copied;
    - `copy_attachments` on its own makes a private, checked folder and refuses a link in the data folder's words;
    - a linked `task.md`, a linked attachment file and an atomic write are all refused in those words.
  - **`tests/test_email_notify.py`:** a linked `notification.eml` is refused in the same words.
- **Remaining limitations:** none known.

### D-1 to D-6 — documentation

**Files:** `README.md`, `extension/README.md`, `extension/CHANGELOG.md`, `docs/safety.md`, `docs/architecture.md`. `docs/development.md` needed no change.

| Finding | Fix |
|---|---|
| D-1 | The First run line now says BugPilot reads the repository and keeps its own files in its data folder. |
| D-2 | The install checks expect `bugpilot 0.1.7` and say the CLI and the extension must be the same version; `docs/architecture.md`'s version line is 0.1.7. |
| D-3 | **CLI:** always adds `--add-dir`, after the folder, link and privacy checks. **Extension:** adds it only when `claude --help` lists the option, after asking the CLI about privacy. **npm `claude.cmd`:** cannot be asked, so no grant, and Claude asks before writing. **`.claude/`:** loaded from a granted folder. Stated in the README, the extension README, the changelog and `docs/safety.md`, keeping the CLI and extension behaviour apart. |
| D-4 | The repository's folder follows the repository's real path. A move or rename, a subfolder, a clone at another path or another `BUGPILOT_HOME` means a new, empty folder; nothing is moved, and a clone at the same path finds its folder again. Stated in the README, the extension README (with a troubleshooting row) and the changelog. No migration or recovery is promised. |
| D-5 | When the home or data path holds a character outside ASCII letters, digits, spaces and `. , : # / _ -`, Fix with AI hands over to no agent. The supported options: a `BUGPILOT_HOME` with a plain path, private to you, or Copy Handoff Prompt. Stated in the README, the extension README (with troubleshooting rows), the changelog and `docs/safety.md` ("ASCII letters", as the code checks). |
| D-6 | `docs/architecture.md`'s status note marks every pre-0.1.7 location and `BUGPILOT_CONFIG_DIR` as historical. The capability list gains `unified-storage`; the configuration reference names `BUGPILOT_HOME` and the retired `BUGPILOT_CONFIG_DIR`; the launcher description gains S-1 and S-2. |

### Verification (Windows, the working tree)

| Check | Result |
|---|---|
| S-1 and S-2, the launcher (`tests/test_agent_runner.py`) | 79 passed |
| ST-1 and ST-2 (`test_write_boundaries.py`, `test_email_notify.py`, `test_attachments.py`) | 86 passed |
| Mutation checks: each fix switched off | **S-1:** 25 tests fail; the 3 plain cases pass, as they must. **S-2:** 6 of 7 fail; the one that passes calls storage directly. **U-1:** both fail. |
| Python, the whole suite | 4,201 passed, 91 skipped, 0 failed: `d05c025`'s 4,147 and the new tests |
| The extension's unit tests; typecheck | 2,384 passed, 1 skipped, 0 failed; clean |
| The extension's CLI integration tests, against the real CLI | 21 of 21 |
| Storage and baselines | every compared baseline matches; the approval gate passes; the storage inventory gains exactly one path-helper reference (`attachments.py`, ST-1) |
| Extension × CLI compatibility: a wheel of the working tree, and the released 0.1.6 CLI | 5 of 5 |
| CLI clean install from that wheel (§4's 38 checks) | 38 of 38 |
| MCP from that wheel (§4's 11 checks); MCP over stdio in the suite | 11 of 11; passed |
| The refusal matrix through the real CLI | 62 of 62 |
| End to end: a real `cmd.exe` batch shim with a plain path; a real access-list grant to Everyone on `work/` | 8 of 8: launched with the grant and the prompt intact; then refused, with the manual handoff printed and `doctor --json` reporting `not-private` |
| The plan checker; publishability | 0 problems; passes |

No account-using AI session was run for this batch: every agent was a stand-in.

### Baselines and goldens

None changed.
- `tests/baselines/`, `tests/golden/` and the baseline approval review are identical to `d05c025`.
- Every compared baseline matches today's behaviour (the full suite, Windows).
- No U7 value or approval date changed, and no new designed difference was needed: `doctor`'s `storage` object is not in a compared record, and no compared run attaches a file or meets a refusal.

### Security impact

- **S-1:**
  - **Closes:** argument injection through `cmd.exe` in the deprecated launcher. T-S12's Python gate now exists on the path where a shell parses the line.
  - **New failure mode:** a user of an npm `claude.cmd` whose data-folder path or configured arguments hold such a character gets the manual handoff instead of a launch.
- **S-2:**
  - **Closes:** the cross-account route to a granted work folder, in the CLI and the extension, Open AI Session restarts included, failing closed on an unprovable answer.
  - **New failure mode:** a shared `BUGPILOT_HOME`, or a volume without access lists, gets no automatic Claude launch with the grant.
  - **Unchanged:** an agent that is given no folder (Codex, Copilot, a custom command, an extension bridge) still reads `task.md` from a data folder that may not be private. `doctor` now reports that, but the handoff does not enforce it; that is beyond the approved scope.
- **U-1:** a display fix; no security impact.
- **ST-1:** the attachments folder is now private and checked like every other folder storage creates.
- **ST-2:** wording only.
- No new Critical, High or Medium finding. No independent external security review has taken place.

### Remaining RC blockers

1. A corrected candidate commit of this batch, with the owner's approval; cross-platform CI green on all 9 jobs on it; and the follow-up review. Until then the classification stays **RC BLOCKED**.
2. The owner's acceptance runs (§12): Fix with AI in a real terminal, the webview, and §20's real-use items.
3. Release governance G-1 to G-6 (§13): public distribution stays **UNRESOLVED**.
4. Still open and outside this batch:
   - D-7 to D-15, S-3 to S-7, ST-3 to ST-7 and R-1;
   - the owner's reading of US-D12 for native launches (S-1).

## 16. Conditional commit approval: pre-commit verification (2026-10-29)

**Status: STOPPED BEFORE THE COMMIT — S-1'S CONDITION FAILS. The `cmd.exe` risk can reach `git` and `rg` through another launch path (S-8, new; rated High by impact, conditional on a non-default installation). A new owner decision is needed. Nothing was staged, committed or pushed. RC BLOCKED; public distribution UNRESOLVED.**

The owner approved the 28-file remediation commit on conditions (2026-10-29). Each condition is recorded here as it was checked.

### S-1: the owner's decision, and its condition

- **Decided by the owner:**
  - Restrictive validation applies to Windows batch-file launches that run through `cmd.exe`.
  - Native executables keep their argument vector, unrestricted, so Unicode and other valid paths still launch.
  - This is the owner's reading of US-D12 for Python (§9.9.1, point 3), recorded in the plan.
- **The condition — "the same shell risk cannot bypass validation through another launcher path": NOT MET.** See S-8.

### S-8 (new) — `git` and `rg` as batch files run through `cmd.exe`, unvalidated

- **Severity:** **High** by impact, conditional; likelihood low. Verified by code reading; not exercised (no exploit or probe was built). Pre-existing: not introduced by 0.1.7 or by this batch.
- **What happens:**
  - `executables.find_executable` honours `PATHEXT` for every program, `.BAT` and `.CMD` included, and returns the first match on `PATH`.
  - `git_ops.run_command`, `search._run_rg`, `review_changes` and `git_history` start the result with `subprocess.run([program, …])`.
  - On Windows, starting a `.bat`/`.cmd` file runs it through `cmd.exe` implicitly. Python adds no escaping for `cmd.exe`, and `list2cmdline` quotes only words with spaces or tabs.
- **What reaches those command lines from the issue's text:**
  - `rg`'s search terms, one per call. A quoted phrase (`keywords._PHRASE_RE`: any character but `"` and a line break) becomes a term, so `"a&b"` reaches `rg` as `a&b`, unquoted.
  - `git log --grep=<term>` in Git history.
  - `git ls-files` with file names taken from the issue (glob characters are filtered, `cmd.exe`'s are not).
- **The precondition:** the developer's `rg` or `git` resolves to a batch file ahead of a native executable on `PATH`. Normal installs of Git for Windows, ripgrep, Chocolatey and Scoop provide native `.exe` files, so this needs a custom or unusual setup.
- **Impact:** text in an issue could run commands as the developer when BugPilot prepares that issue.
- **Smallest remediation (recommended):** never start `git` or `rg` as a batch file. For these programs, `find_executable` on Windows looks only for native executables (`.exe`, `.com`); a batch-file-only installation is reported as not found, with a sentence that says why. The agent launcher keeps its gated shim path (S-1).
- **Not recommended:** applying S-1's character gate to `git` and `rg`. It would drop legitimate search terms, and it validates by character where the real problem is the shell.

### S-2: the owner's decision, and its conditions

| Condition | Result |
|---|---|
| The check uses the approved storage security API | **Met.** `RepositoryStorage.check_private_for_agent` and `privacy()` call `private_folder.verify_private` (`data-root` rule) inside `storage.py`; `private_folder` stays storage's alone (the API-boundary test passes); no new path-security code. |
| `doctor --json` stays backward-compatible | **Met.** `storage` gains `privacy` and `privacy_problem` only; every existing key, value and state is unchanged; a refused storage reports as before. |
| Unknown or unsafe privacy refuses the grant | **Met.** `unverifiable`, `not-private`, a missing answer, a failing `doctor` and a report without the field all refuse (Python and extension tests). |
| No partially started agent session after a refusal | **Met.** The CLI refuses before any process starts. The extension refuses before a terminal is created and records no session; a refused Open AI Session restart types nothing. |
| The asynchronous Open AI Session restart handles cancellation, duplicate presses and closed windows | **Met after a fix in S-2's scope.** The first version did not guard a second press during the privacy question, so it could start the session twice. It now ignores a second press while the CLI is asked, and starts nothing if, meanwhile, the window closed, another work item opened, a new attempt started or the session was started again. Two new tests fail without the guards (mutation-checked) and pass with them. |
| No unauthorized filesystem change | **Met.** The check, `doctor`'s report and a refused launch leave the data folder and the repository unchanged, permission bits included (new test). `verify_private` only reads. |
| Normal private folders stay usable | **Met** on Windows: the default data folder and every test home pass. Linux and macOS are confirmed by the coming CI run. |

**S-2's accepted limitations (owner-accepted with the decision):**
- The folders above the data folder are not checked, as for credentials.
- macOS extended ACLs are not read.
- A volume without access lists (FAT, exFAT, some network shares) answers `unverifiable`, so it gets no grant.
- The extension adds one `doctor --json` call before each grant, and Open AI Session's restart waits for it.
- An agent that is given no folder (Codex, Copilot, a custom command, an extension bridge) still reads `task.md` from a data folder that may not be private. `doctor` reports it; the handoff does not enforce it.

### The remaining findings, classified

None is Critical or High, and none breaks an approved security contract. ST-3 is a gap in the contract's record, not in its security. None blocks this RC on its own. They are not implemented here.

| ID | Severity | Impact | Current evidence | Blocks this RC? |
|---|---|---|---|---|
| D-7 | Low | Upgrade notes omit `BUGPILOT_CONFIG_DIR`'s retirement (the CLI warns in text mode) | README, changelog | No |
| D-8 | Low | The lists of no-longer-read files differ between documents | changelog, extension README vs README | No |
| D-9 | Low | The extension README says a branch switch or pull changes settings | `extension/README.md`, the watcher section | No |
| D-10 | Low | — | Resolved in this batch: the `.claude/` limitation is in the README, extension README and changelog (§15, D-3) | No |
| D-11 | Low | The `EXTENSION_OUTDATED` heuristic's main false positive is not named in the README | README's upgrade note | No |
| D-12 | Low | Paragraphs on mixed 0.1.2-era versions describe files 0.1.7 no longer reads | README, extension README | No |
| D-13 | Low | `docs/safety.md` says hand-off happens "by default" and mentions a team file in a checkout | `docs/safety.md` lines 3 and 59 | No |
| D-14 | Low | Skill and MCP setup docs: no note on access outside the repository; 7 of 9 tools listed; stale names | `SKILL.md`, `docs/skill_setup.md`, `docs/mcp_setup.md` | No |
| D-15 | Low | No advice to keep `.ai/` ignore rules until the old folders are deleted | changelog | No |
| S-3 | Low | The managed runtime pins a version, not a hash | `managedRuntime.ts`; pre-existing since 0.1.1 | No |
| S-4 | Informational | `issue-details` puts an unvalidated key into a same-origin Jira GET | `cli.py`, `jira.py` | No |
| S-5 | Informational | No size or depth limit on Jira responses: local denial of service | `jira.py`, `jira_adf.py` | No |
| S-6 | Informational | `git status` without the `core.fsmonitor` hardening; within Workspace Trust | `git_ops.py` | No |
| S-7 | Informational | `user_feedback.md` written with a plain `writeFile`; same-user, in a private folder | `ports.ts`, `sessionReset.ts` | No |
| ST-3 | Low | §8.10's contract tests were never written, and several §8.10 keys are absent with no recorded withdrawal. 0.1.7's record says the fixture was "not extended; the JSON fields are documented here". Recording the withdrawal is the owner's call. | plan 0.1.7 section; `doctor.py`, `cli.py` | No |
| ST-4 | Informational | Global storage refuses a data folder inside a Git working tree, not inside any folder; credentials are still written only where proven private | `storage.py`; plan "Known gaps" (other version-control systems) | No |
| ST-5 | Informational | A few existence checks in the data folder follow links; no content is exposed | `cli.py`, `workflow.py` | No |
| ST-6 | Informational | The dormant `.gitignore` writer remains (recorded follow-up) | `controller.ts`, `gitignore.ts` | No |
| ST-7 | Low | The no-repository-write record covers 22 commands, not every command or MCP tool | `tests/storage_baseline.py` | No |
| R-1 | Informational | A failed preparation leaves `run.json` and a skeleton `issue.json`, as in 0.1.6 | the MCP acceptance (§4) | No |

### Pre-commit checks made before the stop

- Branch `verify/0.1.7-storage`, HEAD `d05c025`. The change set is the 28 reviewed paths; the relaunch guard and its tests changed files already among them.
- The owner's three paths: untouched. Baselines and goldens: unchanged.
- Since the guard change:
  - the extension's unit tests pass, 2,386 passed and 1 skipped, and the typecheck is clean;
  - the launcher and publishability tests pass, 100 passed.
- The full Python suite (4,201 passed, 0 failed) ran before the guard change. That change touched only the extension and one new Python test.

**Decision needed from the owner:**
1. **S-8:** implement the recommended remediation in this commit; or accept S-8 as documented, with its precondition, and commit as is; or another course.
2. Then the commit and push, as approved.

## 17. S-8 fixed, and the remediation commit (2026-10-29)

**Status: S-8 FIXED BY THE OWNER'S DECISION; EVERY CONDITION OF THE COMMIT APPROVAL MET; COMMITTED WITH THIS RECORD AND PUSHED TO `verify/0.1.7-storage` FOR CROSS-PLATFORM CI. RC BLOCKED** until all nine CI jobs pass and the follow-up review is complete. **Public distribution: UNRESOLVED.**

**The owner's decision.** Fix S-8 in this commit. The commit therefore holds the 28 reviewed paths and the 8 more that the fix needs.

**The fix:**
- `executables.find_program(name)` is `find_executable` on every system but Windows. There it accepts only native executables (`.exe`, `.com`): a batch file earlier on `PATH` is passed over for the program further along, and a name with only a batch file is not found.
- `batch_file_only` and `not_found_sentence` give the reason.
- Every start of `git` or `rg` uses it: `git_ops.run_command`, `search._run_rg`, `review_changes`, and Git history's two direct starts. `doctor`'s `git_available` and `rg_available`, and the availability checks before code search and Git history, ask the same question.
- When only a batch file is there, the code-search and Git-history warnings say why.
- Agents keep the general lookup: the launcher's own batch-file path is gated by S-1.
- The extension starts every process without a shell (Node refuses a batch file there), and its terminal handoffs pass the prompt gate.
- So S-1's condition now holds: the shell risk has no other path.

**Files:**
- product: `bugpilot/core/executables.py`, `git_ops.py`, `search.py`, `git_history.py`, `review_changes.py` and `doctor.py`;
- tests: `tests/test_executables.py`; `tests/test_git_history.py` and `tests/test_workflow.py`, whose availability stubs now name `program_available`, intent unchanged;
- docs: the README and `docs/safety.md`.

**Regression coverage** (`tests/test_executables.py`, Windows' lookup simulated on every system):
- a `.cmd` or `.bat` file earlier on `PATH` is passed over for the program;
- a batch-file-only `git` or `rg` is not found, with the reason, and is refused by name with its extension and by absolute path too;
- `run_command` and `_run_rg` start nothing and say why;
- a missing program is still just "not found";
- other systems are unchanged;
- a source scan guards that no `git` or `rg` start uses the general lookup.

**Mutation check:** with the native-only lookup switched off, 5 of these tests fail. The 2 that pass do not depend on it.

**Verification (Windows, the committed tree):**

| Check | Result |
|---|---|
| Python, the whole suite | 4,210 passed, 91 skipped, 0 failed; the tree was unchanged during the run |
| S-8's tests (`tests/test_executables.py`) | 18 passed; 5 of them fail with the native-only lookup switched off |
| The modules S-8 touches, and those that stub availability | 472 and 373 passed |
| The extension's unit tests; typecheck | 2,386 passed, 1 skipped, 0 failed; clean |
| The extension's CLI integration tests | 21 of 21 |
| Extension × CLI compatibility (a wheel of this tree; the released 0.1.6 CLI) | 5 of 5 |
| CLI clean install; MCP | 38 of 38; 11 of 11 |
| The refusal matrix | 62 of 62 |
| End to end: a real `cmd.exe` batch shim with a plain path; a real access-list grant | 8 of 8 |
| The plan checker; publishability | 0 problems; passes |

No account-using AI session was run.

**Before the commit:**
- the branch was `verify/0.1.7-storage`, with parent `d05c025`;
- the commit holds exactly the 36 paths listed in the plan;
- the owner's three paths are untouched;
- baselines and goldens are unchanged;
- the added lines hold no secret, personal data, temporary file or build output.
