/**
 * User and Project instructions, as the panel holds them:
 * the command lines, reading the CLI's answer as untrusted input, the stale
 * check's fingerprint, and the rows' wording.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  INSTRUCTION_SCOPES,
  INSTRUCTION_TEXT,
  MAX_INSTRUCTION_CHARS,
  instructionsArgs,
  instructionsFingerprint,
  instructionsStatusLine,
  isInstructionScope,
  runInstructions,
  snapshotFromEnvelope,
} from "../src/app/instructions.ts";
import type { InstructionsRunResult } from "../src/app/instructions.ts";

const HERE = path.dirname(fileURLToPath(import.meta.url));

const SHA = "a".repeat(64);
const envelope = (overrides: Record<string, unknown> = {}) => ({
  schema_version: 1,
  ok: true,
  command: "instructions",
  user: { configured: false, characters: 0, sha256: "", path: "~/.bugpilot/instructions.md", text: "" },
  project: { configured: true, characters: 26, sha256: SHA, path: ".bugpilot/instructions.md", text: "Run relevant module tests." },
  max_characters: 20_000,
  warnings: [],
  ...overrides,
});

const answer = (stdout: unknown, code = 0, stderr = ""): InstructionsRunResult => ({
  code,
  stdout: typeof stdout === "string" ? stdout : `${JSON.stringify(stdout)}\n`,
  stderr,
});

test("the limit is the CLI's own", () => {
  const python = readFileSync(path.join(HERE, "..", "..", "bugpilot", "core", "instructions.py"), "utf8");
  const match = /^MAX_INSTRUCTION_CHARS = ([\d_]+)$/m.exec(python);
  assert.ok(match, "MAX_INSTRUCTION_CHARS not found in instructions.py");
  assert.equal(Number(match[1]!.replaceAll("_", "")), MAX_INSTRUCTION_CHARS);
  assert.deepEqual([...INSTRUCTION_SCOPES], ["user", "project"]);
});

test("the page names a scope, never a path", () => {
  for (const scope of ["user", "project"]) assert.equal(isInstructionScope(scope), true);
  for (const value of ["", "User", "../project", "C:\\path\\to\\sample-repo", undefined, 1]) assert.equal(isInstructionScope(value), false);
});

test("show, and set by stdin or --clear: no path and no text on a command line", () => {
  assert.deepEqual([...instructionsArgs()], ["instructions", "show", "--json"]);
  assert.deepEqual([...instructionsArgs({ scope: "project", clear: false })], ["instructions", "set", "--scope", "project", "--stdin", "--json"]);
  assert.deepEqual([...instructionsArgs({ scope: "user", clear: true })], ["instructions", "set", "--scope", "user", "--clear", "--json"]);
});

test("a well-formed answer is read; anything else is not a snapshot", () => {
  const snapshot = snapshotFromEnvelope(envelope());
  assert.deepEqual(snapshot, {
    user: { configured: false, characters: 0, sha256: "", text: "" },
    project: { configured: true, characters: 26, sha256: SHA, text: "Run relevant module tests." },
    maxCharacters: 20_000,
  });
  for (const broken of [
    { ...envelope(), ok: false },
    { ...envelope(), user: undefined },
    { ...envelope(), project: "text" },
    { ...envelope(), project: { ...envelope()["project"], sha256: "not-a-hash" } },
    { ...envelope(), project: { ...envelope()["project"], text: "x".repeat(MAX_INSTRUCTION_CHARS + 1) } },
    [1, 2],
    null,
  ]) {
    assert.equal(snapshotFromEnvelope(broken), undefined, JSON.stringify(broken)?.slice(0, 80));
  }
});

test("a problem is carried; configured needs text; the limit never grows past the extension's", () => {
  const snapshot = snapshotFromEnvelope(
    envelope({
      user: { configured: true, characters: 0, sha256: "", text: "" },
      project: { configured: false, characters: 0, sha256: SHA, problem: "  it is not UTF-8 text.  ", text: "" },
      max_characters: 10_000_000,
    }),
  )!;
  assert.equal(snapshot.user.configured, false);
  assert.equal(snapshot.project.problem, "it is not UTF-8 text.");
  assert.equal(snapshot.maxCharacters, MAX_INSTRUCTION_CHARS);
});

test("the fingerprint is both hashes: the same content is the same fingerprint", () => {
  const first = snapshotFromEnvelope(envelope())!;
  const again = snapshotFromEnvelope(envelope())!;
  assert.equal(instructionsFingerprint(first), instructionsFingerprint(again));
  const changed = snapshotFromEnvelope(envelope({ user: { configured: true, characters: 2, sha256: "b".repeat(64), text: "Hi" } }))!;
  assert.notEqual(instructionsFingerprint(first), instructionsFingerprint(changed));
  assert.equal(instructionsFingerprint(first), `|${SHA}`);
});

test("each row says one thing: nothing yet, the empty state, the size, or why it is not used", () => {
  assert.equal(instructionsStatusLine("project", undefined), "");
  assert.equal(instructionsStatusLine("project", { configured: false, characters: 0, sha256: "", text: "" }), "No project instructions configured.");
  assert.equal(instructionsStatusLine("user", { configured: false, characters: 0, sha256: "", text: "" }), "No user instructions configured.");
  assert.equal(instructionsStatusLine("user", { configured: true, characters: 1204, sha256: SHA, text: "x".repeat(1204) }), "Configured · 1,204 characters");
  assert.equal(instructionsStatusLine("user", { configured: true, characters: 1, sha256: SHA, text: "x" }), "Configured · 1 character");
  assert.equal(
    instructionsStatusLine("project", { configured: false, characters: 0, sha256: SHA, problem: "it is not UTF-8 text.", text: "" }),
    "Not used: it is not UTF-8 text.",
  );
  assert.equal(INSTRUCTION_TEXT.project.scopeLine, "Shared with this repository.");
  assert.equal(INSTRUCTION_TEXT.user.scopeLine, "Applies to all repositories for this user.");
});

test("a load runs show; a save sends the text on stdin; empty text is --clear with nothing on stdin", async () => {
  const calls: { args: readonly string[]; input: string | undefined }[] = [];
  const run = async (args: readonly string[], input?: string) => {
    calls.push({ args, input });
    return answer(envelope());
  };
  assert.equal((await runInstructions(run)).kind, "loaded");
  assert.equal((await runInstructions(run, { scope: "project", text: "Do not add dependencies without approval." })).kind, "loaded");
  assert.equal((await runInstructions(run, { scope: "user", text: "  \n" })).kind, "loaded");
  assert.deepEqual(calls, [
    { args: ["instructions", "show", "--json"], input: undefined },
    { args: ["instructions", "set", "--scope", "project", "--stdin", "--json"], input: "Do not add dependencies without approval." },
    { args: ["instructions", "set", "--scope", "user", "--clear", "--json"], input: undefined },
  ]);
  assert.equal(calls.some((call) => call.args.some((arg) => arg.includes("dependencies"))), false);
});

test("a CLI without the command is out of date; a refusal is its message; a crash is a failure", async () => {
  const outdated = await runInstructions(async () =>
    answer("", 2, "usage: bugpilot ...\nbugpilot: error: argument command: invalid choice: 'instructions' (choose from 'bug', 'doctor')\n"),
  );
  assert.deepEqual(outdated, { kind: "outdated", rejected: ["instructions"] });

  const refused = await runInstructions(
    async () =>
      answer({ schema_version: 1, ok: false, command: "instructions", error: { code: "INVALID_INPUT", message: "Project instructions were not saved: .bugpilot is a symbolic link or junction." } }, 1),
    { scope: "project", text: "x" },
  );
  assert.deepEqual(refused, { kind: "failed", message: "Project instructions were not saved: .bugpilot is a symbolic link or junction." });

  const thrown = await runInstructions(async () => {
    throw new Error("spawn bugpilot ENOENT");
  });
  assert.deepEqual(thrown, { kind: "failed", message: "spawn bugpilot ENOENT" });

  const garbage = await runInstructions(async () => answer("not json"));
  assert.equal(garbage.kind, "failed");
  if (garbage.kind === "failed") assert.doesNotMatch(garbage.message, /not json/, "stdout is never quoted back");
});
