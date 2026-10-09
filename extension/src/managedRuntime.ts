/**
 * BugPilot's own copy of the CLI: a private Python virtual environment the
 * extension creates when the developer asks for it, so a Marketplace install
 * works without `pipx install bugpilot` or a change to PATH.
 *
 * Where it lives: `<globalStorage>/runtime/<extension version>/venv`. One
 * directory per extension version, and the CLI pinned to exactly that version
 * (`bugpilot==<version>`), so after an update the old runtime is simply not
 * looked at rather than trusted as half-compatible.
 *
 * What makes it real is `runtime.json`, written last, and only after the
 * installed `bugpilot --version` printed the pinned version. A directory
 * without it is an install that did not finish — VS Code closed, pip failed —
 * and is removed before the next attempt. The venv is built in place, not in a
 * temporary directory renamed afterwards: on Windows `Scripts\bugpilot.exe` has
 * the venv's absolute path baked in, so a renamed venv would not start.
 *
 * How it runs things: absolute paths through `trustedRunner`, argv only, never
 * a shell; Python always with `-I`, so no PYTHON* variable and no current
 * directory reach the interpreter; the runtime root as the working directory,
 * never a repository. Nothing here is started without the developer asking.
 *
 * Node-only: no `vscode` import.
 */

import { closeSync, existsSync, lstatSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";

import type { Log } from "./app/log.ts";
import { stderrForLog } from "./app/logSafety.ts";
import { locateExecutable } from "./executablePath.ts";
import type { Located } from "./executablePath.ts";
import { trustedRunner } from "./runner.ts";
import type { RunOptions, RunResult } from "./runner.ts";

/** The oldest Python the CLI supports: pyproject's `requires-python`. */
const MINIMUM_PYTHON: readonly number[] = [3, 10];

/** Every step has a limit; an install that hangs must still end. */
const TIMEOUTS = { probe: 15_000, venv: 180_000, pip: 300_000, validate: 60_000 } as const;

/** A lock older than this was left by a window that closed mid-install. */
const STALE_LOCK_MS = 15 * 60_000;

const MARKER = "runtime.json";
const MARKER_SCHEMA = 1;

/**
 * A version that can name a directory: digits and dots, then an optional
 * pre-release or local part — never a path separator.
 */
const VERSION = /^\d+\.\d+\.\d+(?:[.+-][0-9A-Za-z.-]+)?$/;

/** One constant line of Python: which interpreter answered, and its version. */
const PROBE = "import json,sys;print(json.dumps({'executable':sys.executable,'version':list(sys.version_info[:3])}))";

export type InstallStep = "python" | "venv" | "pip" | "validate";

/** The runtime as the extension last saw it: typed state, read from disk or held in memory. */
export type RuntimeStatus =
  | { readonly kind: "not-installed"; readonly version: string }
  | { readonly kind: "installing"; readonly version: string; readonly step: InstallStep }
  | {
      readonly kind: "ready";
      readonly version: string;
      /** The runtime's own `bugpilot`, absolute. */
      readonly executable: string;
      readonly pythonVersion: string;
    }
  /** Present but unusable: an install that did not finish, or a CLI that no longer answers. */
  | { readonly kind: "broken"; readonly version: string; readonly detail: string }
  | { readonly kind: "no-python"; readonly version: string }
  | { readonly kind: "unsupported-python"; readonly version: string; readonly found: string }
  | { readonly kind: "install-failed"; readonly version: string; readonly step: InstallStep; readonly detail: string };

export type InstallOutcome =
  | { readonly kind: "ready"; readonly status: Extract<RuntimeStatus, { kind: "ready" }> }
  | { readonly kind: "no-python" }
  | { readonly kind: "unsupported-python"; readonly found: string }
  | { readonly kind: "failed"; readonly step: InstallStep; readonly detail: string }
  /** Another VS Code window holds the install lock. */
  | { readonly kind: "busy" };

export interface ManagedRuntimeOptions {
  /** Where every version's runtime lives: `<globalStorage>/runtime`. */
  readonly root: string;
  /** The extension's own version, which is the CLI version installed. */
  readonly version: string;
  readonly log?: Log;
  readonly platform?: string;
  /** How a program is started. Production: `trustedRunner`. Replaced in tests. */
  readonly exec?: (program: string, args: readonly string[], options: RunOptions) => Promise<RunResult>;
  /** Where a bare program name resolves. Production: PATH's absolute entries. */
  readonly locate?: (name: string) => Located;
  readonly now?: () => number;
}

interface Layout {
  readonly directory: string;
  readonly venv: string;
  readonly python: string;
  readonly cli: string;
  readonly marker: string;
}

interface PythonFound {
  readonly kind: "found";
  readonly executable: string;
  readonly version: readonly number[];
}

interface Ran {
  readonly ok: boolean;
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly aborted: boolean;
}

export class ManagedRuntimeManager {
  readonly #root: string;
  readonly #version: string;
  readonly #log: Log | undefined;
  readonly #platform: string;
  readonly #exec: NonNullable<ManagedRuntimeOptions["exec"]>;
  readonly #locate: NonNullable<ManagedRuntimeOptions["locate"]>;
  readonly #now: () => number;
  #installing: Promise<InstallOutcome> | undefined;
  #step: InstallStep | undefined;
  #lastFailure: RuntimeStatus | undefined;
  #rejected: string | undefined;

  constructor(options: ManagedRuntimeOptions) {
    this.#root = path.resolve(options.root);
    this.#version = options.version;
    this.#log = options.log;
    this.#platform = options.platform ?? process.platform;
    this.#exec = options.exec ?? ((program, args, runOptions) => trustedRunner(program).run(args, runOptions));
    this.#locate = options.locate ?? ((name) => locateExecutable(name, { purpose: "spawn" }));
    this.#now = options.now ?? Date.now;
  }

  /** The CLI version this runtime installs: the extension's own. */
  get version(): string {
    return this.#version;
  }

  /** Whether an install started by this window is still running. */
  get installing(): boolean {
    return this.#installing !== undefined;
  }

  /**
   * Where this version's runtime lives and what it is made of. The version
   * becomes a directory name, so one that is not a version is refused here,
   * whoever asks.
   */
  layout(): Layout {
    if (!VERSION.test(this.#version)) throw new Error(`"${this.#version}" is not a version the runtime can use.`);
    const directory = path.join(this.#root, this.#version);
    const venv = path.join(directory, "venv");
    return this.#platform === "win32"
      ? { directory, venv, python: path.join(venv, "Scripts", "python.exe"), cli: path.join(venv, "Scripts", "bugpilot.exe"), marker: path.join(directory, MARKER) }
      : { directory, venv, python: path.join(venv, "bin", "python"), cli: path.join(venv, "bin", "bugpilot"), marker: path.join(directory, MARKER) };
  }

  /**
   * The runtime as it stands: an install in flight, a finished one, or why
   * there is none. Reads one small file; never starts a process.
   */
  status(): RuntimeStatus {
    const version = this.#version;
    if (this.#step !== undefined) return { kind: "installing", version, step: this.#step };
    const marker = this.#readMarker();
    if (marker.kind === "ready") return this.#rejected === undefined ? marker : { kind: "broken", version, detail: this.#rejected };
    if (this.#lastFailure) return this.#lastFailure;
    if (marker.kind === "incomplete") return { kind: "broken", version, detail: "Its files are incomplete: the bugpilot executable or its Python is missing." };
    if (VERSION.test(version) && existsSync(this.layout().directory)) {
      return { kind: "broken", version, detail: "An earlier installation did not finish." };
    }
    return { kind: "not-installed", version };
  }

  /**
   * What discovery found when it tried the runtime: `undefined` when the
   * runtime's CLI answered as it should, the reason when it did not. A
   * rejected runtime reads as broken until the next install.
   */
  noteHandshake(rejected: string | undefined): void {
    this.#rejected = rejected;
  }

  /**
   * Create the runtime: find Python, make the venv, install the pinned CLI,
   * check it, and only then write `runtime.json`.
   *
   * One install at a time: a second call while one runs gets the same promise,
   * so repeated clicks never start a second pip. Across windows, a lock file
   * does the same job.
   */
  install(onStep?: (step: InstallStep) => void): Promise<InstallOutcome> {
    if (this.#installing) return this.#installing;
    const run = this.#install(onStep).finally(() => {
      this.#installing = undefined;
      this.#step = undefined;
    });
    this.#installing = run;
    return run;
  }

  async #install(onStep: ((step: InstallStep) => void) | undefined): Promise<InstallOutcome> {
    const version = this.#version;
    const advance = (step: InstallStep) => {
      this.#step = step;
      onStep?.(step);
    };
    this.#lastFailure = undefined;
    this.#rejected = undefined;
    if (!VERSION.test(version)) return this.#fail("python", `"${version}" is not a version the runtime can install.`);
    mkdirSync(this.#root, { recursive: true });
    if (!this.#acquireLock()) {
      this.#log?.info("BugPilot runtime: another window is installing it.");
      return { kind: "busy" };
    }
    const layout = this.layout();
    let ready = false;
    try {
      advance("python");
      const python = await this.#findPython();
      if (python.kind === "missing") {
        this.#log?.info("BugPilot runtime: no Python 3.10 or later found.");
        this.#lastFailure = { kind: "no-python", version };
        return { kind: "no-python" };
      }
      if (python.kind === "unsupported") {
        this.#log?.info(`BugPilot runtime: Python ${python.found} is too old; 3.10 or later is required.`);
        this.#lastFailure = { kind: "unsupported-python", version, found: python.found };
        return { kind: "unsupported-python", found: python.found };
      }
      const pythonVersion = python.version.join(".");
      this.#log?.info(`BugPilot runtime: using Python ${pythonVersion} (${python.executable}).`);

      advance("venv");
      // Whatever an interrupted attempt left is not something to build on.
      this.#remove(layout.directory);
      mkdirSync(layout.directory, { recursive: true });
      const venv = await this.#run(python.executable, ["-I", "-m", "venv", layout.venv], TIMEOUTS.venv);
      if (!venv.ok || !isFile(layout.python)) return this.#fail("venv", venvProblem(venv));

      advance("pip");
      const requirement = `bugpilot==${version}`;
      const pip = await this.#run(
        layout.python,
        // `--no-cache-dir`: pip's cache location follows the environment, and
        // where its user folders cannot be resolved it falls back to the
        // working directory — the runtime root, outside the version directory
        // cleanup owns (seen with a redirected USERPROFILE). Without a cache the install
        // neither reads nor writes one: one small wheel, fetched fresh.
        ["-I", "-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--no-cache-dir", "--only-binary=:all:", requirement],
        TIMEOUTS.pip,
      );
      if (!pip.ok || !isFile(layout.cli)) return this.#fail("pip", pipProblem(pip, requirement));

      advance("validate");
      const check = await this.#run(layout.cli, ["--version"], TIMEOUTS.validate);
      const reported = /^bugpilot\s+(\S+)/m.exec(check.stdout)?.[1];
      if (!check.ok || reported !== version) {
        return this.#fail(
          "validate",
          reported === undefined
            ? "The installed CLI did not report its version."
            : `The installed CLI reports ${reported}, not ${version}.`,
        );
      }
      this.#writeMarker({
        schema: MARKER_SCHEMA,
        version,
        requirement,
        python: pythonVersion,
        installedAt: new Date(this.#now()).toISOString(),
      });
      ready = true;
      this.#log?.info(`BugPilot runtime ready: bugpilot ${version}.`);
      return { kind: "ready", status: { kind: "ready", version, executable: layout.cli, pythonVersion } };
    } catch (error) {
      return this.#fail(this.#step ?? "python", `Unexpected error: ${(error as Error).message}`);
    } finally {
      if (!ready) {
        try {
          this.#remove(layout.directory);
        } catch (error) {
          this.#log?.error(`BugPilot runtime: could not remove an unfinished install: ${(error as Error).message}`);
        }
      }
      this.#releaseLock();
    }
  }

  #fail(step: InstallStep, detail: string): InstallOutcome {
    this.#lastFailure = { kind: "install-failed", version: this.#version, step, detail };
    this.#log?.error(`BugPilot runtime setup failed (${step}): ${detail}`);
    return { kind: "failed", step, detail };
  }

  /**
   * `runtime.json`, if it names this version and what it stands for exists.
   *
   * The marker decides only *whether* the runtime is ready, never *what* runs:
   * the executable is this layout's, wherever a marker might claim it is, and
   * discovery still has to get the pinned version from it before it is used.
   */
  #readMarker():
    | Extract<RuntimeStatus, { kind: "ready" }>
    | { readonly kind: "absent" }
    | { readonly kind: "incomplete" } {
    if (!VERSION.test(this.#version)) return { kind: "absent" };
    const layout = this.layout();
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(layout.marker, "utf8"));
    } catch {
      return { kind: "absent" };
    }
    const marker = (parsed ?? {}) as { schema?: unknown; version?: unknown; python?: unknown };
    if (marker.schema !== MARKER_SCHEMA || marker.version !== this.#version) return { kind: "absent" };
    if (!isFile(layout.python) || !isFile(layout.cli)) return { kind: "incomplete" };
    return {
      kind: "ready",
      version: this.#version,
      executable: layout.cli,
      // Shown in Diagnostics, so only ever a version, whatever the file says.
      pythonVersion: typeof marker.python === "string" && /^\d+\.\d+(?:\.\d+)?$/.test(marker.python) ? marker.python : "unknown",
    };
  }

  /** Written to a temporary name and renamed, so a half-written marker never exists. */
  #writeMarker(content: Record<string, unknown>): void {
    const { marker } = this.layout();
    const temporary = `${marker}.tmp`;
    writeFileSync(temporary, `${JSON.stringify(content, null, 2)}\n`, "utf8");
    renameSync(temporary, marker);
  }

  /**
   * Remove one version's directory, and refuse anything else: the target must
   * be a direct child of the runtime root, named by a version, and a real
   * directory rather than a link or junction to somewhere that is not ours.
   */
  #remove(target: string): void {
    const resolved = path.resolve(target);
    const relative = path.relative(this.#root, resolved);
    if (!VERSION.test(relative) || path.dirname(resolved) !== this.#root) {
      throw new Error(`Refusing to remove ${resolved}: it is not a runtime version directory under ${this.#root}.`);
    }
    // The root this extension created must itself be a real directory: a link
    // put in its place would make "inside the root" mean somewhere else.
    if (lstatSync(this.#root).isSymbolicLink()) {
      throw new Error(`Refusing to remove anything under ${this.#root}: the runtime root is a link.`);
    }
    let stat;
    try {
      stat = lstatSync(resolved);
    } catch {
      return;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      throw new Error(`Refusing to remove ${resolved}: it is not a real directory.`);
    }
    rmSync(resolved, { recursive: true, force: true });
  }

  #lockPath(): string {
    return path.join(this.#root, `${this.#version}.lock`);
  }

  #acquireLock(): boolean {
    const lock = this.#lockPath();
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const handle = openSync(lock, "wx");
        writeFileSync(handle, JSON.stringify({ pid: process.pid, at: new Date(this.#now()).toISOString() }));
        closeSync(handle);
        return true;
      } catch (error) {
        if ((error as { code?: unknown }).code !== "EEXIST") throw error;
        let age = 0;
        try {
          age = this.#now() - statSync(lock).mtimeMs;
        } catch {
          continue;
        }
        if (age <= STALE_LOCK_MS) return false;
        rmSync(lock, { force: true });
      }
    }
    return false;
  }

  #releaseLock(): void {
    rmSync(this.#lockPath(), { force: true });
  }

  /**
   * A Python 3.10 or later, as the absolute path of the interpreter itself.
   *
   * Every candidate is asked who it is with one constant line of Python, so a
   * Microsoft Store placeholder, a broken shim or a stale PATH entry fails the
   * probe instead of being trusted. On Windows the `py` launcher is asked for
   * every interpreter it knows, newest first, before the default it picks.
   */
  async #findPython(): Promise<PythonFound | { readonly kind: "missing" } | { readonly kind: "unsupported"; readonly found: string }> {
    const names = this.#platform === "win32" ? ["py", "python", "python3"] : ["python3", "python"];
    let newestTooOld: readonly number[] | undefined;
    for (const name of names) {
      const located = this.#locate(name);
      if (located.kind !== "found") continue;
      const candidates: { program: string; args: readonly string[] }[] =
        name === "py"
          ? [...(await this.#launcherInterpreters(located.path)).map((program) => ({ program, args: [] })), { program: located.path, args: ["-3"] }]
          : [{ program: located.path, args: [] }];
      for (const candidate of candidates) {
        const probed = await this.#probe(candidate.program, candidate.args);
        if (!probed) continue;
        if (compareVersions(probed.version, MINIMUM_PYTHON) >= 0) return probed;
        if (newestTooOld === undefined || compareVersions(probed.version, newestTooOld) > 0) newestTooOld = probed.version;
      }
    }
    return newestTooOld === undefined ? { kind: "missing" } : { kind: "unsupported", found: newestTooOld.join(".") };
  }

  /** `py -0p`: the launcher's interpreters, newest first, 3.10 and later only. */
  async #launcherInterpreters(launcher: string): Promise<string[]> {
    const listed = await this.#run(launcher, ["-0p"], TIMEOUTS.probe, false);
    if (!listed.ok) return [];
    const found: { version: number[]; program: string }[] = [];
    for (const line of listed.stdout.split(/\r?\n/)) {
      // " -V:3.12 *        C:\...\python.exe", or the older " -3.12-64  C:\...\python.exe".
      const match = /^\s*-(?:V:)?(\d+)\.(\d+)\S*\s+(?:\*\s+)?(.+?)\s*$/.exec(line);
      if (!match) continue;
      const version = [Number(match[1]), Number(match[2])];
      const program = match[3]!;
      if (compareVersions(version, MINIMUM_PYTHON) < 0 || !path.isAbsolute(program)) continue;
      found.push({ version, program });
    }
    return found.sort((a, b) => compareVersions(b.version, a.version)).map((entry) => entry.program);
  }

  async #probe(program: string, prefix: readonly string[]): Promise<PythonFound | undefined> {
    const ran = await this.#run(program, [...prefix, "-I", "-c", PROBE], TIMEOUTS.probe, false);
    if (!ran.ok) return undefined;
    const line = ran.stdout.trim().split(/\r?\n/).pop() ?? "";
    let parsed: { executable?: unknown; version?: unknown };
    try {
      parsed = JSON.parse(line) as { executable?: unknown; version?: unknown };
    } catch {
      return undefined;
    }
    const version = parsed.version;
    if (
      typeof parsed.executable !== "string" ||
      !path.isAbsolute(parsed.executable) ||
      !isFile(parsed.executable) ||
      !Array.isArray(version) ||
      version.length < 2 ||
      !version.every((part) => Number.isInteger(part))
    ) {
      return undefined;
    }
    return { kind: "found", executable: parsed.executable, version: version as number[] };
  }

  /**
   * One program, by absolute path, with a limit. A program that cannot start
   * is a failed run, not an exception; a failure's output reaches the log
   * trimmed to its end and with any credential in a URL removed.
   */
  async #run(program: string, args: readonly string[], timeoutMs: number, logged = true): Promise<Ran> {
    const shown = `${path.basename(program)} ${args.join(" ")}`;
    // The install's own commands are logged as they start — program name and
    // argv, which hold no secret — so the log shows exactly what ran.
    if (logged) this.#log?.info(`BugPilot runtime: running ${shown}`);
    let result: RunResult;
    try {
      result = await this.#exec(program, args, { cwd: this.#root, timeoutMs });
    } catch (error) {
      if (logged) this.#log?.error(`BugPilot runtime: ${shown} could not start: ${(error as Error).message}`);
      return { ok: false, code: null, stdout: "", stderr: (error as Error).message, aborted: false };
    }
    const ok = result.code === 0 && !result.aborted;
    if (!ok && logged) {
      const output = scrubUrlCredentials(result.stderr.trim() === "" ? result.stdout : result.stderr);
      this.#log?.error(
        `BugPilot runtime: ${shown} ${result.aborted ? "timed out" : `exited with code ${String(result.code)}`}` +
          (output.trim() === "" ? "." : `:\n${stderrForLog(output, [])}`),
      );
    }
    return { ok, code: result.code, stdout: result.stdout, stderr: result.stderr, aborted: result.aborted };
  }
}

