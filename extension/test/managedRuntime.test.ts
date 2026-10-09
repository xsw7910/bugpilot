/**
 * BugPilot's managed CLI runtime: where the CLI is resolved from, how
 * the private venv is created and proven, and what a missing CLI offers.
 *
 * Every process is scripted: no Python, pip or network is touched. The runtime
 * root is a real temporary directory, so marker writes, cleanup and the
 * path-safety refusals are exercised on a real file system.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

import { outdatedCliActions, resolveEnvironment } from "../src/app/environment.ts";
import { diagnostics } from "../src/app/diagnostics.ts";
import type { DiagnosticsInput } from "../src/app/diagnostics.ts";
import { COMMANDS } from "../src/commands.ts";
import { discoverExecutable } from "../src/executable.ts";
import type { Verdict } from "../src/executable.ts";
import type { Located } from "../src/executablePath.ts";
import { ManagedRuntimeManager } from "../src/managedRuntime.ts";
import type { RuntimeStatus } from "../src/managedRuntime.ts";
import type { RunOptions, RunResult } from "../src/runner.ts";

const VERSION = "0.1.1";
const PIP_ARGS = ["-I", "-m", "pip", "install", "--disable-pip-version-check", "--no-input", "--no-cache-dir", "--only-binary=:all:", `bugpilot==${VERSION}`];

// --- a scripted machine ------------------------------------------------------

interface Call {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly timeoutMs: number | undefined;
}

interface Script {
  /** The interpreters on PATH, by command name: their version, or `null` for one that fails the probe. */
  readonly pythons?: Readonly<Record<string, readonly number[] | null>>;
  /** `py -0p` output; its listed paths are created as files. */
  readonly launcherList?: (dir: string) => { stdout: string; versions: Record<string, readonly number[]> };
  readonly venvCode?: number;
  readonly venvStderr?: string;
  readonly pipCode?: number;
  readonly pipStderr?: string;
  /** Whether a successful pip leaves the bugpilot command behind. */
  readonly pipInstallsCli?: boolean;
  /** What the installed `bugpilot --version` prints. */
  readonly reports?: string;
}

function machine(script: Script = {}, options: { version?: string } = {}) {
  const base = mkdtempSync(path.join(tmpdir(), "bugpilot-runtime-"));
  const root = path.join(base, "storage", "runtime");
  const bin = path.join(base, "bin");
  mkdirSync(bin, { recursive: true });
  const calls: Call[] = [];
  const logged: string[] = [];
  const located: Record<string, string> = {};
  const versions: Record<string, readonly number[] | null> = {};
  for (const [name, version] of Object.entries(script.pythons ?? { python: [3, 12, 4] })) {
    const file = path.join(bin, `${name}${process.platform === "win32" ? ".exe" : ""}`);
    writeFileSync(file, "");
    located[name] = file;
    versions[file] = version;
  }
  let launcherStdout = "";
  if (script.launcherList) {
    const listed = script.launcherList(bin);
    launcherStdout = listed.stdout;
    for (const [file, version] of Object.entries(listed.versions)) {
      writeFileSync(file, "");
      versions[file] = version;
    }
  }
  const result = (code: number, stdout = "", stderr = ""): RunResult => ({ code, stdout, stderr, aborted: false });
  let manager!: ManagedRuntimeManager;
  const exec = async (program: string, args: readonly string[], runOptions: RunOptions): Promise<RunResult> => {
    calls.push({ program, args: [...args], cwd: runOptions.cwd, timeoutMs: runOptions.timeoutMs });
    const layout = manager.layout();
    if (args.includes("-0p")) return result(launcherStdout === "" ? 1 : 0, launcherStdout);
    if (args.includes("-c")) {
      const version = versions[program];
      if (!version) return result(9009, "", "Python was not found; run without arguments to install from the Microsoft Store");
      return result(0, `${JSON.stringify({ executable: program, version })}\n`);
    }
    if (args.includes("venv")) {
      const code = script.venvCode ?? 0;
      if (code === 0) {
        mkdirSync(path.dirname(layout.python), { recursive: true });
        writeFileSync(layout.python, "");
      }
      return result(code, "", script.venvStderr ?? "");
    }
    if (args.includes("pip")) {
      const code = script.pipCode ?? 0;
      if (code === 0 && script.pipInstallsCli !== false) writeFileSync(layout.cli, "");
      return result(code, code === 0 ? `Successfully installed bugpilot-${VERSION}\n` : "", script.pipStderr ?? "");
    }
    if (args[0] === "--version") return result(0, `bugpilot ${script.reports ?? VERSION}\n`);
    return result(127, "", "unexpected program");
  };
  const locate = (name: string): Located => (located[name] ? { kind: "found", path: located[name]! } : { kind: "not-found" });
  manager = new ManagedRuntimeManager({
    root,
    version: options.version ?? VERSION,
    exec,
    locate,
    log: { info: (line) => logged.push(line), error: (line) => logged.push(line) },
  });
  return { manager, root, base, calls, logged, located };
}

