"""Release guard: refuse to build a release from anything but a reviewed, CI-green main.

The release workflow (`.github/workflows/release.yml`) runs this right after the
checkout, before any build tool is installed. It fails closed — any doubt is a
refusal — unless all of these hold:

- the run is on `refs/heads/main`: a dispatch from another branch or a tag is
  refused, whatever version it names;
- the commit the operator typed is the one GitHub checked out (`GITHUB_SHA`) and
  the one on disk (`git rev-parse HEAD`), so main cannot move between the review
  and the dispatch unnoticed;
- the version the operator typed is the source's: `__version__` in
  `bugpilot/__init__.py` and `version` in `extension/package.json`, which move
  together (docs/development.md);
- CI passed on that commit, and the results are CI's own: the commit has at
  least one run of `.github/workflows/ci.yml`, none of them still queued or
  running, the newest of them concluded with success, and the newest check run
  of each of the nine required jobs — counting only check runs that GitHub
  Actions reported in one of those CI runs' check suites — completed with
  success. A failed, cancelled, skipped, running or missing check refuses; a
  check of the same name from another workflow or another app is ignored.

The CI results are read once, before the build. A CI re-run started after this
check cannot stop a publish that is approved later: the reviewer approves with
the run summary in front of them (docs/development.md, *Releasing*).

Any error reading GitHub's answer, or an answer that does not add up (missing
fields, fewer items than it says it has, more pages than expected), refuses.

Standard library only. Locally, with the variables the workflow sets (the CI
query needs only network access for a public repository):

    GITHUB_REF=refs/heads/main GITHUB_SHA=<sha> RELEASE_VERSION=<version> \
    RELEASE_COMMIT=<sha> GITHUB_REPOSITORY=xsw7910/bugpilot python scripts/release_preflight.py
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import sys
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]

#: The required CI checks, by the names GitHub reports. tests/test_release_workflow.py
#: checks that this is exactly what .github/workflows/ci.yml defines.
REQUIRED_CHECKS = (
    "Safety and baselines (ubuntu-latest, Python 3.13)",
    "Safety and baselines (ubuntu-latest, Python 3.10)",
    "Safety and baselines (macos-latest, Python 3.13)",
    "Safety and baselines (windows-latest, Python 3.13)",
    "Extension evidence boundary (ubuntu-latest)",
    "Full Python suite (ubuntu-latest)",
    "Full Python suite (macos-latest)",
    "Full Python suite (windows-latest)",
    "Extension unit tests (ubuntu-latest)",
)
#: The workflow whose runs count as CI, as GitHub reports a run's `path`.
CI_WORKFLOW = ".github/workflows/ci.yml"
#: The app GitHub Actions reports check runs as; another app's check of the same name does not count.
ACTIONS_APP = "github-actions"
MAIN = "refs/heads/main"
#: ASCII only (`\d` would take any Unicode digit). Operator input is echoed in a message only after it matches.
SHA = re.compile(r"[0-9a-f]{40}")
VERSION = re.compile(r"[0-9]+\.[0-9]+\.[0-9]+")
#: A commit has a handful of runs; far more pages than this means something is wrong.
MAX_PAGES = 20


def source_versions(root: Path = ROOT) -> tuple[str | None, str | None]:
    """`__version__` from bugpilot/__init__.py (read, never imported) and the extension's version."""
    match = re.search(r'^__version__ = "([^"]+)"$', (root / "bugpilot" / "__init__.py").read_text(encoding="utf-8"), re.M)
    package = json.loads((root / "extension" / "package.json").read_text(encoding="utf-8"))
    return (match.group(1) if match else None), package.get("version")


def source_problems(*, ref: str, github_sha: str, head: str, commit: str, version: str,
                    package_version: str | None, extension_version: str | None) -> list[str]:
    """What is wrong with where the run is and what it would build; empty when nothing is."""
    problems = []
    if ref != MAIN:
        problems.append(f"releases run only from {MAIN}, not {ref or '(no ref)'}")
    if not SHA.fullmatch(commit):
        problems.append("the release commit must be a full 40-character lowercase SHA")
    elif not (commit == github_sha == head):
        problems.append(f"the release commit {commit} is not the commit this run checked out "
                        f"(GITHUB_SHA {github_sha or '-'}, HEAD {head or '-'}): main moved, or the wrong SHA was entered")
    if not VERSION.fullmatch(version):
        problems.append("the version must look like 1.2.3")
    elif version != package_version:
        problems.append(f"the version {version} is not bugpilot/__init__.py's ({package_version})")
    elif version != extension_version:
        problems.append(f"the version {version} is not extension/package.json's ({extension_version}): the versions move together")
    return problems


