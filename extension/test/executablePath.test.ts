/**
 * No program is started from the repository because it is the working
 * directory.
 *
 * Node (libuv) on Windows looks for a bare name in the working directory before
 * PATH. Every program the extension starts is therefore resolved first — to an
 * absolute path on PATH, never in the working directory — and that path is
 * what runs. The last tests here plant real fakes and prove which one ran.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir, hostname } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import { childEnvironmentAdditions, environmentValue, locateExecutable } from "../src/executablePath.ts";
import { Runner, trustedRunner } from "../src/runner.ts";
import { discoverExecutable } from "../src/executable.ts";

const WINDOWS = process.platform === "win32";

/** A fake file system: the set of runnable paths, compared case-insensitively on Windows. */
function files(platform: string, ...paths: string[]) {
  const known = new Set(paths.map((entry) => (platform === "win32" ? entry.toLowerCase() : entry)));
  return (candidate: string) => known.has(platform === "win32" ? candidate.toLowerCase() : candidate);
}

test("a bare name resolves through PATH's absolute entries, in order", () => {
  const isRunnable = files("win32", "C:\\b\\bugpilot.exe", "C:\\c\\bugpilot.exe");
  const env = { PATH: "C:\\a;C:\\b;C:\\c" };
  assert.deepEqual(locateExecutable("bugpilot", { env, platform: "win32", isRunnable }), { kind: "found", path: "C:\\b\\bugpilot.exe" });
});

test("empty, '.' and relative PATH entries — the working directory — are never searched", () => {
  const isRunnable = files("win32", ".\\bugpilot.exe", "bugpilot.exe", "repo\\bugpilot.exe", "C:\\tools\\bugpilot.exe");
  for (const PATH of [".;C:\\tools", ";C:\\tools", "repo;C:\\tools", "\"C:\\tools\""]) {
    assert.deepEqual(
      locateExecutable("bugpilot", { env: { PATH }, platform: "win32", isRunnable }),
      { kind: "found", path: "C:\\tools\\bugpilot.exe" },
      PATH,
    );
  }
  assert.deepEqual(locateExecutable("bugpilot", { env: { PATH: ".;repo" }, platform: "win32", isRunnable }), { kind: "not-found" });
});

test("a program Node can start is an .exe or .com; a terminal may also run a .cmd", () => {
  const isRunnable = files("win32", "C:\\npm\\claude.cmd");
  const env = { PATH: "C:\\npm" };
  assert.deepEqual(locateExecutable("claude", { env, platform: "win32", isRunnable, purpose: "spawn" }), { kind: "not-found" });
  assert.deepEqual(locateExecutable("claude", { env, platform: "win32", isRunnable, purpose: "shell" }), { kind: "found", path: "C:\\npm\\claude.cmd" });
  // An explicit extension is the question asked, and PATHEXT does not widen it.
  assert.deepEqual(locateExecutable("claude.cmd", { env, platform: "win32", isRunnable, purpose: "spawn" }), { kind: "not-found" });
  assert.deepEqual(locateExecutable("claude.cmd", { env, platform: "win32", isRunnable, purpose: "shell" }).kind, "found");
});

test("no PATHEXT still means the four Windows guarantees; PATH and PATHEXT are read in any case", () => {
  const isRunnable = files("win32", "C:\\x\\tool.bat");
  const env = { Path: "C:\\x" };
  assert.deepEqual(locateExecutable("tool", { env, platform: "win32", isRunnable, purpose: "shell" }), { kind: "found", path: "C:\\x\\tool.bat" });
  assert.equal(environmentValue({ PathExt: ".EXE" }, "PATHEXT", "win32"), ".EXE");
  assert.equal(environmentValue({ PathExt: ".EXE" }, "PATHEXT", "linux"), undefined);
});

