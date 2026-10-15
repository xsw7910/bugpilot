# Development

How to work on BugPilot itself: the CLI and MCP server in Python, and the VS Code extension in TypeScript.

External code contributions are not currently accepted. Bug reports and feature requests are welcome through [GitHub Issues](https://github.com/xsw7910/bugpilot/issues).

## Python: editable install and tests

```powershell
python -m pip install -e ".[test,mcp]"
python -m pytest
```

The test suite reads `~/.bugpilot/` unless told otherwise; run it with an empty home so a real Jira configuration on your machine is never used:

```bash
HOME=$(mktemp -d) USERPROFILE=$HOME python -m pytest
```

`tests/test_publishable.py` keeps company names, real ticket numbers, personal paths and internal hosts out of everything the repository publishes. Its private word list lives in `tests/forbidden_words.txt`, which is gitignored; copy `tests/forbidden_words.example` to start one.

## The extension

```powershell
cd extension
npm ci
npm test                 # unit tests: node --test on the TypeScript sources
npm run typecheck
npm run smoke            # build, then activate against a stub VS Code
npm run integration      # against the real CLI from this checkout
npx vsce package         # a .vsix; scripts/check-package.mjs checks what it holds
```

The extension and the CLI share a contract: every command line the extension sends is recorded in `tests/fixtures/extension_cli_argv.json`, which both test suites check. Regenerate it with `BUGPILOT_UPDATE_ARGV_FIXTURE=1 node --test test/cliArgvContract.test.ts`, and check an installed CLI against it with `python scripts/check_cli_contract.py --bugpilot <path-to-bugpilot>`.

## A wheel

```powershell
python -m pip wheel --no-deps -w dist .
```

Build from a clean checkout of the commit you mean to release, and check the result with `scripts/check_cli_contract.py`.

## Publishing to PyPI

`.github/workflows/release.yml` publishes through PyPI Trusted Publishing: GitHub OIDC proves to PyPI which workflow is publishing, so no PyPI API token is stored anywhere — not in the repository, not in GitHub. It runs only by hand (**Actions → Release → Run workflow**), never on a push, a tag or a pull request. Run it **from `main`**, with two inputs: the version, and the release commit's full 40-character SHA.

What the workflow does, failing closed at the first doubt:

1. **Refuses any ref but `main`** — before anything is checked out.
2. **`scripts/release_preflight.py` checks the source** before any build tool is installed: the commit entered is the one checked out (so `main` cannot move unnoticed between your review and the dispatch); the version entered is `__version__` in `bugpilot/__init__.py` and `version` in `extension/package.json`; and CI passed on that commit — its `ci.yml` runs are all finished, the newest of them succeeded, and the newest run of each of the nine required jobs succeeded, counting only check runs that belong to those CI runs. A failed, cancelled, skipped, running or missing check refuses the release; a check of the same name from another workflow does not count; an error reading GitHub's answer refuses. CI is read once, before the build: a CI re-run started after that cannot stop a publish you approve later, so look at the commit's CI before approving.
3. **Builds with pinned tools:** `build`, `twine` and `setuptools` (the build backend) at the versions in `.github/release-requirements.txt`, installed with `--require-hashes`, and the build runs without isolation so it uses that setuptools. Every action the workflow uses is pinned to a full commit SHA, with the release tag beside it.
4. **Checks the result:** exactly that version's wheel and sdist, `twine check --strict`, and their SHA-256 in the run summary.
5. **Publishes from a separate job in the `pypi` environment**, the only job with `id-token: write`, after checking that it holds exactly the files the build job hashed.

The builds are not claimed to be byte-for-byte reproducible: an archive records file times. The same pinned tools build the same contents.

`tests/test_release_workflow.py` (in CI's required safety job) holds these properties of the workflow files, and fails on a broken copy of each. It cannot see GitHub's settings.

### Set up outside this repository

Two settings live outside this repository, and the workflow depends on both:

- **On PyPI**, the trusted publisher: PyPI project `bugpilot`, owner `xsw7910`, repository `bugpilot`, workflow `release.yml`, environment `pypi`. Every release so far went through it. Renaming the workflow file or the environment breaks it.
- **On GitHub, the `pypi` environment** (**Settings → Environments → pypi**). **Required configuration:**
  - **Deployment protection rules → Required reviewers:** checked, with the maintainer (`xsw7910`) as the reviewer. Leave **Prevent self-review** unchecked while one person both starts and approves releases: with it checked, the person who started the run cannot approve it, and a sole maintainer could never publish. Leave **Wait timer** off.
  - **Allow administrators to bypass configured protection rules:** unchecked, so an administrator's run waits for approval too.
  - **Deployment branches and tags:** **Selected branches and tags**, with one rule, branch `main`.
  - **Environment secrets:** none.

  **Verified state:** read through GitHub's public API on 2026-10-14, the environment had **no protection rules** — no reviewer, no wait timer, no branch policy — and allowed administrators to bypass. Until the settings above are made and verified, a dispatch publishes without waiting for approval. To verify them, read

  ```bash
  curl -s https://api.github.com/repos/xsw7910/bugpilot/environments/pypi
  ```

  and expect `protection_rules` to hold a `required_reviewers` rule naming the maintainer (with `prevent_self_review: false`) and a `branch_policy` rule, `deployment_branch_policy` to be `{"protected_branches": false, "custom_branch_policies": true}`, and `can_admins_bypass` to be `false`. `https://api.github.com/repos/xsw7910/bugpilot/environments/pypi/deployment-branch-policies` (it may need a token with read access) must list exactly `main`. The next release run is the live check: its publish job must stop at **Waiting for review**.

Per GitHub's documentation, required reviewers and deployment branch rules are available to public repositories on every current plan; in a private repository, required reviewers need GitHub Enterprise. This repository is public.

### Releasing

1. Push the release commit to `main` and wait for CI to pass on it: all nine checks.
2. **Actions → Release → Run workflow**, "Use workflow from" **`main`**, version and the commit's full SHA.
3. While the publish job waits for review, download the run's `python-distributions` artifact, compare its SHA-256 with the run summary, and check it as a release: a clean install, `bugpilot --version`, `scripts/check_cli_contract.py`. A version uploaded to PyPI can never be replaced, so approval is the last point to stop.
4. Approve (**Review deployments → pypi → Approve and deploy**), or reject.

### Updating the pins

- **An action:** take the new release from the action's own repository (its Releases page), resolve the tag to its commit — `curl -s https://api.github.com/repos/<owner>/<action>/git/ref/tags/<tag>`, following an annotated tag (`"type": "tag"`) through `git/tags/<sha>` to its commit — and change the workflow line (`uses: <owner>/<action>@<sha> # <tag>`) and `VERIFIED_PINS` in `tests/test_release_workflow.py` together.
- **The build tools:** change the pins in `.github/release-requirements.in`, then regenerate the hashed file for the release runner (Linux x86_64, CPython 3.13) with [uv](https://docs.astral.sh/uv/), from the repository root:

  ```bash
  uv pip compile .github/release-requirements.in --python-version 3.13 --python-platform x86_64-manylinux_2_28 --generate-hashes -o .github/release-requirements.txt
  ```

  uv is used only to write this file; the workflow installs it with plain pip. Check that pip accepts it for the runner before committing:

  ```bash
  python -m pip download --no-deps --require-hashes --only-binary=:all: --platform manylinux_2_28_x86_64 --platform manylinux_2_17_x86_64 --platform manylinux2014_x86_64 --python-version 3.13 --implementation cp --abi cp313 --abi abi3 --abi none -r .github/release-requirements.txt -d <a temporary folder>
  ```

## Release order: PyPI before the Marketplace

The extension's **Install BugPilot Runtime** installs `bugpilot==<extension version>` from PyPI, so an extension version works for a new user only once PyPI serves the same CLI version. The versions move together — `__version__` in `bugpilot/__init__.py`, `version` in `extension/package.json` (and its lock file: `npm version <version> --no-git-tag-version` in `extension/`), and the Licensed Work in both licence files — and a release goes in this order:

1. Finish and review the source at the new version.
2. Commit and push it to `main`, and wait for CI to pass on it.
3. Run the release workflow from `main` with that commit's full SHA and that version, and approve its publish job after checking the artifact (*Releasing*, above).
4. Check that PyPI serves it: in a new virtual environment, `python -m pip install bugpilot==<version>`, then `bugpilot --version`.
5. With the final VSIX, in a fresh VS Code profile with no `bugpilot` on `PATH`, press **Install BugPilot Runtime** and wait until it is ready.
6. Restart VS Code: the runtime is ready without installing again, and one prepare-only Run succeeds.
7. Only then upload the VSIX to the Marketplace.

Never publish the extension to the Marketplace before PyPI serves the matching CLI: every new user's first click would end in "PyPI has no bugpilot==<version> for this Python."

## A standalone executable (Windows)

One self-contained `bugpilot.exe` with its own Python runtime, for machines without Python:

```powershell
python -m pip install --user pyinstaller
python -m PyInstaller --onefile --name bugpilot --collect-submodules bugpilot --paths . pyi_entry.py
```

The output is `dist\bugpilot.exe`. `pyi_entry.py` is the entry point PyInstaller needs (an absolute-import shim around `bugpilot/__main__.py`). The executable is unsigned, so SmartScreen may ask before the first run. BugPilot's safety rules are built into the package, so the executable, a wheel and a source checkout write the same `task.md`.

## Licensing

Everything published from this repository uses one licence: the Business Source License 1.1 with one set of parameters (Licensor, Additional Use Grant, Change Date, Change License). Each component published on its own carries its own licence file, identical to `LICENSE` except for the Licensed Work, which names that component and its version (and, in `LICENSE`, what it covers): the wheel ships `LICENSE` (BugPilot CLI and Tools; `license = "BUSL-1.1"` and `license-files` in `pyproject.toml`), the VS Code extension ships `extension/LICENSE.txt` (BugPilot for VS Code; `"license": "SEE LICENSE IN LICENSE.txt"` in `package.json`, since the parameters decide what is permitted). A future component — a Claude Code plugin, say — follows the same pattern. `tests/test_publishable.py` finds every licence file by name and fails on one that differs from `LICENSE` anywhere but the Licensed Work, names a version other than the component's, or changes the standard BUSL 1.1 text, so a new component is checked without a test change. Commercial licences are arranged through the GitHub repository.

The Licensed Work names one version, so every release updates it in each licence file. For BugPilot 0.1.0, the first public release date is 2026-10-08 and the BUSL Change Date is 2030-10-08. BugPilot 0.1.1, 0.1.2 and 0.1.3 keep that Change Date. BugPilot 0.1.4's Change Date is 2030-10-11, and BugPilot 0.1.5 keeps it.

Third-party code keeps its own licence and attribution, next to the files it covers and listed in the component's notices file (`extension/THIRD_PARTY_NOTICES.md` for the codicons font, CC BY 4.0). Never append notices to a `LICENSE` copy.

## The Windows installer

`install.cmd` runs `installer/install.ps1`, which installs a wheel from `installer/` with pipx (installing Python with winget if it is missing) and offers to run `bugpilot setup`. Put the wheel built above in `installer/` before distributing it.
