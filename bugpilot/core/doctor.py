"""Environment diagnostics."""

from __future__ import annotations

import platform
import sys
from pathlib import Path

from .. import __version__
from . import storage
from .config import load_config, load_email_config, load_graph_config
from .git_ops import (
    command_available,
    current_branch,
    inside_git_repo,
    program_available,
    working_tree_status,
)

#: What this CLI can do that an older one cannot, by name. A version number
#: alone cannot say it: an older CLI accepts every argument a client sends and
#: still ignores a file it has never heard of — `verification.md` read
#: by 0.1.2 is exactly that. A client that depends on one of these checks for
#: it, and treats its absence as an out-of-date CLI. Names are never removed.
CAPABILITIES: tuple[str, ...] = (
    # `verification.md`, `bugpilot verification`, and
    # `verification_source` in `project-settings` (0.1.3).
    "verification-text",
    # `ai_behavior.md` and `bugpilot ai-behavior` (0.1.4).
    "ai-behavior-text",
    # `bugpilot protected-rules`: the protected rules, read-only (0.1.4).
    "protected-rules",
    # `bugpilot task-preview`: the Effective AI Task, written nowhere (0.1.4).
    "task-preview",
    # `bugpilot context-preview`: the last generated context and its status (0.1.4).
    "context-preview",
    # Work items, bug memory and the repository's settings in BugPilot's data
    # folder, never in the repository, and `doctor`'s `storage` object, which
    # says where (0.1.7). A client that finds files by path needs it.
    "unified-storage",
)


def storage_report(repo_root: Path) -> dict[str, str | None]:
    """Where this repository's BugPilot files are, and whether they can be used. Never raises; creates nothing.

    ``state`` is storage's read-only check: ``usable``, ``uninitialized`` (the
    first run creates the folder), ``refused`` (a data folder inside the
    repository or a Git working tree, a link on the way, a record naming
    another repository) or ``unavailable``; ``problem`` says why in one
    sentence. The paths are absolute and native, for a client that opens the
    files (the VS Code extension); ``data_root_display`` is the form messages
    use. A data folder that cannot be resolved at all (``BUGPILOT_HOME`` not
    absolute, no home folder) has no paths: ``state`` is ``refused``.

    ``privacy`` is whether the folders that hold this repository's work items
    are private (``private``, ``not-private`` or ``unverifiable``), with
    ``privacy_problem`` saying why not: a client gives an agent a work item's
    folder only when it is ``private`` (0.1.7, S-2).
    """
    try:
        namespace = storage.repository_storage(repo_root)
    except storage.StorageError as error:
        return {"state": "refused", "problem": str(error)}
    paths = namespace.diagnostics()
    check = namespace.check()
    privacy, privacy_problem = namespace.privacy()
    return {
        "data_root": paths["data_root"],
        "data_root_display": paths["data_root_display"],
        "data_root_source": paths["data_root_source"],
        "repository_id": paths["repository_id"],
        "repository_dir": paths["repository_dir"],
        "config_dir": paths["config_dir"],
        "state": check.state,
        "problem": check.problem,
        "privacy": privacy,
        "privacy_problem": privacy_problem,
    }


def collect_doctor_report(repo_root: Path) -> dict[str, object]:
    config = load_config(repo_root)
    email_config = load_email_config()
    graph_config = load_graph_config()
    # git and rg as BugPilot starts them: native programs, never batch files (S-8).
    in_git = program_available("git") and inside_git_repo(repo_root)
    return {
        # First, and reported by every consumer of this dict, because "which
        # bugpilot am I actually running?" is a real question: a machine can
        # carry a pipx copy, an editable install and a frozen exe at once, and
        # the extension shows this next to the path it resolved.
        "version": __version__,
        "capabilities": list(CAPABILITIES),
        "python_version": platform.python_version(),
        "python_ok": sys.version_info >= (3, 10),
        "git_available": program_available("git"),
        "current_directory": str(repo_root),
        "inside_git_repo": in_git,
        "current_branch": current_branch(repo_root) if in_git else None,
        "working_tree_status": working_tree_status(repo_root) if in_git else None,
        # Where this repository's work items, memory and settings are (0.1.7).
        # Nothing is written into the repository any more, so there is no
        # `.gitignore` rule to ask about (`ai_artifacts_ignored*` are gone).
        "storage": storage_report(repo_root),
        "rg_available": program_available("rg"),
        "jira_base_url_present": bool(config.jira_base_url),
        "jira_email_present": bool(config.jira_email),
        "jira_token_present": bool(config.jira_token),
        "copilot_available": command_available(config.copilot_command),
        "claude_available": command_available(config.claude_command),
        "email_configured": email_config.is_configured,
        "email_graph_configured": graph_config.is_configured,
    }


def doctor_report_lines(repo_root: Path) -> list[str]:
    """The ``bugpilot doctor`` report, as lines for a caller to print.

    Rendering stays out of core so the MCP server — which owns stdout for its
    JSON-RPC frames — can consume :func:`collect_doctor_report` safely.
    """
    report = collect_doctor_report(repo_root)
    lines = ["bugpilot doctor"]
    for key, value in report.items():
        if isinstance(value, dict):
            lines.append(f"{key}:")
            lines.extend(f"  {name}: {item}" for name, item in value.items())
        else:
            lines.append(f"{key}: {', '.join(value) if isinstance(value, list) else value}")
    return lines

