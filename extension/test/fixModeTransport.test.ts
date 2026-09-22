/**
 * The payload file a Fix Mode save rides in.
 *
 * Two things matter here and neither is visible from the outside: the mode's
 * text never reaches argv, and the temporary file is gone afterwards whether
 * the command worked or not. A left-behind file is small, but it is also a
 * developer's half-written workflow sitting in a temp directory.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";

import { fixModeCommandPort, runFixModeCommand } from "../src/app/fixModeTransport.ts";
import type { Envelope } from "../src/protocol.ts";

const OK: Envelope = { ok: true, command: "fix-mode", warnings: [] };

async function tempFixModeFiles(): Promise<string[]> {
  return (await readdir(tmpdir())).filter((name) => name.startsWith("bugpilot-fix-mode-"));
}

test("the definition travels in a file and only its path is an argument", async () => {
  const hostile = 'quotes " backticks ` pipes | newlines\nand $vars %here%';
  let seen: readonly string[] = [];
  let written: unknown;

  await runFixModeCommand(
    async (args) => {
      seen = args;
      written = JSON.parse(readFileSync(args[args.length - 1]!.split("=")[1]!, "utf8"));
      return OK;
    },
    {
      args: (file) => ["fix-mode", "update", "my-safe", `--from-file=${file}`],
      payload: { id: "my-safe", objective: hostile },
    },
  );

  assert.equal((written as { objective: string }).objective, hostile);
  assert.ok(!seen.some((arg) => arg.includes("backticks")), "mode text reached argv");
  assert.ok(seen.some((arg) => arg.startsWith("--from-file=")));
});

test("the file is gone once the command succeeds", async () => {
  let file = "";
  await runFixModeCommand(
    async (args) => {
      file = args[0]!;
      return OK;
    },
    { args: (payload) => [payload], payload: { id: "my-safe" } },
  );

  await assert.rejects(access(file), "the payload file was left behind");
});

test("the file is gone when the command fails too", async () => {
  let file = "";
  await assert.rejects(
    runFixModeCommand(
      async (args) => {
        file = args[0]!;
        throw new Error("bugpilot exploded");
      },
      { args: (payload) => [payload], payload: { id: "my-safe" } },
    ),
  );

  await assert.rejects(access(file), "a failed save left its payload behind");
});

test("two saves at once do not share a file", async () => {
  const files: string[] = [];
  const run = () =>
    runFixModeCommand(
      async (args) => {
        files.push(args[0]!);
        return OK;
      },
      { args: (payload) => [payload], payload: { id: "my-safe" } },
    );

  await Promise.all([run(), run(), run()]);

  assert.equal(new Set(files).size, 3, "two payloads shared a path");
  assert.equal((await tempFixModeFiles()).length, 0, "payload files were left in the temp dir");
});

test("a command with no definition writes no file at all", async () => {
  let seen: readonly string[] = [];

  await runFixModeCommand(
    async (args) => {
      seen = args;
      return OK;
    },
    { args: () => ["fix-mode", "delete", "my-safe", "--expected-version=1"] },
  );

  assert.deepEqual(seen, ["fix-mode", "delete", "my-safe", "--expected-version=1"]);
  assert.equal((await tempFixModeFiles()).length, 0);
});

test("a management command without a repository runs nothing at all", async () => {
  // `--scope project` decides which repository gets a `.bugpilot/` directory.
  // Falling back to the process's own working directory would create one
  // somewhere the developer never chose.
  let spawned = 0;
  const port = fixModeCommandPort(
    () => undefined,
    async () => {
      spawned += 1;
      return OK;
    },
  );

  const envelope = await port({
    args: (file) => ["fix-mode", "create", "my-safe", `--from-file=${file}`],
    payload: { id: "my-safe" },
  });

  assert.equal(spawned, 0, "a process was started without a repository");
  assert.equal(envelope.ok, false);
  assert.match(
    envelope.ok === false ? envelope.error.message : "",
    /No workspace repository is available/,
  );
  assert.equal((await tempFixModeFiles()).length, 0, "a payload file was written anyway");
});

test("with a repository, the command runs there and nowhere else", async () => {
  let seen: string | undefined;
  const port = fixModeCommandPort(
    () => "/work/app",
    async (_args, cwd) => {
      seen = cwd;
      return OK;
    },
  );

  await port({ args: () => ["fix-mode", "list"] });

  assert.equal(seen, "/work/app");
});
