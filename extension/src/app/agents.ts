/**
 * Which coding agent gets the prepared package, and how it is invoked.
 *
 * The panel says "Fix with AI" rather than naming one vendor, and this is the
 * module that makes that wording true instead of cosmetic. Adding a provider is
 * one entry in `KNOWN_AGENTS`; nothing else in the extension mentions an agent
 * by name.
 *
 * The table is short on purpose. `claude` is here because its invocation was
 * measured on a real install — one positional argument, exit 0. Every other
 * agent's argument shape would be a guess, and a guessed command line fails in
 * a terminal in a way that reads as a bug in this extension. So instead of
 * inventing entries, the third choice is a **custom command** the developer
 * writes themselves: whoever runs Codex, Gemini or an in-house CLI knows its
 * flags, and a template beats our guess about them.
 */

export type AgentChoice = "auto" | "claude" | "custom";

export const AGENT_CHOICES: readonly AgentChoice[] = ["auto", "claude", "custom"];

export interface KnownAgent {
  readonly id: Exclude<AgentChoice, "auto" | "custom">;
  readonly label: string;
  /** Resolved through PATH, like bugpilot itself. */
  readonly command: string;
  /**
   * How to run a review whose answer can be read back, when the agent has one:
   * the fixed arguments of a one-shot, non-interactive run that takes the
   * prompt on stdin and prints its final answer on stdout. Absent means the
   * agent has no such mode BugPilot has measured, and Review with AI hands the
   * prompt to it in a terminal instead — whose output BugPilot never reads.
   */
  readonly capturedReview?: CapturedReviewInvocation;
}

/** A one-shot review run: fixed argv, the prompt on stdin, the answer on stdout. */
export interface CapturedReviewInvocation {
  readonly args: readonly string[];
  /** How stdout is read: `claude-json` is `--output-format json`'s one result object. */
  readonly output: "claude-json";
}

/**
 * Claude Code's one-shot review, measured on 2.1.214 (§37.80).
 *
 * `-p --output-format json` prints one JSON object whose `result` is the final
 * answer only — no tool logs, no progress. The rest keeps an unattended
 * reviewer read-only, because nobody is there to approve anything:
 *
 * - `--tools Read Grep Glob Bash`: nothing that edits is even available;
 * - `--permission-mode dontAsk` with `--allowedTools`: of the shell, only
 *   `git diff`, `git status`, `git log` and `git show` run — anything else is
 *   denied, never asked about. `--allowedTools` alone is not a restriction:
 *   with the developer's own `auto` mode a probe wrote a file through Bash;
 * - `--setting-sources ""` and `--strict-mcp-config`: neither the developer's
 *   nor the repository's settings, allow rules or MCP servers widen that;
 * - `--no-session-persistence`: the review leaves no session to resume.
 */
export const CLAUDE_CAPTURED_REVIEW: CapturedReviewInvocation = {
  args: [
    "-p",
    "--output-format",
    "json",
    "--no-session-persistence",
    "--setting-sources",
    "",
    "--strict-mcp-config",
    "--permission-mode",
    "dontAsk",
    "--tools",
    "Read",
    "Grep",
    "Glob",
    "Bash",
    "--allowedTools",
    "Read",
    "Grep",
    "Glob",
    "Bash(git diff)",
    "Bash(git diff *)",
    "Bash(git status)",
    "Bash(git status *)",
    "Bash(git log *)",
    "Bash(git show *)",
  ],
  output: "claude-json",
};

/** Tried in this order when the choice is "auto". */
export const KNOWN_AGENTS: readonly KnownAgent[] = [
  { id: "claude", label: "Claude Code", command: "claude", capturedReview: CLAUDE_CAPTURED_REVIEW },
];

/** The placeholder a custom command uses for the handoff prompt. */
export const PROMPT_PLACEHOLDER = "{prompt}";

export type AgentPlan =
  | {
      readonly kind: "run";
      /** For the log line and the step's own detail text. */
      readonly label: string;
      readonly commandLine: string;
    }
  | { readonly kind: "unavailable"; readonly reason: string }
  /** The prompt is not one this module will put on a command line; see `isPlainPrompt`. */
  | { readonly kind: "refused"; readonly reason: string };

/**
 * The characters a handoff prompt may be made of: letters, digits, whitespace
 * and `. , : # / _ -` — opening with a letter, a digit or `#`, never a `-` an
 * agent would read as an option. Both of today's prompts fit: Fix with AI's
 * "Read .ai/<id>/task.md and complete the workflow." around a validated work
 * item id, and Review with AI's canonical review prompt.
 */
