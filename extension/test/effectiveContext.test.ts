/**
 * The Effective Context as the panel holds it (0.1.4): the CLI's stored context
 * and status, read from its envelope, and merged with the panel's own
 * freshness — either side's rebuild wins, the CLI's current needs the panel's
 * agreement, an unknown is never upgraded, and no context is never "stale".
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CONTEXT_PREVIEW_CAPABILITY,
  NEEDS_REBUILD_HEADLINE,
  PANEL_FORM_REASON,
  PANEL_POLICY_REASON,
  contextPreviewArgs,
  contextPreviewFromEnvelope,
  contextStatusView,
  readsContextPreview,
  runContextPreview,
} from "../src/app/effectiveContext.ts";
import type { ContextPreviewSnapshot, PanelFreshness } from "../src/app/effectiveContext.ts";

const CONTEXT = "# Bug Context: JR-12345\n\n## Context Quality\n\nOverall: 63/100\n";

const payload = (overrides: Record<string, unknown> = {}) => ({
  schema_version: 1,
  ok: true,
  command: "context-preview",
  work_item: "JR-12345",
  state: "current",
  label: "Context status: Current",
  text: CONTEXT,
  generated: { artifacts: { context: true }, run_status: "prepared", context_step: "pass" },
  freshness: {
    current: true,
    reasons: [],
    checked: ["task_inputs", "artifacts"],
    unchecked: [
      { code: "retrieval_inputs", label: "Retrieval inputs as the panel holds them: the panel compares those itself." },
      { code: "issue_source", label: "The issue in Jira since it was fetched: not fetched again." },
    ],
  },
  task: { exists: true, current: true, changed_sections: [] },
  quality: { overall: 63, issue_completeness: 25, retrieval_quality: 97, repository_context: 70, cap: 75 },
  retrieval: { schema_version: 1, confidence: "high", confidence_version: 2, reason_codes: [], reasons: [], related_files: 3, terms: 9, git_history: { status: "ok", commits: 2 } },
  sources: { issue: { source: "jira", mock: false }, hint: true, attachments: 1, fix_mode: { id: "standard", name: "Standard Fix" }, code_search: true, git_history: "ok", similar_fixes: false },
  problems: [],
  warnings: [],
  ...overrides,
});

const NONE: PanelFreshness = { preparedHere: true, formChanged: false, policiesChanged: false };
const snapshot = (overrides: Record<string, unknown> = {}): ContextPreviewSnapshot => contextPreviewFromEnvelope(payload(overrides))!;

test("one command line, with or without a work item, and the capability by exact name", () => {
  assert.equal(CONTEXT_PREVIEW_CAPABILITY, "context-preview");
  assert.deepEqual(contextPreviewArgs("JR-12345"), ["context-preview", "JR-12345", "--json"]);
  assert.deepEqual(contextPreviewArgs(undefined), ["context-preview", "--json"]);
  assert.equal(readsContextPreview({ capabilities: ["context-preview"] }), true);
  assert.equal(readsContextPreview({ capabilities: ["task-preview"] }), false);
});

test("the snapshot is the CLI's: the stored text, its quality and confidence, never recomputed", () => {
  const read = snapshot();
  assert.equal(read.text, CONTEXT);
  assert.deepEqual(read.quality, { overall: 63, issueCompleteness: 25, retrievalQuality: 97, repositoryContext: 70, cap: 75 });
  assert.deepEqual(read.retrieval, { confidence: "high", reasons: [], relatedFiles: 3, terms: 9, gitHistory: { status: "ok", commits: 2 } });
  assert.deepEqual(read.sources, { issue: { source: "jira", mock: false }, hint: true, attachments: 1, fixMode: "Standard Fix", codeSearch: true, gitHistory: "ok", similarFixes: false });
  // A context shown exactly when the state has one; anything else is refused.
  assert.equal(contextPreviewFromEnvelope(payload({ state: "missing", text: CONTEXT })), undefined);
  assert.equal(contextPreviewFromEnvelope(payload({ state: "current", text: null })), undefined);
  assert.equal(contextPreviewFromEnvelope(payload({ state: "fresh" })), undefined);
  assert.equal(contextPreviewFromEnvelope(payload({ ok: false })), undefined);
  assert.ok(contextPreviewFromEnvelope(payload({ state: "not-generated", label: "No generated context available. Build context first.", text: null })));
});

test("both current: Current — and the panel's own check takes retrieval inputs off the unchecked list", () => {
  const view = contextStatusView(snapshot(), NONE);
  assert.deepEqual([view.state, view.headline, view.needsRebuild, view.reasons], ["current", "Context status: Current", false, []]);
  assert.deepEqual(view.notChecked, ["The issue in Jira since it was fetched: not fetched again."]);
  assert.equal(view.text, CONTEXT);
  assert.deepEqual(view.facts[0], { label: "Context quality", value: "63/100 (issue 25 · retrieval 97 · repository 70; capped at 75)" });
  // A package the panel did not prepare: retrieval inputs stay unchecked.
  assert.equal(contextStatusView(snapshot(), { preparedHere: false, formChanged: false, policiesChanged: false }).notChecked.length, 2);
});

test("CLI current, panel stale: Needs rebuild with the panel's reasons — the context still shown", () => {
  const form = contextStatusView(snapshot(), { ...NONE, formChanged: true });
  assert.deepEqual([form.state, form.headline, form.needsRebuild], ["stale", NEEDS_REBUILD_HEADLINE, true]);
  assert.deepEqual(form.reasons, [PANEL_FORM_REASON]);
  assert.equal(form.text, CONTEXT);
  const policies = contextStatusView(snapshot(), { ...NONE, policiesChanged: true });
  assert.deepEqual(policies.reasons, [PANEL_POLICY_REASON]);
});

test("CLI stale, panel current: Needs rebuild with the CLI's reasons; the panel's policy reason never repeats the CLI's", () => {
  const cli = snapshot({ state: "stale", label: "Context status: Needs rebuild", freshness: { current: false, reasons: [{ code: "verification_changed", label: "Verification Policy" }], unchecked: [] } });
  assert.deepEqual(contextStatusView(cli, NONE).reasons, [{ code: "verification_changed", label: "Verification Policy" }]);
  const both = contextStatusView(cli, { ...NONE, formChanged: true, policiesChanged: true });
  assert.deepEqual(both.reasons.map((reason) => reason.code), ["verification_changed", "panel_inputs_changed"]);
});

test("an unknown is never upgraded to current, but a known rebuild still wins", () => {
  const unknown = snapshot({ state: "unknown", label: "Context status: Unknown — whether it is current could not be checked.", problems: ["issue.json could not be read."] });
  const alone = contextStatusView(unknown, NONE);
  assert.deepEqual([alone.state, alone.needsRebuild, alone.problems], ["unknown", false, ["issue.json could not be read."]]);
  assert.equal(contextStatusView(unknown, { ...NONE, formChanged: true }).state, "stale");
});

test("no context is its own state, never stale, whatever the panel says", () => {
  for (const [state, label, rebuild] of [
    ["unavailable", "No generated context available. Build context first.", false],
    ["not-generated", "No generated context available. Build context first.", false],
    ["missing", "Context status: Missing — the generated context is gone. Build context again.", true],
    ["unreadable", "Context status: Unreadable — the generated context could not be read.", true],
  ] as const) {
    const view = contextStatusView(snapshot({ state, label, text: null, quality: null, retrieval: null }), { ...NONE, formChanged: true, policiesChanged: true });
    assert.deepEqual([view.state, view.headline, view.needsRebuild, view.reasons, view.facts, view.notChecked, view.text], [state, label, rebuild, [], [], [], undefined], state);
  }
});

test("a context prepared before evidence containment is noted as the CLI says, and asks for no rebuild (0.1.5, S7)", () => {
  // The CLI's own note, carried as a warning: a 0.1.5 CLI reading a run record without the format marker.
  const note =
    "This context was prepared before BugPilot quoted evidence in fenced blocks (0.1.5): text from the issue and the " +
    "repository is not set apart in it. Rebuilding the context writes it the new way; nothing else requires a rebuild.";
  const generated = { artifacts: { context: true }, run_status: "prepared", context_step: "pass", context_format: null, context_format_current: 2 };
  const view = contextStatusView(snapshot({ generated, warnings: [note] }), NONE);
  assert.deepEqual([view.state, view.headline, view.needsRebuild, view.reasons], ["current", "Context status: Current", false, []]);
  assert.deepEqual(view.warnings, [note]);
  assert.equal(view.text, CONTEXT, "shown exactly as stored");
  // Written in today's format, or read by an older CLI that knows no marker: nothing to note.
  assert.deepEqual(contextStatusView(snapshot({ generated: { ...generated, context_format: 2 } }), NONE).warnings, []);
  assert.deepEqual(contextStatusView(snapshot(), NONE).warnings, []);
});

test("an old CLI is out of date, a failure says why, and a good answer is loaded", async () => {
  assert.deepEqual(
    await runContextPreview(async () => ({ code: 2, stdout: "", stderr: "usage: bugpilot ...\nbugpilot: error: unrecognized arguments: --json" }), "JR-1"),
    { kind: "outdated" },
  );
  assert.deepEqual(
    await runContextPreview(async () => ({ code: 1, stdout: JSON.stringify({ schema_version: 1, ok: false, command: "context-preview", error: { code: "INVALID_INPUT", message: "Invalid id." } }), stderr: "" }), "../x"),
    { kind: "failed", message: "Invalid id." },
  );
  assert.equal((await runContextPreview(async () => ({ code: 0, stdout: JSON.stringify(payload()), stderr: "" }), "JR-12345")).kind, "loaded");
});