test("a configured absolute path is kept, a relative one is refused as invalid", () => {
  const isRunnable = files("win32", "C:\\tools\\bugpilot.exe");
  assert.deepEqual(locateExecutable("C:\\tools\\bugpilot.exe", { platform: "win32", isRunnable }), { kind: "found", path: "C:\\tools\\bugpilot.exe" });
  assert.deepEqual(locateExecutable("C:\\nope\\bugpilot.exe", { platform: "win32", isRunnable }), { kind: "not-found" });
  for (const relative of ["tools\\bugpilot.exe", ".\\bugpilot.exe", "C:bugpilot.exe", "./bugpilot"]) {
    const located = locateExecutable(relative, { platform: "win32", isRunnable });
    assert.equal(located.kind, "invalid", relative);
    if (located.kind === "invalid") assert.match(located.reason, /relative path/);
  }
});

test("on Linux and macOS: PATH's absolute entries only, and no extension rules", () => {
  const isRunnable = files("linux", "/usr/local/bin/claude", "./claude");
  assert.deepEqual(locateExecutable("claude", { env: { PATH: ".:/usr/local/bin" }, platform: "linux", isRunnable }), { kind: "found", path: "/usr/local/bin/claude" });
  assert.equal(locateExecutable("bin/claude", { env: { PATH: "/usr/bin" }, platform: "linux", isRunnable }).kind, "invalid");
});

test("children started under the policy inherit the switch that keeps the cwd out of their lookups", () => {
  assert.deepEqual(childEnvironmentAdditions("win32"), { NoDefaultCurrentDirectoryInExePath: "1" });
  assert.deepEqual(childEnvironmentAdditions("linux"), {});
});

// --- the Runner under the policy ------------------------------------------------

interface Spawned {
  readonly command: string;
  readonly env: Record<string, string | undefined>;
}

function fakeSpawn() {
  const spawned: Spawned[] = [];
  const spawn = (command: string, _args: string[], options: { env?: Record<string, string | undefined> }) => {
    spawned.push({ command, env: options.env ?? {} });
    const child = new EventEmitter() as unknown as ChildProcess & EventEmitter;
    Object.assign(child, { stdout: new PassThrough(), stderr: new PassThrough(), stdin: null, pid: 7, exitCode: null });
    setImmediate(() => {
      (child.stdout as PassThrough).end();
      (child.stderr as PassThrough).end();
      child.emit("close", 0, null);
    });
    return child;
  };
  return { spawned, spawn: spawn as never };
}

test("a policy Runner starts the absolute path its policy found, with the child switch on Windows", async () => {
  const { spawned, spawn } = fakeSpawn();
  const runner = new Runner("bugpilot", spawn, "win32", { locate: () => ({ kind: "found", path: "C:\\tools\\bugpilot.exe" }) });
  await runner.run(["doctor"], { cwd: "C:\\repo" });
  assert.equal(spawned[0]!.command, "C:\\tools\\bugpilot.exe");
  assert.equal(spawned[0]!.env["NoDefaultCurrentDirectoryInExePath"], "1");
});

test("a program the policy cannot find is ENOENT, and an untrusted value is its own error — nothing spawns", async () => {
  const { spawned, spawn } = fakeSpawn();
  const missing = new Runner("claude", spawn, "win32", { locate: () => ({ kind: "not-found" }) });
  await assert.rejects(missing.run(["-p"], { cwd: "C:\\repo" }), (error: { code?: string }) => error.code === "ENOENT");
  const invalid = new Runner(".\\claude.exe", spawn, "win32", { locate: () => ({ kind: "invalid", reason: "relative path" }) });
  await assert.rejects(invalid.run(["-p"], { cwd: "C:\\repo" }), (error: { code?: string }) => error.code === "BUGPILOT_INVALID_EXECUTABLE");
  assert.deepEqual(spawned, []);
});

