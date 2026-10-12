"""Which branch an agent works and commits on: the developer's choice.

BugPilot never runs ``git branch``, ``git checkout``, ``git switch``,
``git add``, ``git commit`` or ``git push`` itself. What it controls is what
the task tells the agent, and that used to be one rule for everyone: create or
switch to ``feature/<work-item>-<slug>`` before editing. A hand-written bug
gets a new ``local_<timestamp>`` id on every run, so every run named a new
branch; and a developer already working on a branch of their own was moved off
it.

Three policies, recorded per work item with the hint and the Fix Mode:

- ``current`` (the default): work on the branch that is checked out. Never
  create or switch one — except that on ``main``/``master`` or a detached HEAD
  the agent stops and asks before creating the suggested branch.
- ``per-issue``: one branch for the work item, created once and reused — the
  name is recorded the first time and every later preparation names the same
  one.
- ``ask``: before editing, the agent asks whether to stay on the current
  branch or create or switch to the suggested one.

The lifecycle rule under all three: preparing the same work item again — Run,
Rebuild Context, a retry, a new attempt — never calls for a new branch. Only
the policy decides when a branch is created or switched.

Whatever the policy, ``main`` and ``master`` are protected: nothing is edited,
committed or pushed on them, and a commit is never made on a detached HEAD. No
policy and no setting can relax that.

Every sentence about branches in a task, a guardrail, the delivery checks and
a retry prompt comes from this module.
"""

from __future__ import annotations

import re

from .identity import is_local_work_item_id
from .protected_rules import rule_bullet

BRANCH_POLICY_CURRENT = "current"
BRANCH_POLICY_PER_ISSUE = "per-issue"
BRANCH_POLICY_ASK = "ask"

BRANCH_POLICIES: tuple[str, ...] = (BRANCH_POLICY_CURRENT, BRANCH_POLICY_PER_ISSUE, BRANCH_POLICY_ASK)
DEFAULT_BRANCH_POLICY = BRANCH_POLICY_CURRENT

# Never written to, under any policy. Not configurable.
PROTECTED_BRANCHES: tuple[str, ...] = ("main", "master")

# What a recorded branch name may look like: a plain ref, nothing to escape.
_BRANCH_NAME_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9._/-]{0,199}")

_POLICY_NAMES = {
    BRANCH_POLICY_CURRENT: "use the current branch",
    BRANCH_POLICY_PER_ISSUE: "one branch per work item",
    BRANCH_POLICY_ASK: "ask the developer",
}

# The lifecycle rule, said in every task.
_NO_NEW_BRANCH_FOR_REPREPARING = (
    "- Preparing this work item again — Run, Rebuild Context, a retry, a new attempt — "
    "does not call for a new branch."
)


def check_branch_policy(value: str | None) -> str | None:
    """``value`` if it is a policy, ``None`` if absent; anything else is refused."""
    if value is None:
        return None
    policy = value.strip().lower()
    if policy not in BRANCH_POLICIES:
        raise ValueError(
            f"Unknown branch policy {value!r}. Use one of: {', '.join(BRANCH_POLICIES)}."
        )
    return policy


def resolve_branch_policy(requested: str | None, recorded: str | None) -> str:
    """The policy in force: the request's, else what the work item recorded, else the default.

    A recorded value that is not a policy (an issue.json edited by hand, or
    written by a later version) is ignored rather than fatal: the default is safe.
    """
    if requested is not None:
        return check_branch_policy(requested) or DEFAULT_BRANCH_POLICY
    if recorded in BRANCH_POLICIES:
        return recorded  # type: ignore[return-value]
    return DEFAULT_BRANCH_POLICY


def usable_branch_name(value: object) -> str | None:
    """A recorded branch name, if it is one a task may quote; else ``None``.

    The record is read back into ``task.md`` inside backticks, so a name that is
    not a plain ref (a hand-edited ``issue.json``) is dropped and derived again
    rather than quoted.
    """
    if not isinstance(value, str):
        return None
    name = value.strip()
    return name if _BRANCH_NAME_RE.fullmatch(name) and ".." not in name else None


