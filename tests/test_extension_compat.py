"""A BugPilot extension older than 0.1.7 with a 0.1.7 CLI: told to update both, before anything is prepared.

0.1.6 and earlier extensions look for work items in the repository's `.ai/`; 0.1.7 keeps them in BugPilot's
data folder. The released extensions cannot change, and say nothing about themselves; they start every
process with their extension host's environment, and 0.1.7 extensions add `BUGPILOT_CLIENT_STORAGE=unified`
(`extension/src/runner.ts`). The CLI answers the handshake (`doctor --json`) and a run (`bug --json`,
`--json-lines`) of an extension without it with `EXTENSION_OUTDATED` and one sentence; everything else is
untouched (`bugpilot/core/extension_compat.py`).
"""

from __future__ import annotations

import json

import pytest

from bugpilot.cli import main
from bugpilot.core import errors
from bugpilot.core.config import data_dir
from bugpilot.core.extension_compat import outdated_extension_problem

OLD_EXTENSION = {"VSCODE_CRASH_REPORTER_PROCESS_TYPE": "extensionHost"}
NEW_EXTENSION = {**OLD_EXTENSION, "BUGPILOT_CLIENT_STORAGE": "unified"}
UPDATE_TOGETHER = "Update the BugPilot extension and the bugpilot CLI together, to the same version."


@pytest.fixture
def started_by(monkeypatch):
    def start(environ: dict[str, str]) -> None:
        for name in ("VSCODE_CRASH_REPORTER_PROCESS_TYPE", "BUGPILOT_CLIENT_STORAGE"):
            monkeypatch.delenv(name, raising=False)
        for name, value in environ.items():
            monkeypatch.setenv(name, value)

    return start


@pytest.fixture
def repo(tmp_path, monkeypatch):
    root = tmp_path / "repo"
    root.mkdir()
    monkeypatch.chdir(root)
    return root


def _envelope(capsys) -> dict:
    return json.loads(capsys.readouterr().out)


def test_the_sentence_names_the_version_and_the_way_out():
    problem = outdated_extension_problem(OLD_EXTENSION)
    assert problem is not None
    from bugpilot import __version__

    assert f"This bugpilot ({__version__}) keeps work items in BugPilot's data folder" in problem
    assert problem.endswith(UPDATE_TOGETHER)


@pytest.mark.parametrize(
    "environ",
    [
        {},  # a terminal, a script, CI
        NEW_EXTENSION,  # BugPilot for VS Code 0.1.7 or later
        {"VSCODE_CRASH_REPORTER_PROCESS_TYPE": "renderer", "BUGPILOT_CLIENT_STORAGE": ""},
        {"BUGPILOT_CLIENT_STORAGE": "unified"},
    ],
    ids=["terminal", "extension-0.1.7", "not-an-extension-host", "declared-anywhere"],
)
def test_only_an_extension_host_without_the_declaration_is_told(environ):
    assert outdated_extension_problem(environ) is None


@pytest.mark.parametrize("declared", ["", "repository", "Unified"])
def test_any_other_declaration_is_not_this_one(declared):
    assert outdated_extension_problem({**OLD_EXTENSION, "BUGPILOT_CLIENT_STORAGE": declared}) is not None


def test_an_old_extensions_handshake_fails_with_its_own_code_and_the_sentence(repo, started_by, capsys):
    """What a 0.1.6 extension shows: "its environment check failed: <this sentence>", and it runs nothing."""
    started_by(OLD_EXTENSION)
    assert main(["doctor", "--json"]) == 1
    envelope = _envelope(capsys)
    assert envelope["ok"] is False
    assert envelope["error"]["code"] == errors.EXTENSION_OUTDATED
    assert envelope["error"]["message"].endswith(UPDATE_TOGETHER)
    assert not data_dir(repo).exists()


@pytest.mark.parametrize("environ", [{}, NEW_EXTENSION], ids=["terminal", "extension-0.1.7"])
def test_a_supported_handshake_is_unchanged(repo, started_by, capsys, environ):
    started_by(environ)
    assert main(["doctor", "--json"]) == 0
    envelope = _envelope(capsys)
    assert envelope["ok"] is True
    assert "unified-storage" in envelope["report"]["capabilities"]


def test_doctor_for_a_person_is_unchanged_anywhere(repo, started_by, capsys):
    started_by(OLD_EXTENSION)
    assert main(["doctor"]) == 0
    assert "EXTENSION_OUTDATED" not in capsys.readouterr().out


@pytest.mark.parametrize("mode", ["--json", "--json-lines"])
def test_an_old_extensions_run_prepares_nothing(repo, started_by, capsys, mode):
    started_by(OLD_EXTENSION)
    assert main(["bug", "JR-12345", "--allow-mock", mode]) == 1
    out = capsys.readouterr().out
    # --json is one object; --json-lines a stream that ends with its terminal event.
    failure = json.loads(out) if mode == "--json" else json.loads(out.strip().splitlines()[-1])
    assert failure["ok"] is False
    assert failure["error"]["code"] == errors.EXTENSION_OUTDATED
    assert not data_dir(repo).exists(), "nothing is prepared for an extension that could not find it"


def test_an_old_extensions_new_attempt_prepares_nothing_either(repo, started_by, capsys):
    started_by(NEW_EXTENSION)
    assert main(["bug", "JR-12345", "--allow-mock", "--json"]) == 0
    capsys.readouterr()
    started_by(OLD_EXTENSION)
    assert main(["bug", "JR-12345", "--retry", "--json"]) == 1
    assert _envelope(capsys)["error"]["code"] == errors.EXTENSION_OUTDATED
    assert not (data_dir(repo) / "work" / "JR-12345" / "user_feedback.md").exists()


@pytest.mark.parametrize("environ", [{}, NEW_EXTENSION], ids=["terminal", "extension-0.1.7"])
def test_a_supported_run_prepares_as_before(repo, started_by, capsys, environ):
    started_by(environ)
    assert main(["bug", "JR-12345", "--allow-mock", "--json"]) == 0
    assert _envelope(capsys)["ok"] is True
    assert (data_dir(repo) / "work" / "JR-12345" / "task.md").is_file()


def test_a_run_for_a_person_and_other_commands_are_not_affected(repo, started_by, capsys):
    started_by(OLD_EXTENSION)
    assert main(["bug", "JR-12345", "--allow-mock"]) == 0
    assert (data_dir(repo) / "work" / "JR-12345" / "task.md").is_file()
    capsys.readouterr()
    assert main(["status", "JR-12345", "--json"]) == 0
    assert _envelope(capsys)["ok"] is True
