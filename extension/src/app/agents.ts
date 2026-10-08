/**
 * Which coding agent gets the prepared package, and how it is reached.
 *
 * The panel says "Fix with AI" rather than naming one vendor, and this is the
 * module that makes that wording true instead of cosmetic (§37.94). Every agent
 * is an `AiAgentAdapter`: it says what it can do (`detect`) and does it (`run`).
 * The controller asks `AgentService` for the adapter the developer's choice
 * resolves to and hands it a request; nothing else in the extension names an
 * agent. Adding one — Gemini CLI, OpenCode, Copilot — is one definition in
 * `CLI_AGENTS` or `EXTENSION_AGENTS` and one option in the picker.
 *
 * Three kinds of adapter, one rule for each about what is claimed:
 *
 * - **CLI** (`codex`, `claude`): found on PATH with a `--version` probe, and run
 *   in a terminal in the repository root with the handoff prompt as their one
 *   positional argument — `claude`'s measured on a real install, `codex`'s the
 *   `codex [PROMPT]` form its own usage documents.
 * - **Extension** (the Codex and Claude Code VS Code extensions): found through
 *   VS Code's extension API and read off the installed manifest. *Native*
 *   integration only where a definition names a command that takes a prompt
 *   and the installed manifest declares it; today neither does — every command
 *   either contributes opens a view and takes nothing — so both are a *bridge*:
 *   the prompt goes to the clipboard, the agent's own view is brought forward,
 *   and the developer pastes. Nothing types into another extension's UI.
 * - **Custom command**: the developer's own shell template with `{prompt}`,
 *   for any CLI whose flags BugPilot does not know.
 *
 * Auto-detect chooses by capability, never by list position; an explicit choice
 * is used or refused, never swapped for another agent (`AgentService.resolve`).
 */

export type AgentId = "codex-cli" | "claude-cli" | "codex-extension" | "claude-extension" | "custom";
export type AgentChoice = "auto" | AgentId;

/** The picker's options, in the picker's order. */
export const AGENT_CHOICES: readonly AgentChoice[] = [
  "auto",
  "codex-cli",
  "claude-cli",
  "codex-extension",
  "claude-extension",
  "custom",
];

/** Each choice in the picker's words, without "(Recommended)" or the ellipsis. */
export const AGENT_LABELS: Readonly<Record<AgentChoice, string>> = {
  auto: "Auto-detect",
  "codex-cli": "Codex CLI",
  "claude-cli": "Claude CLI",
  "codex-extension": "Codex Extension",
  "claude-extension": "Claude Extension",
  custom: "Custom command",
};

/**
 * Values a saved form may hold from before §37.94, and what they meant.
 *
 * `claude` ran the `claude` CLI in a terminal, which is exactly Claude CLI now.
 */
const LEGACY_CHOICES: Readonly<Record<string, AgentChoice>> = { claude: "claude-cli" };

/**
 * A stored or received agent choice, as one this version knows.
 *
 * A saved form and a page's restored state both outlive a release, so an old
 * value is translated, never dropped to Auto-detect — which would quietly pick
 * a different agent for someone who had chosen one. Anything unknown is Auto.
 */
export function migrateAgentChoice(value: unknown): AgentChoice {
  if (typeof value !== "string") return "auto";
  if ((AGENT_CHOICES as readonly string[]).includes(value)) return value as AgentChoice;
  return LEGACY_CHOICES[value] ?? "auto";
}

// --- the adapter contract ------------------------------------------------------

/** How BugPilot reaches an agent, strongest first in Auto-detect's order. */
export type AgentIntegration = "native-extension" | "cli" | "extension-bridge" | "custom";

/** What one agent can do on this machine now, as detection found it. */
export interface AgentCapability {
  /** The CLI is on PATH, the extension is installed and enabled, the custom command's program exists. */
  readonly installed: boolean;
  /** BugPilot can hand it a prompt, by some route. */
  readonly available: boolean;
  readonly integration: AgentIntegration;
  /** The prompt reaches the agent directly; false for a bridge, where the developer pastes it. */
  readonly canReceivePrompt: boolean;
  /** The agent itself can edit the repository — what Fix with AI needs of it. */
  readonly canModifyWorkspace: boolean;
  /** The short status the picker shows under the choice: "Installed · Limited integration". */
  readonly detail: string;
  /** Why it cannot be used, as the sentence a failure card shows. Only when unavailable. */
  readonly reason?: string;
}