def ci_problems(check_runs: list[dict], workflow_runs: list[dict], commit: str,
                required: tuple[str, ...] = REQUIRED_CHECKS) -> list[str]:
    """Whether CI's own newest results for the commit are all green; empty when they are."""
    ci_runs = [run for run in workflow_runs if run.get("path") == CI_WORKFLOW and run.get("head_sha") == commit]
    if not ci_runs:
        return [f"no run of {CI_WORKFLOW} on this commit"]
    problems = []
    running = sorted(str(run.get("id")) for run in ci_runs if run.get("status") != "completed")
    if running:
        problems.append(f"CI is still running on this commit (workflow run {', '.join(running)})")
    newest_run = max(ci_runs, key=lambda run: int(run["id"]))
    if newest_run.get("conclusion") != "success":
        problems.append(f"the newest CI run on this commit ({newest_run['id']}) is "
                        f"{newest_run.get('status')}/{newest_run.get('conclusion')}, not completed/success")
    suites = {run["check_suite_id"] for run in ci_runs}
    newest: dict[str, dict] = {}
    for run in check_runs:
        if (run.get("app") or {}).get("slug") != ACTIONS_APP or (run.get("check_suite") or {}).get("id") not in suites:
            continue  # another app's check, or another workflow's job: not CI's result
        if run.get("head_sha", commit) != commit:
            continue
        name = run.get("name")
        if name in required and (name not in newest or int(run["id"]) > int(newest[name]["id"])):
            newest[name] = run
    for name in required:
        run = newest.get(name)
        if run is None:
            problems.append(f"CI check {name!r} has not run on this commit")
        elif run.get("status") != "completed" or run.get("conclusion") != "success":
            problems.append(f"CI check {name!r} is {run.get('status')}/{run.get('conclusion')}, not completed/success")
    return problems


def fetch_all(api: str, path: str, key: str, token: str | None) -> list[dict]:
    """Every item of a paginated GitHub list; an answer that does not add up raises."""
    items: list[dict] = []
    separator = "&" if "?" in path else "?"
    for page in range(1, MAX_PAGES + 1):
        request = urllib.request.Request(
            f"{api}{path}{separator}per_page=100&page={page}",
            headers={"Accept": "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28",
                     "User-Agent": "bugpilot-release-preflight", **({"Authorization": f"Bearer {token}"} if token else {})},
        )
        with urllib.request.urlopen(request, timeout=30) as response:
            body = json.load(response)
        batch, total = body.get(key), body.get("total_count")
        if not isinstance(batch, list) or not isinstance(total, int):
            raise ValueError(f"GitHub's answer has no {key} list or no total_count")
        items.extend(batch)
        if len(items) >= total:
            return items
        if not batch:
            raise ValueError(f"GitHub counted {total} {key} but listed {len(items)}")
    raise ValueError(f"more than {MAX_PAGES} pages of {key}")


def main() -> int:
    env = os.environ
    commit = env.get("RELEASE_COMMIT", "").strip()
    version = env.get("RELEASE_VERSION", "").strip()
    try:
        head = subprocess.run(["git", "rev-parse", "HEAD"], cwd=ROOT, capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        head = ""
    package_version, extension_version = source_versions()
    problems = source_problems(ref=env.get("GITHUB_REF", ""), github_sha=env.get("GITHUB_SHA", ""), head=head, commit=commit,
                               version=version, package_version=package_version, extension_version=extension_version)
    if not problems:
        api, token = env.get("GITHUB_API_URL", "https://api.github.com"), env.get("GH_TOKEN")
        try:
            repository = env["GITHUB_REPOSITORY"]
            check_runs = fetch_all(api, f"/repos/{repository}/commits/{commit}/check-runs?filter=all", "check_runs", token)
            workflow_runs = fetch_all(api, f"/repos/{repository}/actions/runs?head_sha={commit}", "workflow_runs", token)
            problems.extend(ci_problems(check_runs, workflow_runs, commit))
        except Exception as error:  # noqa: BLE001 — any failure to read or judge CI is a refusal, never a pass
            problems.append(f"could not read or judge CI's results for {commit}: {type(error).__name__}: {error}")
    for problem in problems:
        print(f"::error::{problem}")
    if not problems:
        print(f"Release source accepted: {commit} on {MAIN}, version {version}, all {len(REQUIRED_CHECKS)} CI checks green "
              f"in {CI_WORKFLOW}.")
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
