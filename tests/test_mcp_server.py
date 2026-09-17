"""Tests for the MCP entry point: tool surface, gates, and the repo binding."""

from __future__ import annotations

import asyncio
import json

import pytest

from mcp.server.mcpserver.exceptions import ToolError, UnexpectedToolError

from bugpilot.core import jira
from bugpilot.mcp_server import REPO_ROOT_ENV, build_server, resolve_repo_root

EXPECTED_TOOLS = {
    "prepare_jira_bug",
    "prepare_bug_description",
    "refine_investigation",
    "check_results",
    "summarize_results",
    "search_memory",
    "get_status",
}

# Outward, destructive, or human-only operations that must not be model-callable.
FORBIDDEN_TOOLS = {
    "jira_comment",
    "post_jira_comment",
    "notify",
    "send_email",
    "commit",
    "push",
    "clean",
    "setup",
    "retry",
    "prepare_retry",
}


def _call(server, name: str, arguments: dict) -> dict:
    result = asyncio.run(server.call_tool(name, arguments))
    assert result.is_error is not True, result.content
    assert result.structured_content is not None
    return result.structured_content


def _expect_tool_error(server, name: str, arguments: dict) -> str:
    """Anticipated failures raise the SDK ToolError and carry a readable message."""
    with pytest.raises(ToolError) as excinfo:
        asyncio.run(server.call_tool(name, arguments))
    assert not isinstance(excinfo.value, UnexpectedToolError), (
        "the tool crashed instead of reporting an anticipated failure, "
        "so the model only sees 'Error executing tool'"
    )
    return str(excinfo.value)


def _tools(server) -> dict:
    return {tool.name: tool for tool in asyncio.run(server.list_tools())}


# --- tool surface -----------------------------------------------------------


def test_exactly_the_seven_planned_tools(tmp_path):
    """Every schema rides in the model's context each turn, so the set is fixed."""
    assert set(_tools(build_server(tmp_path))) == EXPECTED_TOOLS


def test_no_outward_or_destructive_tool_is_exposed(tmp_path):
    """R5: those actions stay human-triggered."""
    names = set(_tools(build_server(tmp_path)))
    assert not names & FORBIDDEN_TOOLS


def test_no_tool_takes_a_repo_root(tmp_path):
    """The root is bound at startup; a model-supplied path could target another checkout."""
    for name, tool in _tools(build_server(tmp_path)).items():
        properties = tool.input_schema.get("properties", {})
        assert "repo_root" not in properties, name
        assert "repo_path" not in properties, name


def test_prepare_tools_describe_when_to_use_each(tmp_path):
    """Two near-siblings: the descriptions have to be mutually exclusive."""
    tools = _tools(build_server(tmp_path))
    jira = tools["prepare_jira_bug"].description
    manual = tools["prepare_bug_description"].description

    assert "JR-12345" in jira
    assert "prepare_bug_description" in jira  # points at the sibling
    assert "no issue key" in manual
    assert "prepare_jira_bug" in manual


def test_the_deterministic_prompt_is_registered(tmp_path):
    prompts = asyncio.run(build_server(tmp_path).list_prompts())
    assert [prompt.name for prompt in prompts] == ["fix_bug"]


# --- repo binding -----------------------------------------------------------


