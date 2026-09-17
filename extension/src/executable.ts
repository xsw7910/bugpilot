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
import { Runner } from "./runner.ts";
import type { SpawnFn } from "./runner.ts";

/** Default command name, resolved through PATH by the OS. */
export const DEFAULT_EXECUTABLE = "bugpilot";

export type Verdict =
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
    };

export interface DiscoverOptions {
  /** The `bugpilot.executablePath` setting, when the developer set one. */
  readonly configured?: string | undefined;
  /** Where to run the handshake. Any directory works; `doctor` needs no work item. */
  readonly cwd: string;
  readonly spawn?: SpawnFn;
  readonly platform?: string;
  readonly timeoutMs?: number;
}

/**
 * Resolve and verify the executable to use.
 *
 * Precedence is the configured path, then the bare command name for the OS to
 * resolve through PATH. A configured path wins even if it turns out to be
 * broken: silently falling back to a different bugpilot than the one the
 * developer named would make the failure impossible to diagnose.
 */
export async function discoverExecutable(options: DiscoverOptions): Promise<Verdict> {
  const configured = options.configured?.trim();
  const executable = configured && configured !== "" ? configured : DEFAULT_EXECUTABLE;
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
      return {
        kind: "not-found",
        executable,
        detail:
          configured && configured !== ""
            ? `The configured bugpilot path does not exist: ${executable}`
            : "bugpilot is not on PATH.",
      };
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

/**
 * The file names a shell would try for a bare command on Windows.
 *
 * Node's `spawn` without a shell goes straight to `CreateProcess`, which
 * appends `.exe` and nothing else — so a command installed as `claude.cmd` (npm
 * does exactly this) is invisible to a spawn probe while running perfectly in a
 * terminal. Spawning the `.cmd` directly is not the answer: since the fix for
 * CVE-2024-27980, Node rejects that with EINVAL. Measured on the author's
 * machine: `claude` exits 0, `claude.cmd` throws EINVAL.
 *
 * So the fallback is a file lookup rather than a second spawn, and this is the
 * list of names to look for. Empty on other platforms, where PATH lookup has no
 * extension rules to reproduce.
 */
export function launcherNames(
  executable: string,
  pathext: string | undefined,
  platform: string,
): readonly string[] {
  if (platform !== "win32") return [];
  // Already carries an extension: a lookup would be asking a different question
  // than the caller asked.
  if (/\.[A-Za-z0-9]+$/.test(executable)) return [executable];
  const extensions = (pathext ?? ".COM;.EXE;.BAT;.CMD")
    .split(";")
    .map((extension) => extension.trim())
    .filter((extension) => extension.startsWith("."));
  return [executable, ...extensions.map((extension) => executable + extension)];
}
