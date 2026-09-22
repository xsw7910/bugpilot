"""What an agent is told to do with a prepared package.

Four places say this today: the CLI's agent launch, the MCP `fix_bug` prompt,
the VS Code extension's "Copy handoff prompt", and the Claude Code skill. The
design doc calls out the risk directly (section 5.5): a skill and an MCP prompt
carrying the same instructions in two files will drift, and the version that
drifts is the one nobody reads.

So the instructions live here, once, as data. Every entry point renders them:

- :func:`handoff_prompt` — the one-line launch prompt (``agent_runner``).
- :func:`retry_handoff_prompt` — the same, for a second attempt.
- :func:`mcp_prompt` — the MCP prompt's expanded form.
- :func:`skill_steps` — the numbered steps in ``SKILL.md``.

The wording of the first two is fixed by requirement R1: existing human-facing
output must survive byte for byte, and those strings reach a spawned agent's
command line.

None of them says *what* the workflow is. That is the selected AI Fix Mode's
to say, and it says it in ``agent_task.md``: an investigate-kind mode changes
no source code, so a handoff that told every agent to "implement the smallest
safe fix" would contradict the task file it points at. The handoff points; the
task file decides.
"""

from __future__ import annotations

# The files an agent must read before doing anything. `agent_task.md` is the
# task; `bug_context.md` is the evidence behind it.
REQUIRED_READS: tuple[str, ...] = ("agent_task.md", "bug_context.md")

# The boundary, stated in the imperative because that is how it reaches a model.
# It is the same list in section 7's safety model: bugpilot prepares, a human
# decides. An agent that commits on its own has taken a decision that was not
# its to take.
FORBIDDEN_ACTIONS: tuple[str, ...] = ("commit", "push", "post to Jira")

# When a host agent should reach for bugpilot at all. Shared by the MCP tool
# descriptions and the skill's frontmatter, because both are answering the same
# question for the same model.
TRIGGER_DESCRIPTION = (
    "Use when the user names a Jira issue key such as JR-12345, or describes a "
    "bug and asks to fix, investigate or analyse it — before searching the "
    "repository yourself."
)

# The words both agent-facing paths must contain, rather than one shared
# sentence. The MCP tool descriptions are deliberately more specific than the
# skill's frontmatter — phase 3 fixed a real misrouting by spelling out what an
# issue key looks like — so forcing identical prose would make one of them
# worse. What has to hold is that the two paths trigger on the same thing:
# section 7 compares their trigger rates, and that comparison is meaningless if
# they are listening for different words.
# "before searching" rather than "before": the weaker token matches almost any
# prose, which would have made the guard pass on two descriptions that agree on
# nothing. Both sides really do carry the longer phrase, and it is the
# behavioural instruction that matters — reach for bugpilot *first*.
TRIGGER_TOKENS: tuple[str, ...] = ("Jira issue key", "JR-12345", "before searching")

def _sentence(actions: tuple[str, ...]) -> str:
    """"a, b, or c" — the join has to read as English, not as a list dump.

    Spelled out because the result is the exact sentence the MCP prompt already
    shipped ("Do not commit, push, or post to Jira."), and this refactor must
    not quietly reword what a model has been reading.
    """
    if len(actions) < 2:
        return f"Do not {''.join(actions)}."
    return f"Do not {', '.join(actions[:-1])}, or {actions[-1]}."


_FORBIDDEN_SENTENCE = _sentence(FORBIDDEN_ACTIONS)


def handoff_prompt(issue_key: str) -> str:
    """The launch prompt for an agent started by bugpilot.

    Byte-for-byte the string ``agent_runner.HANDOFF_PROMPT`` produced before
    this module existed: it is passed on a command line and asserted by tests.
    """
    return f"Read .ai/{issue_key}/agent_task.md and complete the workflow."


def retry_handoff_prompt(prompt_file: str) -> str:
    """The launch prompt for a second attempt, pointing at the retry package."""
    return f"Read {prompt_file} and continue the workflow."


def mcp_prompt(tool: str, argument: str) -> str:
    """The MCP `fix_bug` prompt: call the tool, then work the package.

    Longer than :func:`handoff_prompt` because the model has not run anything
    yet — it has to be told which tool to call first.
    """
    reads = " and ".join(REQUIRED_READS)
    return (
        f"Call {tool} with {argument}.\n"
        f"Then read the returned {reads} and complete the "
        "workflow they describe for the selected AI Fix Mode, "
        "then write the required result files.\n"
        f"Stop before committing. {_FORBIDDEN_SENTENCE}"
    )


def skill_steps() -> tuple[str, ...]:
    """The numbered steps of the Claude Code skill.

    The skill drives the *CLI* through the host's own Bash tool, so step one is
    a command line rather than a tool call. Everything after that is the same
    handoff as every other entry point.
    """
    reads = " and ".join(f"`.ai/<ISSUE>/{name}`" for name in REQUIRED_READS)
    return (
        "Run `bugpilot bug <ISSUE>` from the repository root. "
        'For a bug with no issue key, run `bugpilot bug --description="..."` instead.',
        f"Read {reads}. They contain the issue details, the ranked candidate "
        "files and the relevant git history — read them instead of searching "
        "the repository from scratch.",
        "Complete the workflow `agent_task.md` describes for the selected AI Fix "
        "Mode — it says whether this pass investigates only or implements — and "
        "write the required result files.",
        f"Stop at the commit gate. {_FORBIDDEN_SENTENCE}",
    )