function isFile(candidate: string): boolean {
  try {
    return statSync(candidate).isFile();
  } catch {
    return false;
  }
}

function compareVersions(a: readonly number[], b: readonly number[]): number {
  for (let index = 0; index < Math.max(a.length, b.length); index += 1) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** `https://user:secret@host` → `https://****@host`: an index URL may carry a credential. */
function scrubUrlCredentials(text: string): string {
  return text.replace(/([a-z][a-z0-9+.-]*:\/\/)[^\s/@]+@/gi, "$1****@");
}

/** One sentence for the developer; the details are in the log. */
function venvProblem(ran: Ran): string {
  if (ran.aborted) return "Creating the Python environment took too long.";
  if (/ensurepip is not available|No module named venv|No module named ensurepip/i.test(ran.stderr + ran.stdout)) {
    return "This Python cannot create virtual environments: its venv module or ensurepip is missing (on Debian or Ubuntu, install python3-venv).";
  }
  return `Python could not create the environment (exit code ${String(ran.code)}).`;
}

/**
 * Network trouble first: pip that could not reach its index *also* ends with
 * "No matching distribution found … (from versions: none)", and reporting that
 * as a missing version sends the developer looking for the wrong problem.
 */
function pipProblem(ran: Ran, requirement: string): string {
  const output = ran.stderr + ran.stdout;
  if (ran.aborted) return `Installing ${requirement} took too long.`;
  if (/ConnectionError|NewConnectionError|connection broken|Max retries exceeded|SSLError|ProxyError|Failed to establish|getaddrinfo|Temporary failure in name resolution|Could not fetch URL|Read timed out/i.test(output)) {
    return "PyPI could not be reached. Check the network, or the proxy settings pip uses.";
  }
  // No versions at all: the index answered with nothing for bugpilot, or was
  // never reached (pip with retries off says nothing more).
  if (/\(from versions: none\)/i.test(output)) {
    return "pip could not get bugpilot from its package index. Check the network, and pip's index and proxy settings.";
  }
  if (/No matching distribution found|Could not find a version that satisfies/i.test(output)) {
    return `PyPI has no ${requirement} for this Python.`;
  }
  if (ran.code === 0) return `pip finished, but ${requirement} did not install its bugpilot command.`;
  return `pip could not install ${requirement} (exit code ${String(ran.code)}).`;
}
