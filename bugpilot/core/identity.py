"""Work item identity — the single source of truth for id shapes.

BugPilot addresses two kinds of work item: a Jira issue (``JR-12345``) and one
created locally from a hand-written bug description (``local_20260901094133``).
These are different concepts and are answered by different questions:

- :func:`is_jira_issue_key` — "can this be written back to Jira?" It gates the
  Jira input adapter and every Jira write (comment draft, comment post).
- :func:`is_work_item_id` — "is this a safe artifact directory name?" It gates
  ``.ai/<work_item>/`` creation and cleanup containment.

A local id deliberately fails :func:`is_jira_issue_key`: the ``local_`` prefix
puts an underscore where a Jira key needs a dash before its digits, so nothing
can mistake one for the other. Before this module the two questions shared three
regexes across two modules and disagreed with each other, which made a local id
pass cleanup validation while silently failing memory lookup.

See ``docs/adapter_design.md`` section 3.4.
"""

from __future__ import annotations

import re
from datetime import datetime, timezone

# A Jira issue key: uppercase project prefix, dash, digits. Nothing else.
JIRA_ISSUE_KEY_RE = re.compile(r"^[A-Z][A-Z0-9]+-\d+$")

# A work item id usable as a single path segment. Two properties matter, and both
# are load-bearing for cleanup, which deletes directories by this name:
#
# 1. It must start with a letter and contain only letters, digits, underscore and
#    dash — which is what keeps ``..``, ``.``, ``a/b`` and ``a.b`` out, so an id
#    can never escape its parent directory.
# 2. It must end in a numeric suffix after a dash or underscore, so a bare word
#    like ``JR`` is not a valid target. ``JR-12345`` and ``local_20260901094133``
#    both satisfy this; the previous cleanup regex enforced the same property for
#    Jira keys and it is worth keeping now that local ids exist.
#
# Neither predicate strips whitespace: these validate the exact string that
# becomes a path segment, and `" JR-12345"` is a different directory from
# `"JR-12345"`. Callers that want lenient matching strip before calling.
WORK_ITEM_ID_RE = re.compile(r"^[A-Za-z][A-Za-z0-9_-]*[-_]\d+$")

LOCAL_ID_PREFIX = "local_"


def is_jira_issue_key(value: str) -> bool:
    """True when ``value`` is a Jira issue key such as ``JR-12345``.

    This is the "can it be written back to Jira?" question. Answer it before
    drafting or posting a comment; a local id must never reach that path.
    """
    return bool(JIRA_ISSUE_KEY_RE.match(value))


def is_local_work_item_id(value: str) -> bool:
    """True when ``value`` is an id this tool minted for a hand-written bug."""
    return value.startswith(LOCAL_ID_PREFIX) and bool(WORK_ITEM_ID_RE.match(value))


def is_known_work_item_id(value: str) -> bool:
    """True when ``value`` names a work item rather than being a search term.

    This is the third and narrowest question, and it is not the same as
    :func:`is_work_item_id`. That one asks whether a string is *safe* as a
    directory name and so must accept anything we might ever mint; using it to
    classify user input misreads ordinary search terms — ``utf-8``, ``log4j-2``
    and ``python-3`` all satisfy it — turning a free-text memory search into a
    lookup for a work item that does not exist.
    """
    return is_jira_issue_key(value) or is_local_work_item_id(value)


def is_work_item_id(value: str) -> bool:
    """True when ``value`` is safe to use as a ``.ai/<work_item>/`` directory name.

    Deliberately permissive: it must accept every id shape this tool can create,
    so it is a containment check, not a classifier. To decide whether a user typed
    an id, use :func:`is_known_work_item_id`.
    """
    return bool(WORK_ITEM_ID_RE.match(value))


def validate_work_item_id(value: str) -> None:
    """Raise ``ValueError`` unless ``value`` is a usable work item id."""
    if not is_work_item_id(value):
        raise ValueError(
            "Invalid issue key or work item id. Use a Jira key such as JR-12345, "
            "or a local id such as local_20260901094133. Allowed characters: "
            "letters, numbers, underscore, dash; must start with a letter and end "
            "with -<digits> or _<digits>."
        )


def new_local_work_item_id(now: datetime | None = None) -> str:
    """Build the id for a locally described bug: ``local_<YYYYMMDDHHMMSS>``.

    Timestamped rather than slugged: an id has to stay stable while a bug title
    stays editable, and the existing ``summary_slug`` drops non-ASCII, so a
    Chinese title would produce an empty slug. Readability is a display concern —
    ``bugpilot list`` shows the title alongside the id.
    """
    moment = now or datetime.now(timezone.utc)
    return f"{LOCAL_ID_PREFIX}{moment.strftime('%Y%m%d%H%M%S')}"
