/**
 * The integration suite's isolation checks (BugPilot 0.1.6 Batch 0A, plan §11.1).
 *
 * `test-integration/isolation.ts` refuses, before spawning, a CLI child that
 * could reach the developer's real BugPilot data or a real Jira credential.
 * These tests drive its pure parts with made-up paths and a fake spawn; they
 * never call `isolateIntegrationSuite`, which changes this process's
 * environment, and they write no file. The last one reads the integration
 * suite's sources: that suite does not run in CI, so CI checks here that it
 * cannot start a process around its isolation.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import type { ChildProcess, SpawnOptions } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  environmentProblem,
  guardedSpawn,
  normalizePath,
  realDataRoots,
  within,
} from "../test-integration/isolation.ts";

const base = path.resolve("/isolation-unit-test");
const realHome = path.join(base, "real-home");
const roots = [normalizePath(path.join(realHome, ".bugpilot"))];
const suiteHome = path.join(base, "suite", "home");
const guardDir = path.join(base, "suite", "pyguard");
const noSecrets = new Map<string, string>();

const isolated = {
  HOME: suiteHome,
  USERPROFILE: suiteHome,
  BUGPILOT_HOME: path.join(suiteHome, ".bugpilot"),
  BUGPILOT_CONFIG_DIR: path.join(suiteHome, ".bugpilot"),
  PYTHONPATH: [guardDir, base].join(path.delimiter),
};

test("an isolated environment passes", () => {
  assert.equal(environmentProblem(isolated, roots, noSecrets), undefined);
});

test("a child with no home is refused: it would fall back to the real one", () => {
  const { HOME: _home, USERPROFILE: _profile, ...homeless } = isolated;
  assert.match(environmentProblem(homeless, roots, noSecrets) ?? "", /has no (HOME|USERPROFILE)/);
});

test("a child whose BugPilot data would be the real folder is refused", () => {
  assert.match(environmentProblem({ ...isolated, HOME: realHome, USERPROFILE: realHome }, roots, noSecrets) ?? "", /real BugPilot folder/);
  const config = path.join(realHome, ".bugpilot", "config");
  assert.match(environmentProblem({ ...isolated, BUGPILOT_CONFIG_DIR: config }, roots, noSecrets) ?? "", /real BugPilot folder/);
  // A folder that would contain the real one is refused too.
  assert.match(environmentProblem({ ...isolated, BUGPILOT_HOME: realHome }, roots, noSecrets) ?? "", /real BugPilot folder/);
});

test("a child carrying a real credential is refused; a synthetic one is not", () => {
  const secrets = new Map([["JIRA_TOKEN", "real-token-value"]]);
  assert.match(environmentProblem({ ...isolated, JIRA_TOKEN: "real-token-value" }, roots, secrets) ?? "", /real value in JIRA_TOKEN/);
  assert.equal(environmentProblem({ ...isolated, JIRA_TOKEN: "not-a-real-token" }, roots, secrets), undefined);
  // The same value under an unrelated name (an email is often both) is not a Jira credential.
  assert.equal(environmentProblem({ ...isolated, GIT_AUTHOR_EMAIL: "real-token-value" }, roots, secrets), undefined);
});

test("the real data roots come from the home variables and the data variables, by name only", () => {
  const found = realDataRoots({ HOME: realHome, BUGPILOT_CONFIG_DIR: path.join(base, "configured") });
  assert.ok(found.includes(normalizePath(path.join(realHome, ".bugpilot"))));
  assert.ok(found.includes(normalizePath(path.join(base, "configured"))));
});

test("within compares whole path components", () => {
  const root = normalizePath(path.join(base, "data"));
  assert.equal(within(normalizePath(path.join(base, "data", "x")), root), true);
  assert.equal(within(root, root), true);
  assert.equal(within(normalizePath(path.join(base, "data-other")), root), false);
});

function fakeSpawn(calls: string[]) {
  return (command: string, args: string[], _options: SpawnOptions) => {
    calls.push([command, ...args].join(" "));
    return {} as ChildProcess;
  };
}

test("the guarded spawn refuses before starting the child, and starts an isolated one", () => {
  const calls: string[] = [];
  const spawn = guardedSpawn(fakeSpawn(calls), roots, noSecrets, guardDir);
  assert.throws(
    () => spawn("python", ["-m", "bugpilot", "doctor"], { env: { ...isolated, HOME: realHome, USERPROFILE: realHome } }),
    /Integration isolation refused to start python/,
  );
  assert.deepEqual(calls, []);
  spawn("python", ["-m", "bugpilot", "doctor"], { env: isolated });
  assert.deepEqual(calls, ["python -m bugpilot doctor"]);
});

test("a Python child without the guard first on PYTHONPATH is refused", () => {
  const calls: string[] = [];
  const spawn = guardedSpawn(fakeSpawn(calls), roots, noSecrets, guardDir);
  assert.throws(
    () => spawn("python3", ["-m", "bugpilot", "list"], { env: { ...isolated, PYTHONPATH: base } }),
    /guard is not first on PYTHONPATH/,
  );
  // A non-Python child does not need it.
  spawn("git", ["status"], { env: { ...isolated, PYTHONPATH: base } });
  assert.deepEqual(calls, ["git status"]);
});

// --- what the integration suite can start ------------------------------------

const EXTENSION = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** The relative `.ts` modules `file` loads at run time; `import type` is erased, so it loads nothing. */
function runtimeImports(file: string): string[] {
  const text = readFileSync(file, "utf8");
  const pattern = /^\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+"(\.{1,2}\/[^"]+\.ts)"/gm;
  return [...text.matchAll(pattern)].map((match) => path.resolve(path.dirname(file), match[1] ?? ""));
}

