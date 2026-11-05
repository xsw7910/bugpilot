"""One storage request scope per MCP tool call (0.1.6 Batch 2B-2; plan §14.3, the 2B-5 gate's items 1-3).

Every test goes through ``MCPServer.call_tool``, the SDK's own dispatch, which runs a synchronous tool in a worker
thread (``anyio.to_thread.run_sync``). The contract (plan §14.3, "Batch 2B-2 — final contract resolution"):

- every tool is wrapped, and opens its scope inside its own body, in that worker thread; the prompt builds text only;
- building the server opens none, and none outlives its call: the next call gets a new one;
- two overlapping calls have two scopes, in two threads;
- a change between two calls is seen by the second: nothing is cached across calls;
- a failure fails closed: a refusal and an unavailable store reach the client as one sentence with the code the
  prepare tools always carried (C-1, M-1), and no absolute path;
- the MCP server prints nothing about ``BUGPILOT_CONFIG_DIR``: the warning is the CLI's, in text mode.
"""

from __future__ import annotations

import asyncio
import os
import threading
from pathlib import Path

import pytest
from mcp.server.mcpserver.exceptions import ToolError

from bugpilot import mcp_server
from bugpilot.core import storage
from bugpilot.mcp_server import REQUEST_SCOPED, build_server

TOOLS = {
    "prepare_jira_bug", "prepare_bug_description", "refine_investigation", "check_results", "summarize_results",
    "search_memory", "get_status", "list_fix_modes", "show_fix_mode",
}


def _call(server, name: str, arguments: dict | None = None):
    return asyncio.run(server.call_tool(name, arguments or {}))


@pytest.fixture
def scopes(monkeypatch) -> list[tuple[threading.Thread, object]]:
    """Each `list_fix_modes` body's thread and active scope, seen from inside the call."""
    seen: list[tuple[threading.Thread, object]] = []
    real = mcp_server.catalog_for

    def recording(repo_root):
        seen.append((threading.current_thread(), storage._active_scope()))
        return real(repo_root)

    monkeypatch.setattr(mcp_server, "catalog_for", recording)
    return seen


def test_every_tool_runs_in_a_request_scope_and_the_prompt_is_text_only(tmp_path):
    server = build_server(tmp_path)
    tools = {tool.name: tool for tool in server._tool_manager.list_tools()}
    assert set(tools) == TOOLS
    assert [name for name, tool in tools.items() if not getattr(tool.fn, REQUEST_SCOPED, False)] == []
    prompts = {prompt.name: prompt for prompt in server._prompt_manager.list_prompts()}
    assert set(prompts) == {"fix_bug"} and not getattr(prompts["fix_bug"].fn, REQUEST_SCOPED, False)


def test_building_the_server_opens_no_scope(tmp_path):
    build_server(tmp_path)
    assert storage._active_scope() is None


def test_each_call_has_a_scope_of_its_own_in_its_worker_thread_and_none_outlives_it(tmp_path, scopes):
    server = build_server(tmp_path)
    _call(server, "list_fix_modes")
    _call(server, "list_fix_modes")
    assert len(scopes) == 2
    (first_thread, first), (second_thread, second) = scopes
    assert first is not None and second is not None and first is not second
    assert threading.main_thread() not in (first_thread, second_thread)
    assert storage._active_scope() is None


def test_overlapping_calls_have_separate_scopes_in_separate_threads(tmp_path, monkeypatch):
    barrier = threading.Barrier(2, timeout=30)
    seen: list[tuple[threading.Thread, object]] = []
    lock = threading.Lock()
    real = mcp_server.catalog_for

    def overlapping(repo_root):
        scope = storage._active_scope()
        barrier.wait()  # both bodies are running at once, or the barrier breaks and the call fails
        with lock:
            seen.append((threading.current_thread(), scope))
        return real(repo_root)

    monkeypatch.setattr(mcp_server, "catalog_for", overlapping)
    server = build_server(tmp_path)

    async def both():
        await asyncio.gather(server.call_tool("list_fix_modes", {}), server.call_tool("list_fix_modes", {}))

    asyncio.run(both())
    (first_thread, first), (second_thread, second) = seen
    assert first_thread is not second_thread
    assert first is not None and second is not None and first is not second


def test_a_change_between_two_calls_is_seen_by_the_second(tmp_path, scopes):
    """A `.git` folder created above the data folder after a call is judged by the next one: no verdict is kept."""
    server = build_server(tmp_path)
    _call(server, "list_fix_modes")
    (Path(os.environ["BUGPILOT_HOME"]).parent / ".git").mkdir()
    with pytest.raises(ToolError) as failed:
        _call(server, "list_fix_modes")
    assert str(tmp_path) not in str(failed.value) and os.environ["BUGPILOT_HOME"] not in str(failed.value)
    assert len(scopes) == 2 and scopes[0][1] is not scopes[1][1]
    assert storage._active_scope() is None


@pytest.fixture
def mock_jira(monkeypatch):
    """`prepare_jira_bug` against the demo data `--allow-mock` gives the CLI, as `test_mcp_server` does."""
    from bugpilot.core.jira import fetch_issue as real_fetch

    monkeypatch.setattr(
        "bugpilot.core.workflow.fetch_issue",
        lambda repo_root, issue_key, allow_mock=False: real_fetch(repo_root, issue_key, allow_mock=True),
    )


def test_a_refused_data_folder_reaches_the_client_as_one_sentence_with_its_code(tmp_path, mock_jira):
    (Path(os.environ["BUGPILOT_HOME"]).parent / ".git").mkdir()
    with pytest.raises(ToolError) as failed:
        _call(build_server(tmp_path), "prepare_jira_bug", {"issue_key": "JR-12345"})
    message = str(failed.value)
    assert "[INVALID_INPUT]: " in message
    assert str(tmp_path) not in message and os.environ["BUGPILOT_HOME"] not in message
    assert storage._active_scope() is None


def test_an_unavailable_configuration_reaches_the_client_as_one_sentence_with_the_generic_code(
    tmp_path, mock_jira, user_config_folder
):
    (user_config_folder / "config.toml").mkdir()  # a folder where the file should be: unreadable on every system
    with pytest.raises(ToolError) as failed:
        _call(build_server(tmp_path), "prepare_jira_bug", {"issue_key": "JR-12345"})
    message = str(failed.value)
    assert "[INTERNAL_ERROR]: BugPilot could not read BUGPILOT_HOME/config/config.toml (" in message
    assert str(tmp_path) not in message and os.environ["BUGPILOT_HOME"] not in message
    assert storage._active_scope() is None


def test_the_mcp_server_says_nothing_about_the_retired_variable(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("BUGPILOT_CONFIG_DIR", str(tmp_path / "retired"))
    _call(build_server(tmp_path), "list_fix_modes")
    captured = capsys.readouterr()
    assert "BUGPILOT_CONFIG_DIR" not in captured.out + captured.err
