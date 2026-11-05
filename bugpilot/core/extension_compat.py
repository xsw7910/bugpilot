"""Telling a BugPilot for VS Code older than 0.1.7 that this CLI keeps its work items elsewhere (0.1.7).

0.1.7 keeps a repository's work items in BugPilot's data folder. BugPilot for
VS Code 0.1.6 and earlier look for them in the repository, where this CLI
neither writes nor reads them, so such an extension started with a 0.1.7 CLI
prepares work items it then cannot find, and cannot say why. It cannot be
changed now, and it tells the CLI nothing about itself. What it does show is
the CLI's own sentence for an error code it does not know, with "updating it
may help" — so the CLI answers it in the two places it asks first: its
handshake, ``doctor --json``, and a run, ``bug --json`` or ``--json-lines``.

The signal is two environment variables:

- every process a VS Code extension starts inherits its extension host's
  environment, which holds ``VSCODE_CRASH_REPORTER_PROCESS_TYPE=extensionHost``
  (a terminal's does not);
- BugPilot for VS Code 0.1.7 and later add ``BUGPILOT_CLIENT_STORAGE=unified``
  to every process they start: they read the data folder.

The first without the second is taken for an extension that does not read the
data folder. It is a heuristic: a program that another VS Code extension starts
— an AI agent running ``bugpilot doctor --json`` — looks the same, and is told
the same, unless it sets the variable too. A terminal, a script, CI, the MCP
server, text output and every other command are not affected.
"""

from __future__ import annotations

import os
from collections.abc import Mapping

#: What BugPilot for VS Code 0.1.7 and later set in every process they start, and the value that says it.
CLIENT_STORAGE_VARIABLE = "BUGPILOT_CLIENT_STORAGE"
CLIENT_STORAGE_UNIFIED = "unified"

#: What a VS Code extension host passes to every process it starts.
_EXTENSION_HOST_VARIABLE = "VSCODE_CRASH_REPORTER_PROCESS_TYPE"
_EXTENSION_HOST = "extensionHost"


def outdated_extension_problem(environ: Mapping[str, str] | None = None) -> str | None:
    """The sentence for a BugPilot for VS Code that does not read the data folder, or ``None`` for anything else."""
    from .. import __version__

    env = os.environ if environ is None else environ
    if env.get(_EXTENSION_HOST_VARIABLE) != _EXTENSION_HOST:
        return None
    if env.get(CLIENT_STORAGE_VARIABLE) == CLIENT_STORAGE_UNIFIED:
        return None
    return (
        f"This bugpilot ({__version__}) keeps work items in BugPilot's data folder, and the BugPilot extension that "
        "started it is older than 0.1.7 and looks for them in the repository. Update the BugPilot extension and the "
        "bugpilot CLI together, to the same version."
    )
