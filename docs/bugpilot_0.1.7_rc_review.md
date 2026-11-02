# BugPilot 0.1.7 — Release-Candidate Review

| | |
|---|---|
| **Reviewed commit** | `d05c0253943785b328fa12a280c34bef3b1554e5` (branch `verify/0.1.7-storage`), tree `0b80a3d05b693756612d61d554c12249d6b513af` |
| **Date** | 2026-10-29 |
| **Kind of review** | Release-candidate review, verification and documentation only. Nothing was changed in the product, staged, committed, pushed, merged, tagged, published or released. |
| **Technical classification** | **RC BLOCKED**: documentation defects in the shipped READMEs, and owner-only acceptance not done (§12, §14). *(Later on 2026-10-29: the owner's remediation batch — D-1 to D-6, S-1, S-2, U-1, ST-1, ST-2 — is fixed locally and verified on Windows, uncommitted (§15). Still **RC BLOCKED** until a corrected candidate commit passes cross-platform CI and its follow-up review.)* *(Later: the conditional commit approval's checks stopped on a new finding, S-8: no commit; a new owner decision is needed (§16).)* *(Later: the owner decided to fix S-8 in this commit; it is fixed, every condition is met, and the remediation is committed with this record and pushed for cross-platform CI (§17). Still **RC BLOCKED** until all nine CI jobs pass and the follow-up review is complete.)* *(Later on 2026-10-31: CI run 41068475707 passed 9 of 9 on `35040af`. The follow-up review found F-1: the extension's privacy check stops short of the work item's own folder. **RC BLOCKED** pending the owner's decision on its remediation (§18).)* *(Later on 2026-11-01: F-1, F-2 and F-3 remediated with the owner's Option A′, verified on Windows, and committed with this record on the owner's approval. Still **RC BLOCKED** until all nine CI jobs pass on that commit and a short final RC review is done (§19).)* *(Later on 2026-11-01: CI run 41351728876 passed 9 of 9 on `9fe8a8a`. The final RC acceptance found no blocker; three required scenarios need the owner's desktop: **RC REVIEW INCOMPLETE** (§20).)* *(Later on 2026-11-01: the owner reported A-1 to A-5 and A-7's steps 1–3 PASS on the owner's desktop and approved `9fe8a8a` as 0.1.7's technical release candidate: **RC TECHNICALLY READY** (§21). A-6 and A-7's step 4 are not tested.)* |
| **Public-distribution authorization** | **UNRESOLVED**: release-governance decisions are the owner's (§13) *(Unchanged by the owner's technical approval of `9fe8a8a`: G-1 and G-3 unresolved, G-2 awaiting the owner's confirmation (§21).)* |

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

## 18. Final RC follow-up review of `35040af` (2026-10-31)

**Status: RC BLOCKED. One new finding, F-1, leaves the extension's S-2 privacy check narrower than the owner-approved S-2 condition and than three shipped documents state. A minimal remediation is proposed and awaits the owner's approval. Everything else in this follow-up passed: CI 9 of 9 on the exact commit, the rebuilt artifacts, the clean installs, and the real-window checks this environment can run. Manual acceptance is incomplete. Public distribution: UNRESOLVED.**
- Nothing was changed in the product, staged, committed, pushed, merged, tagged, published or released by this review; this report and the plan's record are its only edits.
- This is an internal review by the developer's AI assistant, with one independent read-only pass by a second AI reviewer that was given the code, not this review's conclusions. It is **not** an independent or external security audit.

### The candidate

| Item | Value | Verified by |
|---|---|---|
| Branch | `verify/0.1.7-storage` | `git branch --show-current` |
| HEAD | `35040af7961e67e59a2a748e69af2353b3f68fc9` (parent `d05c025`), "fix(storage): complete 0.1.7 RC remediation", 36 paths | `git rev-parse HEAD`, `git show --stat` |
| Tree | `d6dba0a1cd01fc0f14cfb4bc94966acf37570183` | `git rev-parse HEAD^{tree}` |
| Origin's branch | `35040af`, the same commit | `git ls-remote origin`, at the start and again during the review |
| Origin's `main` | `7feeaf7`, untouched | `git ls-remote origin` |
| Tags on origin; GitHub releases | none; none | `git ls-remote --tags`; the public API |
| Working tree | the candidate, plus the owner's three unrelated paths, which were not opened | `git status` |
| Approved baselines | U7-1 to U7-142, each `approved: 2026-10-29`, unchanged. Since `59db0b4`, no file under `tests/baselines/` or `tests/golden/` and no approval record changed. The baseline normalizer (`tests/storage_baseline.py`) changed in `d05c025` only, not in this commit. | `git diff 59db0b4 35040af -- tests/baselines tests/golden`, `git diff --name-only d05c025 35040af`, the record |

### CI evidence: run 41068475707

