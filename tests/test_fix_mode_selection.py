"""Choosing a Fix Mode once, and every later path honoring that choice.

The defect this file exists to prevent is silent substitution. A developer picks
Conservative Fix, and three commands later — a resume, a refinement, a
regenerated task file, a retry — the package comes back as Standard Fix because
one call site did not thread the selection through. Nothing fails, nothing warns,
and the agent is handed a different workflow than the one that was chosen. So
every regeneration entry point is tested for the mode it produces, not merely
for producing something.

The second rule these tests hold is that a selection which cannot be honored is
an error rather than a fallback. `fix_mode.json` records an id, and the id is
re-resolved through the registry on every read; a stored mode that no longer
exists has to say so, because "quietly became Standard" is the failure that a
project-scoped custom mode would hit first.
"""

from __future__ import annotations

import json
from pathlib import Path

import pytest

from bugpilot.cli import main
from bugpilot.core import workflow
from bugpilot.core.fix_mode_state import (
    FIX_MODE_FILE,
    FIX_MODE_SCHEMA_VERSION,
    fix_mode_metadata,
    fix_mode_registry,
    persist_fix_mode,
    select_fix_mode,
)
from bugpilot.core.fix_modes import FixModeError, FixModeNotFoundError

REGISTRY = fix_mode_registry()
COMMIT_OFFER = "Do you want me to commit and push this branch to origin?"


def prepare(tmp_path: Path, *args: str) -> int:
    """A prepared package, without launching an agent."""
    return main(["bug", "JR-12345", "--allow-mock", "--prepare-only", *args])


def task_text(tmp_path: Path, name: str = "agent_task.md") -> str:
    return (tmp_path / ".ai" / "JR-12345" / name).read_text(encoding="utf-8")


def stored(tmp_path: Path) -> dict:
    return json.loads(
        (tmp_path / ".ai" / "JR-12345" / FIX_MODE_FILE).read_text(encoding="utf-8")
    )


def status(tmp_path: Path) -> dict:
    return json.loads(
        (tmp_path / ".ai" / "JR-12345" / "workflow_status.json").read_text(encoding="utf-8")
    )


# --- selection precedence ----------------------------------------------------


def test_no_selection_and_no_history_is_standard(tmp_path):
    selection = select_fix_mode(tmp_path, "JR-1")

    assert selection.mode.id == "standard"
    assert selection.origin == "default"
    assert selection.warnings == ()


def test_an_explicit_id_wins_over_the_persisted_one(tmp_path):
    persist_fix_mode(tmp_path, "JR-1", REGISTRY.resolve("conservative"))

    selection = select_fix_mode(tmp_path, "JR-1", "test-driven")

    assert selection.mode.id == "test-driven"
    assert selection.origin == "explicit"


def test_the_persisted_selection_is_used_when_nothing_is_asked_for(tmp_path):
    persist_fix_mode(tmp_path, "JR-1", REGISTRY.resolve("conservative"))

    selection = select_fix_mode(tmp_path, "JR-1")

    assert selection.mode.id == "conservative"
    assert selection.origin == "persisted"


def test_a_fresh_run_does_not_inherit_the_previous_package_s_mode(tmp_path):
    """`use_persisted=False` is what a fresh run passes: it is about to delete
    the package that recorded the mode, so that mode belongs to the run being
    discarded."""
    persist_fix_mode(tmp_path, "JR-1", REGISTRY.resolve("deep-analysis"))

    selection = select_fix_mode(tmp_path, "JR-1", use_persisted=False)

    assert selection.mode.id == "standard"
    assert selection.origin == "default"


def test_an_unknown_explicit_id_raises_rather_than_falling_back(tmp_path):
    with pytest.raises(FixModeNotFoundError, match="Unknown Fix Mode"):
        select_fix_mode(tmp_path, "JR-1", "does-not-exist")


# --- the persisted file ------------------------------------------------------


