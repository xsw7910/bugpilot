"""The ``--json`` envelope: bugpilot's machine-facing output contract.

Lives in the CLI layer, not in ``core``, because rendering is an adapter's job
(design invariant 3). The VS Code extension consumes this; the MCP server gets
the same data as Python objects and never goes through here.

Contract, from ``docs/adapter_design.md`` section 5.1:

- Exactly one JSON object on stdout, whether the command succeeded or failed.
- ``schema_version`` from the first release, so the extension can refuse a
  version it does not understand instead of misreading fields.
- On failure the human-readable message still goes to stderr and the exit code
  is still non-zero. The two channels are additive, not alternatives.
- Consumers branch on ``error.code`` and never parse ``error.message``.
"""

from __future__ import annotations

import json
import sys

SCHEMA_VERSION = 1


def success(command: str, **fields: object) -> dict[str, object]:
    """Build a success envelope. ``fields`` are merged in as-is."""
    payload: dict[str, object] = {
        "schema_version": SCHEMA_VERSION,
        "ok": True,
        "command": command,
    }
    payload.update(fields)
    payload.setdefault("warnings", [])
    return payload


def failure(command: str, code: str, message: str, **fields: object) -> dict[str, object]:
    """Build a failure envelope carrying a stable code and a human message."""
    payload: dict[str, object] = {
        "schema_version": SCHEMA_VERSION,
        "ok": False,
        "command": command,
        "error": {"code": code, "message": message},
    }
    payload.update(fields)
    return payload


def emit(payload: dict[str, object]) -> None:
    """Write one envelope to stdout.

    ``ensure_ascii=False`` so a Chinese bug title stays readable in a terminal
    and in an editor's output pane; the stream is UTF-8 either way.
    """
    print(json.dumps(payload, indent=2, ensure_ascii=False))


def emit_failure(command: str, code: str, message: str, **fields: object) -> None:
    """Write a failure envelope to stdout and the same message to stderr.

    Callers still return a non-zero exit code: a consumer that ignores JSON and
    only checks the exit status must see the failure too.
    """
    emit(failure(command, code, message, **fields))
    print(f"ERROR: {message}", file=sys.stderr)


class JsonLinesEmitter:
    """Streams one JSON object per line while a run is in progress.

    The two output channels have different jobs, per design section 5.1:
    JSONL is live events for as long as the process runs, and
    ``workflow_status.json`` is the state that survives it. A consumer follows
    the stream for progress and re-reads the file after a restart.

    ``run_investigation``'s progress callback fires *before* each step, so
    completion is inferred: the next ``step_started`` closes the previous step,
    and :meth:`finish` closes the last one. A step that raises is never closed,
    which is what distinguishes it from one that finished.
    """

    def __init__(self, work_item_id: str, source: str) -> None:
        self._open_step: str | None = None
        self._emit({"type": "started", "work_item_id": work_item_id, "source": source})

    def _emit(self, event: dict[str, object]) -> None:
        payload: dict[str, object] = {"schema_version": SCHEMA_VERSION}
        payload.update(event)
        print(json.dumps(payload, ensure_ascii=False), flush=True)

    def skipped(self, steps: list[str]) -> None:
        for step in steps:
            self._emit({"type": "step_skipped", "step": step, "reason": "plan"})

    def progress(self, event: str) -> None:
        """Callback for ``run_investigation(progress=...)``.

        Non-step events (the clean phase) are reported under their own type so a
        consumer can show them without mistaking them for pipeline steps.
        """
        if event.startswith("clean_"):
            self._emit({"type": "phase", "phase": event})
            return
        self._close_open_step()
        self._open_step = event
        self._emit({"type": "step_started", "step": event})

    def _close_open_step(self) -> None:
        if self._open_step is not None:
            self._emit({"type": "step_completed", "step": self._open_step})
            self._open_step = None

    def finish(self, generated_files: list[str], warnings: list[str] | None = None) -> None:
        self._close_open_step()
        for path in generated_files:
            self._emit({"type": "artifact", "path": path})
        # Carried on the terminal event rather than as a new event type: a
        # consumer that has not been taught about `warnings` ignores the extra
        # key, where an unknown event type is a shape it has to decide about.
        completed: dict[str, object] = {"type": "completed", "ok": True}
        if warnings:
            completed["warnings"] = list(warnings)
        self._emit(completed)

    def fail(self, code: str, message: str) -> None:
        """End the stream without closing the step that raised."""
        self._emit({"type": "completed", "ok": False, "error": {"code": code, "message": message}})


def emit_stream_failure(code: str, message: str) -> None:
    """Close a --json-lines stream that failed before or outside a run.

    A consumer waits for a terminal event; without one an aborted run is
    indistinguishable from a process that is still working.
    """
    print(
        json.dumps(
            {
                "schema_version": SCHEMA_VERSION,
                "type": "completed",
                "ok": False,
                "error": {"code": code, "message": message},
            },
            ensure_ascii=False,
        ),
        flush=True,
    )
    print(f"ERROR: {message}", file=sys.stderr)
