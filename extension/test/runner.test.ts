import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";

import { Runner } from "../src/runner.ts";
import type { SpawnFn } from "../src/runner.ts";
import { ProtocolError } from "../src/protocol.ts";

/** A child process stand-in: emit output and exits on demand. */
class FakeChild extends EventEmitter {
  stdout = new EventEmitter() as EventEmitter & { setEncoding(encoding: string): void };
  stderr = new EventEmitter() as EventEmitter & { setEncoding(encoding: string): void };
  pid: number | undefined = 4242;
  exitCode: number | null = null;
  killed: string[] = [];

  constructor() {
    super();
    this.stdout.setEncoding = () => {};
    this.stderr.setEncoding = () => {};
  }

  kill(signal?: string): boolean {
    this.killed.push(signal ?? "SIGTERM");
    return true;
  }

  out(chunk: string): void {
    this.stdout.emit("data", chunk);
  }
  err(chunk: string): void {
    this.stderr.emit("data", chunk);
  }
  close(code: number | null): void {
    this.exitCode = code;
    this.emit("close", code);
  }
}

interface Recorded {
  command: string;
  args: string[];
  options: SpawnOptions;
}

function fakeSpawn(platform = "linux"): {
  spawn: SpawnFn;
  calls: Recorded[];
  child: () => FakeChild;
  runner: (executable?: string) => Runner;
} {
  const calls: Recorded[] = [];
  let last: FakeChild | undefined;
  const spawn: SpawnFn = (command, args, options) => {
    calls.push({ command, args, options });
    // taskkill is a side call, not the run itself; keep `child()` pointing at
    // the process under test.
    if (command === "taskkill") return new FakeChild() as unknown as ChildProcess;
    last = new FakeChild();
    return last as unknown as ChildProcess;
  };
  return {
    spawn,
    calls,
    child: () => {
      assert.ok(last, "nothing was spawned");
      return last;
    },
    runner: (executable = "bugpilot") => new Runner(executable, spawn, platform),
  };
}

const envelope = (extra: Record<string, unknown> = {}) =>
  `${JSON.stringify({ schema_version: 1, ok: true, command: "doctor", warnings: [], ...extra })}\n`;

// --- basic running ---------------------------------------------------------

test("collects stdout, stderr and the exit code", async () => {
  const harness = fakeSpawn();
  const promise = harness.runner().run(["doctor"], { cwd: "/repo" });
  const child = harness.child();
  child.out("hello ");
  child.out("world");
  child.err("a warning");
  child.close(0);

  const result = await promise;
  assert.equal(result.stdout, "hello world");
  assert.equal(result.stderr, "a warning");
  assert.equal(result.code, 0);
  assert.equal(result.aborted, false);
});

test("runs in the given repository and layers the caller environment", async () => {
  const harness = fakeSpawn();
  const promise = harness.runner().run(["doctor"], { cwd: "/repo", env: { JIRA_TOKEN: "t" } });
  harness.child().close(0);
  await promise;

  const call = harness.calls[0]!;
  assert.equal(call.options.cwd, "/repo");
  const env = call.options.env as Record<string, string>;
  assert.equal(env["JIRA_TOKEN"], "t");
  // Ambient PATH must survive, or a bugpilot resolved through PATH stops
  // working. Found case-insensitively, and that is the whole point: Windows
  // spells it `Path`, and `{ ...process.env }` keeps whatever casing the parent
  // had — only `process.env` itself is case-insensitive. This assertion used to
  // read `env["PATH"]`, which passed under Git Bash and failed under
  // PowerShell, on the same commit.
  const path = Object.keys(env).find((key) => key.toUpperCase() === "PATH");
  assert.ok(path !== undefined, `no PATH in ${Object.keys(env).join(", ")}`);
  assert.notEqual(env[path], "");
});

test("a spawn error rejects rather than resolving with an empty result", async () => {
  const harness = fakeSpawn();
  const promise = harness.runner().run(["doctor"], { cwd: "/repo" });
  const failure = Object.assign(new Error("spawn ENOENT"), { code: "ENOENT" });
  harness.child().emit("error", failure);

  await assert.rejects(promise, /ENOENT/);
});

// --- JSON mode -------------------------------------------------------------

test("runJson appends the flag and parses the envelope", async () => {
  const harness = fakeSpawn();
  const promise = harness.runner().runJson(["doctor"], { cwd: "/repo" });
  const child = harness.child();
  child.out(envelope({ report: { python_ok: true } }));
  child.close(0);

  const parsed = await promise;
  assert.equal(parsed.ok, true);
  assert.deepEqual(harness.calls[0]!.args, ["doctor", "--json"]);
});

