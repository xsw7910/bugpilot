import { test } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { ChildProcess, SpawnOptions } from "node:child_process";

import {
  DEFAULT_EXECUTABLE,
  describeVerdict,
  discoverExecutable,
  launcherNames,
} from "../src/executable.ts";
import type { SpawnFn } from "../src/runner.ts";
import { chooseRepoRoot, isWithin } from "../src/workspace.ts";
import type { Folder } from "../src/workspace.ts";
import { CredentialStore, assertNoSecretsInArgs } from "../src/secrets.ts";
import type { SecretStore } from "../src/secrets.ts";

// --- executable discovery --------------------------------------------------

type Behaviour =
  | { readonly kind: "envelope"; readonly stdout: string; readonly code: number }
  | { readonly kind: "spawn-error"; readonly code: string }
  | { readonly kind: "old-cli" };

function spawnWith(behaviour: Behaviour): { spawn: SpawnFn; calls: string[] } {
  const calls: string[] = [];
  const spawn: SpawnFn = (command: string, _args: string[], _options: SpawnOptions) => {
    calls.push(command);
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdout = new EventEmitter() as EventEmitter & { setEncoding(e: string): void };
    const stderr = new EventEmitter() as EventEmitter & { setEncoding(e: string): void };
    stdout.setEncoding = () => {};
    stderr.setEncoding = () => {};
    child["stdout"] = stdout;
    child["stderr"] = stderr;
    child["pid"] = 1;
    child["exitCode"] = null;
    child["kill"] = () => true;

    setTimeout(() => {
      if (behaviour.kind === "spawn-error") {
        child.emit("error", Object.assign(new Error("spawn failed"), { code: behaviour.code }));
        return;
      }
      if (behaviour.kind === "old-cli") {
        // argparse's reaction to an unknown flag: nothing on stdout, usage on stderr.
        stderr.emit("data", "usage: bugpilot doctor\nbugpilot: error: unrecognized arguments: --json\n");
        child["exitCode"] = 2;
        child.emit("close", 2);
        return;
      }
      stdout.emit("data", behaviour.stdout);
      child["exitCode"] = behaviour.code;
      child.emit("close", behaviour.code);
    }, 0);

    return child as unknown as ChildProcess;
  };
  return { spawn, calls };
}

const doctorEnvelope = `${JSON.stringify({
  schema_version: 1,
  ok: true,
  command: "doctor",
  warnings: [],
  report: { version: "0.1.0", python_ok: true, rg_available: true },
})}\n`;

test("a working bugpilot is reported ready with its doctor report", async () => {
  const { spawn, calls } = spawnWith({ kind: "envelope", stdout: doctorEnvelope, code: 0 });
  const verdict = await discoverExecutable({ cwd: "/repo", spawn });

  assert.equal(verdict.kind, "ready");
  assert.equal(verdict.executable, DEFAULT_EXECUTABLE);
  if (verdict.kind === "ready") assert.equal(verdict.report["python_ok"], true);
  assert.deepEqual(calls, [DEFAULT_EXECUTABLE]);
});

test("a configured path is used instead of PATH", async () => {
  const { spawn, calls } = spawnWith({ kind: "envelope", stdout: doctorEnvelope, code: 0 });
  const verdict = await discoverExecutable({
    cwd: "/repo",
    spawn,
    configured: "C:\\tools\\bugpilot.exe",
  });

  assert.equal(verdict.executable, "C:\\tools\\bugpilot.exe");
  assert.deepEqual(calls, ["C:\\tools\\bugpilot.exe"]);
});

test("a blank configured path falls back to PATH", async () => {
  const { spawn } = spawnWith({ kind: "envelope", stdout: doctorEnvelope, code: 0 });
  const verdict = await discoverExecutable({ cwd: "/repo", spawn, configured: "   " });
  assert.equal(verdict.executable, DEFAULT_EXECUTABLE);
});

test("ENOENT means not found, with advice naming PATH", async () => {
  const { spawn } = spawnWith({ kind: "spawn-error", code: "ENOENT" });
  const verdict = await discoverExecutable({ cwd: "/repo", spawn });

  assert.equal(verdict.kind, "not-found");
  assert.match(verdict.kind === "not-found" ? verdict.detail : "", /not on PATH/);
  assert.match(describeVerdict(verdict).action, /executablePath/);
});

