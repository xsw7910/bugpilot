"""Shared agent delivery instruction text.

Delivery is two separable things, and conflating them cost a safety rule once
already. The *offer* — show a summary, ask to commit, run the git commands —
only makes sense when a fix exists. The *safety gate* — which branch may be
written to, what may never be staged — applies to any pass that could reach a
commit, including the implementation pass a developer starts by answering "yes"
to an investigation.

So they are separate blocks. An investigation-only task omits the offer and
keeps the gate; anything that can deliver gets both, in that order.
"""

from __future__ import annotations

from .branch_policy import DEFAULT_BRANCH_POLICY, delivery_branch_checks

DELIVERY_SAFETY_HEADING = "## BugPilot Delivery Safety"


def delivery_safety_block(
    issue_key: str,
    branch: str | None = None,
    branch_policy: str = DEFAULT_BRANCH_POLICY,
    *,
    standalone: bool = True,
) -> str:
    """When to commit and push, and what may be staged, in any Fix Mode.

    BugPilot-owned and never editable by a Fix Mode: these are the rules that
    keep a token, a `.ai/` artifact or a commit on `main` out of the developer's
    repository, and they do not become optional because a particular workflow
    has nothing to commit yet. Which other branch is right is the developer's
    branch policy (`branch_policy.py`); `main`/`master` never is, in any policy.

    This is where these rules are defined, once (0.1.3, §42.4). In
    `task.md` the BugPilot Safety Rules above already forbid force pushes,
    merges, pull requests and Jira changes, so the task passes
    ``standalone=False``; a document without that section — the retry prompt —
    gets them here too.
    """
    protected = (
        "- Never force push or use `--force` or `--force-with-lease`; never merge, create pull "
        "requests, or transition, assign, or change Jira fields.\n"
        if standalone
        else ""
    )
    return (
        f"{DELIVERY_SAFETY_HEADING}\n\n"
        "For every commit or push made from this task, in every Fix Mode, including a later "
        "implementation pass the developer starts from it:\n\n"
        "- Commit or push only after the developer explicitly approves it, never automatically. "
        "A pass allowed to change source code may ask once its work is done.\n"
        "- Before staging anything, verify the current branch is not `main` or `master` and HEAD is "
        "not detached. If either is true, do not commit and do not push: ask the developer whether to "
        "create or switch to the suggested branch.\n"
        f"{delivery_branch_checks(branch_policy, issue_key, branch)}"
        "- Stage only intended source, test, or documentation files: never `.ai/`, `.ai_memory/`, "
        "`issue.json`, `jira_field_report.md`, or files containing `JIRA_TOKEN`, `password`, "
        "`api_key`, `secret`, `access_token`, `refresh_token`, or `key=...`.\n"
        "- Never push main/master.\n"
        f"{protected}"
        "\n"
    )


def assisted_delivery_block(
    issue_key: str,
    intro: str = "After completing code changes, focused tests, and the fix report",
    branch_policy: str = DEFAULT_BRANCH_POLICY,
    branch: str | None = None,
) -> str:
    """The commit/push offer, for a pass that actually produced a fix.

    Deliberately does not restate the staging or branch rules: they live in
    `delivery_safety_block`, which is rendered for every Fix Mode, and a second
    copy here is one more place for them to drift.
    """
    return (
        "## Optional Assisted Delivery\n\n"
        f"{intro}, show the developer a delivery summary with:\n"
        "- `git status`\n"
        "- changed files\n"
        "- test result summary\n"
        "- proposed commit message\n"
        "- current branch\n"
        "- target remote\n\n"
        "Then ask exactly:\n\n"
        "\"Do you want me to commit and push this branch to origin?\"\n\n"
        "Only if the developer explicitly answers yes:\n"
        f"- Apply every rule in {DELIVERY_SAFETY_HEADING.lstrip('# ')} above; stage nothing it excludes.\n"
        "- Run `git commit` with the proposed message.\n"
        "- Run `git push -u origin <current-branch>`.\n\n"
    )


def delivery_instructions_block(
    issue_key: str,
    branch: str | None = None,
    intro: str = "After completing code changes, focused tests, and the fix report",
    branch_policy: str = DEFAULT_BRANCH_POLICY,
) -> str:
    """Safety gate followed by the assisted-delivery offer.

    The composed form, for callers that always deliver a fix — and have no
    Safety Rules section of their own, so the gate is the standalone one.
    """
    return delivery_safety_block(issue_key, branch, branch_policy=branch_policy) + assisted_delivery_block(
        issue_key, intro, branch_policy=branch_policy, branch=branch
    )