/**
 * What a handoff gives an agent: the repository, and one sentence pointing at
 * the prepared package.
 *
 * Deliberately not the hint, keywords, focus files or Fix Mode. Those were
 * read when the context was prepared and are in `task.md` already; handing
 * them to the agent again would be a second, unprepared copy of the context —
 * and would make the agent choice something that changes what the agent is
 * told, which it must not (Advanced Settings: "Changes here apply to the next
 * run and do not require rebuilding context").
 */
export interface AiFixRequest {
  /** The repository root: the terminal's cwd, the directory the prompt's paths are relative to. */
  readonly workspacePath: string;
  readonly workItemId: string;
  /** "Read .ai/<id>/task.md and complete the workflow." — or a retry's, or Review with AI's prompt. */
  readonly prompt: string;
  /** The prepared file the prompt points at, absolute, for an integration that takes a file. */
  readonly preparedContextPath?: string;
  /** What is being handed over, for the words a bridge uses. */
  readonly purpose: "fix" | "review";
}

/**
 * What an adapter may do to hand a request over. The controller supplies each
 * one, guarded: once the press is no longer wanted — another work item opened,
 * a run started — they do nothing, so an adapter cannot land an old press on a
 * new screen however it orders its steps.
 */
export interface AgentLaunch {
  /** Open the handoff terminal in the repository root and run one command line in it. */
  runInTerminal(commandLine: string): void;
  copyToClipboard(text: string): Promise<void>;
  /** Execute another extension's command; false when it did not run (it threw, or the press is gone). */
  executeCommand(command: string, ...args: unknown[]): Promise<boolean>;
}

export type AiFixResult =
  /** Started in a terminal this extension does not own. */
  | { readonly kind: "terminal"; readonly label: string; readonly commandLine: string }
  /** Handed to an extension through a command that takes the prompt. */
  | { readonly kind: "native"; readonly label: string; readonly message: string }
  /** On the clipboard, the agent's view brought forward where it could be: the developer pastes. */
  | { readonly kind: "bridge"; readonly label: string; readonly message: string; readonly revealed: boolean }
  | { readonly kind: "failed"; readonly reason: string };

/** One way of reaching one agent. */
export interface AiAgentAdapter {
  readonly id: AgentId;
  readonly label: string;
  /**
   * The vendor's one-shot CLI, for improving a hint (`hintImprovement.ts`),
   * which needs an answer back on stdout and so never goes through `run`.
   */
  readonly vendor?: "codex" | "claude";
  /** A captured one-shot review this agent has, measured (§37.80). */
  readonly capturedReview?: { readonly command: string; readonly invocation: CapturedReviewInvocation };
  /** What the agent can do now. Never throws, never runs the agent, never opens a terminal. */
  detect(): Promise<AgentCapability>;
  run(request: AiFixRequest, launch: AgentLaunch): Promise<AiFixResult>;
}

/** What the host can find out about this machine, for detection. Neither may throw for an ordinary "no". */
export interface AgentProbes {
  /** Whether a command can be started at all; see `canRun` in host/ports.ts. */
  canRun(command: string): Promise<boolean>;
  /**
   * An installed, enabled extension, from VS Code's extension API; undefined
   * when it is not installed or is disabled. Absent: the host cannot tell, and
   * every extension agent is reported not installed rather than guessed at.
   */
  extension?(id: string): InstalledExtension | undefined;
}

export interface InstalledExtension {
  readonly version: string;
  readonly active: boolean;
  /** The command ids the installed manifest contributes — what is known to exist, not what is hoped. */
  readonly commands: readonly string[];
}

// --- captured review -------------------------------------------------------------

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
 * - `--tools Read Grep Glob`: the only tools that exist in the session. No
 *   shell, so no command at all — `git diff --output=<file>`, an external diff
 *   driver or a textconv filter could write files or run programs from inside
 *   a `Bash(git diff *)` rule (pre-release Batch 2, C). The current changes
 *   come in the prompt instead, collected by BugPilot itself
 *   (`review-package --include-changes`);
 * - `--permission-mode dontAsk` with `--allowedTools`: anything not allowed is
 *   denied, never asked about. `--allowedTools` alone is not a restriction:
 *   with the developer's own `auto` mode a probe wrote a file through Bash;
 * - `--setting-sources ""` and `--strict-mcp-config`: neither the developer's
 *   nor the repository's settings, allow rules, hooks or MCP servers widen that;
 * - `--no-session-persistence`: the review leaves no session to resume.
 *
 * Read-only is about the workspace and the machine: `Read` can open any file
 * the developer can, and the answer — shown only in the panel — may quote it.
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
    "--allowedTools",
    "Read",
    "Grep",
    "Glob",
  ],
  output: "claude-json",
};

