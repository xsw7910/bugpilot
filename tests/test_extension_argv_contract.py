"""The CLI accepts every command line the VS Code extension sends (pre-release Batch 1, B).

`tests/fixtures/extension_cli_argv.json` is generated from the extension's own
argv builders by `extension/test/cliArgvContract.test.ts`. This test parses each
entry with this tree's parser; `scripts/check_cli_contract.py` runs the same
fixture against an installed `bugpilot` (a freshly built wheel) before a
release, which is where a stale package used to slip through.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from bugpilot import __version__
from bugpilot.cli import build_parser, main

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "extension_cli_argv.json").read_text(encoding="utf-8"))
COMMANDS = FIXTURE["commands"]


def _concrete(argv: list[str], tmp_path: Path) -> list[str]:
    values = {
        "{REPO}": str(tmp_path),
        "{ATTACHMENT}": str(tmp_path / "crash.log"),
        "{DESCRIPTION_FILE}": str(tmp_path / "description.md"),
        "{PAYLOAD_FILE}": str(tmp_path / "payload.json"),
    }
    out = []
    for arg in argv:
        for placeholder, value in values.items():
            arg = arg.replace(placeholder, value)
        out.append(arg)
    return out


@pytest.mark.parametrize("entry", COMMANDS, ids=[entry["name"] for entry in COMMANDS])
def test_the_parser_accepts_what_the_extension_sends(entry, tmp_path):
    try:
        build_parser().parse_args(_concrete(entry["argv"], tmp_path))
    except SystemExit as exc:  # argparse's way of saying "usage error"
        pytest.fail(f"bugpilot rejects the extension's `{entry['name']}` command line (exit {exc.code})")


def test_the_fixture_is_the_extensions_and_covers_every_run_flag():
    flags = {arg.split("=", 1)[0] for entry in COMMANDS for arg in entry["argv"] if arg.startswith("--")}
    for flag in ("--replace-attachments", "--branch-policy", "--prepare-only", "--resume", "--fresh", "--json-lines"):
        assert flag in flags, flag
    names = [entry["name"] for entry in COMMANDS]
    assert "repository-profile show" in names and "repository-profile set" in names


def test_the_extension_never_asks_the_cli_to_launch_an_agent():
    """Requirement R5 at the boundary: every Run the panel starts is prepare-only."""
    for entry in COMMANDS:
        argv = entry["argv"]
        assert not any(arg.startswith("--launch-agent") for arg in argv), entry["name"]
        if argv[0] == "bug":
            assert "--prepare-only" in argv, entry["name"]


def test_version_is_one_line_from_the_one_source(capsys):
    with pytest.raises(SystemExit) as exc:
        main(["--version"])
    assert exc.value.code == 0
    assert capsys.readouterr().out == f"bugpilot {__version__}\n"


def test_the_package_metadata_reads_the_same_version():
    """pyproject.toml declares the version dynamic, from bugpilot.__version__."""
    pyproject = (Path(__file__).resolve().parents[1] / "pyproject.toml").read_text(encoding="utf-8")
    assert 'dynamic = ["version"]' in pyproject
    assert 'version = { attr = "bugpilot.__version__" }' in pyproject
    assert "\nversion = " not in pyproject.split("[tool.setuptools.dynamic]")[0], "a second hard-coded version"
