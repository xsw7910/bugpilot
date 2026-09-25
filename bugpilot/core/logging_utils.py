"""Diagnostic trace logging, unpersisted (plan §37, Batch 4).

``log()`` used to append every line to ``.ai/<id>/execution.log``. Nothing ever
read that file — the steps map, the generated files and the warnings it echoed
all have canonical homes (``run.json``, ``WorkflowResult.warnings``, the CLI's
own output) — so the artifact is gone. The ~150 call sites keep their
signature; the trace goes through stdlib logging now, where a host that wants
it attaches a handler **to this logger** and nobody else gets a file.

Deliberately non-propagating. A host's root handler would otherwise receive
the whole trace: the MCP SDK installs a rich root handler writing to stderr,
and a prepare streamed through it deadlocked the stdio server against any
client that does not drain stderr — found by ``test_mcp_stdio`` the first time
the trace propagated. Diagnostics are opt-in, on ``bugpilot.execution``.
"""

from __future__ import annotations

import logging
from pathlib import Path

_logger = logging.getLogger("bugpilot.execution")
_logger.addHandler(logging.NullHandler())
_logger.propagate = False


def log(issue_dir: Path, message: str) -> None:
    _logger.info("%s: %s", issue_dir.name, message)
