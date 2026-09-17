# BugPilot as an MCP server

Lets an AI agent — Claude Code, Copilot Chat, any MCP client — drive the BugPilot
workflow by calling tools, instead of you running commands and handing over files.

Design: [adapter_design.md](adapter_design.md) §5.2.

## Install

The MCP SDK is an optional extra, so a plain CLI install stays dependency-free:

```powershell
python -m pip install -e ".[mcp]"
```

That adds a `bugpilot-mcp` console script alongside `bugpilot`.

## Configure a client

The server binds **one repository**, decided at startup — never passed in by the
model. Precedence: `BUGPILOT_MCP_REPO_ROOT`, then the working directory the
client launched the server in. Point the client at the repo you are fixing bugs
in, not at the BugPilot checkout.

### Claude Code

`.mcp.json` at the target repository root (note: `mcpServers`):

```json
{
  "mcpServers": {
**本仓库已自带一份 `.mcp.json`**（阶段 7 之后补的），用的是「从源码跑」的形态，
不需要先 `pip install -e ".[mcp]"`：

```json
{
  "mcpServers": {
    "bugpilot": {
      "command": "python",
      "args": ["-m", "bugpilot.mcp_server"],
      "env": { "PYTHONPATH": ".", "PYTHONIOENCODING": "utf-8" }
    }
  }
}
```

在**目标仓库**里用则推荐装好之后用 `bugpilot-mcp`（下面第一种），
因为那时 `PYTHONPATH: "."` 指向的就不是 bugpilot 的源码了。

    "bugpilot": { "command": "bugpilot-mcp", "args": [] }
  }
}
```

Or `claude mcp add bugpilot -- bugpilot-mcp` (add `-s project` to write
`.mcp.json` so the team shares it; the default is this machine only).

### VS Code / Copilot Chat

`.vscode/mcp.json` at the target repository root (note: `servers`, and each entry
needs a `type`):

```json
{
  "servers": {
    "bugpilot": { "type": "stdio", "command": "bugpilot-mcp", "args": [] }
  }
}
```

Then switch Copilot Chat to **agent mode** and enable the bugpilot tools.

### Developing on BugPilot itself

`bugpilot-mcp` on PATH resolves to whatever is installed, which may be a frozen
pipx copy rather than your working tree. To run the tree you are editing:

```json
{
  "mcpServers": {
    "bugpilot": {
      "command": "python",
      "args": ["-m", "bugpilot.mcp_server"],
      "env": { "BUGPILOT_MCP_REPO_ROOT": "C:\\path\\to\\target\\repo" }
    }
  }
}
```

## What the agent can do

| Tool | Purpose |
| --- | --- |
| `prepare_jira_bug` | Fetch a Jira issue and build focused code context |
| `prepare_bug_description` | Same, from a bug described in prose — no Jira needed |
| `refine_investigation` | Re-search around a new clue; never re-contacts Jira |
| `check_results` | Which result files a fix attempt has not written |
| `summarize_results` | Roll results into a reviewable summary |
| `search_memory` | Find similar past investigations |
| `get_status` | Which preparation steps ran |

Plus one prompt, `fix_bug`, surfaced in Claude Code as
`/mcp__bugpilot__fix_bug` — a deterministic path for when you would rather not
rely on the model choosing to call a tool.

## What the agent deliberately cannot do

Posting a Jira comment, sending mail, committing, pushing, `clean` and `setup`
are **not exposed**. The first four are outward or destructive actions that stay
human-triggered; the last two should not be model-driven. Run them yourself with
the CLI when you are ready.

There is also **no retry tool**. Retry is fed by your written account of what the
previous attempt got wrong, so making it callable would let the model decide it
had failed and start over on its own. Use `bugpilot bug <ID> --retry`.

## Optional: nudge the agent to reach for BugPilot

Add this to the target repository's `CLAUDE.md` (or the equivalent for your
client). It raises the odds the agent prepares context before searching:

```markdown
When investigating a bug or Jira issue, use the BugPilot MCP tools to gather
focused engineering context before performing broad repository searches.
```

**This is an enhancement, not a requirement.** Every tool works with no such
file present — BugPilot must not depend on configuration in the repository it is
pointed at (requirement R9).

## Troubleshooting

| Symptom | Cause |
| --- | --- |
| Client cannot start the server | `bugpilot-mcp` not on PATH — install with the `[mcp]` extra, or use the `python -m` form above |
| Artifacts land in the wrong repository | The client launched the server from a different directory; set `BUGPILOT_MCP_REPO_ROOT` |
| Connection drops immediately | Something wrote to stdout. stdout is the JSON-RPC channel; nothing in `bugpilot/core` prints, so suspect a local edit |
| Agent greps the codebase instead of calling a tool | Add the `CLAUDE.md` snippet above, or use the `fix_bug` prompt for a deterministic path |

To exercise the tools by hand:

```powershell
npx @modelcontextprotocol/inspector bugpilot-mcp
```
