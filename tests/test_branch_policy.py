"""The branch policy: which branch the agent works on, and when it may make one.

BugPilot never runs `git branch` itself; it tells the agent. These tests pin
what it tells the agent under each policy, that main/master stays protected
under all of them, and that the choice — and, where the agent may create a
branch, the branch — is recorded per work item, so a resume, a rebuild, a
regenerated task and a retry prompt all say the same and none of them calls for
a new branch.
"""

from __future__ import annotations

import json

import pytest

from bugpilot.cli import build_parser, main
from bugpilot.core import workflow
from bugpilot.core.branch_policy import (
    BRANCH_POLICIES,
    DEFAULT_BRANCH_POLICY,
    PROTECTED_BRANCHES,
    check_branch_policy,
    resolve_branch_policy,
    usable_branch_name,
)
from bugpilot.core.delivery_instructions import delivery_safety_block
from bugpilot.core.git_ops import branch_name
from bugpilot.core.issue import IssueGuidance, issue_from_dict, issue_to_dict, jira_stub
from bugpilot.core.prompts import generate_task

FEATURE = "feature/JR-1-stale-search-results"

# Never on main/master, never a commit on a detached HEAD — under every policy,
# in every task.
PROTECTED_RULES = (
    "Never work directly on main/master.",
    "Verify the current branch is not `main` or `master`.",
    "- Verify HEAD is not detached.",
    "If on `main` or `master`, or HEAD is detached, do not commit and do not push.",
    "Do not push main/master.",
)

# Run, Rebuild Context, a retry, a new attempt: none of them is a reason for a branch.
LIFECYCLE_RULE = (
    "- Preparing this work item again — Run, Rebuild Context, a retry, a new attempt — "
    "does not call for a new branch."
)


def task(policy: str | None = None, key: str = "JR-1", title: str = "Stale search results", **kwargs) -> str:
    if policy is not None:
        kwargs["branch_policy"] = policy
    return generate_task(key, title, **kwargs)


# --- the policies -------------------------------------------------------------


def test_the_default_is_the_current_branch():
    assert DEFAULT_BRANCH_POLICY == "current"
    assert BRANCH_POLICIES == ("current", "per-issue", "ask")
    assert PROTECTED_BRANCHES == ("main", "master")
    assert task() == task("current")


def test_current_works_on_the_checked_out_branch_and_makes_none_unasked():
    text = task("current")
    for line in (
        "- Branch policy: use the current branch.",
        "- Work on the branch that is currently checked out. Do not create or switch branches.",
        "- Edit only on the current branch.",
        "- Never work directly on main/master.",
        LIFECYCLE_RULE,
    ):
        assert line in text, line
    # A branch only from main/master or a detached HEAD, and only with consent.
    assert (
        "- If the current branch is `main` or `master`, or HEAD is detached, stop before editing "
        f'and ask the developer: "You are on a protected branch / detached HEAD. Create `{FEATURE}` '
        'and continue?" Create and switch to it only if they explicitly agree.'
    ) in text
    assert (
        "- Edit only on the current branch, never on main/master. Do not create or switch branches "
        "unless the developer explicitly approves it from main/master or a detached HEAD."
    ) in text
    # None of the per-issue rules that moved a developer off their branch.
    for rule in (
        "Create or switch to `",
        "Verify the current branch starts with `feature/`",
        "Verify the current branch includes `JR-1`.",
        "is not in the current branch name",
        "Edit only on the work item's branch",
    ):
        assert rule not in text, rule


def test_per_issue_names_one_branch_and_reuses_it():
    text = task("per-issue")
    for line in (
        "- Branch policy: one branch per work item.",
        f"- Branch name: `{FEATURE}`",
        f"- Create or switch to `{FEATURE}` before editing files — from a detached HEAD too. "
        "If it already exists, or another existing branch whose name contains `JR-1`, switch to it "
        "rather than creating another.",
        f"{LIFECYCLE_RULE} Reuse this one.",
        f"- Edit only on the work item's branch, `{FEATURE}`; never on main/master.",
        f"- Verify the current branch is the work item's branch: `{FEATURE}`, or another existing "
        "branch whose name contains `JR-1`.",
        f"If the current branch is not `{FEATURE}`, or another existing branch whose name contains "
        "`JR-1`, stop and ask the developer before committing.",
    ):
        assert line in text, line


