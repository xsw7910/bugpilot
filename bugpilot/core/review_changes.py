"""The current changes, collected by BugPilot for a reviewer that cannot run commands.

Review with AI's captured review runs the agent without a shell: it can read
files, and nothing else. What it used to look up with
``git diff`` and ``git status`` it now receives in its prompt, collected here by
BugPilot itself — with a fixed argv, the git found on PATH, and the switches
that keep a repository's own configuration from running a program
(``core.fsmonitor``, an external diff driver, a textconv filter) or a pager.

Bounded: the status to ``MAX_STATUS_LINES`` lines, the diff to
``MAX_DIFF_CHARS`` characters. Whatever is cut is said, never dropped silently,
and the reviewer is told to read those files directly. ``.ai/`` and
``.ai_memory/`` are left out: they are BugPilot's own files, which the prompt
names separately.
"""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from pathlib import Path

from .executables import child_environment, find_executable

#: Lines of ``git status --short`` kept; the rest are counted.
MAX_STATUS_LINES = 200

#: Characters of ``git diff HEAD`` kept; a cut is said.
MAX_DIFF_CHARS = 60_000

#: Seconds each git command may take.
GIT_TIMEOUT_SECONDS = 30

#: Keeps the review to the repository's own changes.
_PATHSPEC = ["--", ".", ":(exclude).ai", ":(exclude).ai_memory"]

#: Before every subcommand: no pager, no fsmonitor hook, paths printed as they are.
_GIT_PREFIX = ["--no-pager", "-c", "core.fsmonitor=false", "-c", "core.quotepath=off", "-c", "color.ui=never"]


@dataclass(frozen=True)
class ReviewChanges:
    """What git said about the working tree, bounded. ``available`` is False when git could not say."""

    available: bool
    status: str = ""
    status_omitted: int = 0
    diff: str = ""
    diff_truncated: bool = False
    has_head: bool = True


def collect_review_changes(repo_root: Path) -> ReviewChanges:
    """``git status --short`` and ``git diff HEAD``, read-only and bounded."""
    code, status = _git(repo_root, ["status", "--short", "--untracked-files=all", *_PATHSPEC])
    if code != 0:
        return ReviewChanges(available=False)
    lines = [line for line in status.splitlines() if line.strip()]
    kept = lines[:MAX_STATUS_LINES]
    head_code, _ = _git(repo_root, ["rev-parse", "--verify", "--quiet", "HEAD"])
    if head_code != 0:
        # No commit yet: everything is new, and the status says which files.
        return ReviewChanges(available=True, status="\n".join(kept), status_omitted=len(lines) - len(kept), has_head=False)
    diff_code, diff = _git(
        repo_root,
        ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "HEAD", *_PATHSPEC],
    )
    if diff_code != 0:
        return ReviewChanges(available=False)
    truncated = len(diff) > MAX_DIFF_CHARS
    return ReviewChanges(
        available=True,
        status="\n".join(kept),
        status_omitted=len(lines) - len(kept),
        diff=diff[:MAX_DIFF_CHARS] if truncated else diff,
        diff_truncated=truncated,
    )


def review_changes_markdown(changes: ReviewChanges) -> str:
    """The block appended to a captured review's prompt. Says what it is, and what is missing."""
    parts = [
        "## Current Changes",
        "",
        "This review runs without a shell: you cannot run commands, tests or git. "
        "BugPilot collected the current changes below with git before the review started. "
        "Read any file in the repository for more context. "
        "Do not claim that you ran anything; in Validation Notes, say what you read.",
        "",
    ]
    if not changes.available:
        parts.append(
            "BugPilot could not read the current changes with git (this is not a git repository, "
            "or git is not on PATH). Review the files fix_report.md names instead."
        )
        return "\n".join(parts) + "\n"
    parts += ["### git status --short", ""]
    if changes.status:
        parts += [_fenced(changes.status, "text"), ""]
        if changes.status_omitted:
            parts += [f"{changes.status_omitted} more changed files are not listed.", ""]
        parts += ["Untracked files (marked `??`) are not in the diff below; read them directly.", ""]
    else:
        parts += ["No changes outside BugPilot's own files.", ""]
    if not changes.has_head:
        parts.append("The repository has no commit yet, so there is no diff; read the files listed above.")
        return "\n".join(parts) + "\n"
    parts += ["### git diff HEAD", ""]
    if changes.diff:
        parts.append(_fenced(changes.diff, "diff"))
        if changes.diff_truncated:
            parts += [
                "",
                f"The diff was cut at {MAX_DIFF_CHARS:,} characters. Read the remaining changed files listed above directly.",
            ]
    else:
        parts.append("git reports no differences from HEAD in tracked files.")
    return "\n".join(parts) + "\n"


def _fenced(text: str, language: str) -> str:
    """A code fence longer than any backtick run in ``text``, so nothing inside can close it."""
    longest = run = 0
    for character in text:
        run = run + 1 if character == "`" else 0
        longest = max(longest, run)
    fence = "`" * max(3, longest + 1)
    return f"{fence}{language}\n{text.rstrip(chr(10))}\n{fence}"


def _git(repo_root: Path, args: list[str]) -> tuple[int, str]:
    git = find_executable("git")
    if git is None:
        return 127, ""
    environment = child_environment()
    # Read-only for git too: no index refresh written back, no lock taken.
    environment["GIT_OPTIONAL_LOCKS"] = "0"
    environment.pop("GIT_EXTERNAL_DIFF", None)
    environment["GIT_PAGER"] = "cat"
    try:
        completed = subprocess.run(
            [git, *_GIT_PREFIX, *args],
            cwd=repo_root,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.DEVNULL,
            encoding="utf-8",
            errors="replace",
            check=False,
            timeout=GIT_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired):
        return 1, ""
    return completed.returncode, completed.stdout
