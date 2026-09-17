"""Shared agent assisted delivery instruction text."""

from __future__ import annotations


def delivery_instructions_block(
    issue_key: str,
    branch: str | None = None,
    intro: str = "After completing code changes, focused tests, and all required result files",
    jira_comment: bool = True,
) -> str:
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
        "- Verify the current branch is not `main` or `master`.\n"
        "- Verify the current branch starts with `feature/` or another accepted feature prefix.\n"
        f"- Verify the current branch includes `{issue_key}`.\n"
        f"{branch_line}"
        "- Run `git add` only for intended source, test, or documentation files.\n"
        "- Do not add `.ai/`.\n"
        "- Do not add `.ai_memory/`.\n"
        "- Do not add `jira.json`.\n"
        "- Do not add `jira_field_report.md`.\n"
        "- Do not add files containing `JIRA_TOKEN`, `password`, `api_key`, `secret`, `access_token`, `refresh_token`, or `key=...`.\n"
        "- Run `git commit` with the proposed message.\n"
        "- Run `git push -u origin <current-branch>`.\n\n"
        "Do not push main/master. Do not force push. Do not use `--force` or `--force-with-lease`. "
        f"{jira_rule}"
        "If on `main` or `master`, do not commit and do not push. Ask the developer whether to create or switch to the generated feature branch.\n\n"
    )