// --- the prompt gate -------------------------------------------------------------

/** The placeholder a custom command uses for the handoff prompt. */
export const PROMPT_PLACEHOLDER = "{prompt}";

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
 * every handoff passes, so nothing a shell could act on reaches one (§37.70).
 * A prompt outside the class is refused, never "cleaned".
 */
export function isPlainPrompt(prompt: string): boolean {
  return PLAIN_PROMPT.test(prompt);
}

const REFUSED_PROMPT = "The prompt holds characters a shell could act on, or starts like an option.";

// --- CLI agents ------------------------------------------------------------------

export interface CliAgentDefinition {
  readonly id: AgentId;
  readonly label: string;
  /** Resolved through PATH, like bugpilot itself. */
  readonly command: string;
  readonly vendor: "codex" | "claude";
  readonly capturedReview?: CapturedReviewInvocation;
}

/**
 * The CLIs BugPilot knows the interactive invocation of: `<command> "<prompt>"`.
 *
 * Claude first: in Auto-detect's CLI tier the one with a captured review ranks
 * higher, because Review with AI can read its answer back, and the order here
 * is the tie-break after that.
 */
export const CLI_AGENTS: readonly CliAgentDefinition[] = [
  { id: "claude-cli", label: "Claude CLI", command: "claude", vendor: "claude", capturedReview: CLAUDE_CAPTURED_REVIEW },
  { id: "codex-cli", label: "Codex CLI", command: "codex", vendor: "codex" },
];

export function cliAgent(definition: CliAgentDefinition, probes: AgentProbes): AiAgentAdapter {
  const { id, label, command, vendor } = definition;
  return {
    id,
    label,
    vendor,
    ...(definition.capturedReview ? { capturedReview: { command, invocation: definition.capturedReview } } : {}),
    async detect() {
      const found = await probes.canRun(command).catch(() => false);
      return {
        installed: found,
        available: found,
        integration: "cli",
        canReceivePrompt: true,
        canModifyWorkspace: true,
        detail: found ? "Available" : "Not found on PATH",
        ...(found
          ? {}
          : { reason: `${label} is not available: ${command} was not found on PATH. Install or configure ${label}, or choose another AI Agent.` }),
      };
    },
    async run(request, launch) {
      if (!isPlainPrompt(request.prompt)) return { kind: "failed", reason: REFUSED_PROMPT };
      const commandLine = `${command} ${quote(flatten(request.prompt))}`;
      launch.runInTerminal(commandLine);
      return { kind: "terminal", label, commandLine };
    },
  };
}

// --- extension agents ------------------------------------------------------------

export interface ExtensionAgentDefinition {
  readonly id: AgentId;
  readonly label: string;
  /** The Marketplace id, `publisher.name`. */
  readonly extensionId: string;
  /** What the developer calls it: "Paste it into Codex to continue." */
  readonly product: string;
  readonly vendor: "codex" | "claude";
  /**
   * Commands that bring the agent's own view forward, first that works wins.
   * Each read from a real installed manifest; used only when the installed
   * version still declares it.
   */
  readonly reveal: readonly string[];
  /**
   * A documented command that takes the request, when the extension has one.
   * Used only when the installed manifest declares it; otherwise the agent is
   * a bridge. Neither extension below has one today.
   */
  readonly native?: { readonly command: string; readonly args: (request: AiFixRequest) => readonly unknown[] };
}

/**
 * The extensions BugPilot can bridge to, read off their installed manifests.
 *
 * - `openai.chatgpt` 26.917 (the Codex extension): ten commands; the ones that
 *   take something take an editor selection or a file from a context menu, and
 *   none is documented for another extension to call. `chatgpt.openSidebar`
 *   opens its view.
 * - `anthropic.claude-code` 2.1.285: thirty-one commands, none taking a prompt;
 *   `claude-vscode.sidebar.open` and `claude-vscode.editor.openLast` open it.
 *
 * Neither activates with an exported API BugPilot may rely on, so neither is
 * given a `native` entry: an installed extension is a bridge until it documents
 * a way in.
 */
