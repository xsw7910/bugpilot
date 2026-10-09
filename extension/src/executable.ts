/**
 * Finding a usable bugpilot and proving it speaks the contract.
 *
 * "Usable" is stronger than "on PATH". A machine can easily have three
 * bugpilots — a pipx copy, an editable install, and a frozen exe — and an older
 * one will not understand `--json` at all (docs/adapter_design.md §3.2 records
 * that exact situation on the author's machine). So discovery ends with a
 * handshake rather than an existence check.
 *
 * `doctor --json` is the handshake: it needs no work item, touches no network,
 * and only succeeds if the binary implements the phase 2 envelope.
 */

import { diagnose } from "./errors.ts";
import { ProtocolError } from "./protocol.ts";
import type { Envelope } from "./protocol.ts";
import { locateExecutable } from "./executablePath.ts";
import type { Located } from "./executablePath.ts";
import { Runner } from "./runner.ts";
import type { SpawnFn } from "./runner.ts";

/** Default command name, resolved on PATH's absolute entries (`executablePath.ts`). */
export const DEFAULT_EXECUTABLE = "bugpilot";

/**
 * Where the bugpilot a verdict is about came from: the `bugpilot.executablePath`
 * setting, BugPilot's own managed runtime (`managedRuntime.ts`), or PATH.
 */
export type CliSource = "configured" | "managed" | "path";

/** Fields every verdict can carry, whatever its kind. */
interface VerdictOrigin {
  /** Which candidate this verdict is about. Set by `discoverExecutable`. */
  readonly source?: CliSource;
  /**
   * Why the managed runtime was passed over for PATH, when there was one and
   * it did not answer as the pinned version should.
   */
  readonly managedRejected?: string;
}

export type Verdict = VerdictOrigin &
  (
    /** Found, and it implements the JSON contract. */
    | {
        readonly kind: "ready";
        readonly executable: string;
        readonly report: Record<string, unknown>;
        /**
         * The CLI's own version, when it reports one.
         *
         * Optional because an older-but-compatible bugpilot may not have the
         * field. It is shown next to the resolved path: "which of my three
         * bugpilots just ran" is a question this machine can genuinely raise.
         */
        readonly version?: string;
      }
    /** Nothing to run: not on PATH, or the configured path does not exist. */
    | { readonly kind: "not-found"; readonly executable: string; readonly detail: string }
    /** It ran, but does not speak the contract — almost always too old. */
    | { readonly kind: "incompatible"; readonly executable: string; readonly detail: string }
    /** Did not answer the handshake in time. Says nothing about the version. */
    | { readonly kind: "unresponsive"; readonly executable: string; readonly detail: string }
    /**
     * Speaks the contract, but `doctor` itself failed.
     *
     * A well-formed failure envelope *proves* the binary is compatible, so calling
     * it incompatible would send the developer to update a fine bugpilot. The
     * error code is what matters here and is passed through for `diagnose()`.
     */
    | {
        readonly kind: "unhealthy";
        readonly executable: string;
        readonly code: string;
        readonly message: string;
      }
  );

export interface DiscoverOptions {
  /** The `bugpilot.executablePath` setting, when the developer set one. */
  readonly configured?: string | undefined;
  /**
   * BugPilot's managed runtime, when one is installed: its CLI's absolute path
   * and the exact version it must report. Tried after a configured path and
   * before PATH.
   */
  readonly managed?: { readonly executable: string; readonly version: string } | undefined;
  /** Where to run the handshake. Any directory works; `doctor` needs no work item. */
  readonly cwd: string;
  readonly spawn?: SpawnFn;
  readonly platform?: string;
  readonly timeoutMs?: number;
  /**
   * Where a name or a configured path resolves:
   * `executablePath.ts`'s policy by default — PATH's absolute entries, never
   * the working directory. Replaced in tests.
   */
  readonly locate?: (name: string) => Located;
}

/**
 * Resolve and verify the executable to use.
 *
 * Precedence is the configured path, then BugPilot's managed runtime, then the
 * bare command name resolved through PATH. A configured path wins even if it
 * turns out to be broken: silently falling back to a different bugpilot than
 * the one the developer named would make the failure impossible to diagnose.
 * The managed runtime is BugPilot's own, so when it does not answer as the
 * pinned version it is passed over for PATH, and the reason travels with the
 * verdict for Diagnostics and the setup card.
 */
export async function discoverExecutable(options: DiscoverOptions): Promise<Verdict> {
  const configured = options.configured?.trim();
  if (configured && configured !== "") return handshake(configured, "configured", options);
  let managedRejected: string | undefined;
  if (options.managed) {
    const verdict = await handshake(options.managed.executable, "managed", options);
    // Unhealthy proves the CLI works and its environment does not: that is
    // the same answer from PATH, so the runtime is still the one to report.
    if ((verdict.kind === "ready" && verdict.version === options.managed.version) || verdict.kind === "unhealthy") {
      return verdict;
    }
    managedRejected =
      verdict.kind === "ready"
        ? `Its bugpilot reports ${verdict.version ?? "no version"}, not ${options.managed.version}.`
        : verdict.kind === "not-found"
          ? "Its bugpilot executable is missing."
          : verdict.kind === "unresponsive"
            ? "Its bugpilot did not answer in time."
            : "Its bugpilot does not answer the way this extension needs.";
  }
  const fromPath = await handshake(DEFAULT_EXECUTABLE, "path", options);
  return managedRejected === undefined ? fromPath : { ...fromPath, managedRejected };
}