// --- runtime setup -----------------------------------------------------------

test("a supported Python is found, the venv is created with it, and the exact CLI version is installed", async () => {
  const { manager, root, calls, located } = machine();
  const outcome = await manager.install();
  assert.equal(outcome.kind, "ready");
  const layout = manager.layout();

  const venv = calls.find((call) => call.args.includes("venv"))!;
  assert.equal(venv.program, located["python"], "the interpreter the probe proved, by absolute path");
  assert.deepEqual(venv.args, ["-I", "-m", "venv", layout.venv]);

  const pip = calls.find((call) => call.args.includes("pip"))!;
  assert.equal(pip.program, layout.python, "the venv's own Python, never `pip` or an activated shell");
  assert.deepEqual(pip.args, PIP_ARGS);
  assert.ok(path.isAbsolute(pip.program));

  // Nothing ran with a repository as its working directory; every step had a limit.
  for (const call of calls) {
    assert.equal(call.cwd, root);
    assert.ok((call.timeoutMs ?? 0) > 0, `${call.args.join(" ")} has no timeout`);
  }
});

test("the runtime is per version, inside the root it was given, with the platform's own layout", () => {
  const windows = new ManagedRuntimeManager({ root: path.join(tmpdir(), "rt"), version: VERSION, platform: "win32" }).layout();
  assert.equal(windows.directory, path.join(tmpdir(), "rt", VERSION));
  assert.equal(windows.python, path.join(windows.venv, "Scripts", "python.exe"));
  assert.equal(windows.cli, path.join(windows.venv, "Scripts", "bugpilot.exe"));
  const posix = new ManagedRuntimeManager({ root: path.join(tmpdir(), "rt"), version: VERSION, platform: "linux" }).layout();
  assert.equal(posix.python, path.join(posix.venv, "bin", "python"));
  assert.equal(posix.cli, path.join(posix.venv, "bin", "bugpilot"));
  assert.equal(path.basename(posix.marker), "runtime.json");
});

test("a successful version check is what makes the runtime ready, and the marker records it", async () => {
  const { manager } = machine();
  assert.deepEqual(manager.status(), { kind: "not-installed", version: VERSION });
  const outcome = await manager.install();
  assert.equal(outcome.kind, "ready");
  const status = manager.status();
  assert.equal(status.kind, "ready");
  if (status.kind !== "ready") return;
  assert.equal(status.executable, manager.layout().cli);
  assert.equal(status.pythonVersion, "3.12.4");
  const marker = JSON.parse(readFileSync(manager.layout().marker, "utf8")) as Record<string, unknown>;
  assert.equal(marker["version"], VERSION);
  assert.equal(marker["requirement"], `bugpilot==${VERSION}`);
});

test("a failed pip never marks the runtime ready, and leaves nothing behind", async () => {
  const { manager, logged } = machine({ pipCode: 1, pipStderr: "ERROR: No matching distribution found for bugpilot==0.1.1" });
  const outcome = await manager.install();
  assert.deepEqual(outcome, { kind: "failed", step: "pip", detail: `PyPI has no bugpilot==${VERSION} for this Python.` });
  assert.equal(existsSync(manager.layout().marker), false);
  assert.equal(existsSync(manager.layout().directory), false, "an unfinished runtime is removed");
  assert.equal(manager.status().kind, "install-failed");
  // pip's own words are in the log, not in the outcome a toast shows.
  assert.ok(logged.some((line) => line.includes("No matching distribution")));
});