def test_the_selection_file_records_resolvable_audit_metadata(tmp_path):
    path = persist_fix_mode(tmp_path, "JR-1", REGISTRY.resolve("investigate-first"))
    payload = json.loads(path.read_text(encoding="utf-8"))

    assert path.name == FIX_MODE_FILE
    assert payload == {
        "schema_version": FIX_MODE_SCHEMA_VERSION,
        "id": "investigate-first",
        "name": "Investigate First",
        "version": 1,
        "source": "builtin",
        "execution_kind": "investigate",
        "based_on": None,
        "based_on_version": None,
    }
    # Deterministic on disk, so a re-run is not a diff.
    assert path.read_text(encoding="utf-8").endswith("}\n")
    assert path.read_text(encoding="utf-8") == json.dumps(payload, indent=2, sort_keys=True) + "\n"


def test_metadata_is_one_shape_everywhere(tmp_path):
    """The file, the status file and `--json` all say it the same way."""
    mode = REGISTRY.resolve("conservative")
    assert fix_mode_metadata(mode) == {
        "id": "conservative",
        "name": "Conservative Fix",
        "version": 1,
        "source": "builtin",
        "execution_kind": "fix",
        "based_on": None,
        "based_on_version": None,
    }


@pytest.mark.parametrize(
    "contents",
    ["not json at all", "[]", '"conservative"', "null"],
)
def test_an_unreadable_selection_file_fails_clearly(tmp_path, contents):
    target = tmp_path / ".ai" / "JR-1"
    target.mkdir(parents=True)
    (target / FIX_MODE_FILE).write_text(contents, encoding="utf-8")

    with pytest.raises(FixModeError) as excinfo:
        select_fix_mode(tmp_path, "JR-1")
    assert FIX_MODE_FILE in str(excinfo.value)
    assert "--fix-mode" in str(excinfo.value)


@pytest.mark.parametrize("payload", [{}, {"name": "Conservative Fix"}, {"id": "   "}, {"id": 7}])
def test_a_selection_file_without_a_usable_id_fails_clearly(tmp_path, payload):
    target = tmp_path / ".ai" / "JR-1"
    target.mkdir(parents=True)
    (target / FIX_MODE_FILE).write_text(json.dumps(payload), encoding="utf-8")

    with pytest.raises(FixModeError, match="does not record a Fix Mode id"):
        select_fix_mode(tmp_path, "JR-1")


def test_a_stored_id_that_no_longer_resolves_fails_instead_of_becoming_standard(tmp_path):
    """The case a project-scoped custom mode hits the day its file is deleted."""
    target = tmp_path / ".ai" / "JR-1"
    target.mkdir(parents=True)
    (target / FIX_MODE_FILE).write_text(
        json.dumps({"schema_version": 1, "id": "team-safe-fix"}), encoding="utf-8"
    )

    with pytest.raises(FixModeNotFoundError) as excinfo:
        select_fix_mode(tmp_path, "JR-1")
    assert "Stored Fix Mode 'team-safe-fix' cannot be resolved" in str(excinfo.value)
    assert "--fix-mode" in str(excinfo.value)


def test_only_the_id_selects_the_mode(tmp_path):
    """Name and kind in the file are audit data, never authority.

    A stale or hand-edited file must not be able to describe one mode and
    deliver another, so everything but the id is re-derived from the registry.
    """
    target = tmp_path / ".ai" / "JR-1"
    target.mkdir(parents=True)
    (target / FIX_MODE_FILE).write_text(
        json.dumps(
            {
                "schema_version": 1,
                "id": "conservative",
                "name": "Something Else Entirely",
                "execution_kind": "investigate",
                "source": "project",
            }
        ),
        encoding="utf-8",
    )

    mode = select_fix_mode(tmp_path, "JR-1").mode

    assert mode.name == "Conservative Fix"
    assert mode.execution_kind == "fix"
    assert mode.source == "builtin"