def test_ask_has_the_developer_choose_before_editing():
    text = task("ask")
    for line in (
        "- Branch policy: ask the developer.",
        f"- Suggested branch name: `{FEATURE}`",
        "- Before editing, tell the developer the current branch and the suggested branch "
        f"`{FEATURE}`, and ask whether to stay on the current branch or to create or switch to "
        "the suggested one; then do as they answer.",
        # Staying is not an option on main/master or a detached HEAD.
        "- If the current branch is `main` or `master`, or HEAD is detached, staying is not an "
        f"option: ask only whether to create or switch to `{FEATURE}`.",
        LIFECYCLE_RULE,
        "- Edit only on the branch the developer chose; never on main/master.",
        "- Verify the current branch is the one the developer chose before editing. If they chose "
        "to stay on their branch, it does not have to start with `feature/` or include `JR-1`.",
    ):
        assert line in text, line
    assert "Create or switch to `" not in text
    assert "is not in the current branch name" not in text


@pytest.mark.parametrize("policy", BRANCH_POLICIES)
def test_main_and_master_stay_protected_under_every_policy(policy):
    text = task(policy)
    for rule in PROTECTED_RULES:
        assert rule in text, f"{policy} lost: {rule}"
    assert "detached" in text.split("## Branch Instructions")[1].split("##")[0], policy
    # Exactly one Branch Instructions section, whatever the policy.
    assert text.count("## Branch Instructions") == 1


@pytest.mark.parametrize("policy", BRANCH_POLICIES)
def test_every_policy_says_preparing_again_is_no_reason_for_a_branch(policy):
    assert LIFECYCLE_RULE in task(policy)


def test_delivery_checks_follow_the_policy():
    current = delivery_safety_block("JR-1", FEATURE, branch_policy="current")
    assert "- Commit on the current branch. It does not have to start with `feature/` or include `JR-1`." in current
    assert "Verify the current branch includes" not in current
    assert "starts with `feature/`" not in current

    per_issue = delivery_safety_block("JR-1", FEATURE, branch_policy="per-issue")
    assert f"- Verify the current branch is the work item's branch: `{FEATURE}`" in per_issue
    # A work item from before any branch was recorded: the old checks still say whose branch it is.
    unnamed = delivery_safety_block("JR-1", None, branch_policy="per-issue")
    assert "- Verify the current branch starts with `feature/` or another accepted feature prefix." in unnamed
    assert "- Verify the current branch includes `JR-1`." in unnamed

    ask = delivery_safety_block("JR-1", FEATURE, branch_policy="ask")
    assert "- Verify the current branch is the one the developer chose before editing." in ask

    for block in (current, per_issue, unnamed, ask):
        assert "- Verify the current branch is not `main` or `master`.\n- Verify HEAD is not detached.\n" in block


def test_a_policy_is_one_of_three_and_resolves_request_then_record_then_default():
    assert check_branch_policy(None) is None
    assert check_branch_policy(" Per-Issue ") == "per-issue"
    with pytest.raises(ValueError, match="Unknown branch policy 'sideways'"):
        check_branch_policy("sideways")
    assert resolve_branch_policy("ask", "per-issue") == "ask"
    assert resolve_branch_policy(None, "per-issue") == "per-issue"
    assert resolve_branch_policy(None, None) == "current"
    # A record edited into nonsense falls back to the default, never fails a run.
    assert resolve_branch_policy(None, "sideways") == "current"


# --- branch names ------------------------------------------------------------------


def test_a_jira_work_item_branch_is_its_key_and_summary():
    assert branch_name("JR-12345", "Export crash") == "feature/JR-12345-export-crash"


def test_a_hand_written_bug_branch_comes_from_its_title_not_its_minted_id():
    # Every run of a hand-written bug mints a new id; the branch must not follow it.
    first = branch_name("local_20261007101500", "Export crashes on empty selection")
    second = branch_name("local_20261007113000", "Export crashes on empty selection")
    assert first == second == "feature/export-crashes-on-empty-selection"
    # A title with nothing to slug still names one stable branch.
    chinese = branch_name("local_20261007101500", "导出时崩溃")
    assert chinese == branch_name("local_20261007113000", "导出时崩溃")
    assert chinese.startswith("feature/bug-") and len(chinese) == len("feature/bug-") + 8
    assert "local_" not in first + chinese


def test_a_recorded_branch_name_is_quoted_only_when_it_is_a_plain_ref():
    assert usable_branch_name(" feature/JR-1-x ") == "feature/JR-1-x"
    assert usable_branch_name("bugfix/existing") == "bugfix/existing"
    for bad in ("", "feature/`rm -rf`", "a\nb", "../x", "feature/a..b", 42, None):
        assert usable_branch_name(bad) is None, bad


