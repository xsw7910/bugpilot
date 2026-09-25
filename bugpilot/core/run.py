"""run.json: the one canonical runtime artifact (plan §37, Batch 4).

Two files used to carry what a run left behind about itself: a status file
rewritten on every step, and an append-only text log nothing read. One typed
artifact remains. It answers what the status file's consumers actually asked —
which work item, how far the run got, which steps passed, what exists on disk,
which Fix Mode prepared it — plus the one thing neither file kept in a usable
form: which step a failed run failed at, and why.

It is runtime *state*, not history: no timestamps, no event list, no trace.
The diagnostic prose `execution.log` held goes through :mod:`logging_utils`
now, unpersisted.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field, replace
from pathlib import Path

from .artifact_io import atomic_write_text
from .artifacts import ARTIFACT_SCHEMA_VERSION, RUN_ARTIFACT
from .config import WORKFLOW_STEPS, issue_dir

# The one authoritative overall state. The product's own words: `bugpilot list`
# and the extension's history both call a finished package "prepared".
RUN_STATUSES = ("running", "prepared", "failed")

# What a step mark may say. `skipped` is a real outcome (a plan that never
# included the step), not a missing one.
STEP_STATUSES = ("pass", "fail", "skipped")


class RunArtifactError(ValueError):
    """``run.json`` exists but is not a readable version-1 artifact."""


@dataclass(frozen=True)
class RunError:
    """Where a run-level failure happened, in the words the CLI already prints.

    ``step`` is the failed step when the marks name one, else ``None`` — the
    exception may have come from outside any step.
    """

    message: str
    step: str | None = None


@dataclass(frozen=True)
class RunArtifact:
    work_item_id: str
    status: str = "running"
    #: Marks for the steps that have one. Serialization fills the full
    #: ``WORKFLOW_STEPS`` map, defaulting to ``skipped``, which is the shape
    #: every consumer already reads.
    steps: dict[str, str] = field(default_factory=dict)
    #: What exists on disk for this work item, `.ai/<id>/`-relative, plus the
    #: memory entry. A directory snapshot, so it lists ``run.json`` itself.
    generated_files: tuple[str, ...] = ()
    #: The Fix Mode metadata the package was prepared under; ``None`` before a
    #: mode is recorded.
    fix_mode: dict[str, object] | None = None
    #: Set by a run-level failure; cleared by the next run reaching a terminal
    #: state.
    error: RunError | None = None

    def with_step(self, step: str, status: str) -> "RunArtifact":
        return replace(self, steps={**self.steps, step: status})


def run_path(repo_root: Path, work_item_id: str) -> Path:
    return issue_dir(repo_root, work_item_id) / RUN_ARTIFACT


def run_to_dict(run: RunArtifact) -> dict[str, object]:
    data: dict[str, object] = {
        "schema_version": ARTIFACT_SCHEMA_VERSION,
        "work_item_id": run.work_item_id,
        "status": run.status,
        "steps": {step: run.steps.get(step, "skipped") for step in WORKFLOW_STEPS},
        "generated_files": sorted(run.generated_files),
    }
    # Additive, like the status file before it: consumers read the keys they
    # know. Absent rather than null, so the common case stays small.
    if run.fix_mode is not None:
        data["fix_mode"] = run.fix_mode
    if run.error is not None:
        error: dict[str, object] = {"message": run.error.message}
        if run.error.step is not None:
            error["step"] = run.error.step
        data["error"] = error
    return data


def run_from_dict(data: object, work_item_id: str) -> RunArtifact:
    """Rebuild a run from ``run.json``. Version 1 only, by design."""
    where = f".ai/{work_item_id}/{RUN_ARTIFACT}"
    if not isinstance(data, dict):
        raise RunArtifactError(f"{where} does not contain a JSON object.")
    if data.get("schema_version") != ARTIFACT_SCHEMA_VERSION:
        raise RunArtifactError(
            f"{where} has schema_version {data.get('schema_version')!r}; expected "
            f"{ARTIFACT_SCHEMA_VERSION}. Re-run: bugpilot bug {work_item_id}"
        )
    status = str(data.get("status") or "")
    if status not in RUN_STATUSES:
        raise RunArtifactError(f"{where} has an unknown status {status!r}.")
    steps_data = data.get("steps")
    steps = (
        {str(name): _step_status(value) for name, value in steps_data.items()}
        if isinstance(steps_data, dict)
        else {}
    )
    fix_mode = data.get("fix_mode")
    error_data = data.get("error")
    error = None
    if isinstance(error_data, dict) and str(error_data.get("message") or "").strip():
        step = error_data.get("step")
        error = RunError(
            message=str(error_data["message"]),
            step=str(step) if isinstance(step, str) and step else None,
        )
    return RunArtifact(
        work_item_id=str(data.get("work_item_id") or work_item_id),
        status=status,
        steps=steps,
        generated_files=tuple(
            str(item) for item in data.get("generated_files", []) if isinstance(item, str)
        )
        if isinstance(data.get("generated_files"), list)
        else (),
        fix_mode=fix_mode if isinstance(fix_mode, dict) else None,
        error=error,
    )


def _step_status(value: object) -> str:
    return value if isinstance(value, str) and value in STEP_STATUSES else "skipped"


def save_run(repo_root: Path, work_item_id: str, run: RunArtifact) -> Path:
    """Write ``run.json`` atomically: other processes read it mid-run."""
    path = run_path(repo_root, work_item_id)
    path.parent.mkdir(parents=True, exist_ok=True)
    atomic_write_text(path, json.dumps(run_to_dict(run), indent=2) + "\n")
    return path


def load_run(repo_root: Path, work_item_id: str) -> RunArtifact | None:
    """The persisted run state, or ``None`` when no run has written any.

    Raises :class:`RunArtifactError` when the file exists but cannot be used,
    including one from before this schema. There is deliberately no reader for
    the old ``workflow_status.json`` layout.
    """
    path = run_path(repo_root, work_item_id)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError, UnicodeDecodeError) as exc:
        raise RunArtifactError(f".ai/{work_item_id}/{RUN_ARTIFACT} could not be read ({exc}).") from exc
    return run_from_dict(data, work_item_id)


def read_run_quietly(repo_root: Path, work_item_id: str) -> RunArtifact | None:
    """:func:`load_run` for a caller that renders "not available" instead."""
    try:
        return load_run(repo_root, work_item_id)
    except RunArtifactError:
        return None
