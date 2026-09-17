"""Deprecated: launching a coding agent from bugpilot.

**This module is deprecated as of V1 and will be removed after Internal Beta
feedback** (design section 9, phase 7). It still works, and nothing that
depends on it has been changed.

It exists because bugpilot originally launched Claude in a terminal after
preparing a package. The three-entry architecture made that the odd one out:
the MCP server is *called by* an agent, and the VS Code extension hands the
package over on a human's click. In both, deciding to involve a model is a
separate act from preparing the context — which is requirement R5, and the
reason this path is going away rather than being extended.

What to use instead:

- ``bugpilot bug <ID> --prepare-only``, then hand ``.ai/<ID>/agent_task.md`` to
  whatever agent you use. The extension's "Copy handoff prompt" does exactly
  this, and the Claude Code skill in ``skills/`` tells the agent to do it
  itself.
- The handoff wording now lives in :mod:`bugpilot.core.handoff`, shared with
  the MCP prompt and the skill.
"""

from __future__ import annotations

import shlex
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

from .config import AppConfig, load_config
from .handoff import handoff_prompt, retry_handoff_prompt

# Kept as format strings because callers use `.format(...)` on them, but the
# wording now comes from `handoff.py` — the one place that says what an agent is
# told to do with a prepared package (design 5.5: a skill and an MCP prompt
# carrying the same instructions in two files will drift).
HANDOFF_PROMPT = handoff_prompt("{issue_key}")
RETRY_HANDOFF_PROMPT = retry_handoff_prompt("{prompt_file}")


@dataclass
class AgentRunResult:
    agent: str
    ran: bool
    command: list[str]
    returncode: int | None = None
    skipped_reason: str | None = None


def build_agent_command(agent: str, issue_key: str, config: AppConfig, prompt: str | None = None) -> list[str]:
    prompt = prompt or HANDOFF_PROMPT.format(issue_key=issue_key)
    if agent == "claude":
        base = [config.claude_command, *shlex.split(config.claude_args)]
    elif agent == "copilot":
        base = [config.copilot_command, *shlex.split(config.copilot_args)]
    else:
        raise ValueError(f"Unknown agent: {agent}")
    return [*base, prompt]


def run_agent(
    repo_root: Path,
    issue_key: str,
    agent: str,
    config: AppConfig | None = None,
    prompt: str | None = None,
) -> AgentRunResult:
    _warn_deprecated(agent)
    config = config if config is not None else load_config(repo_root)
    command = build_agent_command(agent, issue_key, config, prompt)
    launch = _resolve_launch_command(command)
    if launch is None:
        return AgentRunResult(
            agent=agent,
            ran=False,
            command=command,
            skipped_reason=f"{command[0]} was not found on PATH.",
        )
    # Inherit the terminal so the agent runs interactively and the developer can
    # watch it work. Run in the target repo root (the current working directory).
    completed = subprocess.run(launch, cwd=repo_root)
    return AgentRunResult(
        agent=agent,
        ran=True,
        command=command,
        returncode=completed.returncode,
    )


def _warn_deprecated(agent: str) -> None:
    """Tell the developer, on stderr, that this path is going away.

    A ``DeprecationWarning`` would be the library-shaped answer and invisible
    here: Python hides those by default, and the audience is a person watching a
    terminal. stderr also keeps requirement R1 intact — the human-readable
    stdout of every existing command is untouched.
    """
    print(
        f"NOTE: launching {agent} from bugpilot is deprecated and will be removed "
        "after Internal Beta.",
        file=sys.stderr,
    )
    print(
        "      Prefer --prepare-only and hand agent_task.md over yourself "
        "(the VS Code extension's Copy handoff prompt does this).",
        file=sys.stderr,
    )


def _resolve_launch_command(command: list[str]) -> list[str] | None:
    """Resolve the executable to a runnable form for the current OS.

    shutil.which honors PATHEXT (so it finds `claude.cmd` on Windows), but
    CreateProcess cannot launch a bare name or a .cmd/.bat directly. Resolve the
    full path and, for Windows batch shims, run it through `cmd /c`.
    """
    resolved = shutil.which(command[0])
    if resolved is None:
        return None
    rest = command[1:]
    if sys.platform == "win32" and resolved.lower().endswith((".cmd", ".bat")):
        return ["cmd", "/c", resolved, *rest]
    return [resolved, *rest]
