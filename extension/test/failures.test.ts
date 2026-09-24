/**
 * Turning a failure into something a developer can act on.
 *
 * Two rules run through every test here. **Categories come from codes**, never
 * from reading a message — a substring check on prose is wrong the day somebody
 * rewords it, and wrong silently. And **the original survives**: the card is a
 * translation, not a replacement, so whatever the CLI actually said is still
 * there underneath.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import { COMMANDS } from "../src/commands.ts";
import { handoffError, runError } from "../src/app/failures.ts";
import type { ProgressView } from "../src/app/progress.ts";

type Failure = NonNullable<ProgressView["failure"]>;

const failure = (overrides: Partial<Failure> = {}): Failure => ({
  code: "INTERNAL_ERROR",
  summary: "bugpilot hit an unexpected error.",
  retryable: false,
  ...overrides,
});

test("no failure is no card", () => {
  assert.equal(runError(undefined), undefined);
});

test("a rejected credential is an access problem, with the way to fix it", () => {
  const error = runError(
    failure({
      code: "JIRA_AUTH_FAILED",
      summary: "Jira rejected the stored credentials.",
      action: "Re-run `bugpilot setup`.",
      detail: "Jira returned HTTP 401.",
    }),
  );

  assert.equal(error?.kind, "jira-access");
  assert.equal(error?.title, "Unable to access Jira");
  assert.match(error?.message ?? "", /Jira rejected the stored credentials\./);
  // The button goes where a Jira credential actually lives — SecretStorage,
  // not the settings page.
  assert.deepEqual(error?.action, {
    title: "Set Jira Credentials",
    command: COMMANDS.setCredentials,
  });
  assert.equal(error?.detail, "Jira returned HTTP 401.");
});

test("Jira not being configured at all is the same category", () => {
  const error = runError(failure({ code: "JIRA_NOT_CONFIGURED", summary: "Jira is not configured." }));

  assert.equal(error?.kind, "jira-access");
  assert.equal(error?.action?.command, COMMANDS.setCredentials);
});

test("an issue nobody can find is not an access problem", () => {
  // The distinction that matters: one means "fix your token", the other means
  // "check the key". Telling somebody to re-enter a working credential because
  // they typed JR-9999 sends them to the wrong place entirely.
  const error = runError(
    failure({ code: "JIRA_ISSUE_NOT_FOUND", summary: "Jira has no such issue." }),
    "JR-12345",
  );

  assert.equal(error?.kind, "jira-not-found");
  assert.equal(error?.title, "Issue not found");
  assert.match(error?.message ?? "", /couldn't find JR-12345/);
  assert.match(error?.message ?? "", /describe the bug instead/);
  // No credential button: there is nothing wrong with the credential.
  assert.equal(error?.action, undefined);
});

test("an issue that was never identified is still not-found, just unnamed", () => {
  const error = runError(failure({ code: "JIRA_ISSUE_NOT_FOUND", summary: "No such issue." }));

  assert.equal(error?.kind, "jira-not-found");
  assert.match(error?.message ?? "", /couldn't find that issue/);
});

test("Jira being slow, rate limited or unreachable is not an auth failure", () => {
  // §7: classifying every Jira problem as "check your token" is how a panel
  // teaches developers to distrust it. These keep their own diagnosis and fall
  // to the generic title.
  for (const code of [
    "JIRA_TIMEOUT",
    "JIRA_NETWORK_ERROR",
    "JIRA_RATE_LIMITED",
    "JIRA_INVALID_RESPONSE",
    "JIRA_ERROR",
  ]) {
    const error = runError(failure({ code, summary: "Jira did not respond in time.", action: "Try again." }));
    assert.equal(error?.kind, "run", code);
    assert.equal(error?.title, "Run failed", code);
    assert.equal(error?.action, undefined, code);
    // The specific diagnosis is still what the developer reads.
    assert.match(error?.message ?? "", /Jira did not respond in time\. Try again\./, code);
  }
});

test("anything else is a run failure, and says so rather than guessing", () => {
  for (const code of ["INTERNAL_ERROR", "TIMEOUT", "WORK_ITEM_NOT_FOUND", "SCHEMA_VERSION"]) {
    const error = runError(failure({ code, summary: "Something went wrong." }));
    assert.equal(error?.kind, "run", code);
    assert.equal(error?.title, "Run failed", code);
  }
});

test("a code this extension has never heard of still produces a usable card", () => {
  // `diagnose()` falls back to the CLI's own message for an unknown code, so
  // the card is less specific rather than less informative.
  const error = runError(
    failure({
      code: "SOME_FUTURE_CODE",
      summary: "The widget reticulator refused the splines.",
      action: "This version of the extension does not recognise that error.",
      detail: "The widget reticulator refused the splines.",
    }),
  );

  assert.equal(error?.kind, "run");
  assert.equal(error?.title, "Run failed");
  assert.match(error?.message ?? "", /widget reticulator/);
  assert.equal(error?.detail, "The widget reticulator refused the splines.");
});

test("the original message survives every category", () => {
  // §27. The card is a translation; the Details disclosure is the original.
  for (const code of ["JIRA_AUTH_FAILED", "JIRA_ISSUE_NOT_FOUND", "INTERNAL_ERROR"]) {
    const error = runError(failure({ code, detail: "HTTP 401 Unauthorized" }));
    assert.equal(error?.detail, "HTTP 401 Unauthorized", code);
  }
});

test("a failure with nothing technical to add carries no Details", () => {
  // Rather than an empty disclosure, which is a control that does nothing.
  const error = runError(failure({ detail: "   " }));
  assert.equal(error?.detail, undefined);
  assert.equal(runError(failure())?.detail, undefined);
});

test("an agent that will not start is its own category, worded for any agent", () => {
  const error = handoffError("claude is not on PATH.");

  assert.equal(error.kind, "agent");
  assert.equal(error.title, "AI agent unavailable");
  // Provider-neutral headline: the mechanism is Claude-shaped, the copy is not.
  assert.equal(/claude|codex|copilot/i.test(error.title + error.message), false);
  assert.match(error.message, /couldn't start the selected AI agent/);
  // `resolveAgent`'s own sentence, which may name what the developer configured.
  assert.equal(error.detail, "claude is not on PATH.");
  assert.deepEqual(error.action, { title: "Open Settings", command: COMMANDS.openSettings });
});

test("every reason resolveAgent can give becomes the same card", () => {
  // Four different ways the handoff cannot start, one thing to tell the
  // developer. The difference between them is the Details line.
  for (const reason of [
    "claude is not on PATH.",
    "No AI coding agent was found on PATH (looked for claude).",
    "No custom agent command is set. Put one in Advanced settings, using {prompt} where the handoff prompt goes.",
    "The custom agent command has no {prompt} in it, so the agent would get no instructions.",
  ]) {
    const error = handoffError(reason);
    assert.equal(error.kind, "agent");
    assert.equal(error.detail, reason);
  }
});

test("the card is never built by reading an error message", () => {
  // The guard for §5 and §20, on the source itself: a category decided by
  // `includes("401")` is one that breaks the day somebody rewords a sentence.
  const source = readFileSync(new URL("../src/app/failures.ts", import.meta.url), "utf8");
  const code = source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");

  for (const smell of [".includes(", ".match(", ".indexOf(", "toLowerCase()", "RegExp"]) {
    assert.equal(code.includes(smell), false, `failures.ts inspects message text with ${smell}`);
  }
});