def records_branch_name(policy: str) -> bool:
    """Whether the work item's branch is recorded, so later preparations reuse it.

    ``current`` names a branch only as a suggestion for main/master, so it is
    derived afresh; the other two may have the agent create one, and that one
    is the branch every later preparation must name.
    """
    return policy != BRANCH_POLICY_CURRENT


def _existing_branch_clause(issue_key: str) -> str:
    """For a Jira work item: a branch already made for its key counts as its branch."""
    if is_local_work_item_id(issue_key):
        return ""
    return f", or another existing branch whose name contains `{issue_key}`"


def branch_instructions(policy: str, branch: str, issue_key: str = "") -> str:
    """``task.md``'s Branch Instructions section, heading included."""
    lines = [f"- Branch policy: {_POLICY_NAMES[policy]}."]
    if policy == BRANCH_POLICY_PER_ISSUE:
        lines += [
            f"- Branch name: `{branch}`",
            rule_bullet("never-work-on-main"),
            f"- Check the current branch, then create or switch to `{branch}` before editing files — "
            f"from a detached HEAD too — and edit only there. If it already exists"
            f"{_existing_branch_clause(issue_key)}, switch to it rather than creating another.",
            f"{_NO_NEW_BRANCH_FOR_REPREPARING} Reuse this one.",
        ]
    elif policy == BRANCH_POLICY_ASK:
        lines += [
            f"- Suggested branch name: `{branch}`",
            rule_bullet("never-work-on-main"),
            "- Before editing, check the current branch, tell the developer it and the suggested branch "
            f"`{branch}`, and ask whether to stay on the current branch or to create or switch to "
            "the suggested one; then edit only on the branch they choose.",
            "- If the current branch is `main` or `master`, or HEAD is detached, staying is not an "
            f"option: ask only whether to create or switch to `{branch}`.",
            _NO_NEW_BRANCH_FOR_REPREPARING,
        ]
    else:
        lines += [
            "- Check the current branch before editing, and edit only on the branch that is checked "
            "out. Do not create or switch branches.",
            rule_bullet("never-work-on-main"),
            _NO_NEW_BRANCH_FOR_REPREPARING,
            "- If the current branch is `main` or `master`, or HEAD is detached, stop before editing "
            f'and ask the developer: "You are on a protected branch / detached HEAD. Create `{branch}` '
            'and continue?" Create and switch to it only if they explicitly agree.',
        ]
    return "## Branch Instructions\n\n" + "\n".join(lines) + "\n\n"


def retry_branch_section(policy: str, branch: str | None = None) -> str:
    """A retry prompt's Branch section: the same policy, and no new branch."""
    if policy == BRANCH_POLICY_PER_ISSUE:
        where = f"the work item's branch, `{branch}`" if branch else "the work item's branch"
    elif policy == BRANCH_POLICY_ASK:
        where = "the branch the developer chose for the first attempt"
    else:
        where = "the current branch"
    return (
        "## Branch\n\n"
        f"- Branch policy: {_POLICY_NAMES[policy]}, as in the first attempt.\n"
        f"- Continue on {where}. A retry does not call for a new branch.\n"
        f"{rule_bullet('never-work-on-main')}\n\n"
    )


def delivery_branch_checks(policy: str, issue_key: str, branch: str | None) -> str:
    """The branch checks before staging, after "not main/master" and "not detached"."""
    if policy == BRANCH_POLICY_PER_ISSUE:
        if branch:
            return (
                f"- Verify the current branch is the work item's branch: `{branch}`"
                f"{_existing_branch_clause(issue_key)}. If it is not, stop and ask the developer "
                f"whether to create or switch to `{branch}` before committing.\n"
            )
        # No name to hold the branch to: the old checks, which still say the
        # branch is this work item's.
        return (
            "- Verify the current branch starts with `feature/` or another accepted feature prefix.\n"
            f"- Verify the current branch includes `{issue_key}`. If it does not, stop and ask the "
            "developer before committing.\n"
        )
    if policy == BRANCH_POLICY_ASK:
        return (
            "- Verify the current branch is the one the developer chose before editing. If they chose "
            f"to stay on their branch, it does not have to start with `feature/` or include `{issue_key}`.\n"
        )
    return (
        "- Commit on the current branch. It does not have to start with `feature/` "
        f"or include `{issue_key}`.\n"
    )
