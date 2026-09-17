"""One source for the handoff instructions, and the guard that keeps it one.

Four entry points tell an agent what to do with a prepared package: the CLI's
launch prompt, the MCP `fix_bug` prompt, the VS Code extension's "Copy handoff
prompt", and the Claude Code skill. The design doc names the risk (section 5.5):
the same instructions living in several files will drift, and the copy that
drifts is the one nobody reads.

These tests hold the two halves that cannot be checked by a type: the exact
strings that already shipped, and the markdown file on disk.
"""

from __future__ import annotations

import pathlib
import re

import pytest

from bugpilot.core import handoff
from bugpilot.core.agent_runner import HANDOFF_PROMPT, RETRY_HANDOFF_PROMPT

SKILL_PATH = pathlib.Path(__file__).resolve().parents[1] / "skills" / "bugpilot-investigate" / "SKILL.md"


def _normalize(text: str) -> str:
    """Collapse whitespace so wrapped markdown compares equal to one long line."""
    return re.sub(r"\s+", " ", text).strip()


# --- the strings that already shipped ---------------------------------------


def test_launch_prompts_are_unchanged():
    """R1: these reach a spawned agent's command line and are asserted elsewhere."""
    assert HANDOFF_PROMPT == "Read .ai/{issue_key}/agent_task.md and complete the workflow."
    assert RETRY_HANDOFF_PROMPT == "Read {prompt_file} and continue the workflow."
    assert handoff.handoff_prompt("JR-1") == "Read .ai/JR-1/agent_task.md and complete the workflow."


def test_mcp_prompt_is_byte_for_byte_what_it_was():
    """Moving the wording into one module must not reword what a model reads."""
    assert handoff.mcp_prompt("prepare_jira_bug", 'issue_key="JR-1"') == (
        'Call prepare_jira_bug with issue_key="JR-1".\n'
        "Then read the returned agent_task.md and bug_context.md and complete the "
        "workflow they describe: analyse the bug, implement the smallest safe fix, "
        "and write the required result files.\n"
        "Stop before committing. Do not commit, push, or post to Jira."
    )


def test_the_forbidden_sentence_reads_as_english():
    """"commit, push, post to Jira" is a list dump; a model reads prose."""
    assert "Do not commit, push, or post to Jira." in handoff.mcp_prompt("t", "a")


# --- the skill file on disk -------------------------------------------------


def test_skill_file_exists_with_frontmatter():
    assert SKILL_PATH.is_file(), f"{SKILL_PATH} is missing"
    text = SKILL_PATH.read_text(encoding="utf-8")
    assert text.startswith("---\n"), "a Claude Code skill needs YAML frontmatter"
    assert "\nname: bugpilot-investigate\n" in text
    assert "\ndescription: " in text


@pytest.mark.parametrize("step", handoff.skill_steps())
def test_every_step_appears_in_the_skill(step):
    """The skill's numbered steps are the ones handoff.py renders.

    Whitespace-insensitive, because the file wraps its lines and a single long
    line would be worse to read for no gain.
    """
    body = _normalize(SKILL_PATH.read_text(encoding="utf-8"))
    assert _normalize(step) in body, f"SKILL.md is missing or has reworded: {step}"


def test_the_skill_states_the_boundary():
    body = SKILL_PATH.read_text(encoding="utf-8")
    for action in handoff.FORBIDDEN_ACTIONS:
        assert action in body, f"the skill does not mention {action!r}"
    # And the retry loop, which is the part an agent is most likely to get wrong
    # by starting over instead of asking for feedback.
    assert "--retry" in body
    assert "user_feedback.md" in body


def test_the_skill_frontmatter_carries_the_shared_trigger():
    frontmatter = SKILL_PATH.read_text(encoding="utf-8").split("---")[1]
    description = _normalize(frontmatter.split("description:", 1)[1])
    assert _normalize(handoff.TRIGGER_DESCRIPTION) in description


def test_the_skill_and_the_mcp_tools_trigger_on_the_same_thing():
    """Both answer "when should I reach for bugpilot?" for the same model.

    Not by sharing one sentence: the MCP descriptions are deliberately more
    specific (phase 3 fixed a misrouting by spelling out what an issue key looks
    like). What must hold is that they listen for the same words — section 7
    compares the two paths' trigger rates, and that comparison means nothing if
    one of them is waiting for something else.
    """
    import asyncio

    from bugpilot.mcp_server import build_server

    server = build_server(pathlib.Path.cwd())
    tools = {tool.name: tool.description or "" for tool in asyncio.run(server.list_tools())}
    skill = SKILL_PATH.read_text(encoding="utf-8")

    for token in handoff.TRIGGER_TOKENS:
        assert token in skill, f"the skill never mentions {token!r}"
        assert token in tools["prepare_jira_bug"], f"prepare_jira_bug never mentions {token!r}"

    # And both must point at the same alternative for a bug with no issue key,
    # or a described bug reaches the Jira path in one of them.
    assert "--description" in skill
    assert "prepare_bug_description" in tools["prepare_jira_bug"]


# --- the skill file has to be *loadable*, not just correct ------------------


def _frontmatter_lines() -> list[str]:
    """The lines between the opening and closing `---`, or fail loudly."""
    text = SKILL_PATH.read_text(encoding="utf-8")
    parts = text.split("---\n")
    assert len(parts) >= 3 and parts[0] == "", "frontmatter must open the file with ---"
    return [line for line in parts[1].split("\n") if line.strip()]


def test_frontmatter_is_a_flat_mapping_of_simple_scalars():
    """A malformed skill is *silently ignored*, which is the worst outcome.

    There is no YAML parser in the dependency set, so this checks the structure
    the file actually uses: one flat mapping, one line per key, no tabs, no
    indentation that would make it nested, and no unquoted colon-space in a
    value (which YAML would read as a nested key).
    """
    for line in _frontmatter_lines():
        assert not line.startswith((" ", "\t")), f"indented frontmatter line: {line!r}"
        assert ": " in line, f"not a key: value line: {line!r}"
        key, value = line.split(": ", 1)
        assert key.isidentifier() or "-" in key, f"suspicious key: {key!r}"
        assert value.strip(), f"empty value for {key!r}"
        assert ": " not in value, f"unquoted colon in {key!r} would nest in YAML: {value!r}"


def test_the_skill_name_matches_its_directory():
    """Claude Code finds a skill by its directory; a mismatch is confusing at best."""
    name = next(line for line in _frontmatter_lines() if line.startswith("name: "))
    assert name == f"name: {SKILL_PATH.parent.name}"
    assert SKILL_PATH.parent.name.islower()


def test_the_description_stays_short_enough_to_keep_in_context():
    """The description is what sits in context permanently (design 5.5).

    The body is read on demand; this line is not. A project cap rather than an
    API limit — the point is that it stays a trigger, not a manual.
    """
    description = next(line for line in _frontmatter_lines() if line.startswith("description: "))
    assert len(description) < 500, f"{len(description)} characters is a manual, not a trigger"