test("pip's output reaches the log without a credential in an index URL", async () => {
  const { manager, logged } = machine({ pipCode: 1, pipStderr: "Looking in indexes: https://deploy:hunter2-secret@pypi.example.com/simple\nERROR: failed" });
  await manager.install();
  const text = logged.join("\n");
  assert.equal(text.includes("hunter2-secret"), false);
  assert.ok(text.includes("https://****@pypi.example.com/simple"));
});

test("a CLI reporting another version is not accepted", async () => {
  const { manager } = machine({ reports: "0.1.0" });
  const outcome = await manager.install();
  assert.deepEqual(outcome, { kind: "failed", step: "validate", detail: `The installed CLI reports 0.1.0, not ${VERSION}.` });
  assert.notEqual(manager.status().kind, "ready");
});

test("pip that installs no bugpilot command is a failure, not a runtime", async () => {
  const { manager } = machine({ pipInstallsCli: false });
  const outcome = await manager.install();
  assert.equal(outcome.kind, "failed");
  assert.equal(outcome.kind === "failed" && outcome.step, "pip");
});

test("a Python without venv support says what is missing", async () => {
  const { manager } = machine({ venvCode: 1, venvStderr: "The virtual environment was not created successfully because ensurepip is not available." });
  const outcome = await manager.install();
  assert.equal(outcome.kind === "failed" && outcome.step, "venv");
  assert.match(outcome.kind === "failed" ? outcome.detail : "", /python3-venv/);
});

test("an interrupted install reads as broken and is replaced by the next attempt", async () => {
  const { manager } = machine();
  // VS Code closed after the venv was made: no runtime.json.
  const layout = manager.layout();
  mkdirSync(path.dirname(layout.python), { recursive: true });
  writeFileSync(layout.python, "");
  writeFileSync(path.join(layout.directory, "leftover.txt"), "half an install");
  const before = manager.status();
  assert.equal(before.kind, "broken");
  const outcome = await manager.install();
  assert.equal(outcome.kind, "ready");
  assert.equal(existsSync(path.join(layout.directory, "leftover.txt")), false, "rebuilt, not built on");
});

test("a second request while one install runs gets the same install, not a second pip", async () => {
  const { manager, calls } = machine();
  const first = manager.install();
  assert.equal(manager.installing, true);
  const second = manager.install();
  assert.equal(second, first);
  await Promise.all([first, second]);
  assert.equal(calls.filter((call) => call.args.includes("pip")).length, 1);
  assert.equal(manager.installing, false);
});

test("another window's install lock is respected, and a stale one is taken over", async () => {
  const { manager, root } = machine();
  mkdirSync(root, { recursive: true });
  const lock = path.join(root, `${VERSION}.lock`);
  writeFileSync(lock, "{}");
  assert.deepEqual(await manager.install(), { kind: "busy" });
  const old = new Date(Date.now() - 60 * 60_000);
  utimesSync(lock, old, old);
  assert.equal((await manager.install()).kind, "ready");
  assert.equal(existsSync(lock), false, "released after the install");
});

test("the status reports the step while an install runs", async () => {
  const { manager } = machine();
  const steps: string[] = [];
  const seen: RuntimeStatus["kind"][] = [];
  await manager.install((step) => {
    steps.push(step);
    seen.push(manager.status().kind);
  });
  assert.deepEqual(steps, ["python", "venv", "pip", "validate"]);
  assert.deepEqual([...new Set(seen)], ["installing"]);
});

// --- Python discovery ------------------------------------------------------------

test("a Python older than 3.10 is refused, and the newest one found is named", async () => {
  const { manager, calls } = machine({ pythons: { python3: [3, 9, 13], python: [3, 8, 10] } });
  const outcome = await manager.install();
  assert.deepEqual(outcome, { kind: "unsupported-python", found: "3.9.13" });
  assert.deepEqual(manager.status(), { kind: "unsupported-python", version: VERSION, found: "3.9.13" });
  assert.equal(calls.some((call) => call.args.includes("venv")), false, "no environment is made with it");
});

