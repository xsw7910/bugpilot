/**
 * Running the bugpilot CLI as a child process.
 *
 * The extension is a shell over the CLI (docs/adapter_design.md §4.1), so this
 * is where every interaction with bugpilot actually happens. Two things here
 * are easy to get wrong and expensive to get wrong:
 *
 *  - **Killing a run must kill its children.** bugpilot spawns `rg` and `git`.
 *    On Windows `child.kill()` only signals the direct child, leaving a ripgrep
 *    sweeping a large repository after the developer pressed Stop.
 *  - **Credentials go in the environment, never in argv.** Command lines are
 *    visible to any process listing on the machine.
 *
 * No `vscode` import: cancellation arrives as a standard `AbortSignal`.
 */

import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";

import { EventStreamReader, ProtocolError, parseEnvelope } from "./protocol.ts";
import { assertNoSecretsInArgs } from "./secrets.ts";
import type { Envelope, StreamEvent } from "./protocol.ts";

/** The slice of `child_process.spawn` this module needs, so tests can supply one. */
export type SpawnFn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

/** Grace period before a polite kill becomes SIGKILL / a second taskkill. */
const KILL_ESCALATION_MS = 2_000;
/** After this the run is settled as aborted even if the child never closed. */
const KILL_GIVE_UP_MS = 8_000;

export interface RunOptions {
  /** Absolute path to the repository bugpilot should operate on. */
  readonly cwd: string;
  /** Extra environment for the child. This is where secrets belong. */
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  /** Milliseconds before the run is abandoned. 0 disables the timeout. */
  readonly timeoutMs?: number;
}

export interface RunResult {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** True when the run ended because it was cancelled or timed out. */
  readonly aborted: boolean;
}

export class Runner {
  readonly #executable: string;
  readonly #spawn: SpawnFn;
  readonly #platform: string;

  constructor(executable: string, spawn: SpawnFn = nodeSpawn, platform: string = process.platform) {
    this.#executable = executable;
    this.#spawn = spawn;
    this.#platform = platform;
  }

