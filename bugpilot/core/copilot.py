"""AI agent availability checks and safe handoff guidance.

Split into collect/render halves like :mod:`doctor`: the collectors return data,
and rendering to stdout stays in the CLI layer. Core cannot print, because the
MCP server speaks JSON-RPC over stdout — one stray ``print`` there corrupts the
protocol frame and the client silently loses the connection.

See ``docs/adapter_design.md`` section 4.2, invariant 2.
"""

from __future__ import annotations

from pathlib import Path

from .config import load_config
from .git_ops import command_available
from .handoff import handoff_prompt


def collect_agent_status(repo_root: Path | None = None) -> dict[str, str | bool]:
    """Report which coding agents are reachable, and in what mode bugpilot runs."""
    config = load_config(repo_root or Path.cwd())
    return {
        "copilot_command": config.copilot_command,
        "copilot_available": command_available(config.copilot_command),
        "gh_available": command_available("gh"),
        "claude_available": command_available(config.claude_command),
        "automatic_invocation": "opt-in via `bugpilot bug --claude` or `--copilot`",
        "default_mode": "prepare-only",
    }


def agent_status_lines(repo_root: Path | None = None) -> list[str]:
    """The ``bugpilot agent-check`` report, as lines for a caller to print."""
    status = collect_agent_status(repo_root)
    return ["bugpilot agent-check"] + [f"{key}: {value}" for key, value in status.items()]


def auto_invocation_guidance(issue_key: str) -> list[str]:
    """What to tell a developer who must start their agent by hand."""
    return [
        "Agent automatic invocation is not enabled.",
        "Open your AI agent from the target repo root and run:",
        handoff_prompt(issue_key),
    ]