test("no Python at all is its own answer", async () => {
  const { manager } = machine({ pythons: {} });
  assert.deepEqual(await manager.install(), { kind: "no-python" });
  assert.equal(manager.status().kind, "no-python");
});

test("a placeholder that is not really Python fails the probe and is skipped", async () => {
  // The Microsoft Store alias answers `python` with a message and exit 9009.
  const { manager, calls, located } = machine({ pythons: { python: null, python3: [3, 11, 9] } });
  assert.equal((await manager.install()).kind, "ready");
  assert.equal(calls.find((call) => call.args.includes("venv"))!.program, located["python3"]);
});

test("on Windows the py launcher's newest 3.10+ interpreter is preferred", async (t) => {
  if (process.platform !== "win32") return t.skip("the py launcher is a Windows program");
  const { manager, calls } = machine({
    pythons: { py: [3, 8, 10] },
    launcherList: (dir) => {
      const old = path.join(dir, "Python38", "python.exe");
      const newest = path.join(dir, "Python312", "python.exe");
      mkdirSync(path.dirname(old), { recursive: true });
      mkdirSync(path.dirname(newest), { recursive: true });
      return {
        stdout: ` -V:3.12 *        ${newest}\n -V:3.8           ${old}\n`,
        versions: { [old]: [3, 8, 10], [newest]: [3, 12, 4] },
      };
    },
  });
  assert.equal((await manager.install()).kind, "ready");
  assert.match(calls.find((call) => call.args.includes("venv"))!.program, /Python312/);
});

// --- path safety -------------------------------------------------------------------

test("a version that is not a version is refused before anything is touched", async () => {
  const { manager, base, calls } = machine({}, { version: "../../outside" });
  const sentinel = path.join(base, "outside.txt");
  writeFileSync(sentinel, "keep");
  const outcome = await manager.install();
  assert.equal(outcome.kind, "failed");
  assert.equal(calls.length, 0);
  assert.equal(readFileSync(sentinel, "utf8"), "keep");
});

test("cleanup refuses a version directory that is a link, and what it points at survives", async () => {
  const { manager, root, base } = machine();
  const elsewhere = path.join(base, "elsewhere");
  mkdirSync(elsewhere, { recursive: true });
  writeFileSync(path.join(elsewhere, "precious.txt"), "keep");
  mkdirSync(root, { recursive: true });
  symlinkSync(elsewhere, manager.layout().directory, process.platform === "win32" ? "junction" : "dir");
  const outcome = await manager.install();
  assert.equal(outcome.kind, "failed");
  assert.match(outcome.kind === "failed" ? outcome.detail : "", /not a real directory/);
  assert.equal(readFileSync(path.join(elsewhere, "precious.txt"), "utf8"), "keep");
});

test("the runtime manager never asks for a shell", () => {
  const source = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "managedRuntime.ts"), "utf8");
  assert.equal(/\bshell\s*:/.test(source), false);
  assert.equal(source.includes("node:child_process"), false, "programs start through trustedRunner, argv only");
  assert.equal(/new Runner\(/.test(source), false);
});

// --- CLI resolution ----------------------------------------------------------------

const PATH_CLI = path.join(tmpdir(), "path-bin", "bugpilot.exe");
const MANAGED_CLI = path.join(tmpdir(), "storage", "runtime", VERSION, "venv", "Scripts", "bugpilot.exe");
const CONFIGURED_CLI = path.join(tmpdir(), "tools", "bugpilot.exe");

/** A spawn that answers `doctor --json` with the version each executable reports. */
function doctors(reports: Readonly<Record<string, string>>) {
  const spawned: string[] = [];
  const spawn = ((command: string) => {
    spawned.push(command);
    const child = new EventEmitter() as unknown as ChildProcess & EventEmitter;
    const stdout = new PassThrough();
    Object.assign(child, { stdout, stderr: new PassThrough(), stdin: null, pid: 8, exitCode: null });
    setImmediate(() => {
      stdout.end(`${JSON.stringify({ schema_version: 1, ok: true, command: "doctor", warnings: [], report: { version: reports[command] } })}\n`);
      (child.stderr as PassThrough).end();
      child.emit("close", 0, null);
    });
    return child;
  }) as never;
  return { spawn, spawned };
}