test("a broken configured path says so instead of blaming PATH", async () => {
  // Falling back to a different bugpilot than the developer named would make the
  // failure impossible to diagnose.
  const { spawn } = spawnWith({ kind: "spawn-error", code: "ENOENT" });
  const verdict = await discoverExecutable({ cwd: "/repo", spawn, configured: "/nope/bugpilot" });

  assert.equal(verdict.kind, "not-found");
  assert.match(verdict.kind === "not-found" ? verdict.detail : "", /configured bugpilot path/);
});

test("a bugpilot too old for --json is incompatible, not missing", async () => {
  // The distinction matters: "install bugpilot" is the wrong advice for someone
  // who already has one.
  const { spawn } = spawnWith({ kind: "old-cli" });
  const verdict = await discoverExecutable({ cwd: "/repo", spawn });

  assert.equal(verdict.kind, "incompatible");
  assert.match(verdict.kind === "incompatible" ? verdict.detail : "", /unrecognized arguments/);
  assert.match(describeVerdict(verdict).action, /Update bugpilot/);
});

test("a doctor failure means unhealthy, not incompatible", async () => {
  // A well-formed failure envelope *proves* the binary speaks the contract, so
  // calling it incompatible would send the developer to update a fine bugpilot.
  const failure = `${JSON.stringify({
    schema_version: 1,
    ok: false,
    command: "doctor",
    error: { code: "JIRA_NOT_CONFIGURED", message: "env vars missing" },
  })}\n`;
  const { spawn } = spawnWith({ kind: "envelope", stdout: failure, code: 1 });
  const verdict = await discoverExecutable({ cwd: "/repo", spawn });

  assert.equal(verdict.kind, "unhealthy");
  if (verdict.kind === "unhealthy") assert.equal(verdict.code, "JIRA_NOT_CONFIGURED");
  // Advice comes from the shared code table, not a second explanation.
  assert.match(describeVerdict(verdict).action, /bugpilot setup/);
});

test("a non-executable binary is not reported as absent", async () => {
  // "install bugpilot" is the wrong advice for a binary that is already there.
  const { spawn } = spawnWith({ kind: "spawn-error", code: "EACCES" });
  const verdict = await discoverExecutable({ cwd: "/repo", spawn });

  assert.equal(verdict.kind, "not-found");
  assert.match(verdict.kind === "not-found" ? verdict.detail : "", /not executable/);
});

test("a timed-out handshake is unresponsive, not incompatible", async () => {
  // A frozen exe cold-starting under antivirus can exceed the timeout; telling
  // the developer to update a working bugpilot would be wrong.
  const spawn: SpawnFn = (_command, _args, _options) => {
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdout = new EventEmitter() as EventEmitter & { setEncoding(e: string): void };
    const stderr = new EventEmitter() as EventEmitter & { setEncoding(e: string): void };
    stdout.setEncoding = () => {};
    stderr.setEncoding = () => {};
    child["stdout"] = stdout;
    child["stderr"] = stderr;
    child["pid"] = 7;
    child["exitCode"] = null;
    child["kill"] = () => true;
    // Emits nothing: the timeout has to be what ends it.
    setTimeout(() => child.emit("close", null), 40);
    return child as unknown as ChildProcess;
  };

  const verdict = await discoverExecutable({
    cwd: "/repo",
    spawn,
    timeoutMs: 5,
    platform: "linux",
  });
  assert.equal(verdict.kind, "unresponsive");
  assert.match(describeVerdict(verdict).action, /Try again/);
});

test("the handshake is doctor, which needs no work item and no network", async () => {
  const args: string[][] = [];
  const spawn: SpawnFn = (_command, commandArgs, _options) => {
    args.push(commandArgs);
    const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
    const stdout = new EventEmitter() as EventEmitter & { setEncoding(e: string): void };
    const stderr = new EventEmitter() as EventEmitter & { setEncoding(e: string): void };
    stdout.setEncoding = () => {};
    stderr.setEncoding = () => {};
    child["stdout"] = stdout;
    child["stderr"] = stderr;
    child["pid"] = 1;
    child["exitCode"] = null;
    child["kill"] = () => true;
    setTimeout(() => {
      stdout.emit("data", doctorEnvelope);
      child.emit("close", 0);
    }, 0);
    return child as unknown as ChildProcess;
  };

  await discoverExecutable({ cwd: "/repo", spawn });
  assert.deepEqual(args, [["doctor", "--json"]]);
});

