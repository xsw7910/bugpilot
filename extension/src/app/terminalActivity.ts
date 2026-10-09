/**
 * Whether the agent BugPilot typed into a terminal is still running there.
 *
 * A handoff opens a terminal and types the agent's command line into its shell.
 * When the agent exits — `/exit`, Ctrl+C, a crash — the shell stays, back at its
 * prompt, so the terminal is still open and its `exitStatus` still undefined: an
 * open terminal says nothing about the agent. What can say something is VS
 * Code's shell integration, which reports each command line the shell starts
 * and ends (VS Code 1.93 and later, in shells it supports — PowerShell, bash,
 * zsh, fish, Git Bash; not cmd.exe). This keeps that account per terminal.
 *
 * Three answers, and only what was reported is claimed:
 *
 * - `running` — a command is in progress (a start with no end yet), or one was
 *   just typed and its start is not reported yet (within `LAUNCH_GRACE_MS`,
 *   so a second press right after a launch reveals rather than launching twice);
 * - `exited` — the shell reported a command ending and nothing is running: the
 *   prompt is back, so the agent is not running in that terminal;
 * - `unknown` — nothing was reported: shell integration is off, unsupported, or
 *   older than this API, or the terminal is not one this window started.
 *
 * Node-only and generic over the terminal object, so it is tested without VS Code.
 */

export type AgentActivity = "running" | "exited" | "unknown";

/** How long a typed command line counts as running before its start is reported. */
export const LAUNCH_GRACE_MS = 15_000;

interface Account {
  /** Commands reported started and not yet ended. */
  active: number;
  /** Shell integration has reported something for this terminal. */
  reported: boolean;
  /** When BugPilot last typed a command line here that no report has caught up with. */
  sentAt: number | undefined;
}

export class TerminalActivity<T extends object> {
  readonly #accounts = new WeakMap<T, Account>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  /** BugPilot typed a command line into this terminal. */
  sent(terminal: T): void {
    this.#account(terminal).sentAt = this.#now();
  }

  /** Shell integration: a command line started in this terminal. */
  started(terminal: T): void {
    const account = this.#accounts.get(terminal);
    if (!account) return;
    account.active += 1;
    account.reported = true;
    account.sentAt = undefined;
  }

  /**
   * Shell integration: a command line ended. Also when its start was never
   * reported (integration came up mid-command): it ended all the same.
   */
  ended(terminal: T): void {
    const account = this.#accounts.get(terminal);
    if (!account) return;
    account.active = Math.max(0, account.active - 1);
    account.reported = true;
    account.sentAt = undefined;
  }

  activity(terminal: T): AgentActivity {
    const account = this.#accounts.get(terminal);
    if (!account) return "unknown";
    if (account.active > 0) return "running";
    if (account.sentAt !== undefined) {
      // Typed, and no report since: running for a moment, then honestly unknown —
      // never "exited" on the strength of silence.
      return this.#now() - account.sentAt < LAUNCH_GRACE_MS ? "running" : "unknown";
    }
    return account.reported ? "exited" : "unknown";
  }

  #account(terminal: T): Account {
    let account = this.#accounts.get(terminal);
    if (!account) {
      account = { active: 0, reported: false, sentAt: undefined };
      this.#accounts.set(terminal, account);
    }
    return account;
  }
}
