"""The standard BugPilot artifact contract: what a work item directory holds.

One place for the names, because every reader and writer has to agree on them
and a filename spelled out in five modules is five chances to drift.

    issue.json       the normalized bug and the guidance a run was given
    retrieval.json   search terms, relevant files and their matched lines
    context.md       the context an agent reads first
    task.md          the task package handed to the coding agent
    run.json         runtime state: step lifecycle, agent state
    fix_report.md    optional, only once a fix produced something to report
    review_report.md optional, only once somebody recorded a review's result

Every JSON artifact carries ``schema_version``. There is deliberately no
migration and no reader for any earlier layout: BugPilot is pre-release, and a
work item prepared under an older layout is re-prepared rather than upgraded.
"""

from __future__ import annotations

ARTIFACT_SCHEMA_VERSION = 1

ISSUE_ARTIFACT = "issue.json"
RETRIEVAL_ARTIFACT = "retrieval.json"
CONTEXT_ARTIFACT = "context.md"
TASK_ARTIFACT = "task.md"
RUN_ARTIFACT = "run.json"
FIX_REPORT_ARTIFACT = "fix_report.md"
REVIEW_REPORT_ARTIFACT = "review_report.md"


class WorkItemNotFoundError(FileNotFoundError):
    """The work item directory does not exist."""


# What a normal prepare-only run leaves behind once every batch has landed.
# The two reports are not here: each exists only once something wrote it.
CORE_ARTIFACTS: tuple[str, ...] = (
    ISSUE_ARTIFACT,
    RETRIEVAL_ARTIFACT,
    CONTEXT_ARTIFACT,
    TASK_ARTIFACT,
    RUN_ARTIFACT,
)
