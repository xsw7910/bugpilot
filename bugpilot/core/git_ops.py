"""Small git and command helpers."""

from __future__ import annotations

import hashlib
import re
import shutil
import subprocess
from pathlib import Path

from .identity import is_local_work_item_id


def command_available(command: str) -> bool:
    return shutil.which(command) is not None


#: What :func:`run_command` returns for a command that outlived its ``timeout``.
TIMEOUT_EXIT_CODE = 124


def run_command(args: list[str], cwd: Path, timeout: float | None = None) -> tuple[int, str]:
    try:
        completed = subprocess.run(
            args,
            cwd=cwd,
            encoding="utf-8",
            errors="replace",
            stdout=subprocess.PIPE,
            stderr=subprocess.STDOUT,
            check=False,
            timeout=timeout,
        )
    except FileNotFoundError:
        return 127, f"{args[0]} command not found"
    except subprocess.TimeoutExpired:
        # The argv is not echoed: a git search carries the developer's keywords.
        return TIMEOUT_EXIT_CODE, f"{args[0]} timed out"
    return completed.returncode, completed.stdout.strip()


def inside_git_repo(repo_root: Path) -> bool:
    code, output = run_command(["git", "rev-parse", "--is-inside-work-tree"], repo_root)
    return code == 0 and output.lower() == "true"


def current_branch(repo_root: Path) -> str | None:
    code, output = run_command(["git", "branch", "--show-current"], repo_root)
    return output if code == 0 and output else None


def working_tree_status(repo_root: Path) -> str | None:
    code, output = run_command(["git", "status", "--short"], repo_root)
    if code != 0:
        return None
    return output or "clean"


#: The directories bugpilot writes into a repository, as ``.gitignore`` names them.
ARTIFACT_DIRECTORIES = (".ai", ".ai_memory")


def artifact_directories_ignored(repo_root: Path) -> dict[str, bool] | None:
    """Whether git ignores each directory bugpilot writes into this repository.

    ``{".ai": bool, ".ai_memory": bool}``. ``docs/safety.md`` forbids an agent
    from committing ``.ai/`` or ``.ai_memory/`` — those hold fetched Jira
    content and per-run logs — but nothing stopped a *developer* from doing it,
    and after one run their `git status` is full of files they did not create.
    This only reports; bugpilot never edits someone's `.gitignore` on its own.
    (The extension offers a button that does, which the developer presses.)

    Git's own answer, so a rule written as ``.ai``, ``/.ai/`` or in
    ``.git/info/exclude`` counts exactly as it does for git. `doctor` reports
    it per directory, which is what lets that button add only the missing rule,
    and as one ``ai_artifacts_ignored`` flag for the warning.

    ``None`` when the question cannot be answered (no git, or not a checkout).
    """
    if not (command_available("git") and inside_git_repo(repo_root)):
        return None
    # Two things this got wrong before, both found by asking real repositories:
    #
    #  - one path per call. `git check-ignore -q` refuses several with
    #    "fatal: --quiet is only valid with a single pathname" and exit 128,
    #    which a naive `code == 0` reads as "not ignored" everywhere.
    #  - ask about a path *inside* the directory. A `.ai/` pattern only matches
    #    a path git knows is a directory, so asking about `.ai` answered "not
    #    ignored" until the directory existed — a false alarm at exactly the
    #    moment the advice is worth giving, before the first run.
    return {
        directory: run_command(["git", "check-ignore", "-q", f"{directory}/probe"], repo_root)[0] == 0
        for directory in ARTIFACT_DIRECTORIES
    }


def branch_name(issue_key: str, description: str | None = None) -> str:
    """The branch a work item would get: ``feature/<work-item>-<slug>``.

    A hand-written bug is the exception. Its id is minted afresh on every run
    (``local_<timestamp>``), so a name built from it named a new branch every
    time the same bug was prepared again. Its name comes from its title alone
    — the same bug, the same branch — or, for a title with nothing to slug
    (one in another script), from a hash of the title.
    """
    slug = summary_slug(description)
    if is_local_work_item_id(issue_key):
        if slug:
            return f"feature/{slug}"[:120].rstrip("-")
        seed = (description or "").strip() or issue_key
        return f"feature/bug-{hashlib.sha1(seed.encode('utf-8')).hexdigest()[:8]}"
    branch = f"feature/{issue_key}-{slug or 'jira-workflow'}"
    return branch[:120].rstrip("-")


def summary_slug(description: str | None, max_length: int = 80) -> str:
    if not description:
        return ""
    slug = re.sub(r"[^a-z0-9]+", "-", description.lower())
    slug = re.sub(r"-+", "-", slug).strip("-")
    words = [word for word in slug.split("-") if word and word not in {"are"}]
    capped: list[str] = []
    current_length = 0
    for word in words:
        next_length = current_length + len(word) + (1 if capped else 0)
        if next_length > max_length:
            break
        capped.append(word)
        current_length = next_length
    return "-".join(capped)