/** Find one candidate and prove it speaks the contract. */
async function handshake(requested: string, source: CliSource, options: DiscoverOptions): Promise<Verdict> {
  const missing =
    source === "configured"
      ? `The configured bugpilot path does not exist: ${requested}`
      : source === "managed"
        ? `The BugPilot runtime's bugpilot is missing: ${requested}`
        : "bugpilot is not on PATH.";
  // Resolved once, here, and the absolute path is what this handshake and every
  // later run start: detecting one bugpilot and running another from PATH — or
  // from the repository, the working directory — is how a hijack would look.
  const located = (options.locate ?? ((name) => locateExecutable(name, { purpose: "spawn" })))(requested);
  if (located.kind === "invalid") {
    return {
      kind: "not-found",
      source,
      executable: requested,
      detail: `The configured bugpilot path is not valid: ${located.reason}`,
    };
  }
  if (located.kind === "not-found") {
    return { kind: "not-found", source, executable: requested, detail: missing };
  }
  const executable = located.path;
  const verdict = await probe(executable, missing, options);
  return { ...verdict, source };
}

async function probe(executable: string, missing: string, options: DiscoverOptions): Promise<Verdict> {
  const runner = new Runner(executable, options.spawn, options.platform);

  let envelope: Envelope;
  try {
    envelope = await runner.runJson(["doctor"], {
      cwd: options.cwd,
      timeoutMs: options.timeoutMs ?? 20_000,
    });
  } catch (error) {
    if (isNotExecutable(error)) {
      // Present but not runnable is a different problem from absent, and
      // "install bugpilot" is the wrong advice for it.
      return {
        kind: "not-found",
        executable,
        detail: `${executable} exists but is not executable (permission denied).`,
      };
    }
    if (isMissingBinary(error)) {
      return { kind: "not-found", executable, detail: missing };
    }
    if (error instanceof ProtocolError && /cancelled/i.test(error.message)) {
      // A frozen exe cold-starting under antivirus can exceed the timeout.
      // Telling the developer to update a working bugpilot would be wrong.
      return {
        kind: "unresponsive",
        executable,
        detail: `${executable} did not answer \`doctor --json\` in time.`,
      };
    }
    if (error instanceof ProtocolError) {
      return {
        kind: "incompatible",
        executable,
        // stderr is usually argparse complaining about --json, which is the most
        // useful thing to show for a version too old to have it.
        detail: bestLine(error.stderr) || error.message,
      };
    }
    return { kind: "incompatible", executable, detail: (error as Error).message };
  }

  if (!envelope.ok) {
    return {
      kind: "unhealthy",
      executable,
      code: envelope.error.code,
      message: envelope.error.message,
    };
  }
  const report =
    typeof envelope["report"] === "object" && envelope["report"] !== null
      ? (envelope["report"] as Record<string, unknown>)
      : {};
  const version = report["version"];
  return {
    kind: "ready",
    executable,
    report,
    ...(typeof version === "string" && version !== "" ? { version } : {}),
  };
}

/** True when the program simply is not there. */
function isMissingBinary(error: unknown): boolean {
  return (error as { code?: unknown } | undefined)?.code === "ENOENT";
}

function isNotExecutable(error: unknown): boolean {
  const code = (error as { code?: unknown } | undefined)?.code;
  return code === "EACCES" || code === "EPERM";
}

/**
 * The most informative line of a stderr blob.
 *
 * argparse prints a usage banner first and the actual complaint last, so the
 * first non-empty line is the least useful one. Prefer a line that names an
 * error, and fall back to the first.
 */
function bestLine(text: string): string {
  const lines = text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "");
  return lines.find((line) => /error/i.test(line)) ?? lines[0] ?? "";
}

/** What to tell the developer, given a verdict. Kept next to the verdicts it explains. */
export function describeVerdict(verdict: Verdict): { summary: string; action: string } {
  switch (verdict.kind) {
    case "ready":
      return {
        summary: verdict.version
          ? `Using bugpilot ${verdict.version} (${verdict.executable}).`
          : `Using ${verdict.executable}.`,
        action: "",
      };
    case "not-found":
      return {
        summary: verdict.detail,
        // `pip install -e .` needs a checkout, which somebody who installed
        // this from the Marketplace does not have. That was the only advice
        // here, while `installInstructions()` had it right all along — two
        // copies of the same text, and this is the one that drifted.
        action:
          "Install it with `pipx install bugpilot`, or set `bugpilot.executablePath` to the executable.",
      };
    case "incompatible":
      return {
        summary: `${verdict.executable} does not support the machine-readable output this extension needs.`,
        action: `Update bugpilot, or point \`bugpilot.executablePath\` at a newer one. Details: ${verdict.detail}`,
      };
    case "unresponsive":
      return {
        summary: verdict.detail,
        action:
          "Try again — a frozen executable can be slow to start the first time, especially under antivirus scanning.",
      };
    case "unhealthy": {
      // The binary is fine; the environment is not. Reuse the shared code table
      // rather than inventing a second explanation for the same code.
      const diagnosis = diagnose(verdict.code, verdict.message);
      return {
        summary: `bugpilot runs, but its environment check failed: ${diagnosis.summary}`,
        action: diagnosis.action ?? "",
      };
    }
  }
}