function locator(present: readonly string[]) {
  return (name: string): Located => {
    if (name === "bugpilot") return present.includes(PATH_CLI) ? { kind: "found", path: PATH_CLI } : { kind: "not-found" };
    return present.includes(name) ? { kind: "found", path: name } : { kind: "not-found" };
  };
}

test("an explicit executablePath wins over the managed runtime and PATH", async () => {
  const { spawn, spawned } = doctors({ [CONFIGURED_CLI]: "0.1.0", [MANAGED_CLI]: VERSION, [PATH_CLI]: "0.1.0" });
  const verdict = await discoverExecutable({
    cwd: "/repo",
    configured: CONFIGURED_CLI,
    managed: { executable: MANAGED_CLI, version: VERSION },
    spawn,
    locate: locator([CONFIGURED_CLI, MANAGED_CLI, PATH_CLI]),
  });
  assert.equal(verdict.kind, "ready");
  assert.equal(verdict.source, "configured");
  assert.deepEqual(spawned, [CONFIGURED_CLI]);
});

test("a broken explicit executablePath is not silently replaced by the runtime", async () => {
  const { spawn, spawned } = doctors({ [MANAGED_CLI]: VERSION });
  const verdict = await discoverExecutable({
    cwd: "/repo",
    configured: CONFIGURED_CLI,
    managed: { executable: MANAGED_CLI, version: VERSION },
    spawn,
    locate: locator([MANAGED_CLI]),
  });
  assert.equal(verdict.kind, "not-found");
  assert.equal(verdict.source, "configured");
  assert.match(verdict.kind === "not-found" ? verdict.detail : "", /configured bugpilot path does not exist/);
  assert.deepEqual(spawned, []);
});

test("the managed runtime wins over PATH", async () => {
  const { spawn, spawned } = doctors({ [MANAGED_CLI]: VERSION, [PATH_CLI]: "0.1.0" });
  const verdict = await discoverExecutable({
    cwd: "/repo",
    managed: { executable: MANAGED_CLI, version: VERSION },
    spawn,
    locate: locator([MANAGED_CLI, PATH_CLI]),
  });
  assert.equal(verdict.kind, "ready");
  assert.equal(verdict.source, "managed");
  assert.equal(verdict.kind === "ready" && verdict.executable, MANAGED_CLI);
  assert.deepEqual(spawned, [MANAGED_CLI], "PATH is not even asked");
});

test("PATH is used when there is no managed runtime", async () => {
  const { spawn } = doctors({ [PATH_CLI]: "0.1.0" });
  const verdict = await discoverExecutable({ cwd: "/repo", spawn, locate: locator([PATH_CLI]) });
  assert.equal(verdict.kind, "ready");
  assert.equal(verdict.source, "path");
  assert.equal(verdict.managedRejected, undefined);
});

test("a managed runtime whose CLI is gone is passed over for PATH, and the reason travels", async () => {
  const { spawn } = doctors({ [PATH_CLI]: "0.1.0" });
  const verdict = await discoverExecutable({
    cwd: "/repo",
    managed: { executable: MANAGED_CLI, version: VERSION },
    spawn,
    locate: locator([PATH_CLI]),
  });
  assert.equal(verdict.kind, "ready");
  assert.equal(verdict.source, "path");
  assert.equal(verdict.managedRejected, "Its bugpilot executable is missing.");
});

test("a managed runtime reporting another version is rejected", async () => {
  const { spawn } = doctors({ [MANAGED_CLI]: "0.0.9" });
  const verdict = await discoverExecutable({
    cwd: "/repo",
    managed: { executable: MANAGED_CLI, version: VERSION },
    spawn,
    locate: locator([MANAGED_CLI]),
  });
  assert.equal(verdict.kind, "not-found", "nothing else to use: PATH has no bugpilot");
  assert.equal(verdict.source, "path");
  assert.equal(verdict.managedRejected, `Its bugpilot reports 0.0.9, not ${VERSION}.`);
});

