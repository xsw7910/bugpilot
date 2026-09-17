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
}

/** Tried in this order when the choice is "auto". */
export const KNOWN_AGENTS: readonly KnownAgent[] = [
  { id: "claude", label: "Claude Code", command: "claude" },
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
  | { readonly kind: "unavailable"; readonly reason: string };

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
  const prompt = flatten(input.prompt);

  if (input.choice === "custom") {
    const template = input.customCommand.trim();
    if (template === "") {
      return {
        kind: "unavailable",
        reason: `No custom agent command is set. Put one in Advanced settings, using ${PROMPT_PLACEHOLDER} where the handoff prompt goes.`,
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
 * `agent_handoff.md` can carry several, and a raw newline inside a quoted
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