export const EXTENSION_AGENTS: readonly ExtensionAgentDefinition[] = [
  {
    id: "codex-extension",
    label: "Codex Extension",
    extensionId: "openai.chatgpt",
    product: "Codex",
    vendor: "codex",
    reveal: ["chatgpt.openSidebar"],
  },
  {
    id: "claude-extension",
    label: "Claude Extension",
    extensionId: "anthropic.claude-code",
    product: "Claude",
    vendor: "claude",
    reveal: ["claude-vscode.sidebar.open", "claude-vscode.editor.openLast"],
  },
];

export function extensionAgent(definition: ExtensionAgentDefinition, probes: AgentProbes): AiAgentAdapter {
  const { id, label, product, vendor } = definition;
  const installed = (): InstalledExtension | undefined => {
    try {
      return probes.extension?.(definition.extensionId);
    } catch {
      return undefined;
    }
  };
  const nativeCommand = (extension: InstalledExtension): string | undefined =>
    definition.native && extension.commands.includes(definition.native.command) ? definition.native.command : undefined;

  return {
    id,
    label,
    vendor,
    async detect() {
      const extension = installed();
      if (!extension) {
        // VS Code answers the same for a disabled extension as for a missing
        // one, so the line says both rather than claim which (seen in the
        // real window, §37.94).
        return {
          installed: false,
          available: false,
          integration: "extension-bridge",
          canReceivePrompt: false,
          canModifyWorkspace: true,
          detail: "Not installed or disabled",
          reason: `${label} is not available: the ${definition.extensionId} extension is not installed or is disabled. Install it, or choose another AI Agent.`,
        };
      }
      const native = nativeCommand(extension) !== undefined;
      return {
        installed: true,
        available: true,
        integration: native ? "native-extension" : "extension-bridge",
        canReceivePrompt: native,
        canModifyWorkspace: true,
        detail: native ? "Installed · Native integration available" : "Installed · Limited integration",
      };
    },
    async run(request, launch) {
      const extension = installed();
      if (!extension) {
        return { kind: "failed", reason: `The ${definition.extensionId} extension is not installed or is disabled.` };
      }
      const native = nativeCommand(extension);
      if (native !== undefined && (await launch.executeCommand(native, ...definition.native!.args(request)))) {
        return { kind: "native", label, message: `${purposeText(request)} sent to ${product}.` };
      }
      // A bridge, or a native command that did not take it: the same agent by
      // the route that always works. Copied first, so it is there when the
      // view comes up.
      await launch.copyToClipboard(request.prompt);
      let revealed = false;
      for (const command of definition.reveal.filter((entry) => extension.commands.includes(entry))) {
        if (await launch.executeCommand(command)) {
          revealed = true;
          break;
        }
      }
      return {
        kind: "bridge",
        label,
        revealed,
        message: `${purposeText(request)} copied. Paste it into ${product} to continue.`,
      };
    },
  };
}

function purposeText(request: AiFixRequest): string {
  return request.purpose === "review" ? "BugPilot review prompt" : "BugPilot AI fix context";
}

// --- the custom command ------------------------------------------------------------

/** Whether a custom template can be used at all: set, and with somewhere to put the prompt. */
function customCommandConfigured(template: string): boolean {
  return template.trim() !== "" && template.includes(PROMPT_PLACEHOLDER);
}

/**
 * The developer's own command line, with `{prompt}` where the handoff goes.
 *
 * Whoever runs Gemini, OpenCode or an in-house CLI knows its flags, and a
 * template beats a guess about them. Its label in a result is the program's
 * name, because that is what the developer wrote.
 */
