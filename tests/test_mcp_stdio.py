"""The MCP server over a real pipe, not in-process.

`test_mcp_server.py` calls `build_server()` directly: it proves the tools
behave, and nothing about the transport they arrive over. That gap mattered —
the phase 0A assumption this whole entry point rests on has never been checked
against a real client, and "the server does not even start" would look exactly
like "the model ignored the tool" to anyone testing it.

So this launches the server the way a client does and runs the opening
exchange. It is the MCP counterpart of the extension's `npm run smoke`.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time
from pathlib import Path

import pytest

REPO = Path(__file__).resolve().parents[1]
EXPECTED_TOOLS = {
    "list_fix_modes",
    "show_fix_mode",
    "prepare_jira_bug",
    "prepare_bug_description",
    "refine_investigation",
    "check_results",
    "summarize_results",
    "search_memory",
    "get_status",
}

pytest.importorskip("mcp", reason="the MCP SDK is an optional extra")


class Client:
    """The few JSON-RPC frames this test needs, over stdio."""

    def __init__(self, cwd: Path) -> None:
        self.process = subprocess.Popen(
            [sys.executable, "-m", "bugpilot.mcp_server"],
            cwd=cwd,
            env={**os.environ, "PYTHONPATH": str(REPO), "PYTHONIOENCODING": "utf-8"},
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            bufsize=1,
        )

    def send(self, payload: dict) -> None:
        assert self.process.stdin is not None
        self.process.stdin.write(json.dumps(payload) + "\n")
        self.process.stdin.flush()

    def read(self, timeout: float = 30.0) -> dict:
        assert self.process.stdout is not None
        deadline = time.time() + timeout
        while time.time() < deadline:
            line = self.process.stdout.readline()
            if not line:
                break
            line = line.strip()
            if not line:
                continue
            # stdout is the wire for a stdio server: anything that is not a
            # frame is a contract violation, and the reason core had to stop
            # printing (design 6).
            return json.loads(line)
        raise AssertionError("the server sent nothing back in time")

    def call(self, method: str, params: dict, request_id: int) -> dict:
        self.send({"jsonrpc": "2.0", "id": request_id, "method": method, "params": params})
        return self.read()

    def close(self) -> str:
        assert self.process.stdin is not None
        self.process.stdin.close()
        try:
            self.process.wait(timeout=10)
        except subprocess.TimeoutExpired:  # pragma: no cover - a hung server
            self.process.kill()
        assert self.process.stderr is not None
        return self.process.stderr.read()


@pytest.fixture
def client(tmp_path):
    session = Client(tmp_path)
    session.call(
        "initialize",
        {
            "protocolVersion": "2024-11-05",
            "capabilities": {},
            "clientInfo": {"name": "test", "version": "0"},
        },
        1,
    )
    session.send({"jsonrpc": "2.0", "method": "notifications/initialized", "params": {}})
    yield session
    session.close()


def test_the_server_starts_and_introduces_itself(tmp_path):
    """Name, version, and the instructions a model reads before deciding."""
    session = Client(tmp_path)
    try:
        hello = session.call(
            "initialize",
            {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "t", "version": "0"}},
            1,
        )
        result = hello["result"]
        assert result["serverInfo"]["name"] == "bugpilot"
        # The instructions are the whole phase 0A bet: they are what tells a
        # model to reach for this before searching the repository itself.
        assert "before" in (result.get("instructions") or "").lower()
    finally:
        session.close()


def test_exactly_the_planned_tools_arrive_over_the_wire(client):
    listing = client.call("tools/list", {}, 2)
    assert {tool["name"] for tool in listing["result"]["tools"]} == EXPECTED_TOOLS


def test_the_deterministic_prompt_is_offered(client):
    prompts = client.call("prompts/list", {}, 3)
    assert [prompt["name"] for prompt in prompts["result"]["prompts"]] == ["fix_bug"]


def test_a_failing_tool_reaches_the_model_as_a_readable_message(client):
    """Not a dead pipe, and not a bare "Error executing tool get_status".

    Phase 3 found that a locally defined ToolError produced exactly that: the
    SDK wrapped it and the model saw nothing it could act on.
    """
    answer = client.call(
        "tools/call", {"name": "get_status", "arguments": {"work_item_id": "JR-99999"}}, 4
    )
    result = answer["result"]
    assert result["isError"] is True
    text = result["content"][0]["text"]
    assert "JR-99999" in text
    assert "prepare_jira_bug" in text, "the message must name the way forward"


def test_a_tool_call_writes_into_the_directory_the_server_was_launched_in(client, tmp_path):
    """The bound repository root, over the wire rather than in-process.

    Getting this wrong scatters artifacts into another checkout, which is why
    the root is fixed at startup instead of being a tool argument.
    """
    answer = client.call(
        "tools/call",
        {"name": "prepare_bug_description", "arguments": {"description": "crash on save"}},
        5,
    )
    assert answer["result"]["isError"] is not True, answer["result"]
    written = list((tmp_path / ".ai").iterdir())
    assert len(written) == 1
    assert (written[0] / "agent_task.md").exists()
