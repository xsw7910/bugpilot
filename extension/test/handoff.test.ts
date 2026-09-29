/**
 * What BugPilot is allowed to say when a handoff worked.
 *
 * The extension starts a terminal and stops watching. Every test here defends
 * the distance between that and "the bug is fixed" — a claim the panel has no
 * way to check and a developer would believe. Since Batch 6 the words are the
 * Fix with AI row's, so that is where they are checked.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { HANDOFF_STARTED_TITLE, REVIEW_STARTED_TITLE } from "../src/app/handoff.ts";
import { buildWorkflow, overallStatus } from "../src/app/workflow.ts";
import type { FixWithAiOutcome, WorkflowInput } from "../src/app/workflow.ts";
import { DEFAULT_FORM } from "../src/app/form.ts";
import { CAPABILITIES, CAPABILITY_LABELS } from "../src/app/progress.ts";
import type { ProgressView } from "../src/app/progress.ts";

const DONE: ProgressView = {
  state: "done",
  rows: CAPABILITIES.map((capability) => ({ capability, label: CAPABILITY_LABELS[capability], state: "done" })),
  artifacts: [],
};

function fixRow(fix?: FixWithAiOutcome) {
  const input: WorkflowInput = {
    source: "jira",
    plan: DEFAULT_FORM.plan,
    fixWithAI: false,
    progress: DONE,
    artifacts: ["context.md", "task.md"],
    ...(fix === undefined ? {} : { fix }),
  };
  const steps = buildWorkflow(input);
  return { row: steps.find((step) => step.id === "fixWithAI")!, overall: overallStatus(steps, DONE) };
}

test("a handoff that started an agent says so, and says which one", () => {
  const { row, overall } = fixRow({ status: "success", detail: "Handed to Claude Code in a terminal." });

  assert.equal(row.status, "success");
  // Said once, as the row's status (§37.86); the header still says it in full.
  assert.equal(row.statusText, "Started");
  assert.equal(row.summary, "");
  // The host's own record of the launch. The headline above names no vendor.
  assert.equal(row.detail, "Handed to Claude Code in a terminal.");
  assert.equal(overall.text, "AI fix started");
});

test("nothing else is a success", () => {
  // A skip means no agent was launched — the prompt went to the clipboard, and
  // the row's card explains why. Dressing that up as a success would tell a
  // developer an agent is working on their bug when none is.
  for (const fix of [
    undefined,
    { status: "skipped", detail: "claude is not on PATH." },
    { status: "failed", detail: "boom" },
    { status: "idle" },
    { status: "running" },
  ] as const) {
    assert.notEqual(fixRow(fix).row.status, "success", JSON.stringify(fix));
    assert.notEqual(fixRow(fix).row.summary, HANDOFF_STARTED_TITLE, JSON.stringify(fix));
    assert.notEqual(fixRow(fix).row.statusText, "Started", JSON.stringify(fix));
  }
});

test("a prepared task that nobody handed over is ready, not the green tick", () => {
  const { row } = fixRow();
  assert.equal(row.status, "ready");
  assert.equal(row.statusText, "Ready");
  assert.equal(row.summary, "");
  // Offered by the primary action, not by the row.
  assert.deepEqual([...row.actions], []);
});

test("a success with nothing to add about the agent still reports itself", () => {
  const { row } = fixRow({ status: "success" });
  assert.equal(row.statusText, "Started");
  assert.equal(row.summary, "", `${HANDOFF_STARTED_TITLE} said twice`);
  assert.equal(row.detail, undefined);
});

test("the copy claims a terminal was started and nothing more", () => {
  // The guard that matters. BugPilot does not read the agent's output, diff the
  // repository, or wait — so none of these may appear in what it tells a
  // developer, and a future edit that reaches for one fails here.
  const { row, overall } = fixRow({ status: "success", detail: "Handed to Claude Code in a terminal." });
  const copy = `${row.summary} ${row.detail} ${overall.text}`.toLowerCase();

  for (const claim of [
    "bug fixed",
    "fix completed",
    "fix succeeded",
    "issue resolved",
    "changes applied",
    "tests passed",
    "files changed",
    "done",
    "complete",
    "finished",
    "successfully fixed",
  ]) {
    assert.equal(copy.includes(claim), false, `the success copy claims "${claim}"`);
  }
  assert.match(copy, /started/);
  assert.match(copy, /handed to/);
});

test("the wording is the one the workflow header already uses", () => {
  assert.equal(HANDOFF_STARTED_TITLE, "AI fix started");
});

test("the headline names no vendor", () => {
  const { row } = fixRow({ status: "success", detail: "Handed to Claude Code in a terminal." });
  assert.equal(/claude|codex|copilot|gemini|openai|anthropic/i.test(row.summary), false);
});

// --- Review with AI (Batch 10) ------------------------------------------------

function reviewView(agent: string) {
  const steps = buildWorkflow({
    source: "jira",
    plan: DEFAULT_FORM.plan,
    fixWithAI: false,
    progress: DONE,
    artifacts: ["context.md", "task.md", "fix_report.md"],
    fixReport: { readable: true, summary: "Fixed it." },
    review: { state: "started", agent },
  });
  const review = steps.find((step) => step.id === "fixResult")?.review;
  assert.ok(review?.state === "started");
  return { review, overall: overallStatus(steps, DONE) };
}

test("a started review says a reviewer was started, and nothing about what it found", () => {
  const { review, overall } = reviewView("Claude Code");
  assert.equal(review.summary, REVIEW_STARTED_TITLE);
  assert.equal(review.detail, "Handed to Claude Code in a terminal.");
  const copy = `${review.summary} ${review.detail}`.toLowerCase();
  for (const claim of [
    "review complete",
    "review passed",
    "reviewed",
    "approved",
    "verified",
    "passed",
    "fixed",
    "done",
    "complete",
    "finished",
    "correct",
  ]) {
    assert.equal(copy.includes(claim), false, `the review copy claims "${claim}"`);
  }
  assert.match(copy, /started/);
  assert.match(copy, /handed to/);
  // The header is the run's and the report's, not the review's.
  assert.equal(overall.text, "Fix report available");
});

test("the review headline names no vendor; which agent is the detail's to say", () => {
  assert.equal(REVIEW_STARTED_TITLE, "AI review started");
  assert.equal(/claude|codex|copilot|gemini|openai|anthropic/i.test(REVIEW_STARTED_TITLE), false);
  assert.equal(reviewView("codex").review.detail, "Handed to codex in a terminal.");
});