# --- recorded per work item -----------------------------------------------------


def test_issue_json_records_the_policy_and_branch_and_reads_them_back():
    issue = jira_stub("JR-1", IssueGuidance(branch_policy="ask", branch_name=FEATURE))
    data = issue_to_dict(issue)
    assert data["guidance"]["branch_policy"] == "ask"
    assert data["guidance"]["branch_name"] == FEATURE
    read = issue_from_dict(data, "JR-1").guidance
    assert (read.branch_policy, read.branch_name) == ("ask", FEATURE)
    # A work item from before records neither, and reads as the default.
    plain = issue_to_dict(jira_stub("JR-1", IssueGuidance()))
    assert "branch_policy" not in plain["guidance"]
    assert "branch_name" not in plain["guidance"]
    assert issue_from_dict(plain, "JR-1").guidance.branch_policy is None
    assert resolve_branch_policy(None, issue_from_dict(plain, "JR-1").guidance.branch_policy) == "current"


def _task_text(tmp_path, key: str = "JR-12345") -> str:
    return (tmp_path / ".ai" / key / "task.md").read_text(encoding="utf-8")


def _guidance(tmp_path, key: str = "JR-12345") -> dict:
    return json.loads((tmp_path / ".ai" / key / "issue.json").read_text(encoding="utf-8"))["guidance"]


def _recorded(tmp_path, key: str = "JR-12345") -> str | None:
    return _guidance(tmp_path, key).get("branch_policy")


def _edit_guidance(tmp_path, key: str = "JR-12345", **fields) -> None:
    path = tmp_path / ".ai" / key / "issue.json"
    data = json.loads(path.read_text(encoding="utf-8"))
    data["guidance"].update(fields)
    path.write_text(json.dumps(data), encoding="utf-8")


def test_a_run_records_its_policy_and_resume_regenerate_and_retry_keep_it(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)

    assert main(["bug", "--prepare-only", "JR-12345", "--allow-mock", "--branch-policy", "per-issue"]) == 0
    assert _recorded(tmp_path) == "per-issue"
    assert "Branch policy: one branch per work item." in _task_text(tmp_path)

    # --resume without the flag keeps the recorded policy.
    assert main(["bug", "--prepare-only", "JR-12345", "--allow-mock", "--resume"]) == 0
    assert _recorded(tmp_path) == "per-issue"
    assert "Branch policy: one branch per work item." in _task_text(tmp_path)

    # Regenerating task.md alone keeps it.
    workflow.copilot_task_step(tmp_path, "JR-12345")
    assert "Branch policy: one branch per work item." in _task_text(tmp_path)

    # So does a retry prompt for the same work item.
    retry = workflow._build_retry_prompt(tmp_path, "JR-12345")
    assert "- Branch policy: one branch per work item, as in the first attempt." in retry
    assert "A retry does not call for a new branch." in retry

    # An explicit choice on a later run replaces it, the default included.
    assert main(["bug", "--prepare-only", "JR-12345", "--allow-mock", "--resume", "--branch-policy", "current"]) == 0
    assert _recorded(tmp_path) == "current"
    assert "Branch policy: use the current branch." in _task_text(tmp_path)
    retry = workflow._build_retry_prompt(tmp_path, "JR-12345")
    assert "- Branch policy: use the current branch, as in the first attempt." in retry
    assert "Verify the current branch includes `JR-12345`." not in retry
    assert "Verify the current branch is the work item's branch" not in retry