test("a failure envelope with a non-zero exit is returned, not thrown", async () => {
  // The CLI writes the envelope *and* exits non-zero on purpose; the caller
  // wants the error.code, so this is a normal outcome.
  const harness = fakeSpawn();
  const promise = harness.runner().runJson(["status", "JR-1"], { cwd: "/repo" });
  const child = harness.child();
  child.out(
    `${JSON.stringify({
      schema_version: 1,
      ok: false,
      command: "status",
      error: { code: "WORK_ITEM_NOT_FOUND", message: "nope" },
    })}\n`,
  );
  child.close(1);

  const parsed = await promise;
  assert.equal(parsed.ok, false);
  if (!parsed.ok) assert.equal(parsed.error.code, "WORK_ITEM_NOT_FOUND");
});

test("a cancelled JSON run throws instead of parsing empty output", async () => {
  const harness = fakeSpawn();
  const controller = new AbortController();
  const promise = harness
    .runner()
    .runJson(["doctor"], { cwd: "/repo", signal: controller.signal });
  controller.abort();
  harness.child().close(null);

  await assert.rejects(promise, ProtocolError);
});

// --- streaming -------------------------------------------------------------

test("streams events as they arrive and reports termination", async () => {
  const harness = fakeSpawn();
  const seen: string[] = [];
  const promise = harness
    .runner()
    .runStreaming(["bug", "JR-1"], { cwd: "/repo" }, (event) => seen.push(event.type));
  const child = harness.child();
  child.out(`${JSON.stringify({ schema_version: 1, type: "started", work_item_id: "JR-1", source: "jira" })}\n`);
  child.out(`${JSON.stringify({ schema_version: 1, type: "completed", ok: true })}\n`);
  child.close(0);

  const { terminated, events } = await promise;
  assert.deepEqual(seen, ["started", "completed"]);
  assert.equal(terminated, true);
  assert.equal(events.length, 2);
  assert.deepEqual(harness.calls[0]!.args, ["bug", "JR-1", "--json-lines"]);
});

test("a killed stream is reported as unterminated", async () => {
  // No `completed` event means the process died mid-run; the caller needs to
  // know rather than leaving a progress view stuck on the last step.
  const harness = fakeSpawn();
  const promise = harness.runner().runStreaming(["bug", "JR-1"], { cwd: "/repo" }, () => {});
  const child = harness.child();
  child.out(`${JSON.stringify({ schema_version: 1, type: "step_started", step: "code_search" })}\n`);
  child.close(null);

  const { terminated } = await promise;
  assert.equal(terminated, false);
});

// --- cancellation and process trees ---------------------------------------

test("cancelling kills the process group on POSIX", async () => {
  const harness = fakeSpawn("linux");
  const controller = new AbortController();
  const promise = harness
    .runner()
    .run(["bug", "JR-1"], { cwd: "/repo", signal: controller.signal });
  controller.abort();
  harness.child().close(null);

  const result = await promise;
  assert.equal(result.aborted, true);
  // detached:true is what creates the group that a negative pid can target.
  assert.equal(harness.calls[0]!.options.detached, true);
});

test("cancelling on Windows uses taskkill so ripgrep dies too", async () => {
  // bugpilot shells out to rg and git; child.kill() would leave a ripgrep
  // sweeping a large repository after the developer pressed Stop.
  const harness = fakeSpawn("win32");
  const controller = new AbortController();
  const promise = harness
    .runner()
    .run(["bug", "JR-1"], { cwd: "/repo", signal: controller.signal });
  controller.abort();
  harness.child().close(null);
  await promise;

  const kill = harness.calls.find((call) => call.command === "taskkill");
  assert.ok(kill, "expected a taskkill call");
  assert.deepEqual(kill.args, ["/pid", "4242", "/T", "/F"]);
  assert.equal(harness.calls[0]!.options.detached, false);
});

test("an already-aborted signal kills without waiting for output", async () => {
  const harness = fakeSpawn("win32");
  const controller = new AbortController();
  controller.abort();
  const promise = harness
    .runner()
    .run(["bug", "JR-1"], { cwd: "/repo", signal: controller.signal });
  harness.child().close(null);

  assert.equal((await promise).aborted, true);
  assert.ok(harness.calls.some((call) => call.command === "taskkill"));
});

