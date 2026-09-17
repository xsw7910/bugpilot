"""Environment diagnostics."""

from __future__ import annotations

import platform
import sys
from pathlib import Path

from .. import __version__
from .config import load_config, load_email_config, load_graph_config
from .git_ops import (
    artifacts_ignored,
    command_available,
    current_branch,
    inside_git_repo,
    working_tree_status,
)


def collect_doctor_report(repo_root: Path) -> dict[str, str | bool | None]:
    config = load_config(repo_root)
    email_config = load_email_config()
    graph_config = load_graph_config()
    in_git = command_available("git") and inside_git_repo(repo_root)
    return {
        # First, and reported by every consumer of this dict, because "which
        # bugpilot am I actually running?" is a real question: a machine can
        # carry a pipx copy, an editable install and a frozen exe at once, and
        # the extension shows this next to the path it resolved.
        "version": __version__,
        "python_version": platform.python_version(),
        "python_ok": sys.version_info >= (3, 10),
        "git_available": command_available("git"),
        "current_directory": str(repo_root),
        "inside_git_repo": in_git,
        "current_branch": current_branch(repo_root) if in_git else None,
        "working_tree_status": working_tree_status(repo_root) if in_git else None,
        # False means one run will fill this repository's `git status` with
        # artifacts, and someone will commit fetched Jira content. Reported
        # rather than fixed: bugpilot does not edit a developer's .gitignore.
        "ai_artifacts_ignored": artifacts_ignored(repo_root),
        "rg_available": command_available("rg"),
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
    return ["bugpilot doctor"] + [f"{key}: {value}" for key, value in report.items()]

