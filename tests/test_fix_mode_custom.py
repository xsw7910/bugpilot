"""Custom Fix Modes through the commands a developer actually types.

The store's own tests cover what a file may contain. These cover what happens
when a custom mode meets the rest of BugPilot: the CLI that manages one, the run
that uses one, and — the case this phase exists for — a work item prepared under
`user/my-safe` on a machine where a project later defines `my-safe` too.

Only the id is authority, so that work item's next run correctly resolves to the
project definition. Doing it *silently* would swap a personal workflow for a
team one with nothing on screen to say so, which is why the drift warning is
tested as carefully as the resolution itself.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from bugpilot.cli import main
from bugpilot.core import workflow
from bugpilot.core.fix_mode_store import FixModeStore, custom_mode_payload
from bugpilot.core.fix_modes import builtin_fix_mode_registry

BUILTIN = builtin_fix_mode_registry()
COMMIT_OFFER = "Do you want me to commit and push this branch to origin?"


@pytest.fixture
def home(isolate_bugpilot_config) -> Path:
    """The isolated `~/.bugpilot` every test already runs against."""
    return Path(isolate_bugpilot_config)


@pytest.fixture
def repo(tmp_path, monkeypatch) -> Path:
    monkeypatch.chdir(tmp_path)
    return tmp_path


def definition(mode_id: str, **overrides) -> dict:
    payload = custom_mode_payload(BUILTIN.default)
    payload["id"] = mode_id
    payload["name"] = mode_id.replace("-", " ").title()
    payload.update(overrides)
    return payload


def write_payload(tmp_path: Path, payload: dict) -> str:
    path = tmp_path / "payload.json"
    path.write_text(json.dumps(payload), encoding="utf-8")
    return str(path)


def prepare(*args: str) -> int:
    return main(["bug", "JR-12345", "--allow-mock", "--prepare-only", *args])


def task_text(repo: Path, name: str = "agent_task.md") -> str:
    return (repo / ".ai" / "JR-12345" / name).read_text(encoding="utf-8")


def persisted(repo: Path) -> dict:
    return json.loads((repo / ".ai" / "JR-12345" / "fix_mode.json").read_text(encoding="utf-8"))


# --- the CLI ----------------------------------------------------------------


def test_duplicate_then_list_shows_the_custom_mode_as_effective(repo, capsys):
    assert main(["fix-mode", "duplicate", "standard", "my-safe", "--scope", "user"]) == 0
    capsys.readouterr()

    assert main(["fix-mode", "list", "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)

    custom = [mode for mode in payload["modes"] if mode["id"] == "my-safe"]
    assert custom and custom[0]["source"] == "user"
    assert custom[0]["based_on"] == "standard"
    assert payload["default_mode_id"] == "standard"
    assert payload["issues"] == []


def test_all_scopes_lists_both_definitions_and_says_which_one_runs(repo, capsys):
    assert main(["fix-mode", "duplicate", "standard", "my-safe", "--scope", "user"]) == 0
    assert main(["fix-mode", "duplicate", "conservative", "my-safe", "--scope", "project"]) == 0
    capsys.readouterr()

    assert main(["fix-mode", "list", "--all-scopes", "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)

    assert [mode["id"] for mode in payload["user"]] == ["my-safe"]
    assert [mode["id"] for mode in payload["project"]] == ["my-safe"]
    assert payload["user"][0]["effective"] is False
    assert payload["project"][0]["effective"] is True
    assert len(payload["builtin"]) == len(BUILTIN.list_modes())
    # The plain list answers the other question: one definition per id.
    capsys.readouterr()
    assert main(["fix-mode", "list", "--json"]) == 0
    effective = json.loads(capsys.readouterr().out)["modes"]
    assert len([mode for mode in effective if mode["id"] == "my-safe"]) == 1


def test_show_json_carries_the_sections_an_editor_edits(repo, capsys):
    assert main(["fix-mode", "duplicate", "standard", "my-safe", "--scope", "user"]) == 0
    capsys.readouterr()

    assert main(["fix-mode", "show", "my-safe", "--json"]) == 0
    mode = json.loads(capsys.readouterr().out)["mode"]

    for section in (
        "objective",
        "investigation",
        "implementation",
        "verification",
        "constraints",
        "completion",
    ):
        assert mode[section].strip()
    assert mode["id"] == "my-safe"
    assert mode["source"] == "user"


def test_create_update_and_delete_round_trip_through_a_file(repo, tmp_path, capsys):
    payload = write_payload(tmp_path, definition("my-safe", description="First."))
    assert main(["fix-mode", "create", "my-safe", "--scope", "user", "--from-file", payload]) == 0

    updated = write_payload(tmp_path, definition("my-safe", description="Second."))
    assert (
        main(
            [
                "fix-mode",
                "update",
                "my-safe",
                "--scope",
                "user",
                "--expected-version",
                "1",
                "--from-file",
                updated,
            ]
        )
        == 0
    )
    capsys.readouterr()
    assert main(["fix-mode", "show", "my-safe", "--json"]) == 0
    mode = json.loads(capsys.readouterr().out)["mode"]
    assert (mode["description"], mode["version"]) == ("Second.", 2)

    assert (
        main(["fix-mode", "delete", "my-safe", "--scope", "user", "--expected-version", "2"]) == 0
    )
    capsys.readouterr()
    assert main(["fix-mode", "show", "my-safe"]) == 1


@pytest.mark.parametrize(
    ("argv", "expected"),
    [
        (["fix-mode", "duplicate", "standard", "standard", "--scope", "user"], "reserved"),
        (["fix-mode", "duplicate", "standard", "my-safe"], "--scope"),
        (["fix-mode", "create", "my-safe", "--scope", "user"], "--from-file"),
        (["fix-mode", "update", "my-safe", "--scope", "user"], "--expected-version"),
        (["fix-mode", "delete", "my-safe", "--scope", "user"], "--expected-version"),
        (["fix-mode", "show", "no-such-mode"], "Unknown Fix Mode"),
        (["fix-mode", "duplicate", "standard"], "needs a new id"),
    ],
)
def test_a_refused_command_says_why_without_a_traceback(repo, capsys, argv, expected):
    assert main(argv) == 1
    captured = capsys.readouterr()

    assert expected in captured.err
    assert "Traceback" not in captured.err
    assert "Traceback" not in captured.out


def test_a_refused_command_is_a_json_envelope_when_asked(repo, capsys):
    assert main(["fix-mode", "duplicate", "standard", "standard", "--scope", "user", "--json"]) == 1
    payload = json.loads(capsys.readouterr().out)

    assert payload["ok"] is False
    assert payload["command"] == "fix-mode"
    assert payload["error"]["code"] == "INVALID_INPUT"
    assert "reserved" in payload["error"]["message"]


def test_a_stale_update_is_refused_through_the_cli(repo, tmp_path, capsys):
    payload = write_payload(tmp_path, definition("my-safe"))
    assert main(["fix-mode", "create", "my-safe", "--scope", "user", "--from-file", payload]) == 0
    args = ["fix-mode", "update", "my-safe", "--scope", "user", "--expected-version", "1",
            "--from-file", payload]
    assert main(args) == 0

    assert main(args) == 1

    assert "changed since this editor was opened" in capsys.readouterr().err


def test_a_broken_custom_file_is_a_warning_not_a_disappearing_catalog(repo, home, capsys):
    assert main(["fix-mode", "duplicate", "standard", "my-safe", "--scope", "user"]) == 0
    (home / "fix_modes" / "broken.json").write_text("{ not json", encoding="utf-8")
    capsys.readouterr()

    assert main(["fix-mode", "list", "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)

    assert any(mode["id"] == "my-safe" for mode in payload["modes"])
    assert len(payload["issues"]) == 1
    assert payload["issues"][0]["scope"] == "user"
    assert payload["issues"][0]["path"].endswith("broken.json")
    assert "not valid JSON" in payload["issues"][0]["message"]


# --- running under a custom mode --------------------------------------------


def test_a_run_uses_a_user_custom_mode_and_records_its_scope(repo):
    assert main(["fix-mode", "duplicate", "conservative", "my-safe", "--scope", "user"]) == 0

    assert prepare("--fix-mode", "my-safe") == 0

    assert "- Mode ID: `my-safe`" in task_text(repo)
    assert "- Source: user" in task_text(repo)
    assert persisted(repo)["source"] == "user"
    assert "smallest local change" in task_text(repo)


def test_a_project_custom_mode_runs_the_same_way(repo):
    assert main(["fix-mode", "duplicate", "standard", "team-safe", "--scope", "project"]) == 0

    assert prepare("--fix-mode", "team-safe") == 0

    assert "- Source: project" in task_text(repo)
    assert persisted(repo)["source"] == "project"


def test_a_custom_investigate_mode_gets_every_investigation_rule(repo, tmp_path):
    """Nothing structural may depend on the id `investigate-first`."""
    assert (
        main(["fix-mode", "duplicate", "investigate-first", "team-triage", "--scope", "project"])
        == 0
    )

    assert prepare("--fix-mode", "team-triage") == 0
    task = task_text(repo)

    assert "- Execution: investigate" in task
    assert "## Investigation Handoff" in task
    assert "Investigation complete. No source changes have been applied." in task
    assert "Do you want me to continue with implementation?" in task
    assert COMMIT_OFFER not in task
    assert "## Optional Assisted Delivery" not in task
    # The safety gate an investigation keeps.
    assert "## BugPilot Delivery Safety" in task
    assert "`JIRA_TOKEN`" in task
    # And the retry stays investigative.
    assert main(["retry-prompt", "JR-12345"]) == 0
    retry = task_text(repo, "agent_retry_prompt.md")
    assert COMMIT_OFFER not in retry
    assert "Name the evidence that is still missing" in retry


def test_every_regeneration_path_keeps_a_custom_mode(repo):
    assert main(["fix-mode", "duplicate", "test-driven", "my-safe", "--scope", "user"]) == 0
    assert prepare("--fix-mode", "my-safe") == 0

    assert prepare("--resume") == 0
    assert "- Mode ID: `my-safe`" in task_text(repo)

    workflow.refine_investigation(repo, "JR-12345")
    assert "- Mode ID: `my-safe`" in task_text(repo)

    assert main(["agent-task", "JR-12345"]) == 0
    assert "- Mode ID: `my-safe`" in task_text(repo)

    workflow.prompt_step(repo, "JR-12345")
    assert "- Mode ID: `my-safe`" in task_text(repo)

    assert main(["retry-prompt", "JR-12345"]) == 0
    assert "- Mode ID: `my-safe`" in task_text(repo, "agent_retry_prompt.md")


def test_a_deleted_custom_mode_fails_loudly_rather_than_becoming_standard(repo, capsys):
    assert main(["fix-mode", "duplicate", "standard", "my-safe", "--scope", "user"]) == 0
    assert prepare("--fix-mode", "my-safe") == 0
    assert main(["fix-mode", "delete", "my-safe", "--scope", "user", "--expected-version", "1"]) == 0
    capsys.readouterr()

    assert main(["agent-task", "JR-12345"]) == 1
    err = capsys.readouterr().err

    assert "Stored Fix Mode 'my-safe' cannot be resolved" in err
    assert "--fix-mode" in err
    # The package still says what it was prepared with; nothing rewrote it.
    assert persisted(repo)["id"] == "my-safe"


def test_a_custom_mode_edited_between_runs_is_reloaded(repo, tmp_path, capsys):
    """These files are meant to be edited; nothing caches them across commands."""
    assert main(["fix-mode", "duplicate", "standard", "my-safe", "--scope", "user"]) == 0
    assert prepare("--fix-mode", "my-safe") == 0
    assert "Edited objective." not in task_text(repo)

    payload = write_payload(tmp_path, definition("my-safe", objective="Edited objective."))
    assert (
        main(
            ["fix-mode", "update", "my-safe", "--scope", "user", "--expected-version", "1",
             "--from-file", payload]
        )
        == 0
    )
    assert prepare("--resume") == 0

    assert "Edited objective." in task_text(repo)


# --- drift -------------------------------------------------------------------


def test_a_version_change_is_reported_on_resume(repo, tmp_path, capsys):
    assert main(["fix-mode", "duplicate", "standard", "my-safe", "--scope", "user"]) == 0
    assert prepare("--fix-mode", "my-safe") == 0
    payload = write_payload(tmp_path, definition("my-safe", description="Edited."))
    assert (
        main(
            ["fix-mode", "update", "my-safe", "--scope", "user", "--expected-version", "1",
             "--from-file", payload]
        )
        == 0
    )
    capsys.readouterr()

    assert prepare("--resume") == 0
    out = capsys.readouterr().out

    assert "version: 1 -> 2" in out
    assert persisted(repo)["version"] == 2


def test_the_required_end_to_end_precedence_flow(repo, capsys):
    """One work item, one id, and the definition behind it changing scope twice.

    The whole point of Phase 5 in a single scenario: a personal mode is used for
    a bug, a team later defines the same id, and the developer has to be told
    that the workflow behind that name is no longer theirs — and told again when
    the team's copy goes away.
    """
    # 1. a personal mode, copied from a built-in.
    assert main(["fix-mode", "duplicate", "standard", "my-safe", "--scope", "user"]) == 0

    # 2. a work item prepared under it.
    assert prepare("--fix-mode", "my-safe") == 0
    assert "- Source: user" in task_text(repo)
    assert persisted(repo)["source"] == "user"
    capsys.readouterr()

    # 3. the team defines the same id, from a different built-in.
    assert main(["fix-mode", "duplicate", "conservative", "my-safe", "--scope", "project"]) == 0
    capsys.readouterr()

    # 4. resuming says the definition behind the name changed, and uses it.
    assert prepare("--resume") == 0
    out = capsys.readouterr().out
    assert "source: user -> project" in out
    assert "- Source: project" in task_text(repo)
    assert "smallest local change" in task_text(repo)
    assert persisted(repo)["source"] == "project"

    # 5. the team's copy is deleted again.
    assert (
        main(["fix-mode", "delete", "my-safe", "--scope", "project", "--expected-version", "1"])
        == 0
    )
    capsys.readouterr()

    # 6. and the developer's own mode comes back, with the same warning.
    assert prepare("--resume") == 0
    out = capsys.readouterr().out
    assert "source: project -> user" in out
    assert "- Source: user" in task_text(repo)
    assert persisted(repo)["source"] == "user"


def test_no_drift_warning_when_nothing_moved(repo, capsys):
    assert main(["fix-mode", "duplicate", "standard", "my-safe", "--scope", "user"]) == 0
    assert prepare("--fix-mode", "my-safe") == 0
    capsys.readouterr()

    assert prepare("--resume") == 0

    assert "changed since this work item was prepared" not in capsys.readouterr().out


def test_the_selection_record_stays_audit_metadata(repo):
    """Never a copy of the instructions: the id is what selects a definition."""
    assert main(["fix-mode", "duplicate", "conservative", "my-safe", "--scope", "user"]) == 0
    assert prepare("--fix-mode", "my-safe") == 0

    record = persisted(repo)

    assert set(record) == {
        "schema_version",
        "id",
        "name",
        "version",
        "source",
        "execution_kind",
        "based_on",
        "based_on_version",
    }


# --- repository context ------------------------------------------------------


def test_project_modes_come_from_the_target_repository(tmp_path, home):
    """Not from whichever directory BugPilot itself happens to live in."""
    target = tmp_path / "target"
    (target / ".bugpilot" / "fix_modes").mkdir(parents=True)
    other = tmp_path / "other"
    (other / ".bugpilot" / "fix_modes").mkdir(parents=True)
    FixModeStore(target, home).create("project", "target-mode", definition("target-mode"))
    FixModeStore(other, home).create("project", "other-mode", definition("other-mode"))

    ids = [mode.id for mode in FixModeStore(target, home).load_catalog().project]

    assert ids == ["target-mode"]


def test_bugpilot_does_not_touch_the_repository_beyond_the_mode_file(repo):
    assert main(["fix-mode", "duplicate", "standard", "team-safe", "--scope", "project"]) == 0

    written = sorted(path.name for path in (repo / ".bugpilot" / "fix_modes").iterdir())

    assert written == ["team-safe.json"]
    # Project modes are ordinary repository files: BugPilot neither stages them
    # nor hides them from the developer's own commits.
    assert not (repo / ".gitignore").exists()