def test_a_recorded_version_that_has_moved_on_warns_and_uses_the_installed_one(tmp_path):
    target = tmp_path / ".ai" / "JR-1"
    target.mkdir(parents=True)
    (target / FIX_MODE_FILE).write_text(
        json.dumps({"schema_version": 1, "id": "conservative", "version": 99}),
        encoding="utf-8",
    )

    selection = select_fix_mode(tmp_path, "JR-1")

    assert selection.mode.version == 1
    assert len(selection.warnings) == 1
    assert "version: 99 -> 1" in selection.warnings[0]
    assert "changed since this work item was prepared" in selection.warnings[0]


def test_a_matching_recorded_version_is_silent(tmp_path):
    persist_fix_mode(tmp_path, "JR-1", REGISTRY.resolve("conservative"))

    assert select_fix_mode(tmp_path, "JR-1").warnings == ()


# --- the run, and everything that regenerates from it ------------------------


def test_a_run_without_a_mode_prepares_standard_and_records_it(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)

    assert prepare(tmp_path) == 0

    assert stored(tmp_path)["id"] == "standard"
    assert "- Mode: Standard Fix" in task_text(tmp_path)
    assert status(tmp_path)["fix_mode"]["id"] == "standard"


def test_an_explicit_mode_reaches_the_task_file_and_the_selection_file(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)

    assert prepare(tmp_path, "--fix-mode", "conservative") == 0

    assert stored(tmp_path)["id"] == "conservative"
    assert "- Mode: Conservative Fix" in task_text(tmp_path)
    assert "smallest local change" in task_text(tmp_path)


def test_resume_without_a_flag_keeps_the_chosen_mode(tmp_path, monkeypatch):
    """The regression this phase is built around."""
    monkeypatch.chdir(tmp_path)
    assert prepare(tmp_path, "--fix-mode", "conservative") == 0

    assert prepare(tmp_path, "--resume") == 0

    assert stored(tmp_path)["id"] == "conservative"
    assert "- Mode: Conservative Fix" in task_text(tmp_path)
    assert status(tmp_path)["fix_mode"]["id"] == "conservative"


