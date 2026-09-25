"""Turn a bug report into a :class:`BugSpec`, whatever system it came from.

This module is the Jira boundary. Everything downstream — keyword extraction,
code search, context building, prompts, memory — consumes a ``BugSpec`` and never
learns where the bug was described. Adding GitHub Issues or Azure DevOps later
means adding a constructor here, not touching the workflow.

A spec is input, not state: it is what a caller knows before the pipeline runs.
The normalized issue a run produces, and persists as ``issue.json``, is
:class:`issue.IssueArtifact`.

See ``docs/adapter_design.md`` section 3.3.
"""

from __future__ import annotations

from datetime import datetime
from pathlib import Path

from .config import issue_dir
from .identity import new_local_work_item_id
from .models import SOURCE_MANUAL, BugSpec

# A derived title is a directory-listing label, not prose. Long enough to be
# recognizable in `bugpilot list`, short enough not to wrap a terminal line.
MAX_DERIVED_TITLE_LENGTH = 120


def bug_spec_from_description(
    description: str,
    title: str | None = None,
    now: datetime | None = None,
    repo_root: Path | None = None,
) -> BugSpec:
    """Build a spec from a hand-written bug description.

    ``source_ref`` stays ``None``: there is no external issue to write back to,
    which is what every Jira-facing command checks before doing anything.

    Pass ``repo_root`` to guarantee the id is free. Ids have one-second
    granularity, and a fresh run deletes whatever is already in the work item's
    directory — so two bugs described in the same second would silently destroy
    the first one's artifacts.
    """
    body = (description or "").strip()
    if not body:
        raise ValueError("A manual bug needs a description.")
    work_item_id = new_local_work_item_id(now)
    if repo_root is not None:
        work_item_id = _free_work_item_id(repo_root, work_item_id)
    return BugSpec(
        work_item_id=work_item_id,
        source=SOURCE_MANUAL,
        title=(title or "").strip() or derive_title(body),
        description=body,
    )


def _free_work_item_id(repo_root: Path, base: str) -> str:
    """``base``, or ``base_2``/``base_3``… if earlier work items already claim it."""
    candidate = base
    suffix = 2
    while issue_dir(repo_root, candidate).exists():
        candidate = f"{base}_{suffix}"
        suffix += 1
    return candidate


def manual_issue_payload(spec: BugSpec) -> dict[str, object]:
    """Shape a manual spec like an issue payload so ``parse_issue`` can normalize it.

    This payload exists only in memory, long enough for ``parse_issue`` to
    extract the same signals from a hand-written bug that it extracts from a
    Jira one — one parser, so the two sources cannot drift apart.

    ``adf_to_markdown`` passes plain strings through unchanged, so a hand-written
    description needs no ADF wrapping.
    """
    return {
        "key": spec.work_item_id,
        "fields": {"summary": spec.title, "description": spec.description},
    }


def derive_title(description: str) -> str:
    """First meaningful line of a description, trimmed to a label.

    Markdown headings and list bullets are common in pasted bug reports, so their
    markers are stripped rather than shown in a listing.
    """
    for raw_line in description.splitlines():
        line = raw_line.strip().lstrip("#-*> ").strip()
        if line:
            if len(line) > MAX_DERIVED_TITLE_LENGTH:
                return line[: MAX_DERIVED_TITLE_LENGTH - 1].rstrip() + "…"
            return line
    return "Untitled bug"
