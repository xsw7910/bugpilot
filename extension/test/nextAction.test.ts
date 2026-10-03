/**
 * The primary action's state machine, the form fingerprint that decides when a
 * prepared context is stale, and Start New Attempt's feedback helpers — the
 * pure half of the next-action redesign. The controller's half, and the page's,
 * are tested beside those.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { DEFAULT_FORM, preparationFingerprint } from "../src/app/form.ts";
import type { FormState } from "../src/app/form.ts";
import {
  BUSY_LABEL,
  EARLIER_ATTEMPT_HINT,
  FIX_HINT,
  FRESH_REBUILD_HINT,
  PRIMARY_TOOLTIPS,
  SESSION_HINT,
  STALE_HINT,
  feedbackFromReview,
  feedbackFromVerification,
  hasUnsettledChecks,
  offeredActions,
  primaryView,
  retryHandoffText,
  userFeedbackMarkdown,
} from "../src/app/nextAction.ts";
import type { NextActionInput } from "../src/app/nextAction.ts";
import { parseVerificationReport } from "../src/app/verificationReport.ts";

const input = (overrides: Partial<NextActionInput> = {}): NextActionInput => ({
  ready: true,
  busy: false,
  prepared: false,
  stale: false,
  attempted: false,
  sessionKnown: false,
  fresh: false,
  ...overrides,
});

// --- the primary action ------------------------------------------------------

test("nothing prepared: Run, alone, with no words beside the shortcut — what it does is its tooltip", () => {
  const view = primaryView(input());
  assert.deepEqual(view, { action: "run", label: "Run", enabled: true, busy: false, hint: "", more: [] });
  assert.equal(PRIMARY_TOOLTIPS.run, "Prepare the issue context for AI-assisted fixing");
});

test("the words beside the shortcut are states of a word or three, never sentences (§37.104)", () => {
  assert.equal(FIX_HINT, "Context ready");
  assert.equal(SESSION_HINT, "AI session started");
  assert.equal(EARLIER_ATTEMPT_HINT, "Fix report available");
  assert.equal(STALE_HINT, "Settings changed");
  for (const hint of [FIX_HINT, SESSION_HINT, EARLIER_ATTEMPT_HINT, STALE_HINT, FRESH_REBUILD_HINT]) {
    assert.doesNotMatch(hint, /\.$/, `${hint} is a sentence`);
    assert.ok(hint.split(" ").length <= 4, `${hint} is more than a state`);
  }
  // Every hint the model can produce, for every state, is one of those.
  const seen = new Set<string>();
  for (const prepared of [false, true]) for (const stale of [false, true]) for (const attempted of [false, true])
    for (const sessionKnown of [false, true]) for (const fresh of [false, true]) for (const busy of [false, true])
      seen.add(primaryView(input({ prepared, stale, attempted, sessionKnown, fresh, busy })).hint);
  assert.deepEqual([...seen].sort(), ["", EARLIER_ATTEMPT_HINT, FIX_HINT, SESSION_HINT, STALE_HINT, `${STALE_HINT} · ${FRESH_REBUILD_HINT}`].sort());
  // The explanations are the buttons' tooltips, and the rebuild's says what it uses.
  assert.equal(PRIMARY_TOOLTIPS.rebuildContext, "Rebuild the prepared context using the current settings");
  assert.equal(PRIMARY_TOOLTIPS.openSession, "Focus the existing BugPilot AI terminal");
});

test("a prepared task nobody handed over: Fix with AI, with Rebuild Context behind ⋯", () => {
  const view = primaryView(input({ prepared: true }));
  assert.equal(view.action, "fixWithAI");
  assert.equal(view.label, "Fix with AI");
  assert.equal(view.hint, FIX_HINT);
  // No Start New Attempt before the first attempt.
  assert.deepEqual(view.more, ["rebuildContext"]);
});

test("an attempt exists: Open AI Session, with Start New Attempt and Rebuild Context behind ⋯", () => {
  const started = primaryView(input({ prepared: true, attempted: true, sessionKnown: true }));
  assert.equal(started.action, "openSession");
  assert.equal(started.label, "Open AI Session");
  assert.equal(started.hint, SESSION_HINT);
  assert.deepEqual(started.more, ["startNewAttempt", "rebuildContext"]);
  // An attempt the panel did not see start — a report on disk — says so.
  const earlier = primaryView(input({ prepared: true, attempted: true }));
  assert.equal(earlier.action, "openSession");
  assert.equal(earlier.hint, EARLIER_ATTEMPT_HINT);
});

test("a stale context: Rebuild Context, and never a handoff of it", () => {
  const view = primaryView(input({ prepared: true, stale: true }));
  assert.equal(view.action, "rebuildContext");
  assert.equal(view.label, "Rebuild Context");
  assert.equal(view.hint, STALE_HINT);
  assert.deepEqual(view.more, []);
  // With an attempt: going back to it is harmless; a new one is not offered on
  // a context the form no longer describes.
  const attempted = primaryView(input({ prepared: true, stale: true, attempted: true, sessionKnown: true }));
  assert.equal(attempted.action, "rebuildContext");
  assert.deepEqual(attempted.more, ["openSession"]);
  assert.equal(offeredActions(attempted).includes("fixWithAI"), false);
  assert.equal(offeredActions(attempted).includes("startNewAttempt"), false);
  // Fresh ticked: said before the press, not discovered by it.
  // Fresh's warning stays beside it: a rebuild with it ticked deletes, after asking.
  assert.equal(primaryView(input({ prepared: true, stale: true, fresh: true })).hint, `${STALE_HINT} · ${FRESH_REBUILD_HINT}`);
  assert.equal(FRESH_REBUILD_HINT, "Asks before deleting artifacts");
});

test("anything in flight: Running…, disabled, with nothing behind ⋯", () => {
  for (const state of [input(), input({ prepared: true }), input({ prepared: true, attempted: true }), input({ prepared: true, stale: true })]) {
    const view = primaryView({ ...state, busy: true });
    assert.equal(view.label, BUSY_LABEL);
    assert.equal(view.enabled, false);
    assert.equal(view.busy, true);
    assert.deepEqual(view.more, []);
    assert.deepEqual(offeredActions(view), [], "a busy view offered something");
  }
});

test("not ready: the button says what it would do, and offers nothing", () => {
  const view = primaryView(input({ ready: false, prepared: true }));
  assert.equal(view.label, "Fix with AI");
  assert.equal(view.enabled, false);
  assert.deepEqual(view.more, []);
  assert.deepEqual(offeredActions(view), []);
});

test("offered actions are the button, then its menu, in order", () => {
  assert.deepEqual(offeredActions(primaryView(input({ prepared: true, attempted: true }))), [
    "openSession",
    "startNewAttempt",
    "rebuildContext",
  ]);
});

test("nothing the primary action says is Retry, Resume or Fresh", () => {
  const views = [
    input(),
    input({ prepared: true }),
    input({ prepared: true, attempted: true }),
    input({ prepared: true, attempted: true, sessionKnown: true }),
    input({ prepared: true, stale: true, fresh: true }),
    input({ busy: true }),
  ].map(primaryView);
  for (const view of views) {
    for (const word of ["Retry", "Resume", "Fresh"]) {
      assert.equal(view.label.includes(word), false, `${view.label} says ${word}`);
      assert.equal(view.hint.includes(word), false, `${view.hint} says ${word}`);
    }
  }
});

// --- when a context goes stale -------------------------------------------------

const form = (overrides: Partial<FormState> = {}): FormState => ({ ...DEFAULT_FORM, issueKey: "JR-12345", ...overrides });

test("every preparation input moves the fingerprint", () => {
  const base = preparationFingerprint(form());
  const changes: [string, Partial<FormState>][] = [
    ["issue key", { issueKey: "JR-99999" }],
    ["hint", { hint: "look at the controller" }],
    ["keywords", { keywords: "VolumeDescriptor" }],
    ["focus files", { focusFiles: "src/widgets/WidgetController.cpp" }],
    ["ignore paths", { ignorePaths: "build/" }],
    ["max files", { maxFiles: "5" }],
    ["max search lines", { maxSearchLines: "100" }],
    ["attachments", { attachments: ["/logs/crash.txt"] }],
    ["Fix Mode", { fixModeId: "conservative" }],
    ["plan", { plan: { ...DEFAULT_FORM.plan, gitHistory: false } }],
    ["Build context off", { plan: { ...DEFAULT_FORM.plan, buildContext: false } }],
    ["source", { source: "manual", issueKey: "", description: "The dialog crashes." }],
  ];
  for (const [what, change] of changes) {
    assert.notEqual(preparationFingerprint(form(change)), base, `${what} did not make the context stale`);
  }
});

test("what happens after a run, and whitespace a run ignores, leave it alone", () => {
  const base = preparationFingerprint(form({ keywords: "a, b", focusFiles: "src/x.ts" }));
  for (const change of [
    { fixWithAI: true },
    { agent: "claude-cli" as const },
    { agent: "custom" as const, agentCommand: "my-agent {prompt}" },
    { fresh: true },
    { useIssueDetails: false },
    { issueKey: "  jr-12345 " },
    { keywords: "a,\nb, a" },
    { focusFiles: "src/x.ts\n\n" },
  ]) {
    assert.equal(
      preparationFingerprint(form({ keywords: "a, b", focusFiles: "src/x.ts", ...change })),
      base,
      `${JSON.stringify(change)} made the context stale`,
    );
  }
  // Coupled plan boxes that a run ignores anyway: Build context off drops all three.
  const off = { ...DEFAULT_FORM.plan, buildContext: false };
  assert.equal(
    preparationFingerprint(form({ plan: off })),
    preparationFingerprint(form({ plan: { ...off, codeSearch: false, gitHistory: false } })),
  );
});

test("a hand-written bug's title and description count only on the manual path", () => {
  // As on the command line: a Jira run sends neither.
  assert.equal(
    preparationFingerprint(form({ title: "Crash on save", description: "stale text" })),
    preparationFingerprint(form()),
  );
  const manual = form({ source: "manual", issueKey: "", description: "The dialog crashes." });
  assert.notEqual(preparationFingerprint({ ...manual, title: "Crash on save" }), preparationFingerprint(manual));
  assert.notEqual(preparationFingerprint({ ...manual, description: "It hangs." }), preparationFingerprint(manual));
});

// --- Start New Attempt's feedback ------------------------------------------------

test("user_feedback.md is the developer's words under the template's heading, and nothing else", () => {
  assert.equal(
    userFeedbackMarkdown("JR-12345", "  The previous fix changed the wrong class.\n\n"),
    "# User Feedback: JR-12345\n\n## Required Next Attempt\n\nThe previous fix changed the wrong class.\n",
  );
  // No placeholder an agent could read as an instruction.
  assert.doesNotMatch(userFeedbackMarkdown("JR-1", "x"), /\.\.\.|Describe what did not work/);
});

test("the retry handoff is the CLI's own sentence, pointing at the retry package", () => {
  assert.equal(retryHandoffText("JR-12345"), "Read .ai/JR-12345/agent_retry_prompt.md and continue the workflow.");
  // `retry_handoff_prompt` in bugpilot/core/handoff.py is where the CLI's retry
  // loop gets it; the two must not drift apart.
  const python = readFileSync(new URL("../../bugpilot/core/handoff.py", import.meta.url), "utf8");
  assert.match(python, /def retry_handoff_prompt\(prompt_file: str\) -> str:[\s\S]*?return f"Read \{prompt_file\} and continue the workflow\."/);
  const cli = readFileSync(new URL("../../bugpilot/cli.py", import.meta.url), "utf8");
  assert.match(cli, /prompt = f"\.ai\/\{args\.issue_key\}\/agent_retry_prompt\.md"/);
});

const REVIEW =
  "# Review Report: JR-12345\n\n## Summary\n\nReads correctly.\n\n" +
  "## Findings\n\n- One duplicate null check.\n\n## Validation Notes\n\nNot recorded.\n\n" +
  "## Recommendations\n\n- Remove the duplicate.\n\n## Source\n\nRecorded from an external review.\n";

test("review findings are quoted as recorded — Findings and Recommendations — and nothing is judged", () => {
  const text = feedbackFromReview(REVIEW);
  assert.equal(
    text,
    "From review_report.md (a recorded review):\n\nFindings:\n- One duplicate null check.\n\nRecommendations:\n- Remove the duplicate.",
  );
  // Summary and Validation Notes are not what a new attempt acts on.
  assert.doesNotMatch(text ?? "", /Reads correctly|Validation/);
  for (const word of ["approved", "verified", "passed"]) assert.doesNotMatch(text ?? "", new RegExp(word, "i"));
  // Nothing recorded in either, or no file: no text.
  assert.equal(feedbackFromReview("# Review Report\n\n## Findings\n\nNot recorded.\n\n## Recommendations\n\nNot recorded.\n"), undefined);
  assert.equal(feedbackFromReview(undefined), undefined);
});

const VERIFICATION =
  "# Verification Report: JR-12345\n\n## Summary\n\n3 checks recorded.\n\n## Checks\n\n" +
  "### Check 1: Unit tests\n\nStatus: Passed\nType: Automated\n\nCommand / Procedure:\n\n> npm test\n\nEvidence:\n\n> 1111 passed\n\nNotes:\n\nNot recorded.\n\n" +
  "### Check 2: Open the dialog\n\nStatus: Failed\nType: Manual\n\nCommand / Procedure:\n\nNot recorded.\n\nEvidence:\n\n> Crashed on save.\n\nNotes:\n\nNot recorded.\n\n" +
  "### Check 3: Integration suite\n\nStatus: Not Run\nType: Automated\n\nCommand / Procedure:\n\nNot recorded.\n\nEvidence:\n\nNot recorded.\n\nNotes:\n\nNot recorded.\n\n" +
  "## Overall Recorded Status\n\nRecorded checks include failures.\n";

test("verification evidence lists the checks recorded as Failed or Not Run, as recorded", () => {
  const report = parseVerificationReport(VERIFICATION);
  assert.equal(hasUnsettledChecks(report), true);
  const text = feedbackFromVerification(report) ?? "";
  assert.match(text, /^From verification_report\.md \(checks recorded as Failed or Not Run\):/);
  assert.match(text, /- Open the dialog — recorded as Failed\n {2}Evidence: Crashed on save\./);
  assert.match(text, /- Integration suite — recorded as Not Run/);
  // A check that passed is not feedback, and nothing says verified.
  assert.doesNotMatch(text, /Unit tests/);
  assert.doesNotMatch(text, /verified|approved/i);
});

test("evidence where every recorded check passed, or none could be read, has nothing to add", () => {
  const passed =
    "# Verification Report: JR-1\n\n## Checks\n\n### Check 1: Unit tests\n\nStatus: Passed\nType: Automated\n\n" +
    "Command / Procedure:\n\n> npm test\n\nEvidence:\n\nNot recorded.\n\nNotes:\n\nNot recorded.\n\n## Overall Recorded Status\n\nAll recorded checks passed.\n";
  assert.equal(hasUnsettledChecks(parseVerificationReport(passed)), false);
  assert.equal(feedbackFromVerification(parseVerificationReport(passed)), undefined);
  assert.equal(hasUnsettledChecks(parseVerificationReport(undefined)), false);
  assert.equal(feedbackFromVerification(undefined), undefined);
});

test("evidence not in BugPilot's shape still names what did not pass, from the preview", () => {
  // Hand-edited: no Type line, so not canonical — the preview still has the name.
  const handEdited = "# Verification\n\n## Checks\n\n### Check 1: Smoke test\n\nStatus: Failed\n\nIt broke.\n";
  const report = parseVerificationReport(handEdited);
  assert.equal(report.checks, undefined, "the fixture parsed as canonical");
  assert.equal(feedbackFromVerification(report), "From verification_report.md (checks recorded as Failed or Not Run):\n\n- Smoke test — recorded as Failed");
});

test("counts without names still say how many did not pass, rather than offering nothing", () => {
  // A status line with no check heading above it: counted, never previewed. The
  // helper is on offer because the counts say so, so pressing it must add text.
  const nameless = "# Verification\n\n## Checks\n\nStatus: Failed\nStatus: Not Run\n";
  const report = parseVerificationReport(nameless);
  assert.equal(hasUnsettledChecks(report), true);
  assert.match(feedbackFromVerification(report) ?? "", /- 1 recorded as Failed and 1 as Not Run in all; see verification_report\.md for each\./);
});