def test_resume_with_an_explicit_mode_switches_and_records_the_switch(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    assert prepare(tmp_path, "--fix-mode", "investigate-first") == 0

    assert prepare(tmp_path, "--resume", "--fix-mode", "standard") == 0

    assert stored(tmp_path)["id"] == "standard"
    assert "- Mode: Standard Fix" in task_text(tmp_path)
    # Which is how an investigation becomes an implementation pass: no state
    # machine, just the next run under a fix mode.
    assert COMMIT_OFFER in task_text(tmp_path)


def test_a_fresh_rerun_without_a_flag_returns_to_standard(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    assert prepare(tmp_path, "--fix-mode", "deep-analysis") == 0

    assert prepare(tmp_path) == 0

    assert stored(tmp_path)["id"] == "standard"


def test_refinement_keeps_the_chosen_mode(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    assert prepare(tmp_path, "--fix-mode", "conservative") == 0

    workflow.refine_investigation(tmp_path, "JR-12345")

    assert "- Mode: Conservative Fix" in task_text(tmp_path)


def test_standalone_agent_task_regeneration_keeps_the_chosen_mode(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    assert prepare(tmp_path, "--fix-mode", "investigate-first") == 0

    assert main(["agent-task", "JR-12345"]) == 0

    assert "- Mode: Investigate First" in task_text(tmp_path)
    assert COMMIT_OFFER not in task_text(tmp_path)


def test_prompt_step_regeneration_keeps_the_chosen_mode(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    assert prepare(tmp_path, "--fix-mode", "test-driven") == 0

    workflow.prompt_step(tmp_path, "JR-12345")

    assert "- Mode: Test-Driven Fix" in task_text(tmp_path)


def test_the_selection_file_is_reported_as_a_generated_artifact(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)

    assert prepare(tmp_path, "--fix-mode", "conservative") == 0

    assert f".ai/JR-12345/{FIX_MODE_FILE}" in status(tmp_path)["generated_files"]


def test_a_rejected_mode_costs_no_artifacts(tmp_path, monkeypatch):
    """Resolution happens before a fresh run deletes anything."""
    monkeypatch.chdir(tmp_path)
    assert prepare(tmp_path, "--fix-mode", "conservative") == 0
    before = sorted(path.name for path in (tmp_path / ".ai" / "JR-12345").iterdir())

    assert prepare(tmp_path, "--fix-mode", "nope") == 1

    assert sorted(path.name for path in (tmp_path / ".ai" / "JR-12345").iterdir()) == before
    assert stored(tmp_path)["id"] == "conservative"


# --- retry -------------------------------------------------------------------


def test_a_fix_mode_retry_still_offers_assisted_delivery(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    assert prepare(tmp_path, "--fix-mode", "conservative") == 0

    assert main(["retry-prompt", "JR-12345"]) == 0
    retry = task_text(tmp_path, "agent_retry_prompt.md")

    assert "- Mode: Conservative Fix" in retry
    assert COMMIT_OFFER in retry
    assert "## Optional Assisted Delivery" in retry
    assert "Re-check the implementation location." in retry
    assert "## BugPilot Delivery Safety" in retry


def test_an_investigation_retry_investigates_again_instead_of_delivering(tmp_path, monkeypatch):
    """The Phase 1/2 review found this renderer assuming a fix always existed."""
    monkeypatch.chdir(tmp_path)
    assert prepare(tmp_path, "--fix-mode", "investigate-first") == 0

    assert main(["retry-prompt", "JR-12345"]) == 0
    retry = task_text(tmp_path, "agent_retry_prompt.md")

    assert "- Mode: Investigate First" in retry
    assert "- Execution: investigate" in retry
    # No implementation to revisit, and nothing to deliver.
    assert COMMIT_OFFER not in retry
    assert "## Optional Assisted Delivery" not in retry
    assert "git push -u origin" not in retry
    assert "Re-check the implementation location." not in retry
    assert "If the previous change is wrong" not in retry
    # What a second investigation pass is actually for.
    assert "Name the evidence that is still missing" in retry
    assert "Revise the ranked hypotheses" in retry
    assert "Update the proposed fix plan" in retry
    assert "Do not modify source code" in retry
    # The safety gate and the continuation question both survive.
    assert "## BugPilot Delivery Safety" in retry
    assert "`JIRA_TOKEN`" in retry
    assert "## Investigation Handoff" in retry
    assert "Do you want me to continue with implementation?" in retry


def test_retry_never_silently_changes_the_selected_mode(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    assert prepare(tmp_path, "--fix-mode", "deep-analysis") == 0

    assert main(["retry-prompt", "JR-12345"]) == 0

    assert stored(tmp_path)["id"] == "deep-analysis"
    assert "- Mode: Deep Analysis" in task_text(tmp_path, "agent_retry_prompt.md")


# --- CLI surface -------------------------------------------------------------


def test_fix_mode_list_names_every_mode_and_its_kind(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)

    assert main(["fix-mode", "list"]) == 0
    out = capsys.readouterr().out

    for mode in REGISTRY.list_modes():
        assert mode.id in out
        assert mode.name in out
    assert "investigate" in out
    assert "--fix-mode" in out


def test_fix_mode_show_prints_the_whole_mode_not_a_repr(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)

    assert main(["fix-mode", "show", "standard"]) == 0
    out = capsys.readouterr().out

    assert "Standard Fix (standard)" in out
    assert "Version:        1" in out
    assert "Source:         builtin" in out
    assert "Execution kind: fix" in out
    for heading in (
        "Objective",
        "Investigation",
        "Implementation",
        "Verification",
        "Constraints",
        "Completion Requirements",
    ):
        assert heading in out
    assert "FixMode(" not in out


def test_fix_mode_show_says_when_a_mode_does_not_implement(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)

    assert main(["fix-mode", "show", "investigate-first"]) == 0
    out = capsys.readouterr().out

    assert "Execution kind: investigate" in out
    assert "does not change source code in its first pass" in out


def test_fix_mode_show_rejects_an_unknown_id(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)

    assert main(["fix-mode", "show", "nope"]) == 1
    err = capsys.readouterr().err

    assert "Unknown Fix Mode 'nope'" in err
    assert "standard" in err


def test_fix_mode_show_without_an_id_asks_for_one(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)

    assert main(["fix-mode", "show"]) == 1

    assert "needs a mode id" in capsys.readouterr().err


def test_an_unknown_mode_on_a_run_is_a_clear_error(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)

    assert prepare(tmp_path, "--fix-mode", "nope") == 1
    err = capsys.readouterr().err

    assert "Unknown Fix Mode 'nope'" in err
    assert "bugpilot fix-mode list" in err


def test_regeneration_reports_an_unusable_selection_without_a_traceback(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    assert prepare(tmp_path, "--fix-mode", "conservative") == 0
    (tmp_path / ".ai" / "JR-12345" / FIX_MODE_FILE).write_text("{oh dear", encoding="utf-8")

    assert main(["agent-task", "JR-12345"]) == 1
    err = capsys.readouterr().err

    assert "could not be read" in err
    assert "Traceback" not in err


def test_the_default_command_shorthand_accepts_a_mode(tmp_path, monkeypatch):
    """`bugpilot JR-12345 --fix-mode ...` is how most people will type it."""
    monkeypatch.chdir(tmp_path)

    assert main(["JR-12345", "--allow-mock", "--prepare-only", "--fix-mode", "conservative"]) == 0

    assert stored(tmp_path)["id"] == "conservative"


# --- machine-readable output -------------------------------------------------


def test_json_output_carries_the_selected_mode(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)

    assert main(["bug", "JR-12345", "--allow-mock", "--json", "--fix-mode", "investigate-first"]) == 0
    payload = json.loads(capsys.readouterr().out)

    assert payload["ok"] is True
    assert payload["fix_mode"] == {
        "id": "investigate-first",
        "name": "Investigate First",
        "version": 1,
        "source": "builtin",
        "execution_kind": "investigate",
        "based_on": None,
        "based_on_version": None,
    }
    # The keys that were there before are still there.
    assert payload["work_item_id"] == "JR-12345"
    assert payload["agent_task"] == ".ai/JR-12345/agent_task.md"


def test_json_output_defaults_to_standard_metadata(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)

    assert main(["bug", "JR-12345", "--allow-mock", "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)

    assert payload["fix_mode"]["id"] == "standard"
    assert payload["fix_mode"]["execution_kind"] == "fix"


def test_status_json_exposes_the_recorded_mode(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    assert prepare(tmp_path, "--fix-mode", "conservative") == 0
    capsys.readouterr()  # drain the prepare run's human output

    assert main(["status", "JR-12345", "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)

    assert payload["fix_mode"]["id"] == "conservative"
    assert payload["mode"] == "prepare-only"


# --- machine-readable discovery ---------------------------------------------
#
# The VS Code panel populates its Fix Mode selector from this. It exists so no
# other tool has to parse the human table, and so nothing outside core has to
# encode which mode is the default.


def test_fix_mode_list_json_is_a_normal_envelope(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)

    assert main(["fix-mode", "list", "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)

    assert payload["schema_version"] == 1
    assert payload["ok"] is True
    assert payload["command"] == "fix-mode"
    assert payload["warnings"] == []


def test_fix_mode_list_json_names_the_default_so_a_caller_need_not(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)

    assert main(["fix-mode", "list", "--json"]) == 0
    payload = json.loads(capsys.readouterr().out)

    assert payload["default_mode_id"] == REGISTRY.default.id
    assert payload["default_mode_id"] in {mode["id"] for mode in payload["modes"]}


def test_fix_mode_list_json_carries_what_a_picker_needs(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)

    assert main(["fix-mode", "list", "--json"]) == 0
    modes = json.loads(capsys.readouterr().out)["modes"]

    assert [mode["id"] for mode in modes] == [mode.id for mode in REGISTRY.list_modes()]
    for mode in modes:
        assert set(mode) == {
            "id",
            "name",
            "version",
            "source",
            "execution_kind",
            "based_on",
            "based_on_version",
            "description",
        }
        assert mode["description"].strip()
    # The instruction sections stay in core: they drive an agent, and a UI that
    # carried them would be a second definition of a Fix Mode.
    assert not any("objective" in mode for mode in modes)
    kinds = {mode["id"]: mode["execution_kind"] for mode in modes}
    assert kinds["investigate-first"] == "investigate"
    assert kinds["standard"] == "fix"


def test_fix_mode_show_json_returns_the_whole_definition(tmp_path, monkeypatch, capsys):
    """Phase 5 gave `show` a machine form: the custom-mode editor loads one mode."""
    monkeypatch.chdir(tmp_path)

    assert main(["fix-mode", "show", "standard", "--json"]) == 0
    mode = json.loads(capsys.readouterr().out)["mode"]

    assert mode["id"] == "standard"
    assert mode["source"] == "builtin"
    for section in ("objective", "investigation", "implementation", "verification",
                    "constraints", "completion"):
        assert mode[section].strip()


def test_the_human_listing_is_unchanged_by_the_json_flag(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)

    assert main(["fix-mode", "list"]) == 0
    out = capsys.readouterr().out

    assert out.startswith("ID")
    assert "{" not in out


# --- what the developer is told at launch -----------------------------------


def _stub_agent(monkeypatch) -> dict:
    from bugpilot.core.agent_runner import AgentRunResult

    captured: dict = {}

    def spy(repo_root, issue_key, agent, config=None, prompt=None):
        captured["prompt"] = prompt
        return AgentRunResult(agent=agent, ran=True, command=[agent], returncode=0)

    monkeypatch.setattr("bugpilot.core.agent_runner.run_agent", spy)
    return captured


def test_an_investigate_launch_does_not_promise_a_fix(tmp_path, monkeypatch, capsys):
    """The task file says "do not modify source code"; the launch text must agree.

    Driven by execution_kind: the same words would appear for a custom
    investigate-kind mode, and nothing here names `investigate-first`.
    """
    monkeypatch.chdir(tmp_path)
    _stub_agent(monkeypatch)

    assert main(["bug", "JR-12345", "--allow-mock", "--fix-mode", "investigate-first"]) == 0
    out = capsys.readouterr().out

    assert "Investigation only: the agent will not change source code in this pass." in out
    assert "without changing source code" in out
    assert "smallest safe fix" not in out
    assert "asks before committing" not in out


def test_a_fix_launch_keeps_the_implementation_guidance(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    _stub_agent(monkeypatch)

    assert main(["bug", "JR-12345", "--allow-mock", "--fix-mode", "conservative"]) == 0
    out = capsys.readouterr().out

    assert "implement the smallest safe fix" in out
    assert "asks before committing" in out
    assert "Investigation only" not in out


# --- `list` takes no id ------------------------------------------------------


def test_fix_mode_list_refuses_a_stray_mode_id(tmp_path, monkeypatch, capsys):
    """`fix-mode list standard` printed the whole table and dropped the id."""
    monkeypatch.chdir(tmp_path)

    assert main(["fix-mode", "list", "standard"]) == 1
    captured = capsys.readouterr()

    assert "takes no mode id" in captured.err
    assert "bugpilot fix-mode show standard" in captured.err
    assert "ID" not in captured.out


def test_fix_mode_list_refuses_a_stray_mode_id_in_json_too(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)

    assert main(["fix-mode", "list", "standard", "--json"]) == 1
    payload = json.loads(capsys.readouterr().out)

    assert payload["ok"] is False
    assert payload["error"]["code"] == "INVALID_INPUT"
    assert "takes no mode id" in payload["error"]["message"]
