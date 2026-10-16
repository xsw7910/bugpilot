/**
 * Isolation for the CLI integration suite (BugPilot 0.1.6 Batch 0A, plan §11.1).
 *
 * The suite spawns the real `python -m bugpilot`. Before 0.1.6 those children
 * inherited the developer's own `HOME` and any `JIRA_*` variables, so a run
 * could read or write the real `~/.bugpilot` and reach company Jira. Now:
 *
 * - `isolateIntegrationSuite` (called once, before any test runs) points
 *   `HOME`, `USERPROFILE` (and on Windows `HOMEDRIVE`/`HOMEPATH`),
 *   `BUGPILOT_HOME` and `BUGPILOT_CONFIG_DIR` into one disposable folder,
 *   removes every `JIRA_*`, `SMTP_*`, `GRAPH_*` and `BUGPILOT_EMAIL_*`
 *   variable plus `BUGPILOT_AUTO_JIRA_COMMENT` and `BUGPILOT_MCP_REPO_ROOT`
 *   (agent-command variables are kept; the suite starts no agent), and puts
 *   the Python guard's `sitecustomize` first on `PYTHONPATH` — the same guard and template
 *   as the Python suites (`tests/_isolation.py`,
 *   `tests/isolation_child/sitecustomize.py`), so every Python child refuses to
 *   read or write the real BugPilot data before it happens;
 * - its `spawn` (handed to the `Runner`) and `checkedEnv` (for direct
 *   `execFileSync` calls) refuse — throw, before spawning — a child whose
 *   environment has no home, points its BugPilot data at the real one, carries
 *   a real Jira credential, or would start Python without the guard.
 *
 * The real home is known by path only (the account's own profile folder, and
 * the variables as they were); nothing here lists or reads it. Test-only:
 * production code never imports this module.
 */

import { spawn as nodeSpawn } from "node:child_process";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir, tmpdir, userInfo } from "node:os";
import path from "node:path";

type Environment = Readonly<Record<string, string | undefined>>;
type Spawn = (command: string, args: string[], options: SpawnOptions) => ChildProcess;

export const SANITIZED_PREFIXES: readonly string[] = ["JIRA_", "SMTP_", "GRAPH_", "BUGPILOT_EMAIL_"];
export const SANITIZED_NAMES: readonly string[] = [
  "BUGPILOT_AUTO_JIRA_COMMENT",
  "BUGPILOT_MCP_REPO_ROOT",
  "BUGPILOT_HOME",
  "BUGPILOT_CONFIG_DIR",
];
const DATA_DIR = ".bugpilot";

/** `path.resolve`, case-folded on Windows: the form every comparison here uses. */
export function normalizePath(value: string, platform: string = process.platform): string {
  const resolved = path.resolve(value);
  return platform === "win32" ? resolved.toLowerCase() : resolved;
}

/** Whether `candidate` is `root` or inside it (both already normalized). */
export function within(candidate: string, root: string): boolean {
  if (candidate === root) return true;
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  return candidate.startsWith(prefix);
}

function accountHome(): string | undefined {
  try {
    return userInfo().homedir || undefined;
  } catch {
    return undefined;
  }
}

/** Every folder that may hold the developer's real BugPilot data, as normalized strings. Reads nothing. */
export function realDataRoots(env: Environment, platform: string = process.platform): string[] {
  const homes = [accountHome(), env["HOME"], env["USERPROFILE"], homedir()];
  if (env["HOMEDRIVE"] && env["HOMEPATH"]) homes.push(env["HOMEDRIVE"] + env["HOMEPATH"]);
  const roots = homes.filter((home): home is string => Boolean(home)).map((home) => path.join(home, DATA_DIR));
  for (const name of ["BUGPILOT_HOME", "BUGPILOT_CONFIG_DIR"]) {
    const value = env[name];
    if (value) roots.push(value);
  }
  return [...new Set(roots.map((root) => normalizePath(root, platform)))];
}

/** The variables that hold credentials or reach a real service, as they are now. */
function sanitizedNames(env: Environment): string[] {
  return Object.keys(env).filter((name) => {
    const upper = name.toUpperCase();
    return SANITIZED_PREFIXES.some((prefix) => upper.startsWith(prefix)) || SANITIZED_NAMES.includes(upper);
  });
}

/**
 * Why a child started with `env` could reach the real BugPilot data or a real
 * credential, or `undefined` when it cannot.
 */
export function environmentProblem(
  env: Environment,
  roots: readonly string[],
  realSecrets: ReadonlyMap<string, string>,
  platform: string = process.platform,
): string | undefined {
  const homeName = platform === "win32" ? "USERPROFILE" : "HOME";
  if (!env[homeName]) return `the child's environment has no ${homeName}, so its home would fall back to the real one`;
  const derived: string[] = [];
  for (const name of ["HOME", "USERPROFILE"]) {
    const value = env[name];
    if (value) derived.push(path.join(value, DATA_DIR));
  }
  for (const name of ["BUGPILOT_HOME", "BUGPILOT_CONFIG_DIR"]) {
    const value = env[name];
    if (value) derived.push(value);
  }
  for (const value of derived) {
    const candidate = normalizePath(value, platform);
    if (roots.some((root) => within(candidate, root) || within(root, candidate))) {
      return "the child's environment points its BugPilot data at the developer's real BugPilot folder";
    }
  }
  // A real credential under a Jira, mail or Graph name. (Matched by name too: a
  // developer's email is the value of unrelated variables as well.)
  const secrets = new Set(realSecrets.values());
  for (const name of sanitizedNames(env)) {
    const value = env[name];
    if (value && secrets.has(value)) return `the child's environment carries a real value in ${name}`;
  }
  return undefined;
}

