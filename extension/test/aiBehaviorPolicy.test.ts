/**
 * AI Behavior as the host holds it (0.1.4): what `bugpilot ai-behavior show
 * --json` says — a source, a hash, a problem, the file's state, and the text
 * and lint for the settings row's Preview only — whether the CLI can read
 * `.bugpilot/ai_behavior.md` at all, the commands that write it (the CLI's own
 * template on stdin, or a reset), and the row and Preview the host builds.
 * Nothing here composes AI Behavior.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  AI_BEHAVIOR_DEFAULT_CHANGED,
  AI_BEHAVIOR_FILE,
  AI_BEHAVIOR_ROW_EMPTY,
  AI_BEHAVIOR_TEXT_CAPABILITY,
  aiBehaviorArgs,
  aiBehaviorFingerprint,
  aiBehaviorFromEnvelope,
  aiBehaviorPreviewView,
  aiBehaviorRowView,
  readsAiBehaviorText,
  runAiBehaviorPolicy,
} from "../src/app/aiBehaviorPolicy.ts";
import type { AiBehaviorSnapshot } from "../src/app/aiBehaviorPolicy.ts";

const SHA = "b".repeat(64);
const DEFAULT_TEXT = "## Code Change Conventions\n\n- Prefer small, targeted fixes.";
const TEMPLATE = "## Code Change Conventions\n\n## Evidence Standards\n\n## Reporting Standards";

const payload = (overrides: Record<string, unknown> = {}) => ({
  schema_version: 1,
  ok: true,
  command: "ai-behavior",
  warnings: [],
  source: "bugpilot-default",
  path: AI_BEHAVIOR_FILE,
  text: DEFAULT_TEXT,
  default_text: DEFAULT_TEXT,
  project_text: "",
  sha256: SHA,
  file: { exists: false, characters: 0, schema_version: null, based_on_version: null, mode: null, problem: null },
  based_on_version: null,
  default_version: 1,
  default_changed: false,
  has_project_additions: false,
  differs_from_default: false,
  sections: ["Code Change Conventions", "Evidence Standards", "Reporting Standards"],
  problem: null,
  lint: [],
  max_characters: 20000,
  template: TEMPLATE,
  ...overrides,
});

const snapshot = (overrides: Partial<AiBehaviorSnapshot> = {}): AiBehaviorSnapshot => ({
  ...aiBehaviorFromEnvelope(payload())!,
  ...overrides,
});

test("each command is one fixed command line, and nothing of the text goes on it", () => {
  assert.deepEqual(aiBehaviorArgs(), ["ai-behavior", "show", "--json"]);
  assert.deepEqual(aiBehaviorArgs({ kind: "set", text: "- Keep exports stable." }), ["ai-behavior", "set", "--stdin", "--json"]);
  assert.deepEqual(aiBehaviorArgs({ kind: "reset" }), ["ai-behavior", "reset", "--json"]);
  assert.equal(AI_BEHAVIOR_FILE, ".bugpilot/ai_behavior.md");
});

test("the capability comes from the doctor report, and only an exact name counts", () => {
  assert.equal(AI_BEHAVIOR_TEXT_CAPABILITY, "ai-behavior-text");
  assert.equal(readsAiBehaviorText({ capabilities: ["verification-text", "ai-behavior-text"] }), true);
  assert.equal(readsAiBehaviorText({ capabilities: ["verification-text"] }), false, "a 0.1.3 CLI");
  assert.equal(readsAiBehaviorText({ capabilities: ["ai-behavior"] }), false);
  assert.equal(readsAiBehaviorText({ capabilities: "ai-behavior-text" }), false);
  assert.equal(readsAiBehaviorText(undefined), false);
});

test("a snapshot is the CLI's state, with the text and the template the CLI gave", () => {
  assert.deepEqual(aiBehaviorFromEnvelope(payload()), {
    source: "bugpilot-default",
    sha256: SHA,
    lintCount: 0,
    lint: [],
    text: DEFAULT_TEXT,
    template: TEMPLATE,
    fileExists: false,
    hasProjectAdditions: false,
    defaultVersion: 1,
    defaultChanged: false,
  });
  const file = aiBehaviorFromEnvelope(
    payload({
      source: "ai-behavior-file",
      text: `${DEFAULT_TEXT}\n\n## Evidence Standards\n\n- Quote the failing line.`,
      file: { exists: true, characters: 40, schema_version: 1, based_on_version: 1, mode: "append", problem: null },
      based_on_version: 1,
      default_version: 2,
      default_changed: true,
      has_project_additions: true,
      lint: ["Line 7 of .bugpilot/ai_behavior.md may conflict with a BugPilot rule (force push)."],
    }),
  )!;
  assert.equal(file.hasProjectAdditions, true);
  assert.equal(file.basedOnVersion, 1);
  assert.equal(file.defaultChanged, true);
  assert.deepEqual(file.lint, ["Line 7 of .bugpilot/ai_behavior.md may conflict with a BugPilot rule (force push)."]);
  assert.equal(file.lintCount, 1);
  const broken = aiBehaviorFromEnvelope(payload({ source: "ai-behavior-file", problem: "  it has no front matter.  ", file: { exists: true } }))!;
  assert.equal(broken.problem, "it has no front matter.");
});

test("anything off in the envelope is refused, never guessed", () => {
  assert.equal(aiBehaviorFromEnvelope(undefined), undefined);
  assert.equal(aiBehaviorFromEnvelope(payload({ ok: false })), undefined);
  assert.equal(aiBehaviorFromEnvelope(payload({ source: "verification-file" })), undefined);
  assert.equal(aiBehaviorFromEnvelope(payload({ sha256: "not-a-hash" })), undefined);
  const odd = aiBehaviorFromEnvelope(payload({ based_on_version: 0, default_version: "1", default_changed: "yes", lint: "x", template: "  " }))!;
  assert.equal(odd.basedOnVersion, undefined);
  assert.equal(odd.defaultVersion, undefined);
  assert.equal(odd.defaultChanged, false);
  assert.deepEqual([odd.lintCount, odd.template], [0, undefined]);
  assert.equal(aiBehaviorFromEnvelope(payload({ problem: "x".repeat(1000) }))!.problem!.length, 400);
});

test("the fingerprint is the CLI's hash, which covers the source whenever the file adds something", () => {
  const base = snapshot();
  assert.equal(aiBehaviorFingerprint(base), SHA);
  // A file with only its empty sections hashes as no file in the CLI: the same task, the same fingerprint.
  assert.equal(aiBehaviorFingerprint({ ...base, source: "ai-behavior-file", fileExists: true }), SHA);
  assert.notEqual(aiBehaviorFingerprint(base), aiBehaviorFingerprint({ ...base, sha256: "c".repeat(64) }));
});

test("the row: source in words, Reset only with a file, lint as a count, and nothing before BugPilot is ready", () => {
  const options = { ready: true, readsText: true, writesHeld: false, stale: false, busy: false };
  assert.deepEqual(aiBehaviorRowView(snapshot(), { ...options, ready: false }), AI_BEHAVIOR_ROW_EMPTY);
  const none = aiBehaviorRowView(snapshot(), options);
  assert.equal(none.source, "Source: BugPilot default");
  assert.deepEqual([none.canEdit, none.canReset, none.canPreview], [true, false, true]);
  const empty = aiBehaviorRowView(snapshot({ source: "ai-behavior-file", fileExists: true }), options);
  assert.equal(empty.source, `Source: BugPilot default (${AI_BEHAVIOR_FILE} has no additions yet)`);
  assert.equal(empty.canReset, true);
  const added = aiBehaviorRowView(snapshot({ source: "ai-behavior-file", fileExists: true, hasProjectAdditions: true, lintCount: 2 }), options);
  assert.equal(added.source, "Source: BugPilot default + repository additions");
  assert.equal(added.lint, "2 AI Behavior warnings · details in Preview");
  const broken = aiBehaviorRowView(snapshot({ source: "ai-behavior-file", fileExists: true, problem: "it has no front matter.", lintCount: 3 }), options);
  assert.match(broken.problem, /^\.bugpilot\/ai_behavior\.md is not used: it has no front matter\. BugPilot's default applies until it is fixed\./);
  assert.equal(broken.lint, "", "a problem is not a lint warning");
  assert.equal(aiBehaviorRowView(snapshot({ defaultChanged: true }), options).defaultChanged, AI_BEHAVIOR_DEFAULT_CHANGED);
  // A run in flight holds writes, never reads; an old CLI says so and offers nothing.
  const held = aiBehaviorRowView(snapshot(), { ...options, writesHeld: true });
  assert.deepEqual([held.canEdit, held.canReset, held.canPreview], [false, false, true]);
  const old = aiBehaviorRowView(snapshot(), { ...options, readsText: false });
  assert.match(old.unavailable, /cannot read \.bugpilot\/ai_behavior\.md\. Update it to edit AI Behavior here\./);
  assert.deepEqual([old.canEdit, old.canReset, old.canPreview], [false, false, false]);
});

test("the Preview: the text, where it comes from, the versions and the lint in the CLI's words", () => {
  const view = aiBehaviorPreviewView(
    snapshot({ source: "ai-behavior-file", fileExists: true, hasProjectAdditions: true, basedOnVersion: 1, lint: ["Line 9 …"], lintCount: 1 }),
    4,
  );
  assert.equal(view.token, 4);
  assert.deepEqual(view.facts, [
    { label: "Source", value: "BugPilot default + repository additions" },
    { label: "File", value: AI_BEHAVIOR_FILE },
    { label: "Repository additions", value: "Yes" },
    { label: "Based on default", value: "version 1" },
    { label: "Current default", value: "version 1" },
  ]);
  assert.deepEqual([view.lint, view.lintCount, view.text], [["Line 9 …"], 1, DEFAULT_TEXT]);
});

test("an old CLI is out of date, a failure says why, a set sends the text on stdin, and a good answer is loaded", async () => {
  const outdated = await runAiBehaviorPolicy(async () => ({
    code: 2,
    stdout: "",
    stderr: "usage: bugpilot [-h] [--version] ...\nbugpilot: error: unrecognized arguments: show",
  }));
  assert.deepEqual(outdated, { kind: "outdated", rejected: ["ai-behavior"] });
  const failed = await runAiBehaviorPolicy(async () => ({
    code: 1,
    stdout: JSON.stringify({ schema_version: 1, ok: false, command: "ai-behavior", error: { code: "INVALID_INPUT", message: "Nope." } }),
    stderr: "",
  }));
  assert.deepEqual(failed, { kind: "failed", message: "Nope." });
  const calls: { args: readonly string[]; input: string | undefined }[] = [];
  const created = await runAiBehaviorPolicy(async (args, input) => {
    calls.push({ args, input });
    return { code: 0, stdout: JSON.stringify(payload({ source: "ai-behavior-file", file: { exists: true } })), stderr: "" };
  }, { kind: "set", text: TEMPLATE });
  assert.equal(created.kind, "loaded");
  assert.deepEqual(calls, [{ args: ["ai-behavior", "set", "--stdin", "--json"], input: TEMPLATE }]);
  const thrown = await runAiBehaviorPolicy(async () => {
    throw new Error("spawn failed");
  });
  assert.deepEqual(thrown, { kind: "failed", message: "spawn failed" });
});
