# Development

How to work on BugPilot itself: the CLI and MCP server in Python, and the VS Code extension in TypeScript.

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

## A standalone executable (Windows)

One self-contained `bugpilot.exe` with its own Python runtime, for machines without Python:

```powershell
python -m pip install --user pyinstaller
python -m PyInstaller --onefile --name bugpilot --collect-submodules bugpilot --paths . pyi_entry.py
```

The output is `dist\bugpilot.exe`. `pyi_entry.py` is the entry point PyInstaller needs (an absolute-import shim around `bugpilot/__main__.py`). The executable is unsigned, so SmartScreen may ask before the first run. BugPilot's safety rules are built into the package, so the executable, a wheel and a source checkout write the same `task.md`.

## Licensing

Everything published from this repository is under one licence, the Business Source License 1.1 in `LICENSE`. A component that is published on its own carries an unmodified copy of that file beside its manifest and declares `BUSL-1.1` there: the wheel ships `LICENSE` (`license-files` in `pyproject.toml`), the VS Code extension ships `extension/LICENSE.txt` (`"license": "BUSL-1.1"` in its `package.json`). A future component — a Claude Code plugin, say — follows the same pattern: a `LICENSE` copy in its directory and `"license": "BUSL-1.1"` in its `.claude-plugin/plugin.json`. `tests/test_publishable.py` finds every licence file and manifest by name and fails on a copy that differs from `LICENSE` or a manifest that declares anything else, so a new component is checked without a test change.

Third-party code keeps its own licence and attribution, next to the files it covers and listed in the component's notices file (`extension/THIRD_PARTY_NOTICES.md` for the codicons font, CC BY 4.0). Never append notices to a `LICENSE` copy.

## The Windows installer

`install.cmd` runs `installer/install.ps1`, which installs a wheel from `installer/` with pipx (installing Python with winget if it is missing) and offers to run `bugpilot setup`. Put the wheel built above in `installer/` before distributing it.
