/**
 * What BugPilot is allowed to say when a handoff worked.
 *
 * The extension starts a terminal and stops watching. Every test here defends
 * the distance between that and "the bug is fixed" — a claim the panel has no
 * way to check and a developer would believe.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { HANDOFF_STARTED_MESSAGE, HANDOFF_STARTED_TITLE, handoffOutcome } from "../src/app/handoff.ts";

test("a handoff that started an agent says so, and says which one", () => {
  const outcome = handoffOutcome({
    status: "success",
    detail: "Handed to Claude Code in a terminal.",
  });

  assert.equal(outcome?.title, "AI fix started");
  assert.equal(outcome?.message, "The prepared context was handed to the configured AI agent.");
  // The host's own record of the launch. The two lines above name no vendor.
  assert.equal(outcome?.detail, "Handed to Claude Code in a terminal.");
});

test("nothing else is a success", () => {
  // A skip means no agent was launched — the prompt went to the clipboard, and
  // the UI-B2 card explains why. Dressing that up as a success would tell a
  // developer an agent is working on their bug when none is.
  assert.equal(handoffOutcome(undefined), undefined);
  assert.equal(handoffOutcome({ status: "skipped", detail: "claude is not on PATH." }), undefined);
  assert.equal(handoffOutcome({ status: "failed", detail: "boom" }), undefined);
  assert.equal(handoffOutcome({ status: "idle" }), undefined);
  assert.equal(handoffOutcome({ status: "running" }), undefined);
});

test("a success with nothing to add about the agent still reports itself", () => {
  const outcome = handoffOutcome({ status: "success" });

  assert.equal(outcome?.title, HANDOFF_STARTED_TITLE);
  assert.equal(outcome?.detail, undefined);
  assert.equal(handoffOutcome({ status: "success", detail: "   " })?.detail, undefined);
});

test("the copy claims a terminal was started and nothing more", () => {
  // The guard that matters. BugPilot does not read the agent's output, diff the
  // repository, or wait — so none of these may appear in what it tells a
  // developer, and a future edit that reaches for one fails here.
  const copy = `${HANDOFF_STARTED_TITLE} ${HANDOFF_STARTED_MESSAGE}`.toLowerCase();

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
  // And what it does say: something was started, and something was handed over.
  assert.match(copy, /started/);
  assert.match(copy, /handed to the configured ai agent/);
});

test("the wording is the one the workflow header already uses", () => {
  // `overallStatus` has said "AI fix started" since phase 5. One phrase for one
  // fact; a second vocabulary for it is how a panel starts contradicting itself.
  assert.equal(HANDOFF_STARTED_TITLE, "AI fix started");
});

test("the headline names no vendor", () => {
  const copy = `${HANDOFF_STARTED_TITLE} ${HANDOFF_STARTED_MESSAGE}`;
  assert.equal(/claude|codex|copilot|gemini|openai|anthropic/i.test(copy), false);
});