def test_per_issue_records_the_branch_and_every_later_preparation_names_it(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    assert main(["bug", "--prepare-only", "JR-12345", "--allow-mock", "--branch-policy", "per-issue"]) == 0
    first = _guidance(tmp_path)["branch_name"]
    assert first.startswith("feature/JR-12345-")
    assert f"- Branch name: `{first}`" in _task_text(tmp_path)

    # The record wins over the summary: a Jira summary reworded since — here the
    # record stands in for the old wording — must not name a second branch.
    _edit_guidance(tmp_path, branch_name="feature/JR-12345-the-old-wording")
    assert main(["bug", "--prepare-only", "JR-12345", "--allow-mock", "--resume"]) == 0
    assert "- Branch name: `feature/JR-12345-the-old-wording`" in _task_text(tmp_path)
    workflow.copilot_task_step(tmp_path, "JR-12345")
    assert "- Branch name: `feature/JR-12345-the-old-wording`" in _task_text(tmp_path)
    retry = workflow._build_retry_prompt(tmp_path, "JR-12345")
    assert "Continue on the work item's branch, `feature/JR-12345-the-old-wording`." in retry
    assert "- Verify the current branch is the work item's branch: `feature/JR-12345-the-old-wording`" in retry


def test_the_current_policy_records_no_branch(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    assert main(["bug", "--prepare-only", "JR-12345", "--allow-mock"]) == 0
    assert "branch_name" not in _guidance(tmp_path)


def test_a_run_on_the_default_records_it(tmp_path, monkeypatch, execution_trace):
    monkeypatch.chdir(tmp_path)
    assert main(["bug", "--prepare-only", "JR-12345", "--allow-mock"]) == 0
    assert _recorded(tmp_path) == "current"
    assert "Branch policy: use the current branch." in _task_text(tmp_path)
    assert "[INFO] branch policy: current" in execution_trace.text


def test_an_invalid_recorded_policy_reads_as_the_default(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    assert main(["bug", "--prepare-only", "JR-12345", "--allow-mock", "--branch-policy", "ask"]) == 0
    _edit_guidance(tmp_path, branch_policy="sideways")
    workflow.copilot_task_step(tmp_path, "JR-12345")
    assert "Branch policy: use the current branch." in _task_text(tmp_path)
    assert "- Branch policy: use the current branch, as in the first attempt." in workflow._build_retry_prompt(
        tmp_path, "JR-12345"
    )
    # And a run resumed from it records the default in its place.
    assert main(["bug", "--prepare-only", "JR-12345", "--allow-mock", "--resume"]) == 0
    assert _recorded(tmp_path) == "current"


def _prepare_description(capsys, description: str, policy: str) -> str:
    assert main(["bug", "--prepare-only", "--description", description, "--branch-policy", policy, "--json"]) == 0
    return json.loads(capsys.readouterr().out)["work_item_id"]


def test_a_hand_written_bug_takes_the_policy_too(tmp_path, monkeypatch, capsys):
    monkeypatch.chdir(tmp_path)
    work_item = _prepare_description(capsys, "Export crashes on empty selection", "ask")
    assert work_item.startswith("local_")
    assert _recorded(tmp_path, work_item) == "ask"
    assert "Branch policy: ask the developer." in _task_text(tmp_path, work_item)


@pytest.mark.parametrize("policy", BRANCH_POLICIES)
def test_preparing_the_same_hand_written_bug_again_names_the_same_branch(tmp_path, monkeypatch, capsys, policy):
    # Each Run of a hand-written bug is a new local_<timestamp> work item. The
    # branch the task names must not change with it.
    monkeypatch.chdir(tmp_path)
    description = "Export crashes on empty selection\n\nSteps: select nothing, press Export."
    first = _prepare_description(capsys, description, policy)
    # Ids have one-second granularity; a clash is resolved with a suffix.
    second = _prepare_description(capsys, description, policy)
    assert first != second
    branch = "feature/export-crashes-on-empty-selection"
    for item in (first, second):
        text = _task_text(tmp_path, item)
        assert f"`{branch}`" in text
        assert "local_" not in text.split("## Branch Instructions")[1].split("##")[0]


def test_the_cli_offers_exactly_the_three_policies():
    parser = build_parser()
    assert parser.parse_args(["bug", "JR-1", "--branch-policy", "ask"]).branch_policy == "ask"
    assert parser.parse_args(["bug", "JR-1"]).branch_policy is None
    with pytest.raises(SystemExit):
        parser.parse_args(["bug", "JR-1", "--branch-policy", "sideways"])


# --- the MCP prepare tools --------------------------------------------------------


def test_the_mcp_prepare_tools_take_a_policy_and_refuse_anything_else(tmp_path):
    import asyncio

    from mcp.server.mcpserver.exceptions import ToolError

    from bugpilot.mcp_server import build_server

    server = build_server(tmp_path)
    tools = {tool.name: tool for tool in asyncio.run(server.list_tools())}
    for name in ("prepare_jira_bug", "prepare_bug_description"):
        assert "branch_policy" in tools[name].input_schema["properties"], name

    result = asyncio.run(
        server.call_tool("prepare_bug_description", {"description": "Export crashes", "branch_policy": "per-issue"})
    )
    work_item = result.structured_content["work_item_id"]
    assert _recorded(tmp_path, work_item) == "per-issue"
    assert "Branch policy: one branch per work item." in _task_text(tmp_path, work_item)

    with pytest.raises(ToolError, match="Unknown branch policy"):
        asyncio.run(server.call_tool("prepare_bug_description", {"description": "x", "branch_policy": "sideways"}))