  /** Run a command to completion and collect its output. */
  run(args: readonly string[], options: RunOptions): Promise<RunResult> {
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      const child = this.#start(args, options);
      const finish = this.#wire(child, options, () => ({ stdout, stderr }), resolve, reject);

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      finish();
    });
  }

  /**
   * Run a `--json` command and parse its single envelope.
   *
   * A non-zero exit with a well-formed failure envelope is a normal outcome, not
   * a throw: the CLI writes the envelope *and* exits non-zero on purpose, and the
   * caller wants the `error.code`. Only output that breaks the contract throws.
   */
  async runJson(args: readonly string[], options: RunOptions): Promise<Envelope> {
    const result = await this.run([...args, "--json"], options);
    if (result.aborted) {
      throw new ProtocolError("The bugpilot run was cancelled.", result.stdout, result.stderr);
    }
    return parseEnvelope(result.stdout, result.stderr);
  }

  /**
   * Run a `--json-lines` command, delivering events as they arrive.
   *
   * `terminated` is false when the stream carried no `completed` event, which is
   * how a crash or a kill is told apart from a finished run.
   */
  runStreaming(
    args: readonly string[],
    options: RunOptions,
    onEvent: (event: StreamEvent) => void,
  ): Promise<{
    result: RunResult;
    terminated: boolean;
    events: StreamEvent[];
    /** Set when the stream spoke a contract version this client cannot read. */
    foreignVersion?: number;
  }> {
    const reader = new EventStreamReader();
    const seen: StreamEvent[] = [];
    const emit = (events: StreamEvent[]) => {
      for (const event of events) {
        seen.push(event);
        onEvent(event);
      }
    };

    return new Promise((resolve, reject) => {
      let stderr = "";
      const child = this.#start([...args, "--json-lines"], options);

      child.stdout?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => emit(reader.push(chunk)));
      child.stderr?.setEncoding("utf8");
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });

      this.#wire(
        child,
        options,
        () => ({ stdout: "", stderr }),
        (result) => {
          const { events, terminated, foreignVersion } = reader.end();
          emit(events);
          // Passed through so the caller can say "update the extension" instead
          // of reporting a version bump as a mid-run crash.
          resolve({
            result,
            terminated,
            events: seen,
            ...(foreignVersion === undefined ? {} : { foreignVersion }),
          });
        },
        reject,
      )();
    });
  }

  #start(args: readonly string[], options: RunOptions): ChildProcess {
    // The one spawn site that has both argv and the secret environment, so the
    // only place the argv guard can actually be enforced. secrets.ts declaring
    // the invariant is not the same as something checking it.
    assertNoSecretsInArgs(args, options.env ?? {});
    const child = this.#spawn(this.#executable, [...args], {
      cwd: options.cwd,
      // Inherit the ambient environment so PATH and proxy settings still apply,
      // then layer the caller's additions — which is how secrets reach the child
      // without ever appearing in argv.
      env: { ...process.env, ...options.env },
      // A process group is what makes killing the whole tree possible on POSIX.
      // On Windows the group is created by taskkill /T instead (see #kill).
      detached: this.#platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    // An unlistened 'error' on a stream or a child takes down the whole
    // extension host, so every emitter gets a listener even where there is
    // nothing useful to do with the error. The run itself still settles through
    // the child's own 'error'/'close' handlers.
    child.stdout?.on("error", () => {});
    child.stderr?.on("error", () => {});
    return child;
  }

  /** Attach exit/error/cancellation handling. Returns a function that arms it. */
  #wire(
    child: ChildProcess,
    options: RunOptions,
    collect: () => { stdout: string; stderr: string },
    resolve: (result: RunResult) => void,
    reject: (error: Error) => void,
  ): () => void {
    let aborted = false;
    let settled = false;
    let timer: NodeJS.Timeout | undefined;

    let escalation: NodeJS.Timeout | undefined;
    let lastResort: NodeJS.Timeout | undefined;

    const cleanup = () => {
      if (timer) clearTimeout(timer);
      if (escalation) clearTimeout(escalation);
      if (lastResort) clearTimeout(lastResort);
      options.signal?.removeEventListener("abort", onAbort);
    };
    const settle = () => {
      if (settled) return;
      settled = true;
      cleanup();
      const { stdout, stderr } = collect();
      resolve({ code: null, stdout, stderr, aborted: true });
    };
    const onAbort = () => {
      if (settled) return;
      aborted = true;
      this.#kill(child, false);
      // A kill is a request, not a guarantee: a wedged process, a denied
      // taskkill, or an unkillable child can all swallow it. Escalate once, then
      // settle regardless — `timeoutMs` promises to abandon the run, and a
      // promise that never resolves abandons the caller instead.
      escalation = setTimeout(() => this.#kill(child, true), KILL_ESCALATION_MS);
      lastResort = setTimeout(settle, KILL_GIVE_UP_MS);
    };

    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) return;
      settled = true;
      cleanup();
      const { stdout, stderr } = collect();
      resolve({ code, stdout, stderr, aborted });
    });

    return () => {
      if (options.signal?.aborted) {
        onAbort();
        return;
      }
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const timeoutMs = options.timeoutMs ?? 0;
      if (timeoutMs > 0) {
        timer = setTimeout(onAbort, timeoutMs);
      }
    };
  }

  /**
   * Kill the child and everything it started.
   *
   * bugpilot shells out to `rg` and `git`, and on Windows a plain
   * `child.kill()` leaves those running — a ripgrep sweep over a large
   * repository keeps burning CPU after the developer pressed Stop.
   */
  #kill(child: ChildProcess, force: boolean): void {
    if (child.pid === undefined || child.exitCode !== null) return;
    if (this.#platform === "win32") {
      // No signals on Windows; taskkill /T walks the tree, /F is required
      // because a console child does not honour a polite request.
      const killer = this.#spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      // taskkill can itself fail to spawn (missing from PATH in a stripped
      // container, or blocked). Without this listener that 'error' is unhandled
      // and kills the extension host — turning a cancelled run into a crash.
      killer.on("error", () => {});
      return;
    }
    const signal = force ? "SIGKILL" : "SIGTERM";
    try {
      // Negative pid targets the process group created by `detached`.
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // Already gone, or not ours to signal. The last-resort settle covers it.
      }
    }
  }
}