function startsPython(command: string, args: readonly string[]): boolean {
  return /^python(?:\d+(?:\.\d+)?)?(?:\.exe)?$/i.test(path.basename(command)) || (args[0] === "-m" && args[1] === "bugpilot");
}

export interface IntegrationIsolation {
  /** The disposable folder holding the suite's home and the guard. */
  readonly root: string;
  /** `PYTHONPATH` for a `python -m bugpilot` child: the guard first, then the repository. */
  readonly pythonPath: string;
  readonly protectedRoots: readonly string[];
  /** A `child_process.spawn` that refuses an unisolated child before starting it. */
  readonly spawn: Spawn;
  /** `env` checked like `spawn` checks it; throws on a problem. For `execFileSync`. */
  readonly checkedEnv: (env: NodeJS.ProcessEnv, command?: string, args?: readonly string[]) => NodeJS.ProcessEnv;
  /** What the guard refused in Python children so far (its log), oldest first. */
  readonly violations: () => string[];
}

/**
 * Wrap `spawn` so it refuses a child the checks reject. Exported for the unit
 * test (`test/integrationIsolation.test.ts`), which drives it with a fake.
 */
export function guardedSpawn(
  inner: Spawn,
  roots: readonly string[],
  realSecrets: ReadonlyMap<string, string>,
  guardDir: string,
  platform: string = process.platform,
): Spawn {
  return (command, args, options) => {
    check(options.env ?? process.env, roots, realSecrets, guardDir, platform, command, args);
    return inner(command, args, options);
  };
}

function check(
  env: Environment,
  roots: readonly string[],
  realSecrets: ReadonlyMap<string, string>,
  guardDir: string,
  platform: string,
  command: string,
  args: readonly string[],
): void {
  const name = path.basename(command);
  const problem = environmentProblem(env, roots, realSecrets, platform);
  if (problem) throw new Error(`Integration isolation refused to start ${name}: ${problem}.`);
  if (startsPython(command, args)) {
    const first = (env["PYTHONPATH"] ?? "").split(path.delimiter)[0] ?? "";
    if (normalizePath(first || ".", platform) !== normalizePath(guardDir, platform)) {
      throw new Error(`Integration isolation refused to start ${name}: the isolation guard is not first on PYTHONPATH.`);
    }
  }
}

/**
 * Isolate this process and every child it starts. Call once, before any test
 * runs. Throws — the suite does not run — if isolation cannot be established.
 */
export function isolateIntegrationSuite(repoRoot: string): IntegrationIsolation {
  const original: Environment = { ...process.env };
  const roots = realDataRoots(original);
  const realSecrets = new Map<string, string>();
  for (const name of sanitizedNames(original)) {
    const value = original[name];
    if (value && value.length >= 6 && /^(JIRA_|SMTP_|GRAPH_)/i.test(name)) realSecrets.set(name, value);
  }

  const root = mkdtempSync(path.join(tmpdir(), "bugpilot-it-home-"));
  const normalizedRoot = normalizePath(root);
  if (roots.some((protectedRoot) => within(normalizedRoot, protectedRoot) || within(protectedRoot, normalizedRoot))) {
    rmSync(root, { recursive: true, force: true });
    throw new Error("The integration suite's home would overlap the developer's BugPilot data; refusing to run.");
  }
  const home = path.join(root, "home");
  const guardDir = path.join(root, "pyguard");
  mkdirSync(home);
  mkdirSync(guardDir);
  const template = path.join(repoRoot, "tests", "isolation_child", "sitecustomize.py");
  const guardFile = path.join(repoRoot, "tests", "_isolation.py");
  if (!existsSync(template) || !existsSync(guardFile)) {
    throw new Error("The Python isolation guard is missing from tests/; refusing to run the integration suite.");
  }
  copyFileSync(template, path.join(guardDir, "sitecustomize.py"));
  const log = path.join(root, "guard-violations.log");

  for (const name of sanitizedNames(process.env)) delete process.env[name];
  process.env["HOME"] = home;
  process.env["USERPROFILE"] = home;
  if (process.platform === "win32") {
    const drive = path.parse(home).root.replace(/[\\/]+$/, "");
    process.env["HOMEDRIVE"] = drive;
    process.env["HOMEPATH"] = home.slice(drive.length) || path.sep;
  }
  const data = path.join(home, DATA_DIR);
  process.env["BUGPILOT_HOME"] = data;
  process.env["BUGPILOT_CONFIG_DIR"] = data;
  process.env["BUGPILOT_TEST_SESSION_ROOT"] = root;
  process.env["BUGPILOT_TEST_GUARD_FILE"] = guardFile;
  process.env["BUGPILOT_TEST_GUARD_ROOTS"] = roots.join(path.delimiter);
  process.env["BUGPILOT_TEST_GUARD_LOG"] = log;
  const previous = process.env["PYTHONPATH"];
  process.env["PYTHONPATH"] = previous ? `${guardDir}${path.delimiter}${previous}` : guardDir;

  process.on("exit", () => {
    if (!process.env["BUGPILOT_TEST_KEEP_SESSION"]) rmSync(root, { recursive: true, force: true });
  });

  return {
    root,
    pythonPath: [guardDir, repoRoot].join(path.delimiter),
    protectedRoots: roots,
    spawn: guardedSpawn(nodeSpawn, roots, realSecrets, guardDir),
    checkedEnv: (env, command = "python", args = ["-m", "bugpilot"]) => {
      check(env, roots, realSecrets, guardDir, process.platform, command, args);
      return env;
    },
    violations: () => (existsSync(log) ? readFileSync(log, "utf8").split(/\r?\n/).filter(Boolean) : []),
  };
}
