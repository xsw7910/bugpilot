/**
 * The terminals a handoff opens, and what their agents are doing
 * (`app/terminalActivity.ts`) — the controller's terminal ports, written
 * against the few members of `vscode.window` they use so they are tested
 * without VS Code.
 *
 * What a terminal's agent is doing comes from VS Code's shell-integration
 * execution events, `onDidStartTerminalShellExecution` and
 * `onDidEndTerminalShellExecution`. They are stable API from VS Code 1.93. This
 * extension supports 1.90, where they are either absent or a *proposed* API —
 * present on `vscode.window`, but throwing when an extension that did not
 * enable the proposal calls it. Both read as "not available": nothing is
 * subscribed, activation goes on, and every terminal's activity is `unknown`
 * after its launch grace, so Open AI Session focuses and asks rather than
 * typing into a terminal whose agent may still be running.
 */

import { TerminalActivity } from "../app/terminalActivity.ts";
import type { AgentActivity } from "../app/terminalActivity.ts";

/** The part of a `vscode.Terminal` used here. */
export interface HostTerminal {
  readonly name: string;
  /** Undefined while the terminal's shell is running. */
  readonly exitStatus: unknown;
  show(): void;
  sendText(text: string, addNewLine?: boolean): void;
}

/** A shell-integration execution event: only its terminal is read. */
type ExecutionEvent<T> = { readonly terminal: T };
type Subscribe<T> = (listener: (event: ExecutionEvent<T>) => unknown) => { dispose(): unknown };

/** The part of `vscode.window` used here. The two events are VS Code 1.93's, looked up at run time. */
export interface HostTerminalWindow<T extends HostTerminal> {
  readonly terminals: readonly T[];
  createTerminal(options: { name: string; cwd: string; env: Record<string, string> }): T;
  readonly onDidStartTerminalShellExecution?: unknown;
  readonly onDidEndTerminalShellExecution?: unknown;
}

export interface AgentTerminals {
  /** Open a terminal in `cwd`, bring it forward, and type one command line into it. */
  runInTerminal(name: string, cwd: string, commandLine: string): void;
  /** Bring the newest open terminal whose name matches forward; false when there is none. */
  revealTerminal(matches: (name: string) => boolean): boolean;
  /** What the newest open matching terminal's agent is doing; `closed` when none is open. */
  terminalActivity(matches: (name: string) => boolean): AgentActivity | "closed";
  /** Type a command line into the newest open matching terminal and bring it forward; false when none. */
  sendToTerminal(matches: (name: string) => boolean, commandLine: string): boolean;
  /** Whether this VS Code reports shell executions to this extension (1.93 and later). */
  readonly tracksExecutions: boolean;
}

export function createAgentTerminals<T extends HostTerminal>(
  window: HostTerminalWindow<T>,
  options: {
    readonly subscriptions: { push(...items: { dispose(): unknown }[]): unknown };
    /** What every terminal adds to the environment it inherits. */
    readonly env: () => Record<string, string>;
    readonly now?: () => number;
  },
): AgentTerminals {
  // Kept only for terminals typed into here; a terminal BugPilot did not start
  // (restored after a reload, the developer's own) stays unknown.
  const activity = new TerminalActivity<T>(options.now);
  const tracksExecutions = subscribeToExecutions(window, activity, options.subscriptions);
  // The newest match that is still open: a later attempt's terminal is the
  // session to go back to, and one whose shell has exited is not a session.
  const newestOpen = (matches: (name: string) => boolean) =>
    [...window.terminals].reverse().find((candidate) => candidate.exitStatus === undefined && matches(candidate.name));
  return {
    tracksExecutions,
    runInTerminal: (name, cwd, commandLine) => {
      // The shell resolves the agent's name; with these additions cmd.exe — and
      // every program started inside the terminal, such as an npm shim's `node` —
      // skips the repository, the working directory.
      const terminal = window.createTerminal({ name, cwd, env: { ...options.env() } });
      terminal.show();
      activity.sent(terminal);
      terminal.sendText(commandLine, true);
    },
    revealTerminal: (matches) => {
      const terminal = newestOpen(matches);
      if (!terminal) return false;
      terminal.show();
      return true;
    },
    terminalActivity: (matches) => {
      const terminal = newestOpen(matches);
      return terminal ? activity.activity(terminal) : "closed";
    },
    sendToTerminal: (matches, commandLine) => {
      const terminal = newestOpen(matches);
      if (!terminal) return false;
      terminal.show();
      activity.sent(terminal);
      terminal.sendText(commandLine, true);
      return true;
    },
  };
}

/**
 * Both events, or neither: an end without its start would count a running
 * agent as exited. Any failure — absent, not a function, or the proposed-API
 * error of VS Code 1.90–1.92 — leaves nothing subscribed.
 */
function subscribeToExecutions<T extends HostTerminal>(
  window: HostTerminalWindow<T>,
  activity: TerminalActivity<T>,
  subscriptions: { push(...items: { dispose(): unknown }[]): unknown },
): boolean {
  let started: { dispose(): unknown } | undefined;
  try {
    const onStart = window.onDidStartTerminalShellExecution;
    const onEnd = window.onDidEndTerminalShellExecution;
    if (typeof onStart !== "function" || typeof onEnd !== "function") return false;
    started = (onStart as Subscribe<T>).call(window, (event) => activity.started(event.terminal));
    const ended = (onEnd as Subscribe<T>).call(window, (event) => activity.ended(event.terminal));
    subscriptions.push(started, ended);
    return true;
  } catch {
    try {
      started?.dispose();
    } catch {
      // Nothing left to undo.
    }
    return false;
  }
}
