"""Turn a bug report into a :class:`BugSpec`, whatever system it came from.

This module is the Jira boundary. Everything downstream — keyword extraction,
code search, context building, prompts, memory — consumes a ``BugSpec`` and never
learns where the bug was described. Adding GitHub Issues or Azure DevOps later
means adding a constructor here, not touching the workflow.

It also owns the on-disk form of a spec (``.ai/<work_item>/bug_spec.json``).
Persistence lives next to the constructors deliberately: the file layout and the
constructors have to agree about which fields exist, and splitting them across
modules is how they drift.

See ``docs/adapter_design.md`` section 3.3.
"""

from __future__ import annotations

import json
from datetime import datetime
from pathlib import Path

from .config import issue_dir
from .identity import is_jira_issue_key, new_local_work_item_id, validate_work_item_id
from .models import SOURCE_JIRA, SOURCE_MANUAL, BugSpec

BUG_SPEC_FILENAME = "bug_spec.json"

# A derived title is a directory-listing label, not prose. Long enough to be
# recognizable in `bugpilot list`, short enough not to wrap a terminal line.
MAX_DERIVED_TITLE_LENGTH = 120


def bug_spec_from_jira(parsed: dict[str, object]) -> BugSpec:
    """Build a spec from the output of :func:`jira.parse_issue`.

    Takes the parsed dict rather than the raw issue payload so this module stays
    a leaf — the caller that already ran ``parse_issue`` hands over the result.
    """
    issue_key = str(parsed.get("issue_key") or "").strip()
    if not issue_key:
        raise ValueError("Jira payload has no issue key; cannot build a BugSpec.")
    validate_work_item_id(issue_key)
    # source_ref is what Jira writes are addressed to, so it has to be a real Jira
    # key. validate_work_item_id alone would accept a local id here and let a
    # hand-written bug acquire a write-back target that does not exist.
    if not is_jira_issue_key(issue_key):
        raise ValueError(f"{issue_key!r} is not a Jira issue key; cannot build a Jira BugSpec.")
    return BugSpec(
        work_item_id=issue_key,
        source=SOURCE_JIRA,
        title=str(parsed.get("summary") or "").strip(),
        description=str(parsed.get("description") or "").strip(),
        source_ref=issue_key,
    )


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

    Nothing is written to disk under a Jira name — ``jira.json`` stays exclusively
    Jira's, so a reader can always trust that file to be real fetched data. This
    payload exists only in memory, long enough for ``parse_issue`` to produce the
    same parsed dict the rest of the pipeline already expects.

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


# --- on-disk form -----------------------------------------------------------


def bug_spec_path(repo_root: Path, work_item_id: str) -> Path:
    return issue_dir(repo_root, work_item_id) / BUG_SPEC_FILENAME


def save_bug_spec(repo_root: Path, spec: BugSpec) -> Path:
    """Persist a spec so later commands do not need the original input.

    ``bugpilot list`` reads title and source from here, and manual-mode email
    falls back to these fields because there is no ``jira_summary.md``.
    """
    target = issue_dir(repo_root, spec.work_item_id)
    target.mkdir(parents=True, exist_ok=True)
    path = target / BUG_SPEC_FILENAME
    path.write_text(
        json.dumps(spec_to_dict(spec), indent=2, ensure_ascii=False) + "\n",
        encoding="utf-8",
    )
    return path


def load_bug_spec(repo_root: Path, work_item_id: str) -> BugSpec | None:
    """Read a persisted spec, or ``None`` when there is none or it is unreadable.

    Returns ``None`` rather than raising so a listing can degrade to showing the
    ids it found instead of failing on one corrupt directory.
    """
    path = bug_spec_path(repo_root, work_item_id)
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (json.JSONDecodeError, OSError, UnicodeDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    return spec_from_dict(data)


def spec_to_dict(spec: BugSpec) -> dict[str, object]:
    return {
        "work_item_id": spec.work_item_id,
        "source": spec.source,
        "title": spec.title,
        "description": spec.description,
        "source_ref": spec.source_ref,
    }


def spec_from_dict(data: dict[str, object]) -> BugSpec | None:
    """Rebuild a spec from its on-disk form, or ``None`` if the id is unusable."""
    work_item_id = str(data.get("work_item_id") or "").strip()
    if not work_item_id:
        return None
    source_ref = data.get("source_ref")
    return BugSpec(
        work_item_id=work_item_id,
        source=str(data.get("source") or SOURCE_MANUAL),
        title=str(data.get("title") or ""),
        description=str(data.get("description") or ""),
        source_ref=str(source_ref) if source_ref else None,
    )