export function customCommandAgent(template: string, probes: AgentProbes): AiAgentAdapter {
  const trimmed = template.trim();
  const command = firstWord(trimmed);
  return {
    id: "custom",
    label: AGENT_LABELS.custom,
    async detect() {
      const base = { integration: "custom", canReceivePrompt: true, canModifyWorkspace: true } as const;
      if (trimmed === "") {
        return {
          ...base,
          installed: false,
          available: false,
          detail: "Not configured",
          reason: `No custom agent command is set. Put one in Advanced Settings → Fix with AI, using ${PROMPT_PLACEHOLDER} where the handoff prompt goes.`,
        };
      }
      if (!trimmed.includes(PROMPT_PLACEHOLDER)) {
        // Running it anyway would start an agent with no idea what to work on.
        return {
          ...base,
          installed: false,
          available: false,
          detail: `No ${PROMPT_PLACEHOLDER} in the command`,
          reason: `The custom agent command has no ${PROMPT_PLACEHOLDER} in it, so the agent would get no instructions.`,
        };
      }
      const found = await probes.canRun(command).catch(() => false);
      return {
        ...base,
        installed: found,
        available: found,
        detail: found ? "Configured" : "Not found on PATH",
        ...(found ? {} : { reason: `${command} is not on PATH.` }),
      };
    },
    async run(request, launch) {
      if (!isPlainPrompt(request.prompt)) return { kind: "failed", reason: REFUSED_PROMPT };
      const commandLine = trimmed.replaceAll(PROMPT_PLACEHOLDER, quote(flatten(request.prompt)));
      launch.runInTerminal(commandLine);
      return { kind: "terminal", label: command, commandLine };
    },
  };
}

// --- choosing one ------------------------------------------------------------------

export type AgentResolution =
  | { readonly kind: "ready"; readonly adapter: AiAgentAdapter; readonly capability: AgentCapability }
  | { readonly kind: "unavailable"; readonly reason: string }
  /** The prompt is not one BugPilot will hand over; see `isPlainPrompt`. */
  | { readonly kind: "refused"; readonly reason: string };

/** The subtle line under the picker, per choice; a choice with nothing to say is absent. */
export interface AgentStatusView {
  readonly lines: Partial<Record<AgentChoice, string>>;
}

/** The last agent a handoff reached, kept by the host across reloads. */
export interface LastAgentStore {
  get(): string | undefined;
  set(id: AgentId): void;
}

export interface AgentServiceOptions {
  readonly probes: AgentProbes;
  readonly log?: { info(message: string): void };
  readonly lastAgent?: LastAgentStore;
  readonly now?: () => number;
  /** Adapters to use instead of the built-in ones — a test's, or a future agent's. */
  readonly adapters?: readonly AiAgentAdapter[];
}

/**
 * How long a detection answers the picker's status line. A run never uses it:
 * it asks again, because that is the moment a wrong answer costs something.
 */
const DETECTION_TTL_MS = 2 * 60_000;

/**
 * The longest one adapter's detection may take before it counts as unavailable.
 * `canRun` has its own, shorter timeout; this is the backstop that keeps a
 * probe that never answers from holding the picker, or a handoff, for ever.
 */
export const DETECTION_TIMEOUT_MS = 10_000;

interface CachedCapability {
  readonly capability: AgentCapability;
  readonly at: number;
}

/**
 * The AI Agent layer the workflow depends on: which adapters exist, what they
 * can do, which one a choice means, and what the picker should say about each.
 */
export class AgentService {
  readonly #adapters: readonly AiAgentAdapter[];
  readonly #probes: AgentProbes;
  readonly #log: { info(message: string): void } | undefined;
  readonly #lastAgent: LastAgentStore | undefined;
  readonly #now: () => number;
  readonly #cache = new Map<string, CachedCapability>();
  readonly #inFlight = new Map<string, Promise<AgentCapability>>();
  /** Set by `succeeded` for a host without a store, so Auto-detect still prefers it this session. */
  #lastInMemory: AgentId | undefined;
  /** Refreshes running now: a count, so one finishing does not end another's "Detecting…". */
  #detecting = 0;
  #detected = false;

