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

`.github/workflows/release.yml` publishes through PyPI Trusted Publishing: GitHub OIDC proves to PyPI which workflow is publishing, so no PyPI API token is stored anywhere — not in the repository, not in GitHub. It runs only by hand (**Actions → Release → Run workflow**), never on a push or a tag: run it from the release commit and give it that commit's version. It builds the wheel and the sdist, stops unless they are exactly that version, checks them with `twine check --strict`, and publishes those files from a separate job in the `pypi` environment.

Neither of the two things it needs is set up by this repository; before the first publication the maintainer creates both:

- **On PyPI**, a pending trusted publisher (**Account settings → Publishing → Add a new pending publisher**, GitHub tab): PyPI project name `bugpilot`, owner `xsw7910`, repository name `bugpilot`, workflow name `release.yml`, environment name `pypi`. The first successful run creates the project.
- **On GitHub**, an environment named `pypi` (**Settings → Environments**), with required reviewers so the publish job waits for approval. It holds no secrets.

While the publish job waits, download the run's `python-distributions` artifact (the run summary lists its SHA-256) and check it as a release: a clean install, `bugpilot --version`, `scripts/check_cli_contract.py`. A version uploaded to PyPI can never be replaced, so approval is the last point to stop.

## Release order: PyPI before the Marketplace

The extension's **Install BugPilot Runtime** installs `bugpilot==<extension version>` from PyPI, so an extension version works for a new user only once PyPI serves the same CLI version. The versions move together — `__version__` in `bugpilot/__init__.py`, `version` in `extension/package.json` (and its lock file: `npm version <version> --no-git-tag-version` in `extension/`), and the Licensed Work in both licence files — and a release goes in this order:

1. Finish and review the source at the new version.
2. Commit and push it.
3. Run the release workflow from that commit, with that version.
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

The Licensed Work names one version, so every release updates it in each licence file. For BugPilot 0.1.0, the first public release date is 2026-10-08 and the BUSL Change Date is 2030-10-08. BugPilot 0.1.1 keeps that Change Date.

Third-party code keeps its own licence and attribution, next to the files it covers and listed in the component's notices file (`extension/THIRD_PARTY_NOTICES.md` for the codicons font, CC BY 4.0). Never append notices to a `LICENSE` copy.

## The Windows installer

`install.cmd` runs `installer/install.ps1`, which installs a wheel from `installer/` with pipx (installing Python with winget if it is missing) and offers to run `bugpilot setup`. Put the wheel built above in `installer/` before distributing it.