test("every process the integration suite can start goes through its isolation, or is a stated exception", () => {
  const suite = path.join(EXTENSION, "test-integration", "cli.integration.test.ts");
  const loaded = new Set<string>();
  const pending = [suite];
  while (pending.length > 0) {
    const file = pending.pop() ?? "";
    if (loaded.has(file)) continue;
    loaded.add(file);
    pending.push(...runtimeImports(file));
  }
  const relative = (file: string) => path.relative(EXTENSION, file).split(path.sep).join("/");
  // Of everything the suite loads, only the Runner starts a process, plus the suite and its isolation.
  const spawning = [...loaded].filter((file) => /from "node:child_process"/.test(readFileSync(file, "utf8")));
  assert.deepEqual(spawning.map(relative).sort(), [
    "src/runner.ts",
    "test-integration/cli.integration.test.ts",
    "test-integration/isolation.ts",
  ]);
  // Nothing it loads builds the production Runner, whose spawn is not the isolation's.
  const trusted = [...loaded].filter((file) => !file.endsWith("runner.ts") && readFileSync(file, "utf8").includes("trustedRunner("));
  assert.deepEqual(trusted.map(relative), []);

  const text = readFileSync(suite, "utf8");
  // Every Runner the suite builds is given the isolation's spawn.
  const runners = [...text.matchAll(/new Runner\(([^)]*)\)/g)].map((match) => match[1] ?? "");
  assert.ok(runners.length > 0);
  assert.deepEqual(runners.filter((args) => !args.includes("ISOLATION.spawn")), []);
  // discoverExecutable builds a Runner of its own: every call hands it a spawn.
  const discoveries = [...text.matchAll(/discoverExecutable\((\{[^}]*\})\)/g)].map((match) => match[1] ?? "");
  assert.equal(discoveries.length, (text.match(/discoverExecutable\(/g) ?? []).length);
  assert.deepEqual(discoveries.filter((options) => !/\bspawn\b/.test(options)), []);
  // Direct children: execFileSync only, each checked — or git, a stated exception isolated by
  // the suite's environment alone (non-Python programs carry no guard).
  assert.match(text, /import \{ execFileSync \} from "node:child_process";/);
  const calls = text.split("execFileSync(").slice(1).map((rest) => rest.slice(0, rest.indexOf(");")));
  assert.ok(calls.length > 0);
  assert.deepEqual(calls.filter((call) => !call.startsWith('"git"') && !call.includes("ISOLATION.checkedEnv(")), []);
});