  constructor(options: AgentServiceOptions) {
    this.#probes = options.probes;
    this.#log = options.log;
    this.#lastAgent = options.lastAgent;
    this.#now = options.now ?? Date.now;
    this.#adapters = options.adapters ?? [
      ...CLI_AGENTS.map((definition) => cliAgent(definition, options.probes)),
      ...EXTENSION_AGENTS.map((definition) => extensionAgent(definition, options.probes)),
    ];
  }

  /** The adapter behind an explicit choice; `auto` has none of its own. */
  #adapterFor(choice: AgentChoice, customCommand: string): AiAgentAdapter | undefined {
    if (choice === "auto") return undefined;
    if (choice === "custom") return customCommandAgent(customCommand, this.#probes);
    return this.#adapters.find((adapter) => adapter.id === choice);
  }

  /**
   * The agent a choice means, now — asked afresh, because a handoff is about to
   * depend on it.
   *
   * An explicit choice is that agent or an error that names it: Codex CLI
   * missing is never answered with Claude. Auto-detect may choose any agent,
   * by `#pickAuto`'s order.
   */
  async resolve(input: {
    readonly choice: AgentChoice;
    readonly customCommand: string;
    readonly prompt: string;
  }): Promise<AgentResolution> {
    // Before anything is probed: a prompt that may not be handed over has no
    // agent to look for. Every handoff comes through here.
    if (!isPlainPrompt(input.prompt)) return { kind: "refused", reason: REFUSED_PROMPT };
    const detect = (adapter: AiAgentAdapter) => this.#detect(adapter, input.customCommand, true);

    if (input.choice !== "auto") {
      const adapter = this.#adapterFor(input.choice, input.customCommand);
      if (!adapter) return { kind: "unavailable", reason: `${input.choice} is not an AI Agent BugPilot knows.` };
      const capability = await detect(adapter);
      return capability.available
        ? { kind: "ready", adapter, capability }
        : { kind: "unavailable", reason: capability.reason ?? `${adapter.label} is not available.` };
    }

    const picked = await this.#pickAuto(input.customCommand, detect);
    if (picked) {
      this.#log?.info(`Auto-detect resolved to ${picked.adapter.label}.`);
      return { kind: "ready", ...picked };
    }
    return { kind: "unavailable", reason: this.#nothingFound() };
  }

  /**
   * Detect every agent for the picker's status lines, from the cache where it
   * is recent. Cheap to call again: a detection already running is joined, and
   * nothing is spawned for an answer less than `DETECTION_TTL_MS` old.
   */
  async refresh(customCommand: string): Promise<void> {
    this.#detecting += 1;
    try {
      const adapters = [...this.#adapters];
      if (customCommandConfigured(customCommand)) adapters.push(customCommandAgent(customCommand, this.#probes));
      // Said only when something is asked: reopening Advanced Settings on a
      // cached answer is not a detection, and the log should not claim one.
      const asking = adapters.some((adapter) => !this.#isCached(this.#key(adapter, customCommand)));
      if (asking) this.#log?.info("Detecting AI agents…");
      await Promise.all(adapters.map((adapter) => this.#detect(adapter, customCommand, false)));
      const auto = await this.#pickAuto(customCommand, (adapter) => this.#detect(adapter, customCommand, false));
      if (asking) this.#log?.info(auto ? `Auto-detect resolved to ${auto.adapter.label}.` : "No supported AI agent detected.");
    } finally {
      this.#detecting -= 1;
      this.#detected = true;
    }
  }

  /** Whether a refresh has been asked for: the picker's status lines are on show. */
  get detected(): boolean {
    return this.#detected || this.#detecting > 0;
  }

  /** Forget every detection: an extension was installed or removed, or the host was told something changed. */
  invalidate(): void {
    this.#cache.clear();
  }

  /** A handoff reached this agent: Auto-detect prefers it next time, while it is still available. */
  succeeded(id: AgentId): void {
    this.#lastInMemory = id;
    this.#lastAgent?.set(id);
  }

  /**
   * What the picker says under each choice, from what is cached — never a probe.
   * Nothing at all before the first detection is asked for; "Detecting…" while
   * one runs with nothing to show yet.
   */
  status(customCommand: string): AgentStatusView {
    const lines: Partial<Record<AgentChoice, string>> = {};
    if (!this.#detected && this.#detecting === 0) return { lines };
    const cached = (adapter: AiAgentAdapter) => this.#cache.get(this.#key(adapter, customCommand))?.capability;
    for (const adapter of this.#adapters) {
      const capability = cached(adapter);
      lines[adapter.id] = capability ? capability.detail : "Checking…";
    }
    const auto = this.#pickAutoCached(customCommand, cached);
    lines.auto =
      auto === "pending"
        ? "Detecting AI agents…"
        : auto
          ? `Detected: ${auto.label}`
          : "No supported AI agent detected.";
    return { lines };
  }

  /**
   * Auto-detect: the strongest integration available, asked lazily — each tier
   * only when every stronger one came up empty, so a machine with a working
   * agent is not made to probe for every other.
   *
   * 1. The last agent a handoff reached, if it is still available.
   * 2. An extension with a native, callable integration.
   * 3. A CLI — one with a captured review first, then `CLI_AGENTS`' order.
   * 4. An installed extension, as a bridge.
   * 5. The custom command, only when one is configured.
   */
  async #pickAuto(
    customCommand: string,
    detectOnce: (adapter: AiAgentAdapter) => Promise<AgentCapability>,
  ): Promise<{ adapter: AiAgentAdapter; capability: AgentCapability } | undefined> {
    // Once per adapter per pass: tier 4 reads the extensions tier 2 already did.
    const seen = new Map<AiAgentAdapter, Promise<AgentCapability>>();
    const detect = (adapter: AiAgentAdapter): Promise<AgentCapability> => {
      let answer = seen.get(adapter);
      if (!answer) seen.set(adapter, (answer = detectOnce(adapter)));
      return answer;
    };
    for (const adapter of this.#autoOrder(customCommand)) {
      const capability = await detect(adapter);
      if (capability.available && this.#tierAccepts(adapter, capability)) return { adapter, capability };
    }
    // Tier 4: the bridges the extension tier already detected.
    for (const adapter of this.#adapters) {
      if (this.#nominalIntegration(adapter) !== "extension") continue;
      const capability = await detect(adapter);
      if (capability.available) return { adapter, capability };
    }
    if (customCommandConfigured(customCommand)) {
      const adapter = customCommandAgent(customCommand, this.#probes);
      const capability = await detect(adapter);
      if (capability.available) return { adapter, capability };
    }
    return undefined;
  }

  /** The same order over the cache: "pending" while something it needs is not detected yet. */
  #pickAutoCached(
    customCommand: string,
    cached: (adapter: AiAgentAdapter) => AgentCapability | undefined,
  ): AiAgentAdapter | undefined | "pending" {
    const candidates = [
      ...this.#autoOrder(customCommand).map((adapter) => ({ adapter, tier: true })),
      ...this.#adapters.filter((adapter) => this.#nominalIntegration(adapter) === "extension").map((adapter) => ({ adapter, tier: false })),
      ...(customCommandConfigured(customCommand) ? [{ adapter: customCommandAgent(customCommand, this.#probes), tier: false }] : []),
    ];
    for (const { adapter, tier } of candidates) {
      const capability = cached(adapter);
      if (!capability) {
        // Not asked yet: wait for the refresh that is asking, or pass it over.
        if (this.#detecting > 0) return "pending";
        continue;
      }
      if (capability.available && (!tier || this.#tierAccepts(adapter, capability))) return adapter;
    }
    return undefined;
  }

  /**
   * Tiers 1–3 as one list: the last-used agent, the extensions (for a native
   * integration), then the CLIs in rank order. A tier-2 extension that turns
   * out to be only a bridge is passed over here and taken in tier 4.
   */
  #autoOrder(customCommand: string): AiAgentAdapter[] {
    const last = this.#lastUsed(customCommand);
    const extensions = this.#adapters.filter((adapter) => this.#nominalIntegration(adapter) === "extension");
    const clis = this.#adapters
      .filter((adapter) => this.#nominalIntegration(adapter) === "cli")
      .sort((a, b) => Number(b.capturedReview !== undefined) - Number(a.capturedReview !== undefined));
    const order = [...extensions, ...clis].filter((adapter) => adapter.id !== last?.id);
    return last ? [last, ...order] : order;
  }

  /** Whether a candidate fits the tier it was listed in: only a native extension beats a CLI. */
  #tierAccepts(adapter: AiAgentAdapter, capability: AgentCapability): boolean {
    if (adapter.id === this.#lastUsed("")?.id) return true;
    return this.#nominalIntegration(adapter) !== "extension" || capability.integration === "native-extension";
  }

  /** The last agent a handoff reached, when it is one this service can still offer. */
  #lastUsed(customCommand: string): AiAgentAdapter | undefined {
    const id = this.#lastAgent?.get() ?? this.#lastInMemory;
    if (id === undefined) return undefined;
    // A custom command is last-used only while it is still configured: Auto-detect
    // takes one only when it was set on purpose.
    if (id === "custom") return customCommandConfigured(customCommand) ? customCommandAgent(customCommand, this.#probes) : undefined;
    return this.#adapters.find((adapter) => adapter.id === id);
  }

  /** Which tier an adapter is listed in, from what it is rather than from what detection said. */
  #nominalIntegration(adapter: AiAgentAdapter): "cli" | "extension" | "custom" {
    if (adapter.id === "custom") return "custom";
    return EXTENSION_AGENT_IDS.has(adapter.id) ? "extension" : "cli";
  }

  #nothingFound(): string {
    const named = this.#adapters.map((adapter) => adapter.label);
    const list = named.length <= 1 ? named.join("") : `${named.slice(0, -1).join(", ")} and ${named.at(-1)}`;
    return `No supported AI agent detected. BugPilot looked for ${list}.`;
  }

  #isCached(key: string): boolean {
    const cached = this.#cache.get(key);
    return cached !== undefined && this.#now() - cached.at < DETECTION_TTL_MS;
  }

  #key(adapter: AiAgentAdapter, customCommand: string): string {
    return adapter.id === "custom" ? `custom\u0000${customCommand.trim()}` : adapter.id;
  }

  /**
   * One adapter's capability, bounded in time and never thrown. A refresh takes
   * it from the cache or joins one in flight; a handoff (`fresh`) always asks
   * for itself — each press is answered by its own probe, as before, so one
   * press finishing can never be what lets another through.
   */
  #detect(adapter: AiAgentAdapter, customCommand: string, fresh: boolean): Promise<AgentCapability> {
    const key = this.#key(adapter, customCommand);
    if (!fresh) {
      if (this.#isCached(key)) return Promise.resolve(this.#cache.get(key)!.capability);
      const running = this.#inFlight.get(key);
      if (running) return running;
    }
    const detection: Promise<AgentCapability> = boundedDetection(adapter).then((capability) => {
      this.#cache.set(key, { capability, at: this.#now() });
      // Two presses can overlap: only the newest detection is the one to join.
      if (this.#inFlight.get(key) === detection) this.#inFlight.delete(key);
      this.#log?.info(describeDetection(adapter, capability));
      return capability;
    });
    this.#inFlight.set(key, detection);
    return detection;
  }
}

const EXTENSION_AGENT_IDS: ReadonlySet<string> = new Set(EXTENSION_AGENTS.map((definition) => definition.id));

/** `adapter.detect()`, as an answer whatever it does: a throw or a hang is "unavailable". */
async function boundedDetection(adapter: AiAgentAdapter): Promise<AgentCapability> {
  const failed = (detail: string): AgentCapability => ({
    installed: false,
    available: false,
    integration: "cli",
    canReceivePrompt: false,
    canModifyWorkspace: false,
    detail,
    reason: `${adapter.label} could not be checked: ${detail.toLowerCase()}. Try again, or choose another AI Agent.`,
  });
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      adapter.detect(),
      new Promise<AgentCapability>((resolve) => {
        timer = setTimeout(() => resolve(failed("Detection timed out")), DETECTION_TIMEOUT_MS);
        // Never the thing that keeps a process alive.
        (timer as { unref?: () => void }).unref?.();
      }),
    ]);
  } catch {
    return failed("Detection failed");
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/** One log line per detection: which agent, and what was found — never a prompt or a path. */
function describeDetection(adapter: AiAgentAdapter, capability: AgentCapability): string {
  if (capability.available) {
    if (capability.integration === "extension-bridge") return `${adapter.label} installed, no native integration.`;
    if (capability.integration === "native-extension") return `${adapter.label} installed, native integration available.`;
    return `${adapter.label} available.`;
  }
  return `${adapter.label} not available (${capability.detail}).`;
}

/**
 * How Review with AI reaches the resolved agent: a captured one-shot run, when
 * the agent has one and the host can run it; otherwise the adapter's own
 * handoff, as Fix with AI's.
 *
 * A custom command is never captured. It is a shell template written for a
 * terminal, and running it for its stdout would put the review prompt into
 * shell text — the thing `isPlainPrompt` exists to keep off command lines.
 */
export function capturedReviewOf(
  resolution: AgentResolution,
  capture: boolean,
): { readonly label: string; readonly command: string; readonly invocation: CapturedReviewInvocation } | undefined {
  if (!capture || resolution.kind !== "ready") return undefined;
  const captured = resolution.adapter.capturedReview;
  return captured ? { label: resolution.adapter.label, ...captured } : undefined;
}

/**
 * One shell argument.
 *
 * JSON's escaping happens to be right for both of the shells this lands in: a
 * double-quoted string with `"` and `\` escaped is understood by cmd/PowerShell
 * and by every POSIX shell — for the plain prompts `isPlainPrompt` lets through.
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
