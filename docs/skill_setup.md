# Claude Code skill: installation and comparison

`skills/bugpilot-investigate/SKILL.md` is a **trigger shim**: it tells the host agent
"when to run `bugpilot`, and which artifacts to read afterwards"; the actual execution uses the host's own Bash tool.
It is not a fourth entry point (§5.5); the CLI is that entry point.

## Installation

The skill goes into the **target repository** (the repository where you fix bugs), because that is also where `bugpilot` runs:

```powershell
# At the target repository root
mkdir .claude\skills -Force
Copy-Item -Recurse <bugpilot repo>\skills\bugpilot-investigate .claude\skills\
```

```bash
# POSIX
mkdir -p .claude/skills
cp -r <bugpilot-repo>/skills/bugpilot-investigate .claude/skills/
```

To make it apply to all repositories, put it in `~/.claude/skills/` instead of in the project.

After installing, ask Claude Code "what skills are available", or just say
"please fix JR-12345", and see whether it references this skill.

## Skill or MCP: which one to use

Both paths give the model the same handoff instructions (both rendered from `bugpilot/core/handoff.py`,
with `tests/test_handoff.py` guarding against drift); the difference is **how they execute**:

| | Skill | MCP server |
| --- | --- | --- |
| What to install | Copy one directory | `pip install -e ".[mcp]"` + configure `.mcp.json` |
| What executes it | The host's Bash (**shell permission required**) | Built-in implementation, no shell needed |
| What the model gets | Human-readable stdout that it must parse itself | Structured return values: `generated_files`, `error.code` |
| Context cost | Frontmatter always loaded, body read on demand | Schemas of 7 tools loaded on every turn |
| Cross-client | Claude Code only | Any MCP client (including Copilot Chat) |

**Recommendation**: if you only use Claude Code and do not mind it running shell commands, install the skill first — you can try it in five minutes.
If you need cross-client support, or need the model to get structured results and error codes, use MCP.
Both can be installed at the same time; the instructions are identical, so they will not conflict; the real question is **whether neither of them triggers**,
so the item below is the action left over from Phase 7.

## To do: compare the trigger rates of the two paths (§9 Phase 7)

The Phase 0A hypothesis has still not been verified: **will the model call BugPilot first, rather than grep on its own**.
The skill and MCP both serve this hypothesis, and their costs differ by an order of magnitude, so a measured comparison is worthwhile.

Method (same repository, same set of prompts, 5 runs each):

| Prompt | Skill installed (MCP off) | MCP installed (skill removed) |
| --- | --- | --- |
| `please fix JR-12345` | | |
| `JR-12345 has a crash, take a look` | | |
| `KeyError when saving a record, help me fix it` | | |
| `look at why src/record.py crashes` | | |
| `fix this bug` (no key, no description) | | |

Record three things in each cell:

1. **Did** it use BugPilot (or did it go straight to grep / reading files)?
2. If it did, did it take the Jira path or the description path? **Did it choose correctly**?
3. After getting the artifacts, did it actually read `agent_task.md`, or did it search again on its own?

Point 3 is the easiest to overlook: triggering without reading the artifacts means the run was wasted.

There are three possible conclusions, corresponding to three courses of action:

- **Both are reliable** → keep MCP as the V1 entry point (R2 + R4 call for structured output and cross-client support),
  and document the skill as a lightweight option.
- **The skill is clearly more reliable** → this means the MCP tool descriptions have a problem (which can be fixed;
  Phase 3 already fixed a misrouting once), not that the MCP path does not work.
- **Neither is reliable** → then the Phase 0A hypothesis itself does not hold, and trigger mechanisms other than
  "let the model decide" need to be reconsidered (for example the explicit button in the extension, which already works).

Record the result in the [development plan](bugpilot_prototype_development_plan.md).