// --- repository root -------------------------------------------------------

const folder = (name: string, fsPath: string): Folder => ({ name, fsPath });
const probeFor = (repos: string[]) => ({
  hasDirectory: (root: string, child: string) => child === ".git" && repos.includes(root),
});

test("one git folder is chosen", () => {
  const choice = chooseRepoRoot([folder("app", "/work/app")], probeFor(["/work/app"]));
  assert.deepEqual(choice, { kind: "single", root: "/work/app" });
});

test("no open folder is reported, not guessed", () => {
  const choice = chooseRepoRoot([], probeFor([]));
  assert.equal(choice.kind, "none");
});

test("several git folders are ambiguous rather than first-wins", () => {
  // Guessing writes .ai/ into whichever folder happened to be added first.
  const folders = [folder("a", "/work/a"), folder("b", "/work/b")];
  const choice = chooseRepoRoot(folders, probeFor(["/work/a", "/work/b"]));

  assert.equal(choice.kind, "ambiguous");
  if (choice.kind === "ambiguous") assert.equal(choice.candidates.length, 2);
});

test("a lone non-git folder is still usable", () => {
  // bugpilot degrades without git — it just produces no git context — so
  // refusing would be worse than running with less.
  const choice = chooseRepoRoot([folder("plain", "/work/plain")], probeFor([]));
  assert.deepEqual(choice, { kind: "single", root: "/work/plain" });
});

test("the single git folder wins over non-git siblings", () => {
  const folders = [folder("docs", "/work/docs"), folder("app", "/work/app")];
  const choice = chooseRepoRoot(folders, probeFor(["/work/app"]));
  assert.deepEqual(choice, { kind: "single", root: "/work/app" });
});

const WIN_ROOT = String.raw`C:\work\app`;

test("containment accepts either separator on Windows and folds case", () => {
  assert.equal(isWithin(WIN_ROOT, "C:/work/app/.ai/JR-1", "win32"), true);
  assert.equal(isWithin(WIN_ROOT, String.raw`c:\WORK\App`, "win32"), true);
  assert.equal(isWithin(WIN_ROOT, String.raw`C:\work\app-other`, "win32"), false);
});

test("containment resolves .. instead of being fooled by a prefix", () => {
  // A plain prefix test passes `C:\work\app\..\other`, which is exactly the
  // escape this guard exists to stop.
  assert.equal(isWithin(WIN_ROOT, String.raw`C:\work\app\..\other\.ai\JR-1`, "win32"), false);
  assert.equal(isWithin("/work/app", "/work/app/../other", "linux"), false);
  assert.equal(isWithin("/work/app", "/work/app/./.ai/JR-1", "linux"), true);
});

test("containment is case-sensitive on POSIX, where paths are", () => {
  // Folding unconditionally makes two different directories compare equal.
  assert.equal(isWithin("/work/App", "/work/app", "linux"), false);
  assert.equal(isWithin("/work/app", "/work/app/.ai/JR-1", "linux"), true);
});

test("containment stops at a path boundary", () => {
  assert.equal(isWithin("/work/app", "/work/appendix", "linux"), false);
  assert.equal(isWithin("/work/app", "/work", "linux"), false);
  assert.equal(isWithin("/work/app", "/work/app", "linux"), true);
});

// --- credentials -----------------------------------------------------------

function memoryStore(initial: Record<string, string> = {}): SecretStore & { data: Record<string, string> } {
  const data = { ...initial };
  return {
    data,
    async get(key) {
      return data[key];
    },
    async store(key, value) {
      data[key] = value;
    },
    async delete(key) {
      delete data[key];
    },
  };
}

test("saving stores both parts", async () => {
  const store = memoryStore();
  await new CredentialStore(store).save({ email: " me@co.com ", token: " tok " });

  assert.deepEqual(JSON.parse(store.data["bugpilot.jiraCredentials"]!), {
    email: "me@co.com",
    token: "tok",
  });
});