Dispatched by the owner on `verify/0.1.7-storage` at `35040af`. Read from the public API (the run, its jobs, and each job's annotations); the job logs need a sign-in and were not read. Every annotation is a notice. The counts below are the owner's, confirmed against the jobs' summaries.

| Job | Result | Tests |
|---|---|---|
| Full Python suite (windows-latest) | success | 4,207 passed, 93 skipped, 1 deselected |
| Full Python suite (macos-latest) | success | 4,155 passed, 95 skipped, 1 deselected |
| Full Python suite (ubuntu-latest) | success | 4,151 passed, 99 skipped, 1 deselected |
| Safety suite, Windows | success | 2,120 passed |
| Safety suite, macOS | success | 2,076 passed |
| Safety suite, Ubuntu, Python 3.10 and 3.13 | success, success | 2,072 passed each |
| The extension's unit tests | success | 2,387 tests: 2,385 passed, 2 skipped |
| Evidence boundary | success | 27 passed |

- **Against run 40969753479 (`d05c025`):** every full Python job has 63 more passing tests and the same skips; each safety job has 6 more; the extension has 12 more. That is the remediation's new tests, running on every system.
- **S-2's open condition, "normal private folders stay usable", now holds on Linux and macOS.** The new tests are not skipped on any system. `test_doctor_reports_whether_the_work_folders_are_private` runs the real check and expects `private` for an ordinary prepared folder. The grant tests stub only `subprocess.run`, not the check. The real-folder refusal test opens the folder to other accounts with `icacls` on Windows and mode `0777` elsewhere.
- **Green CI is not taken as proof of the manual workflows.** They are in the checklist below.

### The remediation commit, reviewed

**Method:**
- my own reading of `git show 35040af` against the brief's areas;
- one independent, read-only review by a second AI agent. It was given the commit and the areas, not this review's conclusions, and ran no tests.

Every finding it reported was checked here against the code. F-1 and F-5 were also measured on scratch folders, with an access-list grant and a plain path with a space; no hostile input was used.

| Area | Result | Evidence |
|---|---|---|
| Windows executable discovery and shell safety (S-8, S-1) | **Sound for what the commit changes**, with F-3 and F-4 below and the pre-existing F-5 | `find_program` applies only on Windows. An absolute path must end in `.exe` or `.com`. A bare name tries only `name.exe` and `name.com`. Every start of `git` or `rg` uses it (`git_ops.run_command`, `search._run_rg`, `review_changes`, Git history's two starts). Nothing else in `bugpilot/` starts a process except the launcher, and the extension starts nothing through a shell. The launcher's gate runs before `subprocess.run` and checks the batch file's path, every option and the prompt. |
| Private work-folder permissions (S-2) | **The CLI launcher: sound. The extension: does not judge the work item's own folder (F-1).** | The launcher's check runs before the de-duplication, so a grant in `BUGPILOT_CLAUDE_ARGS` cannot bypass it. Link refusal and containment come first, and an unprovable answer is a no. End to end: 8 of 8. |
| No unintended filesystem changes | **Sound** | `privacy()` and `check_private_for_agent` only read. `attachments/` is made lazily, by storage. Refusals change wording only. The CLI and MCP acceptance and the real window found nothing written into a repository. |
| Open AI Session's asynchronous restart | **Sound for duplicate presses, a closed window, a switched work item, a new attempt, and a session already started again**, with F-2 below | The in-flight guard and the checks after the wait. `#workFolderPrivacy` never rejects. `openSession` has one caller, inside `handle()`, whose rejections `extension.ts` catches. |
| The policy refresh race (U-1) | **Sound; confirmed in a real window** | Requests during a read share one follow-up read, which starts after it. Errors are swallowed only for the follow-up; disposal is checked; there is no unbounded loop. A caller that awaits always gets a read that started after its request. Policy runner: 19 of 19. |
| Extension and CLI compatibility | **Sound**, with F-6 below | `doctor --json` gains only `storage.privacy` and `storage.privacy_problem`; no existing key changes. On Windows only, a batch-file-only `git` or `rg` now reports as unavailable, as intended. Compatibility 5 of 5; the released 0.1.6 extension 9 of 9. |
| Unified Storage contracts | **Sound** | No new module imports `storage`, and `private_folder` is still imported only by `storage`. `DATA_ROOT_BOUNDARY` holds the same string. No error code changed. Every writer ST-2 rewords writes inside the data folder. The storage inventory gains one path helper, as approved. |
| Documentation accuracy | **Accurate, except F-1's coverage statement and F-3** | The S-1, S-8 and D-1 to D-6 texts match the code. |
| Tests | **They exercise the fixes** | The mutation checks in §15 to §17 hold, and the second reviewer's reading agrees. Not covered: F-1, F-2, and a work-item switch during Fix with AI's privacy question. |

**New findings.** No Critical or High finding.

| ID | Severity | Class | Finding | Evidence | Smallest remediation | Blocks the RC? |
|---|---|---|---|---|---|---|
| F-1 | **Low in the code; Medium as documented** | Verified by code reading; measured on Windows | **The extension's privacy answer stops one folder short of the work item's own.**<br>The CLI launcher's check (`check_private_for_agent`) judges the data folder, `repositories`, the repository's folder, `work` and `work/<id>`. The extension's only check is `doctor --json`'s `storage.privacy` (`RepositoryStorage.privacy()`). That judges down to `work` and runs no containment check.<br>So the extension gives Claude a work item's folder that other accounts can write to, below private parents, while the CLI refuses it. This needs a non-default permission on that one folder (set by hand, by a tool, or by a restore) and another local account.<br>The S-2 condition the owner approved, and three shipped documents, say every folder down to the work item's own is checked, on both paths. | **Code:** `storage.py`, `privacy()` (`self._places(("work",))`) against `check_private_for_agent`.<br>**Measured:** with a write grant for Everyone on `work/JR-12345` only, `doctor --json` answers `private`, and `--launch-agent claude` refuses ("is not private").<br>**Documents:** README:290 ("the same privacy question"), README:292 ("keeps other accounts from planting one"), the extension README, lines 135–136, and `docs/safety.md:114`. | See the proposal under "Classification" | **Yes.** It narrows an owner-approved security condition (S-2) on the main path, and the shipped documents overstate it. The owner decides. |
| F-2 | Low | Verified by code reading; new in this commit | Open AI Session's restart reads the terminal's state (`exited`) and then waits for the privacy answer, up to 60 s. It then types the resume line into that terminal without reading its state again. If the developer starts anything in that terminal meanwhile, BugPilot's line is typed into it as input. Not a security issue: the line is BugPilot's own, and plain. | `controller.ts`, `openSession` (reads `terminalActivity`) and `#relaunchSession` (waits, then `sendToTerminal`); `agentTerminals.ts`, `sendToTerminal` (no re-check) | After the wait, when the terminal is to be reused, read its state again: `exited`, type; `closed`, start a new terminal; anything else, bring it forward and say so. | No |
| F-3 | Low | Verified by code reading; missed by S-8's scope | `bugpilot setup` reports "✓ Git" or "✓ ripgrep" when only a batch file is on `PATH`, while `doctor` and every run treat the tool as missing (README:296). Nothing is started. | `setup.py`: `_report_tool` uses `command_available` | Use `program_available` for `git` and `rg` | No |
| F-4 | Informational | Verified by code reading | `_cmd_exe_problem` recognizes a `cmd.exe` launch by the argument list's shape. A different shape would count as no problem. Today the only producer always matches. | `agent_runner.py`: `_resolve_launch_command`, `_cmd_exe_problem` | Decide "through `cmd.exe`" in one place, and refuse a batch file whose launch has an unexpected shape | No |
| F-5 | Low | Verified on Windows; pre-existing (the same construction in 0.1.4 and 0.1.6) | **`--launch-agent` through a batch file whose own path holds a space fails.** `cmd.exe /c` drops the outer quotes and runs the path up to the space ("… is not recognized …"). This hits an npm `claude.cmd` under a Windows profile folder whose name has a space. The usual unquoted-path consequence, that a program named like the truncated path runs instead, needs write access to that folder's parent, which standard users do not have on Windows' profiles folder. | **Measured:** the same stand-in runs from a plain path and does not run from a folder whose name has a space. | Refuse such a batch file with a clear message, or build the `/s /c` command line with one outer pair of quotes | No: the deprecated, opt-in launcher |
| F-6 | Informational | Verified | A 0.1.7 CLI built before this commit reports no `storage.privacy`, so the extension refuses every Claude CLI grant with "bugpilot did not say whether …", without suggesting an update. Only unreleased builds are affected. | `dataFolder.ts`, `workFolderPrivacyOf` | None needed for the release; or a capability | No |
| F-7 | Informational | Verified | Two tests patch `agent_runner.sys.platform`, the interpreter-wide `sys.platform`, restored after each test. On Windows, the real S-2 tests rely on the temporary folder's inherited access list being private. That holds on GitHub-hosted runners, but may not on a self-hosted agent. | `tests/test_agent_runner.py` | Patch `_is_batch_shim` instead; note the runner assumption | No |

**A correction to §16, recorded here rather than made silently.** §16 recorded S-2's condition "Unknown or unsafe privacy refuses the grant" as met.
- For the CLI launcher it is.
- For the extension it holds from the data folder down to `work/`, but not for the work item's own folder (F-1).

§16 is left as written.

### Release artifacts, rebuilt

Built from a clean `git archive` export of `35040af` (no working-tree file), outside the repository: `python -m build` for the wheel and sdist, `npm run package` for the VSIX. Not published.

| File | Bytes | SHA-256 |
|---|---|---|
| `bugpilot-0.1.7-py3-none-any.whl` | 408,138 | `4a7c9f614f67d8e3b3b82f30bab8aa651f423f98090fdb5932fda6353d28d384` |
| `bugpilot-0.1.7.tar.gz` | 390,750 | `467ba15ad8515d0be316522fd39d40521e7ff37b8df201f3bece4aef8c27b7c8` |
| `bugpilot-0.1.7.vsix` | 579,398 | `a397c87848053b05f58f06c2b8b53d8dafede65270ccbf0acb6b893b2922925f` |

| Check | Result |
|---|---|
| `twine check --strict` (wheel, sdist) | PASSED, PASSED |
| Version | 0.1.7 everywhere: the wheel's metadata and `bugpilot.__version__`, the sdist's `PKG-INFO`, the VSIX's `package.json` and manifest |
| Members | wheel 71, sdist 77, VSIX 89; no tests, caches, logs, maps, keys, `.bugpilot/`, `.ai/`, `.vscode/` or `node_modules/` |
| Licence and metadata | `LICENSE` in the wheel (`dist-info/licenses/`) and the sdist, `LICENSE.txt` and `THIRD_PARTY_NOTICES.md` in the VSIX, none changed by this commit; `License-Expression: BUSL-1.1`; the extension's `SEE LICENSE IN LICENSE.txt`, repository URL and engines (`vscode ^1.90.0`, unchanged `package.json`); entry points `bugpilot` and `bugpilot-mcp`; no runtime dependencies (`mcp` and `test` are optional extras) |
| Private data and credentials | none: the publishability scan (the private word list read in place), credential patterns, e-mail addresses and local paths. The one pattern hit, as in the first build, is the README's generic example path under `/home/you/`. |
| Against the first RC build (`d05c025`) | the same member names in all three. Changed members: the 13 Python modules the commit changes; the 4 extension modules (`agents`, `controller`, `dataFolder`, `extension`); the README, extension README and changelog; the metadata that carries the README. Nothing else. |

### Clean installs

| Check | Result |
|---|---|
| CLI: a new venv, the rebuilt wheel only, no index | installs; `bugpilot --version` is `bugpilot 0.1.7`; imported from `site-packages` |
| CLI acceptance (isolated home, data folder and repository) | 38 of 38 |
| MCP: a new venv, `bugpilot[mcp]` from the rebuilt wheel, its dependencies resolved from PyPI (`mcp` 2.3.0) | installs; `pip check` clean; bugpilot 0.1.7 imported from `site-packages` |
| MCP acceptance (raw JSON-RPC over stdio) | 11 of 11 |
| End to end: a real `cmd.exe` batch shim with a plain path; a real access-list grant | 8 of 8 |
| Extension × CLI compatibility (this wheel; the released 0.1.6 CLI) | 5 of 5 |
| The refusal matrix (the source tree, whose `bugpilot/` equals `35040af`) | 62 of 62 |

*Harness note.* A diagnostic line printed from the repository's root first read a stale, ignored `bugpilot.egg-info` there (version 0.1.0); rerun from a neutral folder with `python -I`, both venvs report 0.1.7 from `site-packages`. The acceptance scripts start the installed executables with a synthetic repository as their working directory, so their results are unaffected.

### Real VS Code, disposable

The first review's harness, unchanged, on a fresh profile, project and home:
- a disposable standalone VS Code, with its own user data, extensions folder and home;
- no BugPilot on `PATH`, and no Jira, `BUGPILOT_*` or `VSCODE_*` variables;
- the rebuilt VSIX installed;
- the managed runtime installed offline, from a folder holding only the rebuilt wheel.

It drives the window through VS Code's extension API: commands, editors, the output channel's log on disk, the clipboard, and a test host. It cannot press the webview's buttons, and no terminal process starts in this sandbox.

| Runner | Result | What it shows |
|---|---|---|
| Runtime | **13 of 13** | No runtime before; **Install Runtime** builds it in the extension's storage from the rebuilt wheel; `doctor --json` without the 0.1.7 declaration is refused with `EXTENSION_OUTDATED`; the runtime's CLI lists `unified-storage`; the repository's folder is in the data folder and not created yet; the repository holds no BugPilot folder. |
| Main | **26 of 28** | Both work items prepared in the data folder; **Show Work Item**, **Open Artifact**, **Open task.md** and **Refresh Results** open only the work items' own files; `task.md` names its work folder and report absolutely; invalid and never-prepared ids are handled and create nothing; the planted 0.1.6 `.ai/` and `.bugpilot/` are untouched; no `.ai_memory/`. The 2 failures are **Copy Handoff Prompt**'s clipboard checks: the clipboard probe below reads nothing back in this window. |
| Policy | **19 of 19** | For the Verification Policy and AI Behavior: Edit's command writes the file in the data folder's `settings/`; it opens in an editor from there; the watcher sees it created, changed and removed; the panel rereads it through the CLI after each change. **The editor save during a reread is now reread (2 lines flagged): the check U-1 failed in both of the first review's runs passes.** Nothing written into the repository; the 0.1.6 `.bugpilot/verification.md` is neither read nor changed. |
| Fix with AI (Claude CLI stand-in first on `PATH`) | **5 of 9** | Passes: Fix with AI runs; the extension's flag probe finds `--add-dir`, `--session-id` and `--resume`; the work item's terminal is created; nothing is written into the repository. **S-2's allowed path in a real Extension Host:** the terminal is created only after the extension asked the managed runtime's CLI whether the data folder is private and got `private` (the handoff's log line is written inside the launch, which follows the check). The 4 failures need a running terminal: whether `claude` received `--add-dir=<folder>`, `--session-id` and the prompt is **not observed**, as in the first review. |
| Restart (a normal window, quit through VS Code's own Quit, reopened) | **2 of 2; 2 of 2** | After the restart, the work item shown before opens again from the data folder. |
| The released 0.1.6 extension (SHA-256 `38131c90…`) with this CLI first on `PATH` | **9 of 9** | 0.1.6 activates; its Doctor shows the CLI's `EXTENSION_OUTDATED` sentence (update both together); its run is refused before anything is prepared, in the data folder or in `.ai/`. |
| Clipboard probe | **not usable** | `writeText` then `readText` returns nothing in this window. **Copy Handoff Prompt** runs, but what it copies cannot be read back here. |

### The Low and Informational findings, re-evaluated

Each finding §16 classified as non-blocking was checked against `35040af`. Severities are as recorded; none is reclassified.

| ID | Severity | The remediation's effect | Release-blocking now? |
|---|---|---|---|
| D-7, D-8, D-9, D-11, D-12, D-13, D-14, D-15 | Low | None: their texts are as before (each marker counted in its document, `d05c025` against `35040af`) | No |
| D-10 | Low | Resolved by D-3 (§16) | No |
| S-3 | Low | None: `managedRuntime.ts` is unchanged, and its compiled file is identical in both VSIX builds | No |
| S-4, S-5 | Informational | None: `cli.py`, `jira.py` and `jira_adf.py` are unchanged | No |
| S-6 | Informational | None in substance: `git_ops.py` changed only its lookup and its not-found sentence. `git status` still runs without `core.fsmonitor=false`. Nothing matched on the old sentence. | No |
| S-7 | Informational | None: `ports.ts` and `sessionReset.ts` are unchanged | No |
| ST-3 | Low | Slightly wider: `doctor --json` gains two fields, still without §8.10's contract tests. They are additive and covered by unit tests. | No |
| ST-4, ST-6 | Informational | None | No |
| ST-5 | Informational | None. The new `privacy()` tests existence with `lexists`, which does not follow links. | No |
| ST-7 | Low | None. The new reads have a test showing they change nothing (S-2). | No |
| R-1 | Informational | None | No |
| N-2 (owner-accepted) | — | S-2 was to keep other accounts from planting a `.claude/` folder. For the extension that holds down to `work/`, not in the work item's own folder (F-1). The acceptance itself is unchanged. | Only through F-1 |

**None of the earlier Low or Informational findings becomes release-blocking because of the remediation.** This review's blocker is new: F-1.

### Manual acceptance checklist

**How results are marked:**
- **PASS:** run in a real VS Code window on the rebuilt candidate in this review, and every expected result held.
- **FAIL:** run, and an expected result did not hold.
- **NOT TESTED:** this review's harness cannot reach it (the webview's buttons and forms; the test window's clipboard). The owner can run it in an ordinary VS Code window without any further approval.
- **BLOCKED:** it needs something this review does not have, which the owner must provide or approve:
  - a terminal in which a real agent runs (none starts in this sandbox), which is an account-using run needing approval for each run (G-5);
  - Jira test credentials;
  - the owner's list of supported agent combinations.

A PASS for a step's command path does not make its button PASS: the table names which was run.

**Setup, once (synthetic data only):**
1. **Artifacts.** Use the rebuilt candidate files, and check their hashes against "Release artifacts" above before installing: `certutil -hashfile bugpilot-0.1.7.vsix SHA256` (and the same for the wheel).
2. **A VS Code profile of its own.** `code --profile bugpilot-rc --install-extension C:\path\to\bugpilot-0.1.7.vsix`, then open that profile. No other BugPilot version is installed in it.
3. **The CLI.** 0.1.7 is not on PyPI, so either:
   - install the candidate wheel into a virtual environment and set **BugPilot: Choose Executable** to its `bugpilot.exe`; or
   - before starting VS Code, set `PIP_NO_INDEX=1` and `PIP_FIND_LINKS=C:\path\to\folder-with-only-the-wheel`, then run **BugPilot: Install Runtime**.
4. **A synthetic repository.** In an empty folder such as `C:\path\to\bp-accept`:
   - `git init`;
   - create `src\record.py` holding `def save_record(record):` and, indented on the next line, `return record["id"]`;
   - `git add -A`, then `git commit -m initial`.
   Open the folder in the profile from step 2.
5. **The data folder.** The default is `%USERPROFILE%\.bugpilot`. If your user name holds a character outside ASCII letters, digits, spaces and `. , : # / _ -`, set `BUGPILOT_HOME` to a plain folder that only your account can write to, such as `C:\bp-data`, before starting VS Code.
6. **The log.** **BugPilot: Show Log** shows what the extension ran. Keep it open for M-2 and M-3.

| # | Scenario | Exact steps | Expected | Status in this review | Evidence |
|---|---|---|---|---|---|
| M-1 | The normal bug-description workflow | 1. Click the BugPilot icon in the activity bar. 2. In **Issue**, type `save_record raises KeyError when the record has no id field`; the Issue row says "Bug description". 3. Leave **Fix with AI** unticked; press **Run**. 4. In **Results → Current**, open `context.md` and `task.md`. 5. In a terminal: `git -C C:\path\to\bp-accept status --porcelain`. | The run ends without an error. Both files open from `<data folder>\repositories\bp-accept-<16 hex>\work\<work item>\`. With `rg` on `PATH`, the context names `src/record.py`. `git status` prints nothing. | **NOT TESTED** (the Issue field and Run are in the webview) | The same preparation, through the extension host's CLI in a real window: PASS (main runner, both work items in the data folder; nothing in the repository) |
| M-2 | Fix with AI in a real terminal (Claude CLI) | Needs the owner's approval for an account-using run (G-5). 1. **Advanced Settings → Fix with AI → AI Agent**: **Claude CLI**. 2. Tick **Fix with AI**; press **Run** (or **Fix with AI** on an item already prepared). 3. In the terminal VS Code opens, read the command typed. 4. In Claude, ask it to write `fix_report.md` in the work folder. **Variants:** (a) the native `claude.exe` first on `PATH`; (b) only the npm `claude.cmd`; (c) `BUGPILOT_HOME` set to a folder other accounts can write to (for example after `icacls C:\path\to\shared-data /grant *S-1-5-32-545:(OI)(CI)M`; afterwards `icacls C:\path\to\shared-data /remove:g *S-1-5-32-545`), then prepare again and press Fix with AI. (d) F-1: the same grant on the work item's own folder only (`<data folder>\repositories\bp-accept-<16 hex>\work\<work item>`), then Fix with AI. | One terminal named for the work item; the command is `claude --add-dir="<work folder>" --session-id <uuid> "<prompt>"`, the prompt naming the absolute `task.md`. (a) Claude writes `fix_report.md` without asking, and a **Fix result** row appears. (b) No `--add-dir`; Claude asks before writing in the work folder. (c) Nothing starts: no terminal, and the panel says the folder "is not private" (or "cannot confirm that … is private"). (d) As (c) once F-1 is fixed; **on this candidate the folder is given (F-1)**. | **BLOCKED** (no terminal host here; a real run uses an account and needs approval) | Fix with AI runner, 5 of 9: the extension asked the CLI about privacy, got `private`, and created the work item's terminal; what `claude` received is not observed. (c): unit tests and the CLI end to end. (d): F-1, measured through the CLI |
| M-3 | Open AI Session, and its restart | After M-2 (a). 1. Press **Open AI Session** while Claude runs. 2. In the terminal, `/exit`; press **Open AI Session** again. 3. Repeat step 2, pressing twice within a second. 4. Repeat step 2, switching to another work item in **Results → History** right after pressing. 5. Quit VS Code; reopen the folder. | 1. The terminal comes forward and "AI session focused" shows; no second agent. 2. After a moment (BugPilot asks the CLI about privacy again), Claude starts again with `--resume <the same id>` and the same `--add-dir`, in the same terminal; the panel says so. 3. Exactly one start. 4. Nothing starts for the first work item. 5. The work item shown before opens again from the data folder; Open AI Session can only bring back an open terminal, as the README says. | **BLOCKED** (terminal); step 5 **PASS** | Step 5: the restart runner, 2 of 2 and 2 of 2. Steps 1–4: the extension's unit tests only (guards mutation-checked, §16) |
| M-4 | Verification Policy: Edit and Reset | 1. **Advanced Settings → Guidance & Verification → Verification policy → Edit**. 2. Under the default text, add the line `- Force push when the branch is behind.` and save. 3. Press **Preview**. 4. Press **Reset** and confirm. | 1. `settings\verification.md` opens from `<data folder>\repositories\bp-accept-<16 hex>\`, not from the repository. 2. Within a few seconds the row reports a line that may conflict with a BugPilot rule. 3. The preview holds the new line. 4. The file is deleted; the row shows the default; the repository is unchanged. | Buttons **NOT TESTED**; their commands, the editor and the files **PASS** | Policy runner, 19 of 19: Edit's and Reset's own CLI commands write and remove the file in the data folder; it opens in an editor from there |
| M-5 | Policy watcher freshness (U-1) | With the panel open and `verification.md` open from M-4: 1. Change the file and save twice within a second, with different text each time. 2. Change it, then switch focus to another window and back right after saving. 3. Change it from outside VS Code (Notepad) and save. | After each step, the row and the Preview show the last saved text within a few seconds, without another action. | U-1's case **PASS**; steps 1–3 as written **NOT TESTED** | Policy runner: an editor save while a reread is in flight is reread (2 lines flagged), in a real window |
| M-6 | Copy Handoff Prompt | 1. With a work item prepared, run **BugPilot: Copy Handoff Prompt**. 2. Paste into an editor. 3. Optionally (an account-using run, needs approval), paste it into an agent started by hand in `C:\path\to\bp-accept`. | 2. One line: `Read <data folder>/repositories/bp-accept-<16 hex>/work/<work item>/task.md and complete the workflow.`, with forward slashes, naming a file that exists. 3. The agent reads `task.md`. | **NOT TESTED** (the clipboard returns nothing in this test window) | The command runs (clipboard probe). The sentence it copies, `Read <work folder>/task.md and complete the workflow.`, is the prompt CLI acceptance checks on the launcher's argument list |
| M-7 | The Jira workflow | Needs a test Jira site with a synthetic issue and a test account's API token; never a production site or real tickets. 1. **Jira → Configure**: the test site, email and token; **Save**. 2. In **Issue**, type the synthetic key; press **Run**. 3. **Jira → Replace** with a wrong token; **Run** again. | 2. The work item is named by the key; `context.md` holds the synthetic issue's summary; nothing is written into the repository; the token never appears in the log. 3. "Authentication failed"; nothing new is prepared. | **BLOCKED** (no Jira test credentials; this machine's own Jira configuration is not to be used) | Jira transport and refusal tests in CI; the mock issue path in CLI acceptance |
| M-8 | An existing 0.1.6 extension with this CLI | 1. In a second profile, install the released 0.1.6 VSIX (SHA-256 `38131c90…`) and put this candidate's CLI first on `PATH`. 2. **BugPilot: Doctor**, then **Run** on the description from M-1. 3. The reverse: the 0.1.7 extension with the released 0.1.6 CLI as its executable. | 2. The CLI's `EXTENSION_OUTDATED` sentence (update the extension and the CLI together); the run is refused before anything is prepared; no `.ai/` and no work item are created. 3. The 0.1.7 extension refuses the 0.1.6 CLI and asks for an update. | **PASS** | Steps 1–2: the 0.1.6 runner, 9 of 9 (the 0.1.6 VSIX's SHA-256 checked). Step 3 and both directions: the compatibility matrix, 5 of 5 |
| M-9 | Agent selection and error handling | For each **AI Agent** choice (Auto-detect, Claude CLI, Codex CLI, Claude Extension, Codex Extension, Custom command): 1. With the agent not installed, press Fix with AI. 2. Run **BugPilot: Agent Check**. 3. With `BUGPILOT_HOME` set to a folder whose path holds a non-ASCII letter (for example `C:\path\to\bp-é`), prepare and press Fix with AI. 4. Installed agents: the owner's list of supported agent and provider combinations (plan §9.10), each an account-using run that needs approval. | 1. A message that names the missing agent; no terminal, no session recorded. 2. The output lists the agent CLIs BugPilot finds and whether each is ready. 3. Every agent refuses with the sentence naming `BUGPILOT_HOME` and Copy Handoff Prompt; nothing is typed. 4. As the owner's list says. | Steps 1–3 **NOT TESTED** in a real window; step 4 **BLOCKED** (the owner's list, plan §9.10) | The extension's unit tests for missing agents, the prompt gate and the refusal sentences; `agent-check` was not run |

### Classification

**Technical classification: RC BLOCKED.**
- **The blocker is new: F-1.** The extension's privacy check does not judge the work item's own folder. That is narrower than S-2 as the owner approved it, and than the README, the extension README and `docs/safety.md` state.
- **Everything else in this follow-up passed:**
  - CI 9 of 9, with the expected counts;
  - the rebuilt artifacts and their contents;
  - the clean CLI, MCP, VSIX and managed-runtime installs;
  - the compatibility checks;
  - the real-window checks this environment can run. U-1 is fixed in a real window, and S-2's allowed path works in a real Extension Host.
- **No Critical or High finding.** F-2, F-3 and F-5 are Low; F-4, F-6 and F-7 are Informational. None blocks on its own.
- **Manual acceptance is incomplete either way.** NOT TESTED: M-1, M-4's buttons, M-5 as written, M-6, and M-9 steps 1–3. BLOCKED: M-2, M-3 steps 1–4, M-7, and M-9 step 4. With F-1 resolved, the RC would be technically ready with these runs still outstanding.

**Proposed minimal remediation. Nothing is implemented; it awaits the owner's approval.**
- **Option A (recommended): make the extension's answer as wide as the CLI's.**
  1. `RepositoryStorage.privacy()` runs the same containment check as `check_private_for_agent`. It then judges, with the same `data-root` rule, the data folder down to `work`, and every existing folder directly under `work/` (each work item's own). A link there counts as not private.
     - The first folder not proven private answers, with its sentence.
     - It only reads, and never raises.
     - `doctor --json`'s fields and values keep their meaning; `private` simply covers more.
     - The extension is unchanged.
     - One consequence, failing closed: a single work item's folder that is not private refuses the grant for every work item in that repository until it is restricted. The sentence names the folder.
  2. **Tests:**
     - a grant on one work item's folder only makes `doctor` answer `not-private` (a real access list, or `0777`), as measured here;
     - a link under `work/` answers not private;
     - `doctor` still changes nothing.
  3. **Docs:** README:290's "the same privacy question" becomes "the CLI's answer, which covers BugPilot's data folder and every work item's folder in it". The other three statements are then accurate.
  4. **Recommended in the same commit,** each small and with a test: F-2 (read the terminal's state again after the wait) and F-3 (`setup` uses `program_available`).
  5. **Then:**
     - a new candidate commit on `verify/0.1.7-storage`, from an explicit path list;
     - the owner's CI dispatch;
     - rebuilt artifacts;
     - a short follow-up review of the change.
- **Option A′:** `doctor --json --work-item <id>` judges exactly that work item. It is precise, but it is a new CLI option the extension must pass, so it is more than the minimal fix.
- **Option B (documentation only):** say in README:290 and :292, the extension README (lines 135–136) and `docs/safety.md:114` that the extension's answer covers the data folder down to `work/`. Record the work item's own folder as an accepted S-2 limitation.
  - It is smaller, but it narrows the approved S-2 contract, which only the owner can decide.
  - It still needs a commit, CI and a short review.
- **Not recommended:** accepting F-1 with no change. The shipped documents would stay wrong about a security control.

**Public-distribution authorization: UNRESOLVED.**
- G-1 (ownership and employment policy) and G-3 (a qualified review of the licence parameters) have no recorded resolution.
- G-2 needs the owner's confirmation for 0.1.7.
- G-5 and G-6 are as in §13.
- Neither CI nor this review authorizes distribution, and the technical classification is RC BLOCKED in any case.

**Not done, as the brief requires:**
- nothing implemented, staged, committed, pushed, merged, tagged or published;
- no account-using AI session run;
- no Jira site used.

## 19. F-1, F-2 and F-3 remediated with Option A′ (2026-11-01)

**Status: IMPLEMENTED, VERIFIED ON WINDOWS, AND COMMITTED WITH THIS RECORD ON THE OWNER'S APPROVAL OF 2026-11-01; PUSHED TO `verify/0.1.7-storage` FOR CROSS-PLATFORM CI. RC BLOCKED until all nine CI jobs pass on this commit and a short final RC review is done. PUBLIC DISTRIBUTION UNRESOLVED.**
- **The owner's decision.** Option A′, with F-2 and F-3 in the same batch. Options A and B were not to be implemented.
- **Committed** from an explicit list of 28 paths, with the project's noreply identity, and pushed to `verify/0.1.7-storage` only. Nothing was merged, tagged, released or published. No account-using agent session was run. The owner's three paths were not opened, staged or changed.

### F-1: the extension asks about the work item's own folder

| Part | What changed |
|---|---|
| CLI | **`bugpilot doctor [--json] --work-item <id>`.** Without the option, the output is unchanged. With it, `storage` gains three keys after the existing ones:<ul><li>`work_item_id`, as asked;</li><li>`work_item_privacy`: `private`, `not-private` or `unverifiable`;</li><li>`work_item_privacy_problem`: one sentence, with display paths only.</li></ul>No existing key, value, exit code or error code changes. |
| Storage | **`RepositoryStorage.work_item_privacy(id)`.** The launcher's question for one work item, answered rather than raised, in one request scope:<ul><li>the id is validated;</li><li>containment (`_check_containment`);</li><li>every folder down to `work/<id>` is a real folder, never a link or junction (`_existing`, whose refusal marks the answer `not-private`);</li><li>the identity record is this repository's (`_check_record`);</li><li>the work item's folder is there;</li><li>then the `data-root` rule on the data folder and every folder down to `work/<id>`.</li></ul>That last loop is now `_first_not_private`, shared with `check_private_for_agent`. It reads only, creates nothing, and never lists `work/`. |
| CLI launcher | `check_private_for_agent` is unchanged in behaviour: containment, then the same chain, with the same sentences. Its loop moved into `_first_not_private`. |
| Extension | **The port asks `doctor --json --work-item <id>`** (`workItemPrivacyArgs`, for a validated id only). `workFolderPrivacyOf` accepts only `work_item_privacy: private`, for the same `work_item_id`, whose reported `repository_dir` plus `work/<id>` resolves to the folder the extension is about to give. Anything else is a no, in the CLI's words when it gave them.<ul><li>`storage.privacy` no longer decides a grant.</li><li>The question is now the last wait before the command line is typed, after the `--help` probes.</li><li>Open AI Session asks again, about the folder recorded with the session.</li></ul> |
| Documents | README (the extension's check; repository-level against work-item answers), the extension README, `docs/safety.md`, `docs/architecture.md`, the extension changelog, and the docstrings in `doctor.py` and `storage.py`. |

**The answers, as tested:**

| Situation | `work_item_privacy` |
|---|---|
| Every folder from the data folder down to `work/<id>` is private | `private` |
| Only the work item's own folder is writable by another account (the measured F-1 case) | `not-private`. `privacy` stays `private`, because it is repository-level. |
| A parent folder is writable by another account | `not-private`, naming the first such folder |
| A link or junction at `work/` or at `work/<id>` | `not-private` ("… is a symbolic link or junction"). Nothing is followed. |
| Another work item's folder is open | `private` for this one; the other folder is never looked at |
| The work item is missing, or the id is not one | `unverifiable`. Nothing is created. |
| No data folder yet | `unverifiable`. Nothing is created. |
| The record names another repository | `unverifiable`, with storage's sentence. The record is not rewritten. |
| The data folder is inside the repository | `doctor` fails closed as it does without the option (non-zero exit, one sentence) |
| The access list cannot be read, or the file system raises | `unverifiable` |

### F-2: Open AI Session types only into the terminal it waited for

- **Terminal identity.** The host's terminal port gains `terminalToken(matches)`, a number that names one terminal and no other for the window's life. `sendToTerminal(token, …)` types only into that terminal, and returns false once it has closed. It is never redirected by name.
- **The restart.**
  - It reads the token in the same turn as the activity that chose where to start.
  - While the CLI is asked, it holds the token, the work item, the session record, the restart count and the work-item generation (`#fixEpoch`, which a run, Reset Session or showing another work item changes).
  - In the turn that types or starts, it checks again: the same terminal, or still none; and, to type into it, its agent still exited.
  - Otherwise nothing is typed or started, and the panel says so: "The AI session's terminal changed while BugPilot was checking, so nothing was started. Press Open AI Session again."
  - Nothing is half-done: the restart count and the session are unchanged, and the next press decides again.
- **Repeated presses.** The existing in-flight guard is unchanged: one start, however often it is pressed.

### F-3: `bugpilot setup` looks for Git and ripgrep as every run does

- **Windows:** `setup` now uses `program_available` (`executables.find_program`) for `git` and `rg`.
  - A `.bat` or `.cmd` alone is reported as not found, with the sentence that says why.
  - A program later on `PATH` is found.
- **Agents:** `copilot` keeps the general lookup, as `doctor` does; the launcher gates its batch files itself (S-1).
- **Linux and macOS:** unchanged.

### F-5 and the informational findings

- **F-5 is documented, not fixed.** The README and `docs/safety.md` now state it as a known limitation: a batch-file agent whose own path holds a space cannot be started by `--launch-agent`. They give the workarounds: a native executable first on `PATH`, a folder without a space, or handing the line over by hand. The S-1 gate is not loosened.
- **F-4 and F-7 stay Informational,** unchanged.
- **F-6 is resolved** by the message correction below. With a 0.1.7 CLI built before this change, which has no `--work-item`, the extension refuses every Claude CLI grant and says to update bugpilot.
- **No new evidence** makes any of them a release blocker.

### The compatibility condition of the owner's approval

The owner approved the commit on 2026-11-01, on one condition: a new 0.1.7 extension paired with the previous, unreleased 0.1.7 CLI must safely refuse a Claude folder grant when `--work-item` is unsupported. It must neither fall back to the repository-level answer nor grant an unchecked folder. If the message misleads, the smallest correction, with focused tests; no broad compatibility mechanism.

- **Confirmed with the real `35040af` CLI** (the compatibility matrix):
  - it exits 2 with argparse's usage error and prints nothing on stdout, so the runner throws;
  - no folder is given, nothing is started, and `storage.privacy` is never read.
- **The message misled.** It read "BugPilot could not confirm that its data folder is private to you: bugpilot produced no output on stdout." That points at a permission problem, when the CLI is simply too old.
- **The correction, the smallest one:**
  - the port's few lines moved into `dataFolder.ts` as `askWorkFolderPrivacy`, so they are tested;
  - it recognizes only argparse's "unrecognized arguments: … --work-item";
  - for that, it answers a no: "This bugpilot cannot check a work item's folder (it has no doctor --work-item option). Update bugpilot to the version that came with this extension." The panel adds that Claude CLI was not started, and to use Copy Handoff Prompt;
  - every other failure is thrown, and the controller words it as a no, as before;
  - no capability, version check or other mechanism was added.
- **Tests:**
  - four in `dataFolder.test.ts`: the port asks once, with that work item; the old CLI's exact error gives the update sentence and nothing else is asked; any other failure is not taken for an old CLI; a failure envelope and an invalid id are a no;
  - one in `controller.test.ts`: Fix with AI starts nothing and shows the sentence;
  - the integration test now drives `askWorkFolderPrivacy` over the real CLI;
  - the compatibility matrix checks the exact sentence with the real `35040af` CLI.
- **Mutations:** both killed. Removing the detection fails the update-sentence test. Taking any error for an old CLI fails the other-failure test.
- **No new path.** `dataFolder.ts`, `extension.ts` and the three test files were already among the 28.
- **Older builds too.** A 0.1.7 build before `35040af` has no `--work-item` either, so it gets the same sentence. 0.1.6 and earlier are refused at start-up. This resolves F-6.

### Tests

All new tests use synthetic folders and the one ticket key, JR-12345 (with JR-23456, JR-99999 and generated `local_` ids).

| Where | Added | What they pin |
|---|---|---|
| `tests/test_agent_runner.py` | 24 cases | **F-1, the CLI:**<ul><li>the launcher's chain, in its order, and no unrelated work item looked at;</li><li>only the work item's folder open (a real access-list grant, or `0777`): `not-private`, while `privacy` stays `private`, and the launcher agrees;</li><li>another work item's open folder;</li><li>each of four parent folders open;</li><li>a junction or link at `work/<id>` or at `work/`;</li><li>five missing or invalid ids;</li><li>no data folder yet;</li><li>unprovable privacy and an `OSError`;</li><li>a data folder inside the repository;</li><li>no disk change on success or any refusal;</li><li>five scenarios where `doctor --work-item` and `--launch-agent claude` must reach the same decision;</li><li>`doctor --json` without the option keeping its exact storage keys, and with it gaining only the three.</li></ul> |
| `tests/test_setup.py` | 3 | **F-3:**<ul><li>a batch file alone is not Git or ripgrep, and the reason is printed;</li><li>a program later on `PATH` is found;</li><li>`copilot` keeps the general lookup;</li><li>POSIX unchanged;</li><li>setup asks `program_available`, never `command_available`, for `git` and `rg`.</li></ul> |
| `extension/test/dataFolder.test.ts` | rewritten: 10 (was 3) | **F-1, the extension's reading:**<ul><li>only `work_item_privacy: private` is a yes;</li><li>the repository-level answer is not;</li><li>a yes about another work item id, repository folder or folder is a no;</li><li>a report without the answer is a no;</li><li>the question is built only for a valid id;</li><li>the port, and a CLI without `--work-item` (the compatibility condition, above).</li></ul> |
| `extension/test/agents.test.ts` | 1 | **F-1:** the privacy answer is the last wait, after both `--help` probes; a no there starts nothing. |
| `extension/test/agentTerminals.test.ts` | 1, and 3 updated | **F-2, the host:** a token names one terminal. A closed terminal's token types into no other, not even a new one of the same name. |
| `extension/test/controller.test.ts` | 7 | <ul><li>**F-1:** Fix with AI and Open AI Session ask about the folder on the command line; with a CLI without `--work-item`, nothing starts and the update sentence shows.</li><li>**F-2, with the privacy answer held:**<ul><li>the terminal replaced, closed, or running again;</li><li>a terminal of that name opened, for a restart in a new one;</li><li>another work item shown and back;</li><li>three presses: one start;</li><li>with the real host terminal module: replaced, replaced by one whose agent also exited, or running again.</li></ul></li></ul> |
| `extension/test-integration/cli.integration.test.ts` | 1 | **F-1, extension and CLI together:** the extension's own argv builder and answer reader against the real CLI, with the work folder:<ul><li>private: yes;</li><li>another folder: no;</li><li>open to other accounts: no, while `privacy` says `private`;</li><li>replaced by a junction: no, nothing followed;</li><li>missing: no, nothing created.</li></ul> |

Test fakes updated for the new port shapes: the controller harness (terminal tokens, `replaceTerminal`, the grant recorded with each privacy question), `page.test.ts`, and `cliArgvContract.test.ts` with its fixture.

### Mutation checks

Each mutation was applied to the working tree, its tests run, and the file restored byte for byte (checked by SHA-256).

| Mutation | Result | Killed by |
|---|---|---|
| P1 `work_item_privacy` judges nothing | Killed | the chain test |
| P2 it stops at `work/` (F-1 again) | Killed | only the work item's folder open; the launcher agreement |
| P3 a link answers `unverifiable` | Killed | the link or junction test |
| P4 links followed (no `_existing` walk) | Killed | the link or junction test |
| P5 a missing work item created | Killed | the missing-id and no-disk-change tests |
| P6 no containment check | Killed | the data folder inside the repository |
| P7 an `OSError` escapes | Killed | unprovable privacy |
| P8 the keys added without `--work-item` | Killed | the `doctor --json` compatibility test |
| P9, P10 `setup`'s general lookup for `git`, then for `rg` | Killed | the batch-file setup test |
| E1 the repository-level answer decides again | Killed | three `dataFolder` tests |
| E2 no identity check of the answer | Killed | a yes about another folder |
| E3 privacy asked before the session probe | Killed | the privacy-last test, and the S-2 refusal test |
| E4 the grant asks about another folder | Killed | the F-1 controller test |
| E5 no re-check after the wait | Killed | three F-2 controller tests |
| E6 identity re-checked, activity not | Killed | the running-again cases (fake and real host) |
| E7 activity re-checked, identity not (for typing into the same terminal) | **Survived: equivalent.** The host's `sendToTerminal(token)` refuses the old token, so the outcome is the same cancellation and the same message. | — |
| E9 the host sends by name, not by token | Killed | the host token test |
| E7 and E9 together | Killed | the host token test, and the real-host "replaced by one whose agent also exited" case |
| E8 no work-item generation check | Killed | another work item shown and back |
| E10 no in-flight guard | Killed | both repeated-press tests |
| E11 the old-CLI detection removed | Killed | the update-sentence test |
| E12 any error taken for an old CLI | Killed | the other-failure test |

### Verification on Windows, the working tree

| Check | Result |
|---|---|
| Full Python suite | **First run:** 4,237 passed, 91 skipped, 1 failed. The failure was `test_publishable`: the new tests used a second `JR-` number that is not on the synthetic list. They now use JR-23456. **Rerun after every change:** 4,238 passed, 91 skipped, 0 failed. **After the compatibility correction, before the commit:** 4,238 passed, 91 skipped, 0 failed |
| The affected files: agent runner, setup, publishability, storage boundary | 163 passed; before the commit, agent runner, setup, executables and storage boundary: 161 passed |
| Storage, baselines, goldens, publishability, the argv contract (17 files) | 966 passed, 40 skipped |
| Extension typecheck; build | Clean; succeeds |
| Extension unit tests | 2,397 passed, 1 skipped, 0 failed; after the compatibility correction, 2,402 passed, 1 skipped, 0 failed. The first full run failed one test: the integration-isolation guard flagged the new test's direct `icacls` child. That child now goes through `ISOLATION.checkedEnv`, like every other direct child. |
| CLI integration (`npm run integration`, the real CLI) | 22 of 22, including the new test and the check that no Python child reached real BugPilot data |
| Installed-CLI argv contract (`scripts/check_cli_contract.py`) | A wheel built from the working tree accepts all 40 command lines. The 35040af RC CLI rejects only `doctor --work-item`, as expected. |
| Extension × CLI compatibility (real processes, a disposable home) | 16 of 16:<ul><li>the new CLI: ready; a yes for the prepared work item; a no for a missing one and for another folder;</li><li>without the option, `doctor --json` is byte-for-byte the RC's output, in the same environment;</li><li>the RC CLI: still ready, but every grant is refused with the update sentence (it exits 2);</li><li>0.1.6 extension + new CLI: `EXTENSION_OUTDATED`;</li><li>0.1.7 extension + 0.1.6 CLI: update the CLI;</li><li>the released pair, and a terminal: unchanged.</li></ul> |
| Refusal matrix (the working tree, a disposable home per scenario) | 79 of 79: §18's 62, plus 17 for `--work-item`:<ul><li>private; missing and invalid ids, creating nothing;</li><li>only the work item's folder open to Everyone: `not-private`, while `privacy` says `private`;</li><li>another work item; the grant removed again;</li><li>junctions at `work/<id>` and at `work/`, with the target untouched;</li><li>a foreign record, not rewritten;</li><li>a data folder inside the repository.</li></ul>No `--launch-agent` was run. |
| Mutation checks | 21 of 22 killed; E7 is equivalent (above) |
| Plan checker; the path scan of the added lines | 0 problems; no hits |

**Not run here:**
- the disposable real-VS Code runners (Fix with AI, restart);
- artifacts built from the commit;
- the Linux and macOS runs.

The CI run on the next candidate and the short final RC review cover them.

### Baselines, goldens and contracts

- **Unchanged:**
  - the U7-1 to U7-142 baselines and their approval records;
  - `tests/golden/`;
  - the baseline normalizer (`tests/storage_baseline.py`);
  - the storage inventory (`tests/storage_inventory.json`).

  `git status` on those paths shows nothing. No baseline or golden was regenerated.
- **`tests/fixtures/extension_cli_argv.json`: one entry added,** `doctor --work-item JR-12345 --json`.
  - It is the extension/CLI argv contract fixture, not a U7 baseline or golden.
  - It was regenerated from the extension's own argv builders by its documented procedure (`BUGPILOT_UPDATE_ARGV_FIXTURE=1`), because the extension now sends that command line.
  - The installed-CLI check above runs it against a real CLI.
- **`tests/test_storage_api_boundary.py`:** doctor's existing approval reason now also names `work_item_privacy()`. No importer was added or removed.
- **Contracts:**
  - `doctor --json` without the option is byte-for-byte as before.
  - The Unified Storage layout, every error code and `DATA_ROOT_BOUNDARY` are unchanged.
  - `private_folder` is still imported by `storage` alone.
  - The S-1 gate is unchanged, and `check_private_for_agent` is unchanged in behaviour.
  - The only additions are the ones Option A′ approved: one CLI option, and three keys that appear only with it.

### Changed files

28 paths, all modified; none added, none removed. The owner's three paths were not opened, staged or changed.

| Kind | Paths |
|---|---|
| CLI and storage (4) | `bugpilot/cli.py`, `bugpilot/core/doctor.py`, `bugpilot/core/setup.py`, `bugpilot/core/storage.py` |
| Extension (6) | `extension/src/app/agents.ts`, `extension/src/app/controller.ts`, `extension/src/app/dataFolder.ts`, `extension/src/extension.ts`, `extension/src/host/agentTerminals.ts`, `extension/src/host/ports.ts` |
| Python tests and fixture (4) | `tests/test_agent_runner.py`, `tests/test_setup.py`, `tests/test_storage_api_boundary.py`, `tests/fixtures/extension_cli_argv.json` |
| Extension tests (7) | `extension/test/agentTerminals.test.ts`, `extension/test/agents.test.ts`, `extension/test/cliArgvContract.test.ts`, `extension/test/controller.test.ts`, `extension/test/dataFolder.test.ts`, `extension/test/page.test.ts`, `extension/test-integration/cli.integration.test.ts` |
| Shipped documents (5) | `README.md`, `extension/README.md`, `extension/CHANGELOG.md`, `docs/safety.md`, `docs/architecture.md` |
| Records (2) | `docs/bugpilot_0.1.7_rc_review.md` (§18 and this §19), `docs/bugpilot_0.1.6_unified_storage_plan.md` (the 2026-10-31 and 2026-11-01 records) |

### Remaining findings

| ID | Severity | Status after this batch |
|---|---|---|
| F-1 | Was blocking | **Fixed locally.** Resolved once a committed candidate passes CI and the short final review. |
| F-2 | Low | **Fixed locally.** |
| F-3 | Low | **Fixed locally.** |
| F-5 | Low | **Not fixed, by the owner's decision.** Documented as a known limitation with its workarounds; the S-1 gate is unchanged. |
| F-4 | Informational | Unchanged. |
| F-6 | Informational | **Resolved.** With a 0.1.7 CLI that has no `--work-item` (`35040af` and earlier builds), the extension refuses every Claude CLI grant and says to update bugpilot (the compatibility condition, above). |
| F-7 | Informational | Unchanged. |

**Two notes, not findings:**
- The extension-and-CLI integration test runs in `npm run integration`, which CI does not run. CI runs the Python agreement tests and the extension's unit tests on all three systems.
- Manual acceptance is §18's checklist, still incomplete. On the next candidate, M-2 (d) should refuse to start Claude, where on `35040af` the folder was given.

### The commit

- **Approved by the owner on 2026-11-01.**
- **From an explicit list:** the 28 paths above, on `verify/0.1.7-storage`, with `git add -- <path> …`. Never a broad add.
- **One commit,** made with the project's noreply identity. It carries §18's records, uncommitted since the follow-up review, and this section:

```text
fix(storage): validate work-item privacy and terminal identity before AI grant

F-1: `bugpilot doctor --json --work-item <id>` answers whether that work
item's folder, and every folder above it up to BugPilot's data folder, is
private: storage.work_item_privacy, from RepositoryStorage.work_item_privacy,
the launcher's chain plus its link, record and containment checks, answered
rather than raised. The extension asks it just before it gives Claude CLI the
folder, and again before Open AI Session gives it again, and takes only a yes
about the very folder it gives. doctor --json without the option is unchanged.

F-2: Open AI Session's restart holds the terminal it looked at (a per-terminal
token), the work item and its generation while the CLI is asked, checks them
again in the turn that types or starts, and types into no other terminal.

F-3: `bugpilot setup` looks for git and rg with program_available, as every
run does; on Windows a batch file alone is not reported as present.

A bugpilot without --work-item (a 0.1.7 build before this) is refused with
a sentence that says to update it; nothing falls back to storage.privacy.

F-5 is documented as a known limitation; the S-1 gate is unchanged.
Records: the final RC follow-up review (§18) and this remediation (§19).

<the attribution trailer>
```

- **Then:**
  - the owner's CI dispatch, which must pass 9 of 9;
  - artifacts rebuilt from the new commit;
  - a short final RC review: the diff, the real-VS Code runners, the installs and the classification.

### Classification

**Technical classification: RC BLOCKED.**
- F-1, the one blocker, is fixed, verified on Windows and committed.
- Before technical RC approval:
  - all nine cross-platform CI jobs must pass on this commit;
  - a short final RC review must be done.
- **No new blocker was found.**
- **Manual acceptance is incomplete,** as in §18:
  - NOT TESTED: M-1, M-4's buttons, M-5 as written, M-6, and M-9 steps 1–3;
  - BLOCKED: M-2, M-3 steps 1–4, M-7, and M-9 step 4.

**Public-distribution authorization: UNRESOLVED.**
- G-1 and G-3 have no recorded resolution.
- G-2 needs the owner's confirmation for 0.1.7.
- Neither this remediation nor CI authorizes distribution.

## 20. Final RC acceptance of `9fe8a8a` (2026-11-01)

**Status: RC REVIEW INCOMPLETE. No blocker was found: CI 9 of 9 on the exact commit; reproducible artifacts; clean CLI, MCP, VSIX and managed-runtime installs; F-1, F-2 and F-3 accepted wherever this environment can observe them; and the real BugPilot panel driven in a disposable VS Code. Three required scenarios cannot be observed here and are on the owner's desktop checklist below: a terminal running the agent, the clipboard, and Open AI Session typing into the same terminal. One new Low finding (F-8, a misleading card title) and five Informational ones. Public distribution: UNRESOLVED.**
- A verification and documentation phase. Nothing was implemented, staged, committed, pushed, merged, tagged, published or released. This section and the plan's record are its only edits.
- No account-using AI session was run. Agents were the argument-echo stand-in. No Jira site was used.
- An internal review by the developer's AI assistant, with one independent read-only pass by a second AI reviewer that was given the code, not this review's conclusions. It is **not** an independent or external security audit.

### The candidate

| Item | Value | Verified by |
|---|---|---|
| Branch | `verify/0.1.7-storage` | `git branch --show-current` |
| HEAD | `9fe8a8a379c9e9cf83ed8c7f84fbb6c73be1c525` (parent `35040af`), "fix(storage): validate work-item privacy and terminal identity before AI grant", 28 paths | `git rev-parse HEAD` |
| Tree | `48785521d5b269422a43968bf949c9b8b92ead48` | `git rev-parse HEAD^{tree}` |
| Origin's branch | `9fe8a8a`, the same commit | `git ls-remote origin` |
| Origin's `main`; tags | `7feeaf7`, untouched; none | `git ls-remote origin`, `git ls-remote --tags origin` |
| The reviewed sources | equal to the commit: `bugpilot/`, `extension/src`, `extension/test`, `extension/test-integration`, `scripts/` and `tests/` show no difference from `9fe8a8a`; the artifacts were built from a `git archive` export of the commit, not from the working tree | `git diff --quiet 9fe8a8a -- …`; the export |
| Working tree | the candidate, plus the owner's three unrelated paths, which were not opened | `git status` |

### CI evidence: run 41351728876

Dispatched by the owner (`workflow_dispatch`) on `verify/0.1.7-storage`. Read from the public API: the run, its jobs and each job's annotations, attempt 1, head `9fe8a8a379c9e9cf83ed8c7f84fbb6c73be1c525`, conclusion `success`. The job logs need a sign-in and were not read; the counts are the jobs' own summary annotations.

| Job | Result | Tests |
|---|---|---|
| Full Python suite (windows-latest) | success | 4,235 passed, 93 skipped, 1 deselected |
| Full Python suite (macos-latest) | success | 4,183 passed, 95 skipped, 1 deselected |
| Full Python suite (ubuntu-latest) | success | 4,179 passed, 99 skipped, 1 deselected |
| Safety and baselines, Windows, Python 3.13 | success | 2,120 passed, 93 skipped, 1 deselected |
| Safety and baselines, macOS, Python 3.13 | success | 2,076 passed, 88 skipped, 1 deselected |
| Safety and baselines, Ubuntu, Python 3.13 and 3.10 | success, success | 2,072 passed, 92 skipped, 1 deselected, each |
| The extension's unit tests (ubuntu-latest) | success | 2,403 tests: 2,401 passed, 2 skipped |
| Extension evidence boundary (ubuntu-latest) | success | 27 passed |

- **Against run 41068475707 (`35040af`):** every full Python job has 28 more passing tests and the same skips, which are the commit's new F-1 and F-3 tests running on every system. The safety jobs are unchanged; the new tests are not in that selection. The extension has 16 more tests.
- **Green CI is not taken as proof of the manual workflows.** They are below.

### Release artifacts

Built from a clean `git archive` export of `9fe8a8a`, outside the repository: `python -m build` (an isolated build, setuptools 84.2.1) for the wheel and sdist; `npm ci`, then `npm run package` (build, `check-package`, `vsce package`) for the VSIX. Not published or uploaded.

| File | Bytes | SHA-256 |
|---|---|---|
| `bugpilot-0.1.7-py3-none-any.whl` | 409,816 | `c6679c089eba0c33b5b2df039bda84f7625d25625ec364222d56d041ed2514a4` |
| `bugpilot-0.1.7.tar.gz` | 393,227 | `9caf49f43a3154176ea3c28fd54cb56d80cf5fa792263a28d34c24dc250b6f2f` |
| `bugpilot-0.1.7.vsix` | 581,333 | `abc29a8d8bf46f0bf61598e1b559c4cbd3248fe7acb9ea8281e38b33a0f8844f` |

| Check | Result |
|---|---|
| `twine check --strict` | PASSED (wheel), PASSED (sdist) |
| Version | 0.1.7 everywhere: the wheel's `METADATA` and `bugpilot.__version__`, the sdist's `PKG-INFO`, the VSIX's `package.json` and `extension.vsixmanifest` |
| Metadata and licence | `License-Expression: BUSL-1.1`, `License-File: LICENSE` (in the wheel's `dist-info/licenses/`, byte-for-byte the committed file); `Requires-Python: >=3.10`; no runtime dependencies (`mcp` and `test` are extras); entry points `bugpilot` and `bugpilot-mcp`; the repository and issue URLs. The VSIX: `SEE LICENSE IN LICENSE.txt`, `LICENSE.txt` and `THIRD_PARTY_NOTICES.md`, engines `vscode ^1.90.0`, `node >=22.18`, the publisher and repository unchanged. The commit changed no licence, notice, manifest or version file. |
| Members | wheel 71, sdist 77, VSIX 89 (`check-package`: 87 files, 74 of them built JavaScript, all current). No tests, caches, logs, maps, keys, `.bugpilot/`, `.ai/`, `.vscode/`, `node_modules/` or private word lists. |
| Members against the commit | every one of the wheel's 65 package files and the sdist's 69 source files is byte-for-byte the committed file; the VSIX's 11 static members (licence, notices, readme, changelog, media) match the committed files. |
| Private data and credentials | none. The scan reads every text member: the publishability scan (the private word list read in place, never printed), credential patterns, e-mail addresses and local paths. The one hit, as in every earlier build, is the README's generic example path under `/home/you/`. |
| Reproducible contents | a second, independent export and build: every member of all three archives has the same content (SHA-256 per member). The archives' own hashes differ only through timestamps. |
| Against the `35040af` build | the same member names in all three. Changed members: the 4 Python modules the commit changed (`cli.py`, `doctor.py`, `setup.py`, `storage.py`) and the metadata that carries the README; the 6 extension modules (`agents`, `controller`, `dataFolder`, `extension`, `agentTerminals`, `ports`), the readme and the changelog. Nothing else. |
| Python and extension requirements | they match. The managed runtime installs `bugpilot==` the extension's own version (0.1.7). The extension requires the `unified-storage` capability, and, to give Claude a folder, `doctor --work-item`; the wheel's CLI has both. The installed-CLI contract check accepts all 40 command lines the extension sends, with `--expect-version 0.1.7`. |

### Clean installs

Each in a new virtual environment or a new disposable VS Code profile, with an isolated home and data folder, no Jira, `BUGPILOT_*`, `PYTHONPATH` or `VSCODE_*` variables, and only synthetic repositories.

| Check | Result |
|---|---|
| CLI: a new venv, the wheel only, no index | installs; `bugpilot --version` prints `bugpilot 0.1.7`; imported from `site-packages` |
| `doctor --json`, `doctor --json --work-item <id>` (installed CLI) | 11 of 11: `doctor --json` is ok, lists `unified-storage` and has no `work_item_*` key; a bug description prepares a work item in the data folder and nothing in the repository; `--work-item` on it answers `private`, about that id, with its three keys after the existing ones; a never-prepared id answers `unverifiable`, creates nothing, and its sentence holds no home path; the text form names the work item |
| Installed-CLI argv contract (`scripts/check_cli_contract.py`) | all 40 command lines accepted; version 0.1.7; every capability the extension depends on listed |
| CLI acceptance | 38 of 38 |
| MCP: a new venv, `bugpilot[mcp]` from the wheel, the SDK from PyPI (`mcp` 2.3.0) | installs; `pip check` clean; bugpilot 0.1.7 from `site-packages`. MCP acceptance (raw JSON-RPC over stdio, `bugpilot-mcp`): 11 of 11 |
| End to end: a real `cmd.exe` batch stand-in, a real access-list grant | 8 of 8 |
| Extension × CLI compatibility (the extension's own code; the released 0.1.6 CLI, the `35040af` RC CLI, this wheel) | 16 of 16 |
| Refusal matrix (the installed wheel) | 92 of 92: §19's 79, plus 13 new (below) |
| The VSIX in a new disposable VS Code (standalone 1.142) | installs and activates in three new profiles; the extension is listed at 0.1.7 |
| The managed runtime, from the wheel alone (pip offline, a folder holding only the wheel) | 13 of 13: Install Runtime builds it in the extension's storage, pinned to `bugpilot==0.1.7`; its 65 package files equal the wheel's; `EXTENSION_OUTDATED` without the 0.1.7 declaration; `unified-storage` listed; BugPilot: Doctor runs |

### F-1, F-2 and F-3: final acceptance

**F-1, the work item's privacy.** The CLI's answers were measured through the installed wheel; the grant decisions in the real panel.

| Requirement | Result | Evidence |
|---|---|---|
| A private work item permits the grant | **PASS** | Real panel: Fix with AI hands the work item to Claude CLI, and the CLI's last call before the handoff is `doctor --json --work-item <that item>`. Installed CLI: `private`. |
| The current work item's folder open to others refuses | **PASS** | Real panel: with Everyone granted write on the work item's folder only, Fix with AI starts nothing; the row says "… is not private (Everyone may write to it). Restrict it to your account, or set BUGPILOT_HOME to a private folder. BugPilot did not start Claude CLI with the work item's folder; use Copy Handoff Prompt …". Open AI Session's restart refuses the same way. Installed CLI: `not-private`, while the repository-level `privacy` stays `private`. |
| An unrelated work item open to others does not block a private one | **PASS** | Installed CLI (refusal matrix): another work item stays `private` while JR-12345's folder is open |
| A parent folder open to others refuses | **PASS** | Installed CLI, new: `work/`, the repository's folder and `repositories/`, each open to Everyone in turn: `not-private`, naming that folder; `private` again once the grant is removed |
| A missing work item refuses, creating nothing | **PASS** | Installed CLI: never-prepared and invalid ids answer `unverifiable`; the data folder is unchanged |
| Links and junctions refuse | **PASS** | Installed CLI: a junction, and (new) a directory symbolic link, at `work/<id>` and at `work/`: `not-private`, naming the link; the target untouched |
| Unprovable privacy refuses | **PASS** | Installed CLI, new: an access list this account may not read answers `unverifiable` ("its access list cannot be read"); the access list was then written back exactly and the answer is `private` again |
| No disk mutation | **PASS** | Installed CLI: the data folder's files and modes are the same before and after every answer |
| A CLI without `--work-item` refuses with an update message | **PASS** | Real panel, with the `35040af` CLI as the executable: Run prepares, then Fix with AI starts nothing and says "This bugpilot cannot check a work item's folder (it has no doctor --work-item option). Update bugpilot to the version that came with this extension. …". No handoff, no terminal, no fall back. Compatibility matrix: the same. |

**F-2, terminal identity.** In the real panel, with the session's terminal created by VS Code. No terminal process starts in this sandbox, so what a terminal would run is not observed. A test-only hook in the scratch runtime delayed the CLI's privacy answer by 3–6 s, so each race had a known window.

| Requirement | Result | Evidence |
|---|---|---|
| A normal Open AI Session restart | **PASS** for a closed terminal; **NOT TESTED** for typing into the same terminal after the agent exited (it needs shell integration from a running shell) | The terminal closed: Open AI Session asks the CLI again, then starts Claude CLI in a new terminal of the same name, resuming its session; the panel says "Resuming Claude CLI in a new terminal". With the terminal open: "AI session focused", nothing new started. |
| A double press starts one session | **PASS** | Two presses 150 ms apart: one privacy question, one start, one terminal |
| A terminal replaced during the privacy check cancels | **PASS** | A terminal of the session's name opened during the wait: nothing started; the panel says "The AI session's terminal changed while BugPilot was checking, so nothing was started. Press Open AI Session again."; only the developer's terminal is there |
| A work-item switch cancels | **PASS** | Another work item shown during the wait: nothing started for the first; shown again, it still offers Open AI Session |
| Reset or a new run cancels | **PASS** | A new run (Rebuild Context) during the wait, and Reset Session during the wait: nothing started; after Reset the files are kept and the form is empty |
| A closed or disposed terminal receives nothing | **PASS** as far as observable | The closed terminal is never typed into: the restart creates a new one. Typing itself cannot be observed without a running shell; the unit tests with the real host module show that a closed terminal's token types into no other terminal |

**F-3, Git and ripgrep (Windows, the installed wheel):** 12 of 12.
- With only `git.cmd` and `rg.cmd` on `PATH`, `bugpilot setup` reports Git and ripgrep as not found and says each is there only as a batch file, which BugPilot does not start. `doctor --json` agrees (`git_available` and `rg_available` false).
- With the real `git.exe` and `rg.exe` later on `PATH`, setup reports both, and `doctor` agrees.
- The batch stand-ins never ran.
- Setup was given a synthetic Jira site that never resolves, so it stopped at "Authentication failed" and saved nothing.

### Real VS Code acceptance

**Method.** A disposable standalone VS Code (1.142) with its own user data, extensions folder and home; the RC VSIX installed; the managed runtime built from the wheel alone; a synthetic Git repository; no BugPilot, real `claude`, Jira, `BUGPILOT_*` or `VSCODE_*` on `PATH` or in the environment. New in this review: **the BugPilot panel itself was driven** through VS Code's remote-debugging port.
- The Issue field was typed into with real input events, its buttons clicked (DOM clicks on the real elements, so the panel's own handlers ran and posted to the real host), and its text read.
- VS Code's own confirmation dialogs were read and pressed in a normal window: a test-host window refuses dialogs.
- The previous review's command-path runners were run again too.
- A PATH guard before every Fix with AI press confirmed that the only `claude` was the stand-in.

| Required check | Result | Evidence |
|---|---|---|
| Run from a bug description | **PASS** | Typed into Issue, which reads it as a bug description; Fix with AI left unticked; Run. The run ends, the primary becomes Fix with AI, one new work item is in the data folder with `context.md` and `task.md`, the context names `src/record.py`, no row failed, and the repository is unchanged. |
| Build Context | **PASS** | The Build context row says "Context ready"; its `context.md` link opens the file from the work item's folder in the data folder |
| Fix with AI | **PASS** up to the terminal; what the terminal runs is **NOT TESTED** (no terminal process here) | The panel: the F-1 refusal, then the handoff to Claude CLI in the work item's terminal; the primary becomes Open AI Session. The flag probes ran first (`--add-dir`, `--session-id`, `--resume`). |
| Open AI Session | **PASS** for focusing and for a restart in a new terminal; **NOT TESTED** for typing into the same terminal | As F-2 above |
| Restart (quit and reopen) and Reset Session | **PASS** | VS Code quit through its own Quit and reopened: the work item shown before opens again from the data folder (2 of 2, twice). Reset Session through ⋯ More: the dialog opens with Keep chosen; Cancel resets nothing; Reset keeps the files and empties the form. |
| Verification Policy Edit and Reset | **PASS** | Edit creates and opens `settings/verification.md` from the repository's folder in the data folder. A conflicting line saved in the editor is reported on the row. Reset asks through VS Code: "Reset the Verification Policy? This deletes settings/verification.md. …", with Keep File, Delete File and Cancel. Keep File keeps it; Delete File deletes it, and the row shows the default again. The repository is unchanged. |
| Policy watcher freshness | **PASS** for two editor saves 300 ms apart (the preview shows the second) and for a write from outside VS Code; **NOT TESTED**: a save followed by a focus switch | The panel's Preview, read after each change |
| Copy Handoff Prompt | **NOT TESTED** | The command runs, but the clipboard reads back nothing in this sandbox, in a test window and in a normal window alike |
| Advanced Settings | **PASS** | It replaces the workflow; AI Agent offers Auto-detect, Claude CLI, Codex CLI, Claude Extension, Codex Extension and Custom command; the Verification policy row has Edit, Reset and Preview; Back returns |
| Error and refusal messages | **PASS**, with F-8 below | The privacy refusal (Fix with AI and the restart); the old CLI's update sentence; no agent on `PATH` ("No supported AI agent detected. BugPilot looked for Claude CLI, Codex CLI, Codex Extension and Claude Extension."); the released 0.1.6 extension with this CLI (`EXTENSION_OUTDATED`, 9 of 9) |
| Reload and recovery | **PASS** | Reload Webviews: the panel comes back offering the same next step. The quit-and-reopen restart above. |

**Every runner's count, and every failed check explained:**

| Runner | Result | The failed checks |
|---|---|---|
| Managed runtime (profile 1) | 13 of 13 | — |
| Main, policy, Fix with AI, restart, the released 0.1.6 extension (the previous review's command paths) | 26 of 28; 19 of 19; 5 of 9; 2 of 2 and 2 of 2; 9 of 9 | Main: the clipboard (2). Fix with AI: what the terminal ran (4), since no terminal process starts here. As in §18. |
| The panel, test window (profile 2) | 72 of 79 | None is a product failure. **Harness (3):** a radio read as a checkbox; then VS Code's "refused to show dialog in tests" (2), so both dialogs were re-run in a normal window. **Expectation (1):** a changed description makes the primary Rebuild Context, as designed. **Environment (1):** the clipboard. **Shared project (2):** the earlier runners' planted 0.1.6 canaries, untouched. |
| The panel, normal window | 14 of 15 | the clipboard |
| The `35040af` CLI as the executable | 8 of 9 | the shared project's planted canaries, untouched |
| No agent on `PATH` | 7 of 8 | the same |
| Managed runtime (profile 2, the same home and project) | 11 of 13 | two fresh-state checks, which cannot hold after the earlier runners in the same home and project |

The planted canaries are a 0.1.6 `.ai/JR-12345/context.md` and `.bugpilot/verification.md` in the synthetic repository. The main runner checks that 0.1.7 never reads or changes them, and every runner found the repository's `git status` unchanged from its start.

### Regression and security review

| Area | Result | Evidence |
|---|---|---|
| Approved U7-1 to U7-142 baselines | **Preserved** | All 142 entries, each `approved: 2026-10-29`; no file under `tests/baselines/` or `tests/golden/` changed since `59db0b4` |
| Golden output | **Preserved** | the same; the task and prompt-boundary golden tests pass in CI and from the export |
| The baseline normalizer; the storage inventory | **Unchanged** | since `d05c025`; since `35040af` |
| Unified Storage contracts | **Preserved** | `doctor --json` without the option is byte-for-byte the `35040af` CLI's output (compatibility matrix). No error code, layout, `DATA_ROOT_BOUNDARY` or storage importer changed. The storage suites from the export: 1,297 passed, 44 skipped, 0 failed (24 files) |
| Repository identity and containment | **Preserved** | a foreign or corrupt record, a data folder inside the repository and a relative `BUGPILOT_HOME` all fail closed through the installed wheel; the record is never rewritten |
| Claude directory-grant restrictions | **Preserved** | a grant only for Claude CLI, only when its `--help` lists `--add-dir`, only for a plain folder path, as one `--add-dir=<folder>` word, and now only after a `private` answer about that very folder; never for Codex, Copilot, a custom command or a review |
| Shell safety and executable discovery | **Preserved** | `git` and `rg` only as native programs on Windows (S-8), and `setup` now agrees (F-3); the S-1 gate unchanged; end to end 8 of 8 |
| Extension and CLI fail-closed version handling | **Preserved** | the 0.1.7 extension refuses the 0.1.6 CLI; the 0.1.6 extension is refused by this CLI (`EXTENSION_OUTDATED`); the `35040af` CLI is refused every grant |
| The extension, from the export | **PASS: typecheck clean; unit tests 2,402 passed, 1 skipped, 0 failed; CLI integration 22 of 22** | typecheck, unit tests and the CLI integration suite (`npm run integration`, the export's own CLI) |

**The independent read-only review** of `9fe8a8a` (the commit and its surrounding code; no tests run): no Critical, High or Medium finding. Its Informational points were checked against the code and are in the table below.

**Findings, new in this review.** None blocks the RC.

| ID | Severity | Finding | Evidence | Smallest remediation, if the owner wants one | Blocks? |
|---|---|---|---|---|---|
| F-8 | Low (UX; the privacy refusal has shown it since `35040af`) | **A refused Fix with AI shows a card titled "AI agent unavailable"**, whose message says to check that the agent is installed or choose another, with an Open Settings button. That is the card for every handoff that does not start. For a privacy refusal or an old CLI that headline is wrong: the agent is there. The row under the step says the real reason in full, and so does the card's Details. It fails closed. | Real panel: the privacy refusal and the old-CLI refusal (`failures.ts`, `handoffError`; `controller.ts`, where a failed handover sets it) | A card kind for a refusal BugPilot made itself, for example "Fix with AI was not started", whose message is the reason's first sentence; Open Settings only where a setting is the fix. **Tests:** controller tests for the privacy, old-CLI, plain-folder and prompt-gate refusals, and a real-window check of the card. | No |
| F-9 | Informational | The CLI's batch-file sentence names `git.CMD` for a file named `git.cmd`: the case of the `PATHEXT` entry, not the file's | Installed wheel, F-3 run | None needed | No |
| F-10 | Informational | `work_item_privacy` is documented never to raise. A `display_path` `ValueError` could escape if the data folder's real path changed during the call, for example a data-folder link re-pointed by the same user. `doctor --json` then answers `ok: false`, which the extension refuses; the text form prints a traceback. | Independent review; code reading (`storage.py`, the missing-folder branch and `_not_private_for_agent`) | Catch `ValueError` beside `StorageError` and answer `unverifiable` | No |
| F-11 | Informational | A namespace whose identity record is missing is accepted, as the launcher's `work_item_dir` accepts it; every folder must still be private | Independent review; `_check_record` | None needed; noted for the owner | No |
| F-12 | Informational | The old-CLI sentence relies on argparse's English "unrecognized arguments". Another wording would give the general refusal: still a no. | `dataFolder.ts`, `askWorkFolderPrivacy` | None needed | No |
| F-13 | Informational | When the developer accepts the restart offer for a terminal whose state is unknown, the token is read after that offer, not with the activity. That path always starts a new terminal, and the work-item, session and count checks still apply. If the old terminal closes during the wait, the press says "terminal changed" when it could have started. | Independent review; `#offerRelaunch` | None needed; UX only | No |

**The earlier findings:**
- F-1 is resolved, as accepted above, and F-6 by §19.
- F-2 and F-3 are fixed and accepted.
- F-5 is documented, with the S-1 gate unchanged.
- F-4 and F-7 are unchanged, Informational.
- The earlier Low and Informational findings (§18's re-evaluation) are unchanged by `9fe8a8a`: none of their code changed.
- None of them, and none of F-8 to F-13, becomes release-blocking.

### Manual acceptance on the owner's desktop

What this sandbox cannot observe. Each item is short; §18's checklist has the setup (a separate VS Code profile, the candidate's VSIX and wheel by the hashes above, a synthetic repository) and the variants.

| # | Scenario | Why it is here | Steps | Expected |
|---|---|---|---|---|
| A-1 | Fix with AI runs Claude CLI in a real terminal (M-2 a, b) | **BLOCKED**: an account-using run needs the owner's approval for each run (G-5); no terminal process here | Claude CLI selected; on a prepared work item, press Fix with AI; read the typed line | One terminal for the work item; `claude --add-dir="<work folder>" --session-id <uuid> "<prompt naming task.md>"`. With the native `claude.exe` Claude writes `fix_report.md` without asking; with only the npm `claude.cmd` there is no `--add-dir` |
| A-2 | Open AI Session resumes in the same terminal (M-3 step 2) | **BLOCKED**: needs A-1's running agent and shell integration | After A-1, `/exit` in the terminal, then press Open AI Session | After a moment, `--resume <the same id>` with the same `--add-dir`, typed into that terminal |
| A-3 | A race in a real terminal (M-3 steps 3–4) | **NOT TESTED** here for the same-terminal path (the new-terminal path passed above) | As A-2, but press twice within a second; then again, showing another work item right after pressing | Exactly one start; nothing for the first work item |
| A-4 | Copy Handoff Prompt (M-6) | **NOT TESTED**: the clipboard reads back nothing here | Run **BugPilot: Copy Handoff Prompt** on a prepared item; paste into an editor | One line, `Read <data folder>/repositories/<repo>-<16 hex>/work/<id>/task.md and complete the workflow.`, with forward slashes, naming a file that exists |
| A-5 | Policy watcher with a focus switch (M-5 step 2) | **NOT TESTED** | Edit `verification.md`, save, switch to another window and back at once | The row and the Preview show the saved text within a few seconds |
| A-6 | The Jira workflow (M-7) | **BLOCKED**: needs a test Jira site and token; never a production site | As §18's M-7 | As §18's M-7 |
| A-7 | Agent selection, a non-ASCII `BUGPILOT_HOME`, and the supported agents (M-9 steps 1–4) | Steps 1–3 **NOT TESTED** in a real window for every agent choice (Auto-detect with no agent passed); step 4 **BLOCKED** on the owner's list (plan §9.10) | As §18's M-9 | As §18's M-9 |

The rest of §18's checklist passed here:
- in the real panel: M-1, M-4 (its buttons), M-5 steps 1 and 3, M-8, and M-2 (d), the refusal for the work item's own folder;
- through the installed CLI: M-2 (c), a parent folder open to others.

### Remaining known limitations

- **F-5** (Low, documented): `--launch-agent` cannot start a batch-file agent whose own path holds a space. The workarounds are documented; the S-1 gate is unchanged.
- **F-8** (Low): the refused handoff's card headline, above.
- **The time between the privacy answer and the agent's start.** A change of the folder's permissions in that window is not detected. The window is inherent to a check made before a start, and short, since the answer is the last wait. It is not among S-2's listed limitations (§16), so it is recorded here for the owner.
- **S-2's accepted limitations** (§16): folders above the data folder, macOS extended ACLs, volumes without access lists, the added `doctor` call, and agents given no folder.
- **Open AI Session without shell integration** cannot tell a running agent from an exited one. It offers a restart and never types blind.
- **The extension and CLI must be the same release.** The old-CLI refusal shows when they are not.
- **N-1 to N-4, R-1, S-3 to S-7 and ST-3 to ST-7:** as accepted or recorded before, and unchanged.

### Security assessment

- **No Critical, High or Medium finding** in `9fe8a8a`, by this review's reading, the measurements above, and the independent read-only review.
- **The security property the remediation was for now holds end to end.** Claude CLI is given a work item's folder only after the CLI, asked about that very folder, proves every folder from the data folder down to it private. Proved here:
  - in the real panel, for Fix with AI and for Open AI Session's restart;
  - through the installed wheel, for parents, the work item's own folder, links, junctions, an unreadable access list and a missing folder;
  - with an older CLI, which is refused.
- **Nothing found widens a grant.** No fall back to the repository-level answer, no redirection into another terminal, and no start after a switch, a reset, a new run, or a terminal change during the check.
- **This is not an independent or external security audit.**

### Classification and recommendation

**Technical readiness: RC REVIEW INCOMPLETE.**
- **No blocker was found,** and every check this environment can run passed: CI, the artifacts, the installs, F-1, F-2 and F-3, and the real panel.
- **What is missing is evidence, not a fix.** The brief counts a missing required manual check as incomplete. Three required scenarios need the owner's desktop: A-1 and A-2 (a terminal running the agent: an account-using run, approved per run) and A-4 (the clipboard). A-3, A-5 and A-7's steps 1–3 should be run with them; A-6 and A-7's step 4 need a Jira test site and the owner's agent list.
- **Recommendation:** run A-1 to A-5, and A-7's steps 1–3, on the owner's desktop with these exact artifacts (check the hashes first). If they pass, `9fe8a8a` is technically suitable as the 0.1.7 release candidate as built here, and the classification can become RC TECHNICALLY READY without a new commit. F-8 is the owner's choice: fixing it before the release means a new commit, CI and a short review; deferring it changes nothing else.

**Public distribution: UNRESOLVED.**
- G-1 (ownership and employment policy) and G-3 (a qualified review of the licence parameters) have no recorded resolution.
- G-2 needs the owner's confirmation for 0.1.7.
- G-5 and G-6 are as in §13.
- Neither CI nor this review authorizes distribution. Nothing was published.

**Not done, as the brief requires:**
- nothing implemented, staged, committed, pushed, merged, tagged, released or published;
- no account-using AI session run;
- no Jira site used.

## 21. Technical RC approval of `9fe8a8a` (2026-11-01)

**Status: RC TECHNICALLY READY. The owner approved `9fe8a8a379c9e9cf83ed8c7f84fbb6c73be1c525` as BugPilot 0.1.7's technical release candidate, after reporting A-1 to A-5 and A-7's steps 1–3 PASS on the owner's desktop. A-6 and A-7's step 4 are not tested. Public distribution: UNRESOLVED.**
- The approval does **not** authorize public distribution, a merge into `main`, a tag, a release, or publication to PyPI or the VS Code Marketplace.
- A documentation phase. No product code, U7 baseline, golden file, test or packaging configuration changed. Nothing was merged, tagged, released or published. This section, its header notes and the plan's record are the only edits.
- **The approved source commit is `9fe8a8a`; the documentation commit is separate.** On the owner's approval, §20, §21 and the plan's records were committed afterwards in one documentation-only commit on `verify/0.1.7-storage`, whose parent is `9fe8a8a`, and pushed. That commit changes only this report and the plan. It does not replace the candidate: the release candidate's source, CI run and artifacts are `9fe8a8a`'s. No CI run was dispatched for it, since it changes no executable, test, baseline, packaging or workflow file.

### The approved candidate

| Item | Value | Verified by |
|---|---|---|
| Commit | `9fe8a8a379c9e9cf83ed8c7f84fbb6c73be1c525` on `verify/0.1.7-storage` (parent `35040af`) | `git rev-parse HEAD` |
| Tree | `48785521d5b269422a43968bf949c9b8b92ead48` | `git rev-parse HEAD^{tree}` |
| Origin | `verify/0.1.7-storage` at `9fe8a8a`; `main` at `7feeaf7`, untouched; no tags | `git ls-remote origin`, `git ls-remote --tags origin`, on the approval day |
| The working tree | the product, tests, scripts, packaging and licence files equal `9fe8a8a`; only this record, the plan and the owner's unrelated paths differ | `git diff --quiet 9fe8a8a -- bugpilot extension scripts tests pyproject.toml LICENSE README.md` |
| Cross-platform CI | run 41351728876 (`workflow_dispatch`, attempt 1, head `9fe8a8a`): **9 of 9** | §20 |
| Artifacts | wheel `c6679c089eba0c33b5b2df039bda84f7625d25625ec364222d56d041ed2514a4`, sdist `9caf49f43a3154176ea3c28fd54cb56d80cf5fa792263a28d34c24dc250b6f2f`, VSIX `abc29a8d8bf46f0bf61598e1b559c4cbd3248fe7acb9ea8281e38b33a0f8844f`; not published or uploaded | §20 |

### Evidence, by source

The approval rests on two kinds of evidence, kept apart here.

| Source | What it covers | Where recorded |
|---|---|---|
| **Agent-observed:** measured by the developer's AI assistant in this review, with one independent read-only pass by a second AI reviewer | CI run 41351728876, read from the public API. The artifacts: built from a clean export, hashed, inspected, and rebuilt with identical contents. Clean installs: the CLI, MCP, the VSIX and the managed runtime. F-1, F-2 and F-3 through the installed wheel and the real panel. The real VS Code acceptance in a disposable profile. The regression and security review. | §20 |
| **Owner-reported:** run by the owner on the owner's desktop, and accepted as owner-reported evidence | A-1, A-2, A-3, A-4, A-5, and A-7's steps 1–3 | the table below |

- This review did not observe or re-run the owner's tests. It holds the owner's PASS for each, not their logs.
- **Which build was installed for them is not confirmed.** The owner has not stated it, so this record does not claim that the hashed artifacts above were used; §20 asked for them, checked against their hashes. The owner does not require another desktop test to record the approval.

### The owner's desktop acceptance

| # | Scenario (§20's checklist) | In §20 | Now | Source |
|---|---|---|---|---|
| A-1 | Fix with AI runs Claude CLI in a real terminal (M-2 a, b) | BLOCKED | **PASS** | Owner-reported |
| A-2 | Open AI Session resumes in the same terminal (M-3 step 2) | BLOCKED | **PASS** | Owner-reported |
| A-3 | A race in a real terminal (M-3 steps 3–4) | NOT TESTED | **PASS** | Owner-reported |
| A-4 | Copy Handoff Prompt (M-6) | NOT TESTED | **PASS** | Owner-reported |
| A-5 | The policy watcher with a focus switch (M-5 step 2) | NOT TESTED | **PASS** | Owner-reported |
| A-6 | The Jira workflow (M-7) | BLOCKED | **NOT TESTED** (still BLOCKED: no Jira test site) | — |
| A-7, steps 1–3 | Agent selection, Agent Check, and a non-ASCII `BUGPILOT_HOME` (M-9 steps 1–3) | NOT TESTED | **PASS** | Owner-reported |
| A-7, step 4 | The installed agents on the owner's list (M-9 step 4, plan §9.10) | BLOCKED | **NOT TESTED** (still BLOCKED: the owner's list) | — |

- **A-1 and A-2 use an AI account.** The owner ran them on the owner's own desktop (G-5). This review ran no account-using session.
- **Together with §20, every required scenario now has evidence**, except A-6 and A-7's step 4. That includes what §20 could not observe here: a terminal running the agent, Open AI Session typing into the same terminal, and the clipboard.

### Outstanding manual coverage

These are not tested, and are not counted as passed:
- **A-6, the Jira workflow (M-7).** It needs a Jira test site with a synthetic issue and a test account's token, never a production site. Today only CI's Jira transport and refusal tests and CLI acceptance's mock issue path cover it.
- **A-7 step 4, the installed agents on the owner's list (plan §9.10).** Each is an account-using run. This approval adds no agent and provider combination to a supported list.
- **Platforms.** This review's real VS Code acceptance ran on Windows. Linux and macOS have CI's coverage only.

### Low and Informational findings accepted for 0.1.7

The owner approved `9fe8a8a` unchanged, so these ship as known limitations. None blocks, and none changes the classification.

| ID | Severity | Finding | Recorded in |
|---|---|---|---|
| F-8 | Low (UX) | A handoff that BugPilot itself refuses (folder not private, or an old CLI) shows the card "AI agent unavailable". The row under the step states the real reason. It fails closed. The proposed remediation and its test plan stay in §20 for a later release. | §20 |
| F-5 | Low (documented) | `--launch-agent` cannot start a batch-file agent whose own path holds a space. The workarounds are documented; the S-1 gate is unchanged. | §18, §19 |
| F-9 to F-13 | Informational | `git.CMD` letter case; a rare `ValueError` in the privacy check (JSON mode fails closed); a missing identity record accepted, as the launcher accepts it; the old-CLI sentence relies on argparse's English; a restart-offer timing quirk that affects only the message. | §20 |
| F-4, F-7 | Informational | Unchanged. | §18 |
| Earlier | Low and Informational | D-7 to D-9 and D-11 to D-15 (D-10 resolved by D-3); S-3 to S-7; ST-3 to ST-7; R-1; N-1 to N-4 (accepted by the owner on 2026-10-29); S-2's accepted limitations (§16); the time between the privacy answer and the agent's start (§20) | §16, §18 (re-evaluated), §20 |

### Release governance

Unchanged from §13 and §20. This record claims no ownership, no employment-policy clearance and no licence approval. Legal and employment questions need the owner's own qualified advice; this review gives none.

| ID | Question | State |
|---|---|---|
| G-1 | Ownership and employment policy | **UNRESOLVED**: no explicit resolution recorded |
| G-2 | Confidentiality | The artifacts are clean (§20). The history's earlier risk acceptance awaits the owner's confirmation for 0.1.7. **Open.** |
| G-3 | Licence parameters (REL-2) | **UNRESOLVED**: no qualified review recorded |
| G-4 | Third-party IP | As §13 |
| G-5 | Account-using runs | A-1 and A-2 were run by the owner, on the owner's desktop; this review ran none |
| G-6 | Publication accounts | The owner's; publication stays manual |

### Classification and freeze

**Technical readiness: RC TECHNICALLY READY.** The owner approved `9fe8a8a` as 0.1.7's technical release candidate. The approval rests on:
- §20's agent-observed evidence: CI 9 of 9 on the exact commit; reproducible, inspected artifacts; clean installs; F-1, F-2 and F-3; the real panel; and the regression and security review, with no Critical, High or Medium finding;
- the owner-reported desktop acceptance above.

**Public distribution: UNRESOLVED.** G-1 and G-3 are unresolved, and G-2 awaits the owner's confirmation. Neither the technical approval nor CI authorizes distribution.

**The candidate is frozen.**
- No change to 0.1.7's product code, the U7 baselines, the golden files, the tests or the packaging configuration.
- A new development batch only if a release-blocking issue is demonstrated.
- The owner's three unrelated paths are preserved, unopened.

**Not done:**
- nothing merged into `main`, tagged, released or published; the only commit is the documentation commit above, which is not the release candidate;
- no account-using AI session, and no Jira site, in this phase.
