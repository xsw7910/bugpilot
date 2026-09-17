"""Append-only execution logging."""

from __future__ import annotations

from datetime import datetime, timezone
from pathlib import Path


def log(issue_dir: Path, message: str) -> None:
    issue_dir.mkdir(parents=True, exist_ok=True)
    timestamp = datetime.now(timezone.utc).isoformat()
    with (issue_dir / "execution.log").open("a", encoding="utf-8") as handle:
        handle.write(f"{timestamp} {message}\n")