test("a half-set credential is refused", async () => {
  const credentials = new CredentialStore(memoryStore());
  await assert.rejects(credentials.save({ email: "me@co.com", token: "  " }), /required/);
});

test("status reports configuration without yielding the token", async () => {
  // UI code asks this, so it must have no way to print the secret.
  const credentials = new CredentialStore(
    memoryStore({ "bugpilot.jiraCredentials": JSON.stringify({ email: "me@co.com", token: "tok" }) }),
  );
  const status = await credentials.status();

  assert.equal(status.configured, true);
  assert.equal(status.email, "me@co.com");
  assert.equal(JSON.stringify(status).includes("tok"), false);
});

test("a missing token means not configured", async () => {
  const credentials = new CredentialStore(
    memoryStore({ "bugpilot.jiraCredentials": JSON.stringify({ email: "me@co.com" }) }),
  );
  assert.deepEqual(await credentials.status(), { configured: false });
});

test("the environment block carries what config.py reads", async () => {
  const credentials = new CredentialStore(
    memoryStore({ "bugpilot.jiraCredentials": JSON.stringify({ email: "me@co.com", token: "tok" }) }),
  );
  assert.deepEqual(await credentials.environment(), {
    JIRA_EMAIL: "me@co.com",
    JIRA_TOKEN: "tok",
  });
});

test("no stored credential yields an empty environment, not a failure", async () => {
  // A manual-mode bug needs no Jira credential, and the CLI can still fall back
  // to its own config file.
  assert.deepEqual(await new CredentialStore(memoryStore()).environment(), {});
});

test("clearing removes both parts", async () => {
  const store = memoryStore({
    "bugpilot.jiraCredentials": JSON.stringify({ email: "me@co.com", token: "tok" }),
  });
  await new CredentialStore(store).clear();
  assert.deepEqual(store.data, {});
});

test("a credential in argv is refused before spawning", async () => {
  // A command line is readable by any process listing; the environment is not.
  const token = "ATATT3xFfGF0abcdef1234567890";
  assert.throws(
    () => assertNoSecretsInArgs(["bug", "JR-1", "--hint", `token is ${token}`], { JIRA_TOKEN: token }),
    /command line/,
  );
});

test("ordinary arguments pass the argv guard", () => {
  assertNoSecretsInArgs(["bug", "JR-1", "--json"], { JIRA_TOKEN: "tok" });
});

test("the argv guard ignores non-secret environment values", () => {
  // The email is an identifier, not a secret, and may legitimately appear.
  assertNoSecretsInArgs(["bug", "--description", "me@co.com saw a crash"], {
    JIRA_EMAIL: "me@co.com",
    JIRA_TOKEN: "tok",
  });
});


// --- credential atomicity (review follow-up) -------------------------------

test("a credential save is one write, so no mismatched pair can survive", async () => {
  const store = memoryStore();
  await new CredentialStore(store).save({ email: "me@co.com", token: "tok" });
  assert.equal(Object.keys(store.data).length, 1);
});

test("a failed save leaves the previous credential intact", async () => {
  // Two sequential writes could pair a new email with an old token, which
  // status() calls configured and environment() then injects — producing a
  // JIRA_AUTH_FAILED that points at the wrong thing.
  const store = memoryStore();
  const credentials = new CredentialStore(store);
  await credentials.save({ email: "old@co.com", token: "old-tok" });

  const failing: SecretStore = {
    get: store.get.bind(store),
    store: async () => {
      throw new Error("keychain unavailable");
    },
    delete: store.delete.bind(store),
  };
  await assert.rejects(
    new CredentialStore(failing).save({ email: "new@co.com", token: "new-tok" }),
  );

  assert.deepEqual(await credentials.environment(), {
    JIRA_EMAIL: "old@co.com",
    JIRA_TOKEN: "old-tok",
  });
});

test("corrupt credential storage reads as not configured", async () => {
  // Throwing from every command that asks would be worse than treating it as
  // absent; re-running setup overwrites it.
  const store = memoryStore({ "bugpilot.jiraCredentials": "{ not json" });
  assert.deepEqual(await new CredentialStore(store).status(), { configured: false });
  assert.deepEqual(await new CredentialStore(store).environment(), {});
});


