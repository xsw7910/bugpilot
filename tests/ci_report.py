"""Publish a CI job's test results as GitHub Actions annotations (0.1.5 Batch 0, plan §44.10).

Not a test module (no `test_` prefix). A job's log of a public repository can
be read only by someone signed in to GitHub, and its artifacts only with a
token; the annotations on a run are public. So each CI job ends by publishing
the result it would otherwise leave in the log: the summary line, each failed
test, the skips, and what the file-safety tests observed. That is all: the
runner holds no secret, and nothing here reads one.

    python tests/ci_report.py pytest LOG [OBSERVATIONS_DIR]
    python tests/ci_report.py node LOG

It only reports. It always exits 0, so it never changes a job's result.
"""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

#: Keep each annotation well inside GitHub's limits.
MESSAGE_LIMIT = 3500


def _escape_data(text: str) -> str:
    return text.replace("%", "%25").replace("\r", "%0D").replace("\n", "%0A")


def _escape_property(text: str) -> str:
    return _escape_data(text).replace(":", "%3A").replace(",", "%2C")


def annotation(level: str, title: str, message: str) -> str:
    """One workflow command: `::notice title=…::message`, escaped as the runner expects."""
    if len(message) > MESSAGE_LIMIT:
        message = message[: MESSAGE_LIMIT - 20] + "\n… (cut; see the log)"
    return f"::{level} title={_escape_property(title)}::{_escape_data(message)}"


def pytest_report(log: str, observations: Path | None = None) -> list[str]:
    lines = log.splitlines()
    summary = next(
        (line.strip("= ").strip() for line in reversed(lines)
         if re.search(r"\b(passed|failed|error|errors|skipped|deselected|no tests ran)\b", line) and " in " in line),
        "no pytest summary line found",
    )
    out = [annotation("notice", "pytest summary", summary)]
    failed = [line for line in lines if line.startswith(("FAILED ", "ERROR "))]
    if failed:
        out.append(annotation("error", f"pytest failures ({len(failed)})", "\n".join(failed)))
    skipped = [line for line in lines if line.startswith("SKIPPED ")]
    if skipped:
        out.append(annotation("notice", f"pytest skips ({len(skipped)} lines)", "\n".join(skipped)))
    if observations is not None and observations.is_dir():
        for path in sorted(observations.glob("*.json")):
            data = json.loads(path.read_text(encoding="utf-8"))
            out.append(annotation("notice", f"observed: {path.stem}", json.dumps(data, sort_keys=True, separators=(",", ":"))))
    return out


def node_report(log: str) -> list[str]:
    """`node --test` output in either reporter: spec (`ℹ tests 2`, `✖ name`) or TAP (`# tests 2`, `not ok 3 - name`)."""
    lines = [line.strip() for line in log.splitlines()]
    totals = [line for line in lines if re.match(r"(ℹ|#) (tests|suites|pass|fail|cancelled|skipped|todo) \d", line)]
    out = [annotation("notice", "node --test summary", "\n".join(totals) or "no node --test summary found")]
    failed = sorted({line for line in lines if line.startswith(("✖ ", "not ok "))})
    if failed:
        out.append(annotation("error", f"node --test failures ({len(failed)})", "\n".join(failed)))
    return out


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[0] not in ("pytest", "node"):
        print(annotation("warning", "ci_report", "usage: ci_report.py pytest|node LOG [OBSERVATIONS_DIR]"))
        return 0
    path = Path(argv[1])
    log = path.read_text(encoding="utf-8", errors="replace") if path.is_file() else ""
    if argv[0] == "pytest":
        observed = Path(argv[2]) if len(argv) > 2 else None
        lines = pytest_report(log, observed)
    else:
        lines = node_report(log)
    print("\n".join(lines))
    return 0


if __name__ == "__main__":  # pragma: no cover - a CI command
    raise SystemExit(main(sys.argv[1:]))