// --- what a missing CLI offers ------------------------------------------------------

const notOnPath: Verdict = { kind: "not-found", source: "path", executable: "bugpilot", detail: "bugpilot is not on PATH." };

async function cardFor(verdict: Verdict, runtime: RuntimeStatus | undefined) {
  const environment = await resolveEnvironment({
    folders: [{ name: "app", fsPath: "/work/app" }],
    probe: { hasDirectory: (_folder, child) => child === ".git" },
    discover: async () => verdict,
    ...(runtime === undefined ? {} : { runtime: () => runtime }),
  });
  assert.equal(environment.kind, "unusable-cli");
  if (environment.kind !== "unusable-cli") throw new Error("not a card");
  return environment;
}

test("a missing CLI offers Install BugPilot Runtime first, and still Choose Executable", async () => {
  const card = await cardFor(notOnPath, { kind: "not-installed", version: VERSION });
  assert.equal(card.summary, "BugPilot CLI is required.");
  assert.deepEqual(
    card.actions.map((action) => [action.title, action.command, action.primary === true]),
    [
      ["Install BugPilot Runtime", COMMANDS.installRuntime, true],
      ["Choose Executable", COMMANDS.chooseExecutable, false],
      ["Install Instructions", COMMANDS.showInstallInstructions, false],
      ["Retry", COMMANDS.checkEnvironment, false],
    ],
  );
});

test("while the runtime installs, the card says so and offers nothing to press", async () => {
  const card = await cardFor(notOnPath, { kind: "installing", version: VERSION, step: "pip" });
  assert.equal(card.summary, "Installing BugPilot Runtime…");
  assert.equal(card.action, "Installing the BugPilot CLI from PyPI…");
  assert.deepEqual(card.actions, []);
});

test("a failed install is actionable: retry, choose an executable, or read the details", async () => {
  const card = await cardFor(notOnPath, { kind: "install-failed", version: VERSION, step: "pip", detail: "PyPI could not be reached." });
  assert.equal(card.summary, "BugPilot runtime setup could not be completed.");
  assert.match(card.action, /PyPI could not be reached/);
  assert.deepEqual(
    card.actions.map((action) => [action.title, action.command]),
    [
      ["Retry", COMMANDS.installRuntime],
      ["Choose Executable", COMMANDS.chooseExecutable],
      ["Show Details", COMMANDS.showLog],
    ],
  );
});

test("no suitable Python names the requirement", async () => {
  for (const runtime of [
    { kind: "no-python", version: VERSION },
    { kind: "unsupported-python", version: VERSION, found: "3.9.13" },
  ] as const) {
    const card = await cardFor(notOnPath, runtime);
    assert.equal(card.summary, "Python 3.10 or later is required to install the BugPilot runtime.");
    assert.ok(card.actions.some((action) => action.command === COMMANDS.chooseExecutable));
  }
});

test("a broken runtime offers a reinstall", async () => {
  const card = await cardFor(notOnPath, { kind: "broken", version: VERSION, detail: "Its bugpilot executable is missing." });
  assert.equal(card.summary, "The BugPilot runtime is not working.");
  assert.equal(card.actions[0]!.command, COMMANDS.installRuntime);
});

test("a broken configured path keeps its own card: a runtime would not change which bugpilot runs", async () => {
  const configured: Verdict = { kind: "not-found", source: "configured", executable: CONFIGURED_CLI, detail: "The configured bugpilot path does not exist." };
  const card = await cardFor(configured, { kind: "not-installed", version: VERSION });
  assert.equal(card.actions.some((action) => action.command === COMMANDS.installRuntime), false);
  assert.ok(card.actions.some((action) => action.command === COMMANDS.chooseExecutable));
});

test("a ready managed runtime makes BugPilot ready, and says where the CLI came from", async () => {
  const environment = await resolveEnvironment({
    folders: [{ name: "app", fsPath: "/work/app" }],
    probe: { hasDirectory: (_folder, child) => child === ".git" },
    discover: async () => ({ kind: "ready", source: "managed", executable: MANAGED_CLI, report: {}, version: VERSION }),
    runtime: () => ({ kind: "ready", version: VERSION, executable: MANAGED_CLI, pythonVersion: "3.12.4" }),
  });
  assert.equal(environment.kind, "ready");
  assert.equal(environment.kind === "ready" && environment.source, "managed");
  assert.equal(environment.kind === "ready" && environment.runtime?.kind, "ready");
});

