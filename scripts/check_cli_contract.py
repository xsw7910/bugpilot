"""Release check: does an installed bugpilot accept everything the extension sends?

The VS Code extension and the CLI ship separately, and a wheel built before a
flag existed once passed every other check — the source tree declared the flag,
`doctor --json` answered — and then rejected every Run. Run this against the
executable a release will ship, from a clean environment that has only the
freshly built wheel installed:

    python -I scripts/check_cli_contract.py --bugpilot <venv>/Scripts/bugpilot.exe

It runs every command line in `tests/fixtures/extension_cli_argv.json` (generated
from the extension's own argv builders) for real, in a throwaway git repository
with an empty home directory and no Jira configuration. A command may fail for
an ordinary reason — there is no Jira, no such work item — but argparse's usage
error (exit code 2: "unrecognized arguments", "invalid choice") means the CLI
is older than the extension, and fails the check. It also checks that
`bugpilot --version` prints `bugpilot <version>`, and with `--expect-version`
which version.

Standard library only; prints one line per command and exits non-zero on any
mismatch.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import subprocess
import sys
import tempfile
from pathlib import Path

FIXTURE = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "extension_cli_argv.json"
USAGE_ERROR = re.compile(r"error: (unrecognized arguments|argument [^:]+: invalid choice|the following arguments are required)")


def _environment(home: Path) -> dict[str, str]:
    env = {key: value for key, value in os.environ.items() if not key.startswith(("JIRA_", "BUGPILOT_"))}
    env.update(
        HOME=str(home),
        USERPROFILE=str(home),
        BUGPILOT_CONFIG_DIR=str(home / ".bugpilot"),
        PYTHONIOENCODING="utf-8",
        # Nothing this check runs may start an agent; make sure one could not.
        BUGPILOT_CLAUDE_COMMAND="bugpilot-contract-no-agent",
        BUGPILOT_COPILOT_COMMAND="bugpilot-contract-no-agent",
    )
    return env


def _repository(root: Path) -> None:
    root.mkdir(parents=True, exist_ok=True)
    (root / "src").mkdir(exist_ok=True)
    (root / "src" / "record.py").write_text("def save(record):\n    return record['id']\n", encoding="utf-8")
    for command in (["git", "init", "-q"], ["git", "add", "."], ["git", "-c", "user.name=check", "-c", "user.email=check@example.com", "commit", "-q", "-m", "init"]):
        subprocess.run(command, cwd=root, check=True, capture_output=True)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--bugpilot", required=True, help="The bugpilot executable to check.")
    parser.add_argument("--expect-version", help="The version `bugpilot --version` must report.")
    args = parser.parse_args(argv)

    commands = json.loads(FIXTURE.read_text(encoding="utf-8"))["commands"]
    failures: list[str] = []
    with tempfile.TemporaryDirectory(prefix="bugpilot-contract-") as scratch:
        base = Path(scratch)
        home = base / "home"
        home.mkdir()
        repo = base / "repo"
        _repository(repo)
        env = _environment(home)
        files = {
            "{REPO}": repo,
            "{ATTACHMENT}": base / "crash.log",
            "{DESCRIPTION_FILE}": base / "description.md",
            "{PAYLOAD_FILE}": base / "payload.json",
        }
        files["{ATTACHMENT}"].write_text("Traceback: KeyError 'id'\n", encoding="utf-8")
        files["{DESCRIPTION_FILE}"].write_text("Saving a record without an id crashes.\n", encoding="utf-8")
        files["{PAYLOAD_FILE}"].write_text("{}\n", encoding="utf-8")

        version = subprocess.run([args.bugpilot, "--version"], capture_output=True, text=True, env=env, cwd=repo)
        reported = version.stdout.strip()
        if version.returncode != 0 or not re.fullmatch(r"bugpilot \d+\.\d+\.\d+\S*", reported):
            failures.append(f"--version: exit {version.returncode}, printed {reported!r} {version.stderr.strip()!r}")
        elif args.expect_version and reported != f"bugpilot {args.expect_version}":
            failures.append(f"--version: printed {reported!r}, expected 'bugpilot {args.expect_version}'")
        print(f"{'ok' if not failures else 'FAIL'}  --version -> {reported}")

        for entry in commands:
            concrete = []
            for arg in entry["argv"]:
                for placeholder, value in files.items():
                    arg = arg.replace(placeholder, str(value))
                concrete.append(arg)
            try:
                result = subprocess.run(
                    [args.bugpilot, *concrete], capture_output=True, text=True, env=env, cwd=repo, timeout=300,
                    encoding="utf-8", errors="replace",
                )
            except subprocess.TimeoutExpired:
                failures.append(f"{entry['name']}: timed out")
                print(f"FAIL  {entry['name']}: timed out")
                continue
            usage = USAGE_ERROR.search(result.stderr)
            if result.returncode == 2 and usage:
                failures.append(f"{entry['name']}: {usage.group(0)}")
                print(f"FAIL  {entry['name']}: {usage.group(0)}")
            else:
                print(f"ok    {entry['name']} (exit {result.returncode})")

    if failures:
        print(f"\n{len(failures)} command line(s) the extension sends are not accepted:", file=sys.stderr)
        for failure in failures:
            print(f"  {failure}", file=sys.stderr)
        return 1
    print(f"\nAll {len(commands)} command lines accepted.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
