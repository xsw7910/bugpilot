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

DELIVERY_SAFETY_HEADING = "## BugPilot Delivery Safety"


def delivery_safety_block(
    issue_key: str,
    branch: str | None = None,
    jira_comment: bool = True,
) -> str:
    """Branch and staging rules for any commit, in any Fix Mode.

    BugPilot-owned and never editable by a Fix Mode: these are the rules that
    keep a token, a `.ai/` artifact or a commit on `main` out of the developer's
    repository, and they do not become optional because a particular workflow
    has nothing to commit yet.
    """
    branch_line = (
        f"- If needed, ask whether to create or switch to `{branch}` before editing or delivery.\n"
        if branch
        else ""
    )
    jira_rule = (
        "Do not merge, create PRs, transition Jira, assign Jira, or change Jira fields. "
        "The one status comment (posted before commit) is the only permitted Jira write.\n\n"
        if jira_comment
        else "Do not merge, create PRs, update Jira, transition Jira, assign Jira, or change Jira fields.\n\n"
    )
    return (
        f"{DELIVERY_SAFETY_HEADING}\n\n"
        "These rules apply to every commit or push made from this task, in every Fix Mode, "
        "including a later implementation pass the developer starts from it.\n\n"
        "Before staging anything:\n"
        "- Verify the current branch is not `main` or `master`.\n"
        "- Verify the current branch starts with `feature/` or another accepted feature prefix.\n"
        f"- Verify the current branch includes `{issue_key}`.\n"
        f"{branch_line}"
        "- Run `git add` only for intended source, test, or documentation files.\n"
        "- Do not add `.ai/`.\n"
        "- Do not add `.ai_memory/`.\n"
        "- Do not add `jira.json`.\n"
        "- Do not add `jira_field_report.md`.\n"
        "- Do not add files containing `JIRA_TOKEN`, `password`, `api_key`, `secret`, `access_token`, `refresh_token`, or `key=...`.\n\n"
        "Do not push main/master. Do not force push. Do not use `--force` or `--force-with-lease`. "
        f"{jira_rule}"
        "If on `main` or `master`, do not commit and do not push. Ask the developer whether to create or switch to the generated feature branch.\n\n"
    )


def assisted_delivery_block(
    issue_key: str,
    intro: str = "After completing code changes, focused tests, and all required result files",
) -> str:
    """The commit/push offer, for a pass that actually produced a fix.

    Deliberately does not restate the staging rules: they live in
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
        f"If {issue_key} is not in the current branch name, stop and ask the developer before committing.\n\n"
    )


def delivery_instructions_block(
    issue_key: str,
    branch: str | None = None,
    intro: str = "After completing code changes, focused tests, and all required result files",
    jira_comment: bool = True,
) -> str:
    """Safety gate followed by the assisted-delivery offer.

    The composed form, for callers that always deliver a fix.
    """
    return delivery_safety_block(issue_key, branch, jira_comment) + assisted_delivery_block(
        issue_key, intro
    )
