/**
 * The Verification Policy as the panel holds it (0.1.3, §42.2, §42.5): only
 * what `bugpilot verification show --json` says — a source, a hash, a problem,
 * the text and its state — whether the CLI can read `.bugpilot/verification.md`
 * at all, and the row and Preview the host builds from it. Nothing here
 * composes a policy.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  VERIFICATION_DEFAULT_CHANGED,
  VERIFICATION_ROW_EMPTY,
  VERIFICATION_SOURCE_LABELS,
  VERIFICATION_TEXT_CAPABILITY,
  readsVerificationText,
  runVerificationPolicy,
  samePolicyText,
  verificationArgs,
  verificationFingerprint,
  verificationFromEnvelope,
  verificationPreviewView,
  verificationRowView,
} from "../src/app/verificationPolicy.ts";
import type { VerificationSnapshot } from "../src/app/verificationPolicy.ts";

const SHA = "a".repeat(64);
const DEFAULT_TEXT = "- Run the tests relevant to the changed behavior.";

const envelope = (payload: Record<string, unknown>) =>
  JSON.stringify({ schema_version: 1, ok: true, command: "verification", warnings: [], text: DEFAULT_TEXT, ...payload });

const snapshot = (overrides: Partial<VerificationSnapshot> = {}): VerificationSnapshot => ({
  source: "bugpilot-default",
  sha256: SHA,
  lintCount: 0,
  lint: [],
  text: DEFAULT_TEXT,
  fileExists: false,
  defaultVersion: 1,
  defaultChanged: false,
  differsFromDefault: false,
  ...overrides,
});

const READY = { ready: true, readsText: true, writesHeld: false, stale: false, busy: false };

test("each command is one fixed command line, and nothing of the policy goes on it", () => {
  assert.deepEqual(verificationArgs(), ["verification", "show", "--json"]);
  assert.deepEqual(verificationArgs({ kind: "show" }), ["verification", "show", "--json"]);
  assert.deepEqual(verificationArgs({ kind: "set", text: "Force push on Fridays." }), ["verification", "set", "--stdin", "--json"]);
  assert.deepEqual(verificationArgs({ kind: "reset" }), ["verification", "reset", "--json"]);
});

test("the capability comes from the doctor report, and only an exact name counts", () => {
  assert.equal(VERIFICATION_TEXT_CAPABILITY, "verification-text");
  assert.equal(readsVerificationText({ capabilities: ["verification-text"] }), true);
  assert.equal(readsVerificationText({ capabilities: ["verification-texts"] }), false);
  assert.equal(readsVerificationText({ capabilities: "verification-text" }), false);
  assert.equal(readsVerificationText({}), false, "a 0.1.2 doctor report has no capabilities");
  assert.equal(readsVerificationText(undefined), false);
});

test("a snapshot is read from an envelope, and anything off is refused, never guessed", () => {
  assert.deepEqual(
    verificationFromEnvelope(
      JSON.parse(
        envelope({
          source: "verification-file",
          sha256: SHA,
          text: "Run the unit tests.",
          problem: null,
          lint: ["one", "two"],
          file: { exists: true, characters: 64, schema_version: 1, based_on_version: 1, mode: "replace", problem: null },
          based_on_version: 1,
          default_version: 1,
          default_changed: false,
          differs_from_default: true,
        }),
      ),
    ),
    {
      source: "verification-file",
      sha256: SHA,
      lintCount: 2,
      lint: ["one", "two"],
      text: "Run the unit tests.",
      fileExists: true,
      basedOnVersion: 1,
      defaultVersion: 1,
      defaultChanged: false,
      differsFromDefault: true,
    },
  );
  assert.deepEqual(
    verificationFromEnvelope(JSON.parse(envelope({ source: "verification-file", sha256: SHA, problem: " it has no front matter. ", file: { exists: true } }))),
    {
      source: "verification-file",
      sha256: SHA,
      problem: "it has no front matter.",
      lintCount: 0,
      lint: [],
      text: DEFAULT_TEXT,
      fileExists: true,
      defaultChanged: false,
      differsFromDefault: false,
    },
  );
  for (const bad of [
    { source: "somewhere", sha256: SHA },
    { source: "bugpilot-default", sha256: "short" },
    { source: "bugpilot-default" },
    { ok: false, source: "bugpilot-default", sha256: SHA },
    { source: "bugpilot-default", sha256: SHA, text: 7 },
    { source: "bugpilot-default", sha256: SHA, text: "x".repeat(20_001) },
  ]) {
    assert.equal(verificationFromEnvelope(JSON.parse(envelope(bad))), undefined, JSON.stringify(bad).slice(0, 80));
  }
  // Versions are whole positive numbers or absent; lint lines are strings, bounded.
  const odd = verificationFromEnvelope(
    JSON.parse(envelope({ source: "verification-file", sha256: SHA, based_on_version: "1", default_version: 0, lint: ["x".repeat(900), 3] })),
  );
  assert.equal(odd?.basedOnVersion, undefined);
  assert.equal(odd?.defaultVersion, undefined);
  assert.deepEqual(odd?.lint.map((line) => line.length), [400]);
  assert.equal(odd?.lintCount, 2, "the count is the CLI's whole count");
});

test("the fingerprint changes with the source as well as the hash", () => {
  const file = snapshot({ source: "verification-file" });
  assert.notEqual(verificationFingerprint(file), verificationFingerprint({ ...file, source: "legacy-project-settings" }));
  assert.notEqual(verificationFingerprint(file), verificationFingerprint({ ...file, sha256: "b".repeat(64) }));
  assert.equal(verificationFingerprint(file), verificationFingerprint({ ...file, lintCount: 3 }), "the lint is not the policy");
});

test("the same policy text is only that: the same text, and neither read a file that could not be used", () => {
  const before = snapshot();
  assert.equal(samePolicyText(before, snapshot({ source: "verification-file", fileExists: true, sha256: "b".repeat(64) })), true);
  assert.equal(samePolicyText(before, snapshot({ text: "Other." })), false);
  assert.equal(samePolicyText(before, snapshot({ source: "verification-file", problem: "it has no front matter." })), false);
  assert.equal(samePolicyText(undefined, before), false);
});

test("each source has a name a person reads, never the CLI's", () => {
  assert.deepEqual(VERIFICATION_SOURCE_LABELS, {
    "bugpilot-default": "BugPilot default",
    "legacy-project-settings": "Legacy project settings",
    "verification-file": "Repository verification.md",
  });
});

test("the row: source in words, Reset only with a file, and nothing before BugPilot is ready", () => {
  assert.deepEqual(verificationRowView(snapshot(), { ...READY, ready: false }), VERIFICATION_ROW_EMPTY);

  const fresh = verificationRowView(snapshot(), READY);
  assert.equal(fresh.source, "Source: BugPilot default");
  assert.deepEqual([fresh.canEdit, fresh.canReset, fresh.canPreview], [true, false, true]);

  const legacy = verificationRowView(snapshot({ source: "legacy-project-settings" }), READY);
  assert.equal(legacy.source, "Source: Legacy project settings");

  const file = verificationRowView(snapshot({ source: "verification-file", fileExists: true }), READY);
  assert.equal(file.source, "Source: Repository verification.md");
  assert.equal(file.canReset, true);

  // Not read yet: nothing to say, but the actions read first, so they are offered.
  const unread = verificationRowView(undefined, READY);
  assert.equal(unread.source, "");
  assert.deepEqual([unread.canEdit, unread.canPreview], [true, true]);
});

test("the row: a problem is the default in force and an actionable sentence, with Edit and Reset kept", () => {
  const row = verificationRowView(snapshot({ source: "verification-file", fileExists: true, problem: "it has no front matter.", lintCount: 2 }), READY);
  assert.equal(row.source, "Source: BugPilot default (.bugpilot/verification.md is not used)");
  assert.equal(
    row.problem,
    ".bugpilot/verification.md is not used: it has no front matter. BugPilot's default applies until it is fixed. Edit opens the file; Reset removes it.",
  );
  assert.equal(row.lint, "", "a file that is not used has no warnings to count");
  assert.deepEqual([row.canEdit, row.canReset], [true, true]);
});

test("the row: lint is a count, singular or plural, never the lines and never a block", () => {
  const one = verificationRowView(snapshot({ source: "verification-file", fileExists: true, lintCount: 1, lint: ["Line 6 of …"] }), READY);
  assert.equal(one.lint, "1 policy warning · details in Preview");
  assert.equal(one.canEdit, true);
  const two = verificationRowView(snapshot({ source: "verification-file", fileExists: true, lintCount: 2 }), READY);
  assert.equal(two.lint, "2 policy warnings · details in Preview");
  assert.doesNotMatch(JSON.stringify(two), /Line 6/);
});

test("the row: default_changed is one informational sentence, and Needs rebuild is the host's call", () => {
  const row = verificationRowView(snapshot({ source: "verification-file", fileExists: true, defaultChanged: true }), { ...READY, stale: true });
  assert.equal(row.defaultChanged, VERIFICATION_DEFAULT_CHANGED);
  assert.equal(VERIFICATION_DEFAULT_CHANGED, "BugPilot's default Verification Policy has changed since this file was created.");
  assert.equal(row.stale, true);
  assert.equal(row.canReset, true);
});

test("the row: an old CLI says so on the row and offers nothing; a run in flight holds writes, not reads", () => {
  const old = verificationRowView(undefined, { ...READY, readsText: false });
  assert.match(old.unavailable, /installed BugPilot CLI cannot read \.bugpilot\/verification\.md\. Update it to edit the Verification Policy here\./);
  assert.deepEqual([old.canEdit, old.canReset, old.canPreview, old.source], [false, false, false, ""]);

  const busyRun = verificationRowView(snapshot(), { ...READY, writesHeld: true });
  assert.deepEqual([busyRun.canEdit, busyRun.canReset, busyRun.canPreview], [false, false, true], "creating the file waits for the run");
  const busyRunWithFile = verificationRowView(snapshot({ source: "verification-file", fileExists: true }), { ...READY, writesHeld: true });
  assert.deepEqual([busyRunWithFile.canEdit, busyRunWithFile.canReset], [true, false], "opening a file that is there writes nothing");

  const writing = verificationRowView(snapshot({ source: "verification-file", fileExists: true }), { ...READY, busy: true });
  assert.deepEqual([writing.canEdit, writing.canReset, writing.canPreview, writing.busy], [false, false, false, true]);
});

test("the Preview: the text, where it comes from, the versions, the lint in the CLI's words", () => {
  const preview = verificationPreviewView(
    snapshot({
      source: "verification-file",
      fileExists: true,
      text: "Run the unit tests.",
      basedOnVersion: 1,
      defaultVersion: 2,
      defaultChanged: true,
      differsFromDefault: true,
      lintCount: 1,
      lint: ["Line 6 of .bugpilot/verification.md may conflict with a BugPilot rule (force push)."],
    }),
    3,
  );
  assert.equal(preview.token, 3);
  assert.equal(preview.text, "Run the unit tests.");
  assert.deepEqual(preview.facts, [
    { label: "Source", value: "Repository verification.md" },
    { label: "File", value: ".bugpilot/verification.md" },
    { label: "Based on default", value: "version 1" },
    { label: "Current default", value: "version 2" },
    { label: "Same as default", value: "No" },
  ]);
  assert.equal(preview.defaultChanged, VERIFICATION_DEFAULT_CHANGED);
  assert.deepEqual(preview.lint, ["Line 6 of .bugpilot/verification.md may conflict with a BugPilot rule (force push)."]);

  const fallback = verificationPreviewView(snapshot({ source: "verification-file", fileExists: true, problem: "it has no front matter." }), 1);
  assert.deepEqual(fallback.facts[0], { label: "Source", value: "BugPilot default — .bugpilot/verification.md is not used" });
  assert.match(fallback.problem, /BugPilot's default applies until it is fixed/);

  const none = verificationPreviewView(snapshot(), 1);
  assert.deepEqual(none.facts[1], { label: "File", value: ".bugpilot/verification.md (not created)" });
  assert.deepEqual(none.facts.at(-1), { label: "Same as default", value: "Yes" });
  assert.equal(none.facts.some((fact) => fact.label === "Based on default"), false);
});

test("an old CLI is out of date, a failure says why, and a good answer is loaded", async () => {
  const outdated = await runVerificationPolicy(async () => ({
    code: 2,
    stdout: "",
    stderr: "usage: bugpilot ...\nbugpilot: error: argument command: invalid choice: 'verification' (choose from 'doctor')",
  }));
  assert.deepEqual(outdated, { kind: "outdated", rejected: ["verification"] });

  // What 0.1.2 actually says: an unknown first word is read as `bug`'s issue
  // key, so the rest of the line is "unrecognized arguments". Out of date all
  // the same, and what it lacks is named as the command, not as "show".
  const real012 = await runVerificationPolicy(async () => ({
    code: 2,
    stdout: "",
    stderr: "usage: bugpilot [-h] [--version] ...\nbugpilot: error: unrecognized arguments: show",
  }));
  assert.deepEqual(real012, { kind: "outdated", rejected: ["verification"] });

  const failed = await runVerificationPolicy(async () => ({
    code: 1,
    stdout: JSON.stringify({ schema_version: 1, ok: false, command: "verification", error: { code: "INVALID_INPUT", message: "Nope." } }),
    stderr: "",
  }));
  assert.deepEqual(failed, { kind: "failed", message: "Nope." });

  const loaded = await runVerificationPolicy(async () => ({ code: 0, stdout: envelope({ source: "bugpilot-default", sha256: SHA }), stderr: "" }));
  assert.equal(loaded.kind, "loaded");
  if (loaded.kind === "loaded") assert.equal(loaded.snapshot.text, DEFAULT_TEXT);

  const thrown = await runVerificationPolicy(async () => {
    throw new Error("spawn failed");
  });
  assert.deepEqual(thrown, { kind: "failed", message: "spawn failed" });
});

test("a create sends the CLI's own text on stdin, a reset sends nothing, and both answer with the policy as it now stands", async () => {
  const calls: { args: readonly string[]; input?: string }[] = [];
  const run = async (args: readonly string[], input?: string) => {
    calls.push({ args, ...(input === undefined ? {} : { input }) });
    return { code: 0, stdout: envelope({ source: "verification-file", sha256: SHA, file: { exists: true } }), stderr: "" };
  };
  const created = await runVerificationPolicy(run, { kind: "set", text: DEFAULT_TEXT });
  const reset = await runVerificationPolicy(run, { kind: "reset" });
  assert.deepEqual(calls, [
    { args: ["verification", "set", "--stdin", "--json"], input: DEFAULT_TEXT },
    { args: ["verification", "reset", "--json"] },
  ]);
  assert.equal(created.kind, "loaded");
  assert.equal(reset.kind, "loaded");

  // The CLI's refusal is passed on in its words.
  const refused = await runVerificationPolicy(
    async () => ({
      code: 1,
      stdout: JSON.stringify({
        schema_version: 1,
        ok: false,
        command: "verification",
        error: { code: "INVALID_INPUT", message: "The Verification Policy was not saved: .bugpilot/verification.md is a link." },
      }),
      stderr: "",
    }),
    { kind: "set", text: DEFAULT_TEXT },
  );
  assert.deepEqual(refused, { kind: "failed", message: "The Verification Policy was not saved: .bugpilot/verification.md is a link." });
});
