"""run.json: the one canonical runtime artifact (plan §37, Batch 4).

The run used to leave a status file rewritten on every step and an append-only
text log nothing read. One typed artifact remains. These tests hold its schema,
the lifecycle (running → prepared / failed), the step marks and generated-file
snapshot its consumers read, the failure record, and that an unusable file is
an error, never a fallback.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest

from bugpilot.cli import main
from bugpilot.core import workflow
from bugpilot.core.artifacts import CORE_ARTIFACTS
from bugpilot.core.config import WORKFLOW_STEPS
from bugpilot.core.input_adapters import bug_spec_from_description
from bugpilot.core.models import InvestigationOptions, InvestigationRequest
from bugpilot.core.run import (
    RunArtifact,
    RunArtifactError,
    RunError,
    load_run,
    read_run_quietly,
    run_from_dict,
    run_to_dict,
    save_run,
)

needs_rg = pytest.mark.skipif(shutil.which("rg") is None, reason="code search needs ripgrep")

# A successful prepare writes exactly these top-level keys. `error` appears only
# on a run-level failure — and nothing here is a log: no events, no timestamps,
# no trace lines (the guard §37.21 asks for against run.json becoming a dump).
PREPARED_KEYS = {"schema_version", "work_item_id", "status", "steps", "generated_files", "fix_mode"}


def _repo(root: Path) -> Path:
    (root / "src").mkdir()
    (root / "src" / "WidgetController.cpp").write_text(
        "bool WidgetController::validate(OutputType type) {\n  return type != OutputType::VDS;\n}\n",
        encoding="utf-8",
    )
    return root


def _manual(root: Path) -> str:
    spec = bug_spec_from_description(
        "WidgetController rejects the VDS output type.", title="VDS rejected"
    )
    request = InvestigationRequest(
        spec=spec, options=InvestigationOptions(hint="Check validate", keywords=["WidgetController"])
    )
    workflow.run_investigation(root, request)
    return spec.work_item_id


def _read(root: Path, work_item: str) -> dict:
    return json.loads((root / ".ai" / work_item / "run.json").read_text(encoding="utf-8"))


# --- the schema and the lifecycle -------------------------------------------------


@needs_rg
def test_a_prepared_run_records_exactly_the_contract_fields(tmp_path):
    work_item = _manual(_repo(tmp_path))
    data = _read(tmp_path, work_item)

    assert set(data) == PREPARED_KEYS
    assert data["schema_version"] == 1
    assert data["work_item_id"] == work_item
    assert data["status"] == "prepared"
    # The full map, every WORKFLOW_STEP with a mark — the shape the extension's
    # checklist and the MCP get_status read.
    assert set(data["steps"]) == set(WORKFLOW_STEPS)
    assert set(data["steps"].values()) <= {"pass", "fail", "skipped"}
    assert data["fix_mode"]["id"] == "standard"


@needs_rg
def test_generated_files_snapshot_the_canonical_artifacts(tmp_path):
    work_item = _manual(_repo(tmp_path))
    generated = _read(tmp_path, work_item)["generated_files"]

    for name in CORE_ARTIFACTS:
        assert f".ai/{work_item}/{name}" in generated, name
    # A directory snapshot lists run.json itself; the memory entry rides along.
    assert f".ai_memory/bugs/{work_item}.md" in generated
    assert generated == sorted(generated)


@needs_rg
def test_the_run_is_valid_and_running_while_steps_execute(tmp_path, monkeypatch):
    """§37.21: a valid run.json exists from the first moment of the run."""
    _repo(tmp_path)
    observed: list[tuple[str, str]] = []
    real = workflow.context_step

    def spy(repo_root, issue_key, **kwargs):
        run = load_run(repo_root, issue_key)
        observed.append((run.status, run.steps.get("code_search", "")))
        return real(repo_root, issue_key, **kwargs)

    monkeypatch.setattr(workflow, "context_step", spy)
    _manual(tmp_path)

    # Mid-run: already readable, already carrying the marks of finished steps.
    assert observed == [("running", "pass")]


@needs_rg
def test_a_standalone_step_updates_its_mark_and_leaves_the_lifecycle_alone(tmp_path, monkeypatch):
    work_item = _manual(_repo(tmp_path))
    (tmp_path / ".ai" / work_item / "context.md").unlink()
    monkeypatch.chdir(tmp_path)

    assert main(["context", work_item]) == 0

    data = _read(tmp_path, work_item)
    assert data["status"] == "prepared"
    assert data["steps"]["context"] == "pass"


def test_a_failed_run_records_the_step_and_the_message(tmp_path, monkeypatch):
    monkeypatch.delenv("JIRA_BASE_URL", raising=False)
    monkeypatch.delenv("JIRA_EMAIL", raising=False)
    monkeypatch.delenv("JIRA_TOKEN", raising=False)
    monkeypatch.chdir(tmp_path)

    assert main(["bug", "JR-12345", "--no-mock"]) == 1

    data = _read(tmp_path, "JR-12345")
    assert data["status"] == "failed"
    assert data["steps"]["fetch"] == "fail"
    assert data["error"]["step"] == "fetch"
    assert "Jira environment variables are missing" in data["error"]["message"]
    # Bounded and structured: where and why, not a trace.
    assert set(data["error"]) == {"message", "step"}


@needs_rg
def test_a_successful_run_clears_an_earlier_failure(tmp_path, monkeypatch):
    monkeypatch.delenv("JIRA_BASE_URL", raising=False)
    monkeypatch.delenv("JIRA_EMAIL", raising=False)
    monkeypatch.delenv("JIRA_TOKEN", raising=False)
    monkeypatch.chdir(tmp_path)
    assert main(["bug", "JR-12345", "--no-mock"]) == 1

    assert main(["bug", "JR-12345", "--allow-mock"]) == 0

    data = _read(tmp_path, "JR-12345")
    assert data["status"] == "prepared"
    assert "error" not in data


@needs_rg
def test_a_refine_failure_names_its_own_step_not_a_stale_mark(tmp_path, monkeypatch):
    """A refine keeps earlier marks, so the failing step is named, not scanned."""
    work_item = _manual(_repo(tmp_path))
    stale = load_run(tmp_path, work_item)
    save_run(tmp_path, work_item, stale.with_step("fetch", "fail"))

    def boom(*args, **kwargs):
        raise RuntimeError("context exploded")

    monkeypatch.setattr(workflow, "context_step", boom)
    with pytest.raises(RuntimeError):
        workflow.refine_investigation(tmp_path, work_item)

    data = _read(tmp_path, work_item)
    assert data["status"] == "failed"
    assert data["error"]["step"] == "context"
    assert "context exploded" in data["error"]["message"]


def test_a_human_command_reports_an_unusable_run_file_without_a_traceback(tmp_path, monkeypatch, capsys):
    target = tmp_path / ".ai" / "JR-1"
    target.mkdir(parents=True)
    (target / "run.json").write_text("{ truncated", encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    assert main(["git-context", "JR-1"]) == 1

    err = capsys.readouterr().err
    assert "run.json" in err
    assert "A fresh run replaces it: bugpilot bug" in err


def test_an_unusable_run_file_is_a_missing_artifact_to_the_error_codes():
    from bugpilot.core import errors

    assert errors.error_code_for(RunArtifactError("unusable")) == errors.ARTIFACT_NOT_FOUND


# --- serialization ------------------------------------------------------------------


def test_the_dict_form_round_trips():
    run = RunArtifact(
        work_item_id="JR-12345",
        status="failed",
        steps={"fetch": "fail"},
        generated_files=(".ai/JR-12345/issue.json",),
        fix_mode={"id": "standard"},
        error=RunError(message="boom", step="fetch"),
    )

    rebuilt = run_from_dict(run_to_dict(run), "JR-12345")

    assert rebuilt.status == "failed"
    assert rebuilt.steps["fetch"] == "fail"
    # Serialization fills the full map; the marks survive unchanged.
    assert rebuilt.steps["context"] == "skipped"
    assert rebuilt.error == RunError(message="boom", step="fetch")
    assert run_to_dict(rebuilt) == run_to_dict(run)


def test_save_and_load_round_trip(tmp_path):
    save_run(tmp_path, "JR-1", RunArtifact(work_item_id="JR-1", status="prepared"))
    run = load_run(tmp_path, "JR-1")

    assert run is not None
    assert (run.work_item_id, run.status) == ("JR-1", "prepared")


def test_a_missing_run_is_none(tmp_path):
    assert load_run(tmp_path, "JR-1") is None
    assert read_run_quietly(tmp_path, "JR-1") is None


# --- an unusable file is an error, not a fallback ------------------------------------


@pytest.mark.parametrize(
    "contents",
    [
        "{ truncated",
        '"a string"',
        '{"schema_version": 2, "work_item_id": "JR-1", "status": "prepared", "steps": {}}',
        '{"schema_version": 1, "work_item_id": "JR-1", "status": "done", "steps": {}}',
        # The old workflow_status.json layout: no schema_version, no status.
        '{"issue_key": "JR-1", "mode": "prepare-only", "steps": {"doctor": "pass"}}',
    ],
)
def test_an_unusable_run_file_is_an_error_not_a_fallback(tmp_path, contents):
    target = tmp_path / ".ai" / "JR-1"
    target.mkdir(parents=True)
    (target / "run.json").write_text(contents, encoding="utf-8")

    with pytest.raises(RunArtifactError):
        load_run(tmp_path, "JR-1")
    assert read_run_quietly(tmp_path, "JR-1") is None


def test_the_status_command_reports_an_unusable_file_instead_of_guessing(tmp_path, monkeypatch, capsys):
    target = tmp_path / ".ai" / "JR-1"
    target.mkdir(parents=True)
    (target / "run.json").write_text("{ truncated", encoding="utf-8")
    monkeypatch.chdir(tmp_path)

    assert main(["status", "JR-1"]) == 1

    err = capsys.readouterr().err
    assert "run.json" in err
    assert "Re-run: bugpilot bug JR-1" in err


def test_a_standalone_step_refuses_a_corrupt_run_file(tmp_path):
    target = tmp_path / ".ai" / "JR-1"
    target.mkdir(parents=True)
    (target / "run.json").write_text("{ truncated", encoding="utf-8")

    with pytest.raises(RunArtifactError):
        workflow._mark_step(tmp_path, "JR-1", "doctor", "pass")


@needs_rg
def test_a_fresh_run_replaces_a_corrupt_run_file(tmp_path):
    """A run owns its file: re-preparing is the sanctioned recovery."""
    _repo(tmp_path)
    target = tmp_path / ".ai" / "local_x"
    target.mkdir(parents=True)
    (target / "run.json").write_text("{ truncated", encoding="utf-8")

    work_item = _manual(tmp_path)

    assert _read(tmp_path, work_item)["status"] == "prepared"


# --- the old runtime files are gone ---------------------------------------------------


@needs_rg
def test_no_runtime_file_but_run_json_is_written(tmp_path):
    work_item = _manual(_repo(tmp_path))
    target = tmp_path / ".ai" / work_item

    assert not (target / "workflow_status.json").exists()
    assert not (target / "execution.log").exists()


def test_status_does_not_read_the_old_layout(tmp_path, monkeypatch, capsys):
    """A directory holding only workflow_status.json has no run state."""
    target = tmp_path / ".ai" / "JR-1"
    target.mkdir(parents=True)
    (target / "workflow_status.json").write_text(
        '{"issue_key": "JR-1", "steps": {"doctor": "pass"}}', encoding="utf-8"
    )
    monkeypatch.chdir(tmp_path)

    assert main(["status", "JR-1"]) == 1
    assert "No run state found for JR-1." in capsys.readouterr().err
