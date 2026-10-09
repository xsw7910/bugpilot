/**
 * The handoff's terminals against a `vscode.window` without VS Code
 * (`host/agentTerminals.ts`), and above all against the VS Codes this
 * extension supports that have no shell-execution events: 1.90–1.92, where
 * `onDidStartTerminalShellExecution` is absent or a proposed API that throws
 * when an extension calls it. Activation must go on, and every agent's
 * activity must be honestly unknown after its launch grace.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { createAgentTerminals } from "../src/host/agentTerminals.ts";
import type { HostTerminalWindow } from "../src/host/agentTerminals.ts";
import { LAUNCH_GRACE_MS } from "../src/app/terminalActivity.ts";

class FakeTerminal {
  exitStatus: { code: number } | undefined = undefined;
  shown = 0;
  readonly sent: string[] = [];
  readonly name: string;
  readonly cwd: string;
  readonly env: Record<string, string>;
  constructor(name: string, cwd: string, env: Record<string, string>) {
    this.name = name;
    this.cwd = cwd;
    this.env = env;
  }
  show(): void {
    this.shown += 1;
  }
  sendText(text: string): void {
    this.sent.push(text);
  }
}

/** The proposed-API refusal VS Code 1.90–1.92 throws at an extension that did not enable it. */
const PROPOSAL_ERROR = "Extension 'ShiweiX.bugpilot' CANNOT use API proposal: terminalShellIntegration.";

type Api = "absent" | "gated" | "gated-getter" | "start-only" | "end-throws" | "present";

/** A `vscode.window` with the terminals it made, as each VS Code version would offer the execution events. */
function fakeWindow(api: Api) {
  const terminals: FakeTerminal[] = [];
  const listeners = { start: [] as ((event: { terminal: FakeTerminal }) => unknown)[], end: [] as ((event: { terminal: FakeTerminal }) => unknown)[] };
  const disposed: string[] = [];
  const subscribe = (kind: "start" | "end") => (listener: (event: { terminal: FakeTerminal }) => unknown) => {
    listeners[kind].push(listener);
    return { dispose: () => disposed.push(kind) };
  };
  const refuse = () => {
    throw new Error(PROPOSAL_ERROR);
  };
  const window: Record<string, unknown> = {
    terminals,
    createTerminal: (options: { name: string; cwd: string; env: Record<string, string> }) => {
      const terminal = new FakeTerminal(options.name, options.cwd, options.env);
      terminals.push(terminal);
      return terminal;
    },
  };
  if (api === "gated") Object.assign(window, { onDidStartTerminalShellExecution: refuse, onDidEndTerminalShellExecution: refuse });
  if (api === "gated-getter") {
    Object.defineProperty(window, "onDidStartTerminalShellExecution", { get: refuse });
    Object.defineProperty(window, "onDidEndTerminalShellExecution", { get: refuse });
  }
  if (api === "start-only") window.onDidStartTerminalShellExecution = subscribe("start");
  if (api === "end-throws") Object.assign(window, { onDidStartTerminalShellExecution: subscribe("start"), onDidEndTerminalShellExecution: refuse });
  if (api === "present") Object.assign(window, { onDidStartTerminalShellExecution: subscribe("start"), onDidEndTerminalShellExecution: subscribe("end") });
  return {
    window: window as unknown as HostTerminalWindow<FakeTerminal>,
    terminals,
    disposed,
    start: (terminal: FakeTerminal) => listeners.start.forEach((listener) => listener({ terminal })),
    end: (terminal: FakeTerminal) => listeners.end.forEach((listener) => listener({ terminal })),
  };
}

function setup(api: Api) {
  let now = 50_000;
  const subscriptions: { dispose(): unknown }[] = [];
  const fake = fakeWindow(api);
  const host = createAgentTerminals(fake.window, { subscriptions, env: () => ({ NoDefaultCurrentDirectoryInExePath: "1" }), now: () => now });
  return { ...fake, host, subscriptions, advance: (ms: number) => (now += ms) };
}

const AGENT = "Fix with AI · JR-1";
const named = (name: string) => (candidate: string) => candidate === name;