def test_repo_root_precedence(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    monkeypatch.delenv(REPO_ROOT_ENV, raising=False)
    assert resolve_repo_root() == tmp_path.resolve()

    other = tmp_path / "elsewhere"
    other.mkdir()
    monkeypatch.setenv(REPO_ROOT_ENV, str(other))
    assert resolve_repo_root() == other.resolve()
    assert resolve_repo_root(str(tmp_path)) == tmp_path.resolve()


def test_artifacts_land_in_the_bound_repo_only(tmp_path, monkeypatch):
    """Two servers on two roots must not write into each other."""
    first, second = tmp_path / "a", tmp_path / "b"
    first.mkdir()
    second.mkdir()
    monkeypatch.chdir(second)  # cwd deliberately differs from the bound root

    payload = _call(build_server(first), "prepare_bug_description", {"description": "crash"})
    assert (first / ".ai" / payload["work_item_id"]).is_dir()
    assert not (second / ".ai").exists()


# --- prepare / refine -------------------------------------------------------


def test_prepare_bug_description_returns_paths_not_the_whole_package(tmp_path):
    server = build_server(tmp_path)
    payload = _call(server, "prepare_bug_description", {"description": "OpenVdsStatistics crashes"})

    assert payload["source"] == "manual"
    assert payload["title"] == "OpenVdsStatistics crashes"
    assert payload["agent_task"].endswith("agent_task.md")
    assert "Stop before committing" in payload["next_step"]
    assert payload["context_excerpt"]


def test_prepare_bug_description_rejects_an_empty_description(tmp_path):
    message = _expect_tool_error(
        build_server(tmp_path), "prepare_bug_description", {"description": "  "}
    )
    assert "needs a description" in message


def test_prepare_keeps_a_non_ascii_title(tmp_path):
    payload = _call(
        build_server(tmp_path), "prepare_bug_description", {"description": "三维视图切换层位后崩溃"}
    )
    assert payload["title"] == "三维视图切换层位后崩溃"


def test_refine_reuses_the_prepared_work_item(tmp_path):
    server = build_server(tmp_path)
    prepared = _call(server, "prepare_bug_description", {"description": "something goes wrong"})
    work_item = prepared["work_item_id"]

    refined = _call(
        server,
        "refine_investigation",
        {"work_item_id": work_item, "keywords": ["OpenVdsStatistics"], "hint": "look in the writer"},
    )
    assert refined["work_item_id"] == work_item

    extracted = json.loads(
        (tmp_path / ".ai" / work_item / "extracted_keywords.json").read_text(encoding="utf-8")
    )
    assert extracted["high_value_keywords"][0] == "OpenVdsStatistics"
    hint = (tmp_path / ".ai" / work_item / "developer_hint.md").read_text(encoding="utf-8")
    assert hint.strip() == "look in the writer"


def test_refine_never_refetches_jira(tmp_path, monkeypatch):
    """Refinement must work offline: the issue data is already on disk."""
    server = build_server(tmp_path)
    prepared = _call(server, "prepare_bug_description", {"description": "crash"})

    def explode(*args, **kwargs):
        raise AssertionError("refine must not contact Jira")

    monkeypatch.setattr("bugpilot.core.workflow.fetch_issue", explode)
    _call(server, "refine_investigation", {"work_item_id": prepared["work_item_id"]})


# --- read-only tools --------------------------------------------------------


def test_check_results_reports_what_is_missing(tmp_path):
    server = build_server(tmp_path)
    prepared = _call(server, "prepare_bug_description", {"description": "crash"})

    payload = _call(server, "check_results", {"work_item_id": prepared["work_item_id"]})
    assert payload["complete"] is False
    assert payload["missing"]


def test_get_status_reports_the_steps(tmp_path):
    server = build_server(tmp_path)
    prepared = _call(server, "prepare_bug_description", {"description": "crash"})

    payload = _call(server, "get_status", {"work_item_id": prepared["work_item_id"]})
    assert payload["source"] == "manual"
    assert payload["steps"]["parse"] == "pass"


def test_get_status_on_an_unknown_work_item_says_how_to_fix_it(tmp_path):
    message = _expect_tool_error(build_server(tmp_path), "get_status", {"work_item_id": "JR-99999"})
    assert "prepare_jira_bug" in message


def test_search_memory_finds_a_prior_investigation(tmp_path):
    server = build_server(tmp_path)
    _call(server, "prepare_bug_description", {"description": "OpenVdsStatistics fails to initialize"})

    payload = _call(server, "search_memory", {"query": "OpenVdsStatistics"})
    assert payload["query"] == "OpenVdsStatistics"
    assert payload["report"]


def test_search_memory_does_not_treat_a_search_term_as_a_work_item(tmp_path):
    """The phase 1 regression, reachable through this entry point too."""
    _call(build_server(tmp_path), "search_memory", {"query": "utf-8"})
    assert not (tmp_path / ".ai" / "utf-8").exists()


# --- summarize does not reach outward ---------------------------------------


def test_summarize_results_never_posts_to_jira(tmp_path, monkeypatch):
    """R5 through the new entry point: a new output path must not bypass the gate."""
    server = build_server(tmp_path)
    prepared = _call(server, "prepare_bug_description", {"description": "crash"})

    def explode(*args, **kwargs):
        raise AssertionError("the MCP path must not post to Jira")

    monkeypatch.setattr("bugpilot.core.workflow.post_jira_comment", explode)
    payload = _call(server, "summarize_results", {"work_item_id": prepared["work_item_id"]})
    assert payload["result_summary"].endswith("result_summary.md")


def test_summarize_takes_no_jira_comment_argument(tmp_path):
    properties = _tools(build_server(tmp_path))["summarize_results"].input_schema["properties"]
    assert set(properties) == {"work_item_id"}


# --- the deterministic prompt ----------------------------------------------


@pytest.mark.parametrize(
    "work_item, expected_tool",
    [
        ("JR-12345", "prepare_jira_bug"),
        ("3D view crashes after changing horizon", "prepare_bug_description"),
    ],
)
def test_fix_bug_prompt_routes_by_input_shape(tmp_path, work_item, expected_tool):
    result = asyncio.run(build_server(tmp_path).get_prompt("fix_bug", {"work_item": work_item}))
    text = " ".join(
        message.content.text for message in result.messages if hasattr(message.content, "text")
    )
    assert expected_tool in text
    assert "Stop before committing" in text


# --- review follow-ups ------------------------------------------------------


@pytest.mark.parametrize(
    "tool, extra",
    [
        ("refine_investigation", {}),
        ("check_results", {}),
        ("summarize_results", {}),
        ("get_status", {}),
    ],
)
@pytest.mark.parametrize("evil", ["../../outside/evil-1", "..", "../sibling-1", ".ai"])
def test_no_tool_accepts_an_id_that_escapes_the_repo(tmp_path, tool, extra, evil):
    """The repo binding is worthless if a model-supplied id can leave it."""
    repo = tmp_path / "repo"
    repo.mkdir()
    (tmp_path / "outside").mkdir()

    _expect_tool_error(build_server(repo), tool, {"work_item_id": evil, **extra})
    assert not any((tmp_path / "outside").iterdir())


def test_prepare_jira_bug_rejects_an_escaping_key(tmp_path):
    _expect_tool_error(build_server(tmp_path), "prepare_jira_bug", {"issue_key": "../evil-1"})


def test_re_preparing_the_same_work_item_never_deletes_agent_results(tmp_path, monkeypatch):
    """A fresh run would clean the directory; deleting artifacts is not model-callable.

    Uses the Jira path deliberately: only there does a second call address the
    *same* work item. prepare_bug_description mints a new local id each time, so
    testing it here would pass without exercising the guarantee at all.

    The fetch is forced onto the mock fallback because the MCP path passes
    ``allow_mock=False`` — a model must not be handed invented issue data. So
    the only way this test ever got a successful fetch was a live Jira, and it
    was getting one: it passed on this machine, against a real tenant and a
    real ticket, and would have failed anywhere else.
    """
    monkeypatch.setattr(
        "bugpilot.core.workflow.fetch_issue",
        lambda repo_root, issue_key, allow_mock=True: jira.fetch_issue(repo_root, issue_key, allow_mock=True),
    )
    server = build_server(tmp_path)
    _call(server, "prepare_jira_bug", {"issue_key": "JR-12345"})

    written_by_agent = tmp_path / ".ai" / "JR-12345" / "fix_summary.md"
    written_by_agent.write_text("what the agent changed", encoding="utf-8")

    _call(server, "prepare_jira_bug", {"issue_key": "JR-12345"})
    assert written_by_agent.read_text(encoding="utf-8") == "what the agent changed"


def test_preparing_a_description_twice_makes_two_work_items(tmp_path):
    """Documents the non-idempotence the tool description now warns about."""
    server = build_server(tmp_path)
    first = _call(server, "prepare_bug_description", {"description": "crash on save"})
    second = _call(server, "prepare_bug_description", {"description": "crash on save"})

    assert first["work_item_id"] != second["work_item_id"]
    assert len(list((tmp_path / ".ai").iterdir())) == 2


def test_prepare_bug_description_points_at_refine_for_rework(tmp_path):
    """Otherwise a model retrying after a transient error silently duplicates."""
    description = _tools(build_server(tmp_path))["prepare_bug_description"].description
    assert "not idempotent" in description
    assert "refine_investigation" in description


def test_search_memory_is_read_only(tmp_path):
    """An id-shaped query used to mkdir a phantom work item."""
    _call(build_server(tmp_path), "search_memory", {"query": "JR-77777"})
    assert not (tmp_path / ".ai").exists()


def test_artifact_excerpts_are_not_mangled_by_the_jira_redactor(tmp_path):
    """The redactor is built for outbound comments and destroys code signatures."""
    server = build_server(tmp_path)
    (tmp_path / "src").mkdir()
    (tmp_path / "src" / "Loader.cpp").write_text(
        "void load(const char* key, const char* secret_path) {}\n", encoding="utf-8"
    )
    prepared = _call(
        server, "prepare_bug_description", {"description": "load fails for secret_path"}
    )

    excerpt = prepared["context_excerpt"]
    assert "<redacted>" not in excerpt


@pytest.mark.parametrize(
    "tool", ["refine_investigation", "check_results", "summarize_results", "get_status"]
)
def test_tools_refuse_an_unprepared_work_item(tmp_path, tool):
    """Steps create their own directory, so an unchecked id conjures a phantom item."""
    message = _expect_tool_error(build_server(tmp_path), tool, {"work_item_id": "JR-99999"})
    assert "prepare" in message.lower()
    assert not (tmp_path / ".ai" / "JR-99999").exists()


def test_tool_errors_carry_a_stable_code(tmp_path, monkeypatch):
    """errors.error_code_for exists so a Jira failure reads differently from a crash."""
    server = build_server(tmp_path)
    prepared = _call(server, "prepare_bug_description", {"description": "crash"})

    def boom(*args, **kwargs):
        raise FileNotFoundError("result_summary inputs are gone")

    monkeypatch.setattr("bugpilot.core.workflow.summarize_results_step", boom)
    message = _expect_tool_error(
        server, "summarize_results", {"work_item_id": prepared["work_item_id"]}
    )
    assert "ARTIFACT_NOT_FOUND" in message


@pytest.mark.parametrize(
    "work_item, expected_tool",
    [
        ("JR-12345", "prepare_jira_bug"),
        ("local_20260901094133", "prepare_jira_bug"),
        # These used to route to the Jira tool and dead-end on validation.
        ("crash in openvds-2", "prepare_bug_description"),
        ("regression since v1.2-3", "prepare_bug_description"),
        ("jr-12345", "prepare_bug_description"),
    ],
)
def test_fix_bug_prompt_uses_the_shared_identity_predicate(tmp_path, work_item, expected_tool):
    result = asyncio.run(build_server(tmp_path).get_prompt("fix_bug", {"work_item": work_item}))
    text = " ".join(
        message.content.text for message in result.messages if hasattr(message.content, "text")
    )
    assert expected_tool in text


def test_refine_dispatches_every_resolved_step(tmp_path):
    """A step in `resolved` with no handler used to be skipped silently."""
    from bugpilot.core.models import InvestigationPlan
    from bugpilot.core.workflow import refine_investigation

    server = build_server(tmp_path)
    prepared = _call(server, "prepare_bug_description", {"description": "crash"})
    work_item = prepared["work_item_id"]

    memory_file = tmp_path / ".ai_memory" / "bugs" / f"{work_item}.md"
    before = memory_file.read_text(encoding="utf-8")
    refine_investigation(tmp_path, work_item, plan=InvestigationPlan(issue_details=False))
    assert memory_file.read_text(encoding="utf-8") != before  # memory_add ran
