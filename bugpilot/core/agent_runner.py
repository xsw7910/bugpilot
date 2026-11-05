"""Deprecated: launching a coding agent from bugpilot.

**This module is deprecated as of V1 and will be removed in a future
release** (design section 9, phase 7). It still works, and nothing that
depends on it has been changed.

It exists because bugpilot originally launched Claude in a terminal after
preparing a package. That is no longer the default: `bugpilot bug` prepares and
stops, and this module runs only when a command line asks for it with
``--launch-agent claude`` or ``--launch-agent copilot``. The three-entry architecture made that the odd one out:
the MCP server is *called by* an agent, and the VS Code extension hands the
package over on a human's click. In both, deciding to involve a model is a
separate act from preparing the context — which is requirement R5, and the
reason this path is going away rather than being extended.

What to use instead:

- ``bugpilot bug <ID>`` (prepare-only is the default), then hand the work item's ``task.md`` to
  whatever agent you use. The extension's "Copy handoff prompt" does exactly
  this, and the Claude Code skill in ``skills/`` tells the agent to do it
  itself.
- The handoff wording now lives in :mod:`bugpilot.core.handoff`, shared with
  the MCP prompt and the skill.
"""

from __future__ import annotations

import os
import re
import shlex
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path, PureWindowsPath

from .config import AppConfig, check_work_folder_private, load_config, prompt_path, shown, writable_issue_dir
from .errors import StorageAccessError
from .executables import child_environment, find_executable
from .handoff import retry_handoff_prompt, work_item_handoff
from .safe_paths import UnsafePathError

# Kept as a format string because callers use `.format(...)` on it, but the
# wording now comes from `handoff.py` — the one place that says what an agent is
# told to do with a prepared package (design 5.5: a skill and an MCP prompt
# carrying the same instructions in two files will drift). The first launch's
# sentence is `handoff.work_item_handoff` (0.1.7: it names the task absolutely).
RETRY_HANDOFF_PROMPT = retry_handoff_prompt("{prompt_file}")

# What `bugpilot bug --launch-agent` accepts. The flag is the only way the CLI
# starts an agent: there is no implicit default one.
LAUNCHABLE_AGENTS: tuple[str, ...] = ("claude", "copilot")

# Claude Code's option for one more folder it may read and edit, besides its
# working directory (0.1.7). Given as one `--add-dir=<folder>` word: the option
# takes several folders, so as two words the prompt after it would be read as
# another one.
CLAUDE_ADD_DIR = "--add-dir"

# A batch-file shim (an npm `claude.cmd`) runs through cmd.exe, which acts on `%`, `^`, `&`, `|`, `<`, `>`, `(`,
# `)`, `!` and quotes in its command line: the plain-prompt gate's character set (US-D12; T-S12), ASCII only, is
# all its words may hold. The prompt also opens like a sentence, never like an option; an option word may hold
# `=` (`--add-dir=<folder>`). A native program gets its arguments as a vector, which no shell reads.
_CMD_PROMPT = re.compile(r"[A-Za-z0-9#][A-Za-z0-9 .,:#/_-]*", re.ASCII)
_CMD_WORD = re.compile(r"[A-Za-z0-9 .,:#/_=-]+", re.ASCII)
_CMD_ACTS_ON = re.compile(r'[%!^&|<>()"\x00-\x1f\x7f]')


@dataclass
class AgentRunResult:
    agent: str
    ran: bool
    command: list[str]
    returncode: int | None = None
    skipped_reason: str | None = None


def build_agent_command(agent: str, issue_key: str, config: AppConfig, prompt: str | None = None) -> list[str]:
    prompt = prompt or work_item_handoff(config.repo_root, issue_key)
    if agent == "claude":
        args = shlex.split(config.claude_args)
        base = [config.claude_command, *args, *_work_folder_grant(config.repo_root, issue_key, args)]
    elif agent == "copilot":
        base = [config.copilot_command, *shlex.split(config.copilot_args)]
    else:
        raise ValueError(f"Unknown agent: {agent}")
    return [*base, prompt]


def _work_folder_grant(repo_root: Path, issue_key: str, args: list[str]) -> list[str]:
    """``--add-dir=<work folder>`` for Claude Code, unless ``args`` grant that folder already.

    0.1.7 keeps a work item outside the repository, and Claude Code edits only
    in its working directory and the folders it is given: without this its
    write of ``fix_report.md`` is refused under ``acceptEdits``. One folder,
    the work item's own, never BugPilot's data folder. Checked by storage like
    every other use of it — the id, and no link or junction on the way — and it
    must be there, since Claude Code refuses a folder that is not. It, and every
    folder above it up to the data folder, must be private, so no other account
    can change what the agent reads or plant a ``.claude/`` there (S-2). Raises
    ``UnsafePathError`` (or ``StorageAccessError``) instead of launching
    without it.
    """
    folder = writable_issue_dir(repo_root, issue_key, create=False)
    if not folder.is_dir():
        raise UnsafePathError(f"The work item's folder {shown(folder)} is not there. Prepare the work item first.")
    check_work_folder_private(repo_root, issue_key)
    if any(_same_folder(repo_root, granted, folder) for granted in _granted_folders(args)):
        return []
    return [f"{CLAUDE_ADD_DIR}={prompt_path(folder)}"]