const PLAIN_PROMPT = /^\s*[A-Za-z0-9#][A-Za-z0-9\s.,:#/_-]*$/;

/**
 * Whether a prompt may go on a command line at all.
 *
 * `quote` below is JSON's escaping, which is right only for text in which no
 * shell expands anything — PowerShell and bash both act on `$(…)` and
 * backticks inside double quotes, cmd on `%VAR%`. That is the recorded
 * pre-release quoting issue (§37.27), and this is not its fix: it is the gate
 * every terminal handoff passes, so nothing a shell could act on reaches one
 * (§37.70). A prompt outside the class is refused, never "cleaned".
 */
export function isPlainPrompt(prompt: string): boolean {
  return PLAIN_PROMPT.test(prompt);
}

export interface ResolveAgentInput {
  readonly choice: AgentChoice;
  /** The template, used only when the choice is "custom". */
  readonly customCommand: string;
  readonly prompt: string;
  /** Whether a command can be started at all; see `canRun` in host/ports.ts. */
  readonly canRun: (command: string) => Promise<boolean>;
}

/**
 * Decide what to run, or say why nothing can be.
 *
 * Never returns a command line for something that is not installed: the whole
 * reason this asks first is that a terminal printing "command not found" looks
 * like the extension failed rather than like a tool is missing.
 */
export async function resolveAgent(input: ResolveAgentInput): Promise<AgentPlan> {
  // Before anything is probed: a prompt that may not go on a command line has
  // no agent to look for. Both handoffs come through here, so both are held to
  // the same rule.
  if (!isPlainPrompt(input.prompt)) {
    return {
      kind: "refused",
      reason: "The prompt holds characters a shell could act on, or starts like an option.",
    };
  }
  const prompt = flatten(input.prompt);

  if (input.choice === "custom") {
    const template = input.customCommand.trim();
    if (template === "") {
      return {
        kind: "unavailable",
        reason: `No custom agent command is set. Put one in Workflow Settings → Fix with AI, using ${PROMPT_PLACEHOLDER} where the handoff prompt goes.`,
      };
    }
    if (!template.includes(PROMPT_PLACEHOLDER)) {
      // Running it anyway would start an agent with no idea what to work on.
      return {
        kind: "unavailable",
        reason: `The custom agent command has no ${PROMPT_PLACEHOLDER} in it, so the agent would get no instructions.`,
      };
    }
    const command = firstWord(template);
    if (!(await input.canRun(command))) {
      return { kind: "unavailable", reason: `${command} is not on PATH.` };
    }
    return {
      kind: "run",
      label: command,
      commandLine: template.replaceAll(PROMPT_PLACEHOLDER, quote(prompt)),
    };
  }

  const candidates =
    input.choice === "auto"
      ? KNOWN_AGENTS
      : KNOWN_AGENTS.filter((agent) => agent.id === input.choice);

  for (const agent of candidates) {
    if (await input.canRun(agent.command)) {
      return {
        kind: "run",
        label: agent.label,
        commandLine: `${agent.command} ${quote(prompt)}`,
      };
    }
  }

  const named = candidates.map((agent) => agent.command).join(", ");
  return {
    kind: "unavailable",
    reason:
      candidates.length === 1
        ? `${named} is not on PATH.`
        : `No AI coding agent was found on PATH (looked for ${named}).`,
  };
}

/**
 * How Review with AI reaches the selected agent: a captured one-shot run, when
 * the agent has one; otherwise the terminal handoff `resolveAgent` plans.
 *
 * A custom command is never captured. It is a shell template written for a
 * terminal, and running it for its stdout would put the review prompt into
 * shell text — the thing `isPlainPrompt` exists to keep off command lines. So a
 * custom agent (Codex included, which BugPilot reaches only that way) gets the
 * terminal and Paste Review Output.
 */
export type ReviewerPlan =
  | {
      readonly kind: "captured";
      readonly label: string;
      readonly command: string;
      readonly invocation: CapturedReviewInvocation;
    }
  | AgentPlan;

export async function resolveReviewer(input: ResolveAgentInput & { readonly capture: boolean }): Promise<ReviewerPlan> {
  if (input.capture && input.choice !== "custom" && isPlainPrompt(input.prompt)) {
    const candidates =
      input.choice === "auto" ? KNOWN_AGENTS : KNOWN_AGENTS.filter((agent) => agent.id === input.choice);
    for (const agent of candidates) {
      if (!(await input.canRun(agent.command))) continue;
      // The first installed agent is the one Fix with AI would use; only it is
      // asked, captured if it can be, in a terminal if not.
      if (agent.capturedReview === undefined) break;
      return { kind: "captured", label: agent.label, command: agent.command, invocation: agent.capturedReview };
    }
  }
  return resolveAgent(input);
}

/**
 * One shell argument.
 *
 * JSON's escaping happens to be right for both of the shells this lands in: a
 * double-quoted string with `"` and `\` escaped is understood by cmd/PowerShell
 * and by every POSIX shell.
 */
function quote(text: string): string {
  return JSON.stringify(text);
}

/**
 * A command line is one line.
 *
 * A custom prompt can carry several, and a raw newline inside a quoted
 * argument is submitted by the terminal as a second command — which is how a
 * handoff prompt becomes an accidental shell invocation. Collapsed here rather
 * than at the source, because the clipboard copy of the same text should keep
 * its formatting.
 */
function flatten(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function firstWord(text: string): string {
  return text.trim().split(/\s+/)[0] ?? "";
}