for (const api of ["absent", "gated", "gated-getter"] as const) {
  test(`without the shell-execution API (${api}): nothing subscribed, nothing thrown, and the agent unknown after its launch`, () => {
    const s = setup(api);
    assert.equal(s.host.tracksExecutions, false);
    assert.deepEqual(s.subscriptions, []);

    s.host.runInTerminal(AGENT, "/repo", "claude --session-id 1 \"Read it.\"");
    const terminal = s.terminals[0]!;
    assert.deepEqual({ cwd: terminal.cwd, env: terminal.env, shown: terminal.shown, sent: terminal.sent }, {
      cwd: "/repo",
      env: { NoDefaultCurrentDirectoryInExePath: "1" },
      shown: 1,
      sent: ["claude --session-id 1 \"Read it.\""],
    });
    // Just launched: running, so a second press right away only reveals.
    assert.equal(s.host.terminalActivity(named(AGENT)), "running");
    s.advance(LAUNCH_GRACE_MS);
    // Nothing will ever report on it: unknown, never "exited".
    assert.equal(s.host.terminalActivity(named(AGENT)), "unknown");
    assert.equal(s.host.revealTerminal(named(AGENT)), true);
    assert.equal(terminal.shown, 2);
    assert.deepEqual(terminal.sent, ["claude --session-id 1 \"Read it.\""], "revealing typed something");
  });
}

test("both events or neither: an end that cannot be subscribed leaves no start behind", () => {
  for (const api of ["start-only", "end-throws"] as const) {
    const s = setup(api);
    assert.equal(s.host.tracksExecutions, false, api);
    assert.deepEqual(s.subscriptions, [], api);
    assert.deepEqual(s.disposed, api === "end-throws" ? ["start"] : [], api);
  }
});

test("with the API (VS Code 1.93+): both subscribed for disposal, and a start and an end tell running from exited", () => {
  const s = setup("present");
  assert.equal(s.host.tracksExecutions, true);
  assert.equal(s.subscriptions.length, 2);
  s.host.runInTerminal(AGENT, "/repo", "claude \"Read it.\"");
  const terminal = s.terminals[0]!;
  s.start(terminal);
  s.advance(LAUNCH_GRACE_MS * 10);
  assert.equal(s.host.terminalActivity(named(AGENT)), "running");
  s.end(terminal);
  assert.equal(s.host.terminalActivity(named(AGENT)), "exited");
  // The restart is typed into that same terminal, which is brought forward.
  assert.equal(s.host.sendToTerminal(named(AGENT), "claude --resume 1"), true);
  assert.deepEqual(terminal.sent, ["claude \"Read it.\"", "claude --resume 1"]);
  assert.equal(s.host.terminalActivity(named(AGENT)), "running");
});

test("a terminal BugPilot did not start is unknown whatever its shell reports", () => {
  const s = setup("present");
  const own = s.window.createTerminal({ name: AGENT, cwd: "/repo", env: {} });
  s.start(own);
  s.end(own);
  assert.equal(s.host.terminalActivity(named(AGENT)), "unknown");
});

test("closed — removed, or its shell gone — is closed, and nothing is typed or shown", () => {
  const s = setup("absent");
  s.host.runInTerminal(AGENT, "/repo", "agent");
  s.terminals[0]!.exitStatus = { code: 0 };
  assert.equal(s.host.terminalActivity(named(AGENT)), "closed");
  assert.equal(s.host.sendToTerminal(named(AGENT), "agent"), false);
  assert.equal(s.host.revealTerminal(named(AGENT)), false);
  s.terminals.length = 0;
  assert.equal(s.host.terminalActivity(named(AGENT)), "closed");
});

test("the newest open terminal of that name is the session: a restart in a new terminal is the one found next", () => {
  const s = setup("absent");
  s.host.runInTerminal(AGENT, "/repo", "agent");
  s.host.runInTerminal(AGENT, "/repo", "agent --resume");
  assert.equal(s.host.sendToTerminal(named(AGENT), "typed"), true);
  assert.deepEqual(s.terminals.map((terminal) => terminal.sent), [["agent"], ["agent --resume", "typed"]]);
});