def _granted_folders(args: list[str]) -> list[str]:
    """The folders ``args`` already give Claude Code: ``--add-dir=<folder>``, and every word after ``--add-dir`` up to the next option."""
    folders: list[str] = []
    taking = False
    for arg in args:
        if arg.startswith(f"{CLAUDE_ADD_DIR}="):
            folders.append(arg.split("=", 1)[1])
            taking = False
        elif arg == CLAUDE_ADD_DIR:
            taking = True
        elif taking and not arg.startswith("-"):
            folders.append(arg)
        else:
            taking = False
    return folders


def _same_folder(repo_root: Path, granted: str, folder: Path) -> bool:
    """Whether a granted folder names ``folder``, as Claude Code resolves it: against the repository, in the system's case rules."""
    resolved = os.path.normpath(os.path.join(repo_root, granted))
    return os.path.normcase(resolved) == os.path.normcase(os.path.normpath(folder))


def run_agent(
    repo_root: Path,
    issue_key: str,
    agent: str,
    config: AppConfig | None = None,
    prompt: str | None = None,
) -> AgentRunResult:
    _warn_deprecated(agent)
    config = config if config is not None else load_config(repo_root)
    try:
        command = build_agent_command(agent, issue_key, config, prompt)
    except (UnsafePathError, StorageAccessError) as exc:
        # The work folder cannot be granted: the agent is not started without it.
        return AgentRunResult(agent=agent, ran=False, command=[], skipped_reason=str(exc))
    launch = _resolve_launch_command(command)
    if launch is None:
        return AgentRunResult(
            agent=agent,
            ran=False,
            command=command,
            skipped_reason=f"{command[0]} was not found on PATH.",
        )
    problem = _cmd_exe_problem(launch, command)
    if problem is not None:
        # Refused before anything starts, never "cleaned": the developer gets the manual handoff (T-S12).
        return AgentRunResult(agent=agent, ran=False, command=command, skipped_reason=problem)
    # Inherit the terminal so the agent runs interactively and the developer can
    # watch it work. Run in the target repo root (the current working directory),
    # with the current directory out of the agent's own program lookups.
    completed = subprocess.run(launch, cwd=repo_root, env=child_environment())
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
        "in a future release.",
        file=sys.stderr,
    )
    print(
        "      Prefer leaving out --launch-agent (prepare-only is the default) and handing "
        "task.md over yourself (the VS Code extension's Copy handoff prompt does this).",
        file=sys.stderr,
    )


def _resolve_launch_command(command: list[str]) -> list[str] | None:
    """Resolve the executable to a runnable form for the current OS.

    `find_executable` honors PATHEXT (so it finds `claude.cmd` on Windows) and,
    unlike shutil.which, never looks in the current directory — the repository.
    CreateProcess cannot launch a .cmd/.bat directly, so a
    Windows batch shim runs through the system's own cmd.exe, by absolute path.
    """
    resolved = find_executable(command[0])
    if resolved is None:
        return None
    rest = command[1:]
    if _is_batch_shim(resolved):
        shell = find_executable(os.environ.get("ComSpec") or "") or find_executable("cmd")
        if shell is None:
            return None
        return [shell, "/c", resolved, *rest]
    return [resolved, *rest]


def _is_batch_shim(resolved: str) -> bool:
    return sys.platform == "win32" and resolved.lower().endswith((".cmd", ".bat"))


def _cmd_exe_problem(launch: list[str], command: list[str]) -> str | None:
    """Why ``launch`` may not start: ``None`` unless cmd.exe would read words it acts on (T-S12, US-D12).

    Only a batch-file shim goes through cmd.exe (``[cmd, /c, <shim>, ...]``); a
    native program is started with its arguments as a vector and is not
    checked here. Every word is checked as it stands, never rewritten: the
    shim's own path, the configured arguments, the work-folder grant and the
    prompt.
    """
    if not (len(launch) == len(command) + 2 and launch[1] == "/c" and _is_batch_shim(launch[2])):
        return None
    shim, *options, prompt = launch[2:]
    plain = (
        not _CMD_ACTS_ON.search(shim)
        and all(_CMD_WORD.fullmatch(word) for word in options)
        and _CMD_PROMPT.fullmatch(prompt) is not None
    )
    if plain:
        return None
    return (
        f"{PureWindowsPath(shim).name} is a batch file, which Windows runs through cmd.exe, and its command line would "
        "hold characters cmd.exe acts on, so BugPilot does not start it. Set BUGPILOT_HOME to a folder whose path "
        "holds only ASCII letters, digits, spaces and . , : # / _ - (and keep BugPilot's agent arguments to those), "
        "or install the agent as a program rather than an npm script."
    )