// --- diagnostics -----------------------------------------------------------------------

const base: DiagnosticsInput = { jiraConfigured: false, agent: "auto", source: "jira" };
const row = (input: DiagnosticsInput, label: string) => diagnostics(input).rows.find((entry) => entry.label === label);

test("Diagnostics say where the CLI came from, and how the runtime stands", () => {
  const ready = { ...base, executable: MANAGED_CLI, cliVersion: VERSION, cliSource: "managed" as const, runtime: { kind: "ready", version: VERSION, executable: MANAGED_CLI, pythonVersion: "3.12.4" } as const };
  assert.deepEqual(row(ready, "CLI source"), { label: "CLI source", value: "BugPilot runtime" });
  assert.deepEqual(row(ready, "BugPilot runtime"), { label: "BugPilot runtime", value: `Ready · ${VERSION}`, detail: "Python 3.12.4" });
  // The runtime row names no path; the CLI row above it already does.
  assert.equal(JSON.stringify(row(ready, "BugPilot runtime")).includes("storage"), false);

  assert.deepEqual(row({ ...base, cliSource: "path", executable: PATH_CLI }, "CLI source")?.value, "PATH");
  assert.deepEqual(row({ ...base, cliSource: "configured", executable: CONFIGURED_CLI }, "CLI source")?.value, "Configured path");
  assert.deepEqual(row(base, "CLI source")?.value, "Unavailable");
  assert.equal(row({ ...base, runtime: { kind: "not-installed", version: VERSION } }, "BugPilot runtime")?.value, "Not installed");
  assert.equal(row({ ...base, runtime: { kind: "install-failed", version: VERSION, step: "pip", detail: "PyPI could not be reached." } }, "BugPilot runtime")?.value, "Setup failed");
});

// --- Hardening and the out-of-date card -------------------------------------------------

test("every install command is logged as it starts: program name and argv", async () => {
  const { manager, logged } = machine();
  await manager.install();
  const running = logged.filter((line) => line.startsWith("BugPilot runtime: running "));
  assert.equal(running.length, 3);
  assert.match(running[0]!, /running python(\.exe)? -I -m venv /);
  assert.match(running[1]!, /running python(\.exe)? -I -m pip install --disable-pip-version-check --no-input --no-cache-dir --only-binary=:all: bugpilot==0\.1\.1$/);
  assert.match(running[2]!, /running bugpilot(\.exe)? --version$/);
});

test("the layout refuses a version that is not one, whoever asks", () => {
  const manager = new ManagedRuntimeManager({ root: path.join(tmpdir(), "rt"), version: "..\..\outside" });
  assert.throws(() => manager.layout(), /not a version/);
  assert.deepEqual(manager.status(), { kind: "not-installed", version: "..\..\outside" });
});

test("runtime.json decides only whether the runtime is ready, and shows only a version", async () => {
  const { manager } = machine();
  await manager.install();
  const layout = manager.layout();
  writeFileSync(layout.marker, JSON.stringify({ schema: 1, version: VERSION, python: "<img src=x onerror=alert(1)>", executable: "C:\evil\bugpilot.exe" }));
  const status = manager.status();
  assert.equal(status.kind, "ready");
  if (status.kind !== "ready") return;
  assert.equal(status.pythonVersion, "unknown");
  assert.equal(status.executable, layout.cli, "the executable is the layout's, never the marker's");
  writeFileSync(layout.marker, "null");
  assert.equal(manager.status().kind, "broken");
});

test("a marker whose files are gone reads as broken, and says so", async () => {
  const { manager } = machine();
  await manager.install();
  rmSync(manager.layout().cli);
  const status = manager.status();
  assert.equal(status.kind, "broken");
  assert.match(status.kind === "broken" ? status.detail : "", /incomplete/);
});