test("a timeout aborts the run", async () => {
  const harness = fakeSpawn("linux");
  const promise = harness.runner().run(["bug", "JR-1"], { cwd: "/repo", timeoutMs: 5 });
  await new Promise((resolve) => setTimeout(resolve, 25));
  harness.child().close(null);

  assert.equal((await promise).aborted, true);
});

test("an exited child is not killed again", async () => {
  const harness = fakeSpawn("win32");
  const controller = new AbortController();
  const promise = harness
    .runner()
    .run(["doctor"], { cwd: "/repo", signal: controller.signal });
  harness.child().close(0);
  await promise;
  controller.abort();

  assert.equal(harness.calls.filter((call) => call.command === "taskkill").length, 0);
});


// --- kill escalation, crash safety and the argv guard (review follow-up) ---

test("a kill that does not take is escalated and then abandoned", (t) => {
  // A kill is a request, not a guarantee: a wedged process or a denied
  // taskkill swallows it. `timeoutMs` promises to abandon the run, so the
  // promise must settle even when the child never closes.
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const harness = fakeSpawn("win32");
  const controller = new AbortController();
  const promise = harness.runner().run(["bug", "JR-1"], { cwd: "/repo", signal: controller.signal });

  controller.abort();
  assert.equal(harness.calls.filter((call) => call.command === "taskkill").length, 1);

  t.mock.timers.tick(2_500);
  assert.equal(
    harness.calls.filter((call) => call.command === "taskkill").length,
    2,
    "expected a second, forced kill after the grace period",
  );

  t.mock.timers.tick(6_000);
  // The child is deliberately never closed.
  return promise.then((result) => {
    assert.equal(result.aborted, true);
    assert.equal(result.code, null);
  });
});

test("a stream error does not take down the extension host", async () => {
  // An unlistened 'error' on a pipe is an uncaught exception, which would kill
  // the whole extension host rather than the one run.
  const harness = fakeSpawn();
  const promise = harness.runner().run(["doctor"], { cwd: "/repo" });
  const child = harness.child();

  assert.doesNotThrow(() => child.stdout.emit("error", new Error("EPIPE")));
  assert.doesNotThrow(() => child.stderr.emit("error", new Error("EPIPE")));

  child.close(0);
  assert.equal((await promise).code, 0);
});

test("a taskkill that cannot spawn does not take down the extension host", async () => {
  // taskkill can be missing from PATH in a stripped container, or blocked.
  // That must not turn a cancelled run into a crash.
  const calls: string[] = [];
  let run: FakeChild | undefined;
  const spawn: SpawnFn = (command) => {
    calls.push(command);
    const child = new FakeChild();
    if (command === "taskkill") {
      // After the caller has had a chance to attach its listener.
      queueMicrotask(() => child.emit("error", new Error("spawn taskkill ENOENT")));
    } else {
      run = child;
    }
    return child as unknown as ChildProcess;
  };

  const controller = new AbortController();
  const promise = new Runner("bugpilot", spawn, "win32").run(["bug", "JR-1"], {
    cwd: "/repo",
    signal: controller.signal,
  });
  controller.abort();
  await Promise.resolve();
  run!.close(null);

  assert.equal((await promise).aborted, true);
  assert.ok(calls.includes("taskkill"));
});

test("the argv guard runs before spawning, not after", async () => {
  // secrets.ts declaring the invariant is not the same as something checking
  // it; this is the one call site that has both argv and the secret env.
  const harness = fakeSpawn();
  const token = "ATATT3xFfGF0abcdef1234567890";
  await assert.rejects(
    harness.runner().run(["bug", token], { cwd: "/repo", env: { JIRA_TOKEN: token } }),
    /credential appeared in the command line/,
  );
  assert.equal(harness.calls.length, 0, "the process must not be spawned at all");
});

test("a stream from a newer contract reports the version instead of looking like a crash", async () => {
  // Dropping every event silently would render as a run that stopped after its
  // first step. The caller needs to be able to say "update the extension".
  const harness = fakeSpawn();
  const seen: string[] = [];
  const promise = harness
    .runner()
    .runStreaming(["bug", "JR-1"], { cwd: "/repo" }, (event) => seen.push(event.type));
  const child = harness.child();
  child.out(`${JSON.stringify({ schema_version: 2, type: "started", work_item_id: "JR-1" })}
`);
  child.close(0);

  const { foreignVersion, terminated } = await promise;
  assert.equal(foreignVersion, 2);
  assert.equal(terminated, false);
  assert.deepEqual(seen, []);
});