// --- argv guard precision (review follow-up) -------------------------------

test("a short token is still refused when it is the whole argument", () => {
  // The precision rules must not become a hole: a credential passed as an
  // argument is caught regardless of length.
  assert.throws(() => assertNoSecretsInArgs(["bug", "t"], { JIRA_TOKEN: "t" }), /credential appeared/);
});

test("a credential in the value half of --flag=value is refused", () => {
  assert.throws(
    () => assertNoSecretsInArgs(["bug", "--token=abc"], { JIRA_TOKEN: "abc" }),
    /credential appeared/,
  );
});

test("a short token does not block ordinary arguments that happen to contain it", () => {
  // "doctor".includes("t") is true. A guard that refuses every run over that
  // would be deleted rather than fixed, so short secrets match only by shape.
  assertNoSecretsInArgs(["doctor", "--json"], { JIRA_TOKEN: "t" });
});

test("a realistic token is caught anywhere in an argument", () => {
  const token = "ATATT3xFfGF0abcdef1234567890";
  assert.throws(
    () => assertNoSecretsInArgs(["bug", `--hint=see ${token}`], { JIRA_TOKEN: token }),
    /credential appeared/,
  );
});

test("the CLI's own version is captured and shown with the path", async () => {
  // A machine can carry a pipx copy, an editable install and a frozen exe at
  // once — this one does — so "which bugpilot just ran" is a real question.
  const { spawn } = spawnWith({ kind: "envelope", stdout: doctorEnvelope, code: 0 });
  const verdict = await discoverExecutable({ cwd: "/repo", spawn });

  assert.equal(verdict.kind === "ready" ? verdict.version : undefined, "0.1.0");
  assert.match(describeVerdict(verdict).summary, /bugpilot 0\.1\.0/);
});

test("a compatible CLI that reports no version is still ready", async () => {
  // The field is newer than the contract, so its absence must not downgrade a
  // working bugpilot.
  const withoutVersion = `${JSON.stringify({
    schema_version: 1,
    ok: true,
    command: "doctor",
    warnings: [],
    report: { python_ok: true },
  })}\n`;
  const { spawn } = spawnWith({ kind: "envelope", stdout: withoutVersion, code: 0 });
  const verdict = await discoverExecutable({ cwd: "/repo", spawn });

  assert.equal(verdict.kind, "ready");
  assert.equal(verdict.kind === "ready" ? verdict.version : "unset", undefined);
  assert.match(describeVerdict(verdict).summary, /Using bugpilot\./);
});

test("a bare Windows command is looked for under every PATHEXT extension", () => {
  // The case this exists for: npm installs Claude Code as `claude.cmd`, which a
  // spawn probe cannot see. Measured, not assumed — spawning the `.cmd` itself
  // throws EINVAL, so the launcher has to be found by name on disk.
  const names = launcherNames("claude", ".COM;.EXE;.BAT;.CMD", "win32");

  // PATHEXT's case is kept as the environment wrote it, which costs nothing on
  // a case-insensitive filesystem and avoids inventing a spelling.
  assert.ok(
    names.some((name) => name.toLowerCase() === "claude.cmd"),
    "must look for the npm launcher",
  );
  assert.deepEqual(names, ["claude", "claude.COM", "claude.EXE", "claude.BAT", "claude.CMD"]);
});

test("PATHEXT lookup is Windows-only and never second-guesses an explicit extension", () => {
  assert.deepEqual(launcherNames("claude", ".COM;.EXE", "linux"), []);
  // Asking about `claude.exe` and being told about `claude.exe.cmd` would
  // answer a question nobody asked.
  assert.deepEqual(launcherNames("claude.exe", ".COM;.EXE", "win32"), ["claude.exe"]);
});

test("a machine with no PATHEXT still gets the four extensions Windows guarantees", () => {
  assert.deepEqual(launcherNames("claude", undefined, "win32"), [
    "claude",
    "claude.COM",
    "claude.EXE",
    "claude.BAT",
    "claude.CMD",
  ]);
});