test("discovery resolves once and reports the absolute path it will run, or why it will not", async () => {
  const doctor = `${JSON.stringify({ schema_version: 1, ok: true, command: "doctor", warnings: [], report: { version: "0.1.0" } })}\n`;
  const spawned: string[] = [];
  const spawn = ((command: string) => {
    spawned.push(command);
    const child = new EventEmitter() as unknown as ChildProcess & EventEmitter;
    const stdout = new PassThrough();
    Object.assign(child, { stdout, stderr: new PassThrough(), stdin: null, pid: 8, exitCode: null });
    setImmediate(() => {
      stdout.end(doctor);
      (child.stderr as PassThrough).end();
      child.emit("close", 0, null);
    });
    return child;
  }) as never;

  const ready = await discoverExecutable({ cwd: "C:\\repo", spawn, locate: () => ({ kind: "found", path: "C:\\py\\Scripts\\bugpilot.exe" }) });
  assert.equal(ready.kind, "ready");
  assert.equal(ready.executable, "C:\\py\\Scripts\\bugpilot.exe");
  assert.deepEqual(spawned, ["C:\\py\\Scripts\\bugpilot.exe"]);

  const relative = await discoverExecutable({ cwd: "C:\\repo", spawn, configured: "tools\\bugpilot.exe", locate: () => ({ kind: "invalid", reason: "x is a relative path" }) });
  assert.equal(relative.kind, "not-found");
  if (relative.kind === "not-found") assert.match(relative.detail, /configured bugpilot path is not valid/);

  const absent = await discoverExecutable({ cwd: "C:\\repo", spawn, locate: () => ({ kind: "not-found" }) });
  assert.equal(absent.kind, "not-found");
  if (absent.kind === "not-found") assert.match(absent.detail, /not on PATH/);
  assert.equal(spawned.length, 1, "nothing was spawned for a program that was not found or not trusted");
});

test("every production Runner is built through trustedRunner or from an already-resolved path", () => {
  const source = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src");
  const offenders: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const full = path.join(directory, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".ts") && !["runner.ts", "executable.ts"].includes(entry.name)) {
        if (/new Runner\(/.test(readFileSync(full, "utf8"))) offenders.push(entry.name);
      }
    }
  };
  walk(source);
  assert.deepEqual(offenders, [], "start programs with trustedRunner(), which resolves them under the policy");
});

// --- the real thing, with planted fakes ---------------------------------------------

test("on Windows, a bugpilot.exe in the working directory never runs — the one on PATH does", { skip: !WINDOWS }, async () => {
  const root = mkdtempSync(path.join(tmpdir(), "bugpilot-hijack-"));
  const repo = path.join(root, "repo");
  const bin = path.join(root, "bin");
  mkdirSync(repo);
  mkdirSync(bin);
  const system32 = path.join(process.env["SystemRoot"] ?? "C:\\Windows", "System32");
  // The fake prints the user name; the "real" one prints the machine name.
  copyFileSync(path.join(system32, "whoami.exe"), path.join(repo, "bugpilot.exe"));
  copyFileSync(path.join(system32, "hostname.exe"), path.join(bin, "bugpilot.exe"));
  writeFileSync(path.join(repo, "README.md"), "a repository with a planted executable\n");
  const saved = process.env["NoDefaultCurrentDirectoryInExePath"];
  // A normal user's environment: this switch is what would hide the problem.
  delete process.env["NoDefaultCurrentDirectoryInExePath"];
  try {
    const env = { PATH: `${bin};${system32}` };
    const plain = await new Runner("bugpilot").run([], { cwd: repo, env });
    const trusted = await trustedRunner("bugpilot").run([], { cwd: repo, env });
    // The hazard, reproduced: libuv picked the working directory's fake.
    assert.notEqual(plain.stdout.trim().toLowerCase(), hostname().toLowerCase(), "the plain spawn did not reproduce the hazard");
    // The fix: the PATH one ran.
    assert.equal(trusted.stdout.trim().toLowerCase(), hostname().toLowerCase());
  } finally {
    if (saved !== undefined) process.env["NoDefaultCurrentDirectoryInExePath"] = saved;
  }
});