test("nothing is removed under a runtime root that is a link", async () => {
  const { manager, root, base } = machine();
  const elsewhere = path.join(base, "elsewhere-root");
  mkdirSync(path.join(elsewhere, VERSION), { recursive: true });
  writeFileSync(path.join(elsewhere, VERSION, "precious.txt"), "keep");
  mkdirSync(path.dirname(root), { recursive: true });
  symlinkSync(elsewhere, root, process.platform === "win32" ? "junction" : "dir");
  const outcome = await manager.install();
  assert.equal(outcome.kind, "failed");
  assert.match(outcome.kind === "failed" ? outcome.detail : "", /runtime root is a link/);
  assert.equal(readFileSync(path.join(elsewhere, VERSION, "precious.txt"), "utf8"), "keep");
});

test("a CLI on PATH too old for the extension is offered the runtime, when nothing is configured", async () => {
  const old: Verdict = { kind: "incompatible", source: "path", executable: PATH_CLI, detail: "unrecognized arguments: --json" };
  const card = await cardFor(old, { kind: "not-installed", version: VERSION });
  assert.match(card.summary, /does not support the machine-readable output/);
  assert.match(card.action, /Or install BugPilot Runtime/);
  assert.deepEqual(
    card.actions.map((action) => [action.command, action.primary === true]),
    [
      [COMMANDS.installRuntime, true],
      [COMMANDS.showInstallInstructions, false],
      [COMMANDS.chooseExecutable, false],
      [COMMANDS.checkEnvironment, false],
    ],
  );
  // A configured CLI that is too old is the developer's choice: no runtime offer.
  const configured: Verdict = { ...old, source: "configured", executable: CONFIGURED_CLI };
  const environment = await resolveEnvironment({
    folders: [{ name: "app", fsPath: "/work/app" }],
    probe: { hasDirectory: (_folder, child) => child === ".git" },
    discover: async () => configured,
    runtime: () => ({ kind: "not-installed", version: VERSION }),
  });
  assert.equal(environment.kind === "unusable-cli" && environment.actions.some((action) => action.command === COMMANDS.installRuntime), false);
});

test("the out-of-date card a Run raises offers the runtime only for a CLI from PATH", () => {
  assert.deepEqual(outdatedCliActions(true)[0], { title: "Install BugPilot Runtime", command: COMMANDS.installRuntime, primary: true });
  assert.equal(outdatedCliActions(true).length, 4);
  assert.deepEqual(outdatedCliActions().map((action) => action.command), [COMMANDS.showInstallInstructions, COMMANDS.chooseExecutable, COMMANDS.checkEnvironment]);
});

test("pip that could not reach its index is reported as that, not as a missing version", async () => {
  // Exactly what pip prints with an unreachable index and retries off.
  const silent = machine({ pipCode: 1, pipStderr: "ERROR: Could not find a version that satisfies the requirement bugpilot==0.1.1 (from versions: none)\nERROR: No matching distribution found for bugpilot==0.1.1" });
  const quiet = await silent.manager.install();
  assert.match(quiet.kind === "failed" ? quiet.detail : "", /^pip could not get bugpilot from its package index. Check the network/);
  // With pip's default retries it also warns about the connection first.
  const loud = machine({ pipCode: 1, pipStderr: "WARNING: Retrying (Retry(total=4, connect=None, read=None, redirect=None, status=None)) after connection broken by 'NewConnectionError(...)': /simple/bugpilot/\nERROR: Could not find a version that satisfies the requirement bugpilot==0.1.1 (from versions: none)\nERROR: No matching distribution found for bugpilot==0.1.1" });
  const outcome = await loud.manager.install();
  assert.equal(outcome.kind === "failed" && outcome.detail, "PyPI could not be reached. Check the network, or the proxy settings pip uses.");
  // A reachable PyPI without that version lists the versions it has.
  const missing = machine({ pipCode: 1, pipStderr: "ERROR: Could not find a version that satisfies the requirement bugpilot==0.1.1 (from versions: 0.1.0)\nERROR: No matching distribution found for bugpilot==0.1.1" });
  const absent = await missing.manager.install();
  assert.equal(absent.kind === "failed" && absent.detail, `PyPI has no bugpilot==${VERSION} for this Python.`);
});
