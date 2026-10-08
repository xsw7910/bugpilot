/**
 * Finding the programs the extension starts without trusting the repository
 * (pre-release Batch 2, A).
 *
 * The extension starts `bugpilot`, `claude`, `codex` and `taskkill`, mostly with
 * the repository as the working directory. Node (libuv) on Windows looks for a
 * bare program name in the working directory *before* PATH, so a `bugpilot.exe`
 * or `claude.exe` committed to a repository would run in place of the real one —
 * verified on this machine. So nothing is started by its bare name: a name is
 * resolved here to an absolute path, and that path is what is started.
 *
 * The policy, the same as `bugpilot/core/executables.py`'s:
 *  - an absolute path (an explicitly configured executable) is kept as it is;
 *  - a relative path with a directory part is refused — it would resolve
 *    against the repository;
 *  - a bare name is searched only in the absolute entries of PATH, in order,
 *    with PATHEXT on Windows; empty, `.` and other relative entries are
 *    skipped, and the working directory is never searched.
 *
 * Node-only: no `vscode` import.
 */

import { accessSync, constants, statSync } from "node:fs";
import path from "node:path";

export type Located =
  | { readonly kind: "found"; readonly path: string }
  | { readonly kind: "not-found" }
  /** A configured value that cannot be trusted as given, with the reason. */
  | { readonly kind: "invalid"; readonly reason: string };

export interface LocateOptions {
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly platform?: string;
  /**
   * `spawn`: a file Node can start without a shell — on Windows an `.exe` or
   * `.com`. `shell`: also a `.cmd`/`.bat`, which a terminal's shell can run (an
   * npm-installed `claude.cmd`, say).
   */
  readonly purpose?: "spawn" | "shell";
  /** Whether a candidate is a runnable file. Replaced in tests. */
  readonly isRunnable?: (candidate: string, platform: string) => boolean;
}

const DEFAULT_PATHEXT = ".COM;.EXE;.BAT;.CMD";
const SPAWNABLE_ON_WINDOWS = [".com", ".exe"];

/** One environment variable, by its name in any case on Windows. */
export function environmentValue(
  env: Readonly<Record<string, string | undefined>>,
  name: string,
  platform: string,
): string | undefined {
  if (platform !== "win32") return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key === undefined ? undefined : env[key];
}

function defaultRunnable(candidate: string, platform: string): boolean {
  try {
    if (!statSync(candidate).isFile()) return false;
    if (platform !== "win32") accessSync(candidate, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function isAbsoluteFor(value: string, platform: string): boolean {
  // A drive-relative `C:tools\x.exe` or a root-relative `\x.exe` is not a
  // location anyone chose on purpose; only a full drive path or a UNC path is.
  return platform === "win32" ? /^(?:[A-Za-z]:[\\/]|\\\\)/.test(value) : path.posix.isAbsolute(value);
}

/** Where `name` resolves, under the policy above. */
export function locateExecutable(name: string, options: LocateOptions = {}): Located {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const purpose = options.purpose ?? "spawn";
  const runnable = options.isRunnable ?? defaultRunnable;
  const flavor = platform === "win32" ? path.win32 : path.posix;
  const value = name.trim();
  if (value === "") return { kind: "not-found" };
  if (isAbsoluteFor(value, platform)) {
    return runnable(value, platform) ? { kind: "found", path: value } : { kind: "not-found" };
  }
  if (value.includes("/") || (platform === "win32" && (value.includes("\\") || value.includes(":")))) {
    return {
      kind: "invalid",
      reason: `"${value}" is a relative path, which would resolve inside the repository. Use an absolute path.`,
    };
  }
  let candidates = [value];
  if (platform === "win32") {
    const known = (environmentValue(env, "PATHEXT", platform) || DEFAULT_PATHEXT)
      .split(";")
      .map((extension) => extension.trim().toLowerCase())
      .filter((extension) => extension.startsWith("."));
    const allowed = purpose === "spawn" ? known.filter((extension) => SPAWNABLE_ON_WINDOWS.includes(extension)) : known;
    const own = flavor.extname(value).toLowerCase();
    candidates = own !== "" && known.includes(own)
      ? (allowed.includes(own) ? [value] : [])
      : allowed.map((extension) => `${value}${extension}`);
  }
  const separator = platform === "win32" ? ";" : ":";
  for (const raw of (environmentValue(env, "PATH", platform) ?? "").split(separator)) {
    const entry = raw.trim().replace(/^"(.*)"$/, "$1");
    if (entry === "" || !isAbsoluteFor(entry, platform)) continue;
    for (const candidate of candidates) {
      const full = flavor.join(entry, candidate);
      if (runnable(full, platform)) return { kind: "found", path: full };
    }
  }
  return { kind: "not-found" };
}

/**
 * An environment for a child process that starts programs of its own: on
 * Windows, `NoDefaultCurrentDirectoryInExePath` keeps cmd.exe and every
 * CreateProcess caller inside it out of the working directory too — an npm
 * `claude.cmd` shim, for one, looks up a bare `node`.
 */
export function childEnvironmentAdditions(platform: string = process.platform): Readonly<Record<string, string>> {
  return platform === "win32" ? { NoDefaultCurrentDirectoryInExePath: "1" } : {};
}
