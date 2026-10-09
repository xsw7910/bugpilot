/**
 * Whether the agent typed into a terminal is still running there
 * (`terminalActivity.ts`): what shell integration reported, and nothing more.
 * The terminals are plain objects and the clock is the test's.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { LAUNCH_GRACE_MS, TerminalActivity } from "../src/app/terminalActivity.ts";

function tracker() {
  let now = 1_000;
  const activity = new TerminalActivity<object>(() => now);
  return { activity, advance: (ms: number) => (now += ms) };
}

test("a terminal BugPilot never typed into is unknown, whatever its shell reports", () => {
  const { activity } = tracker();
  const foreign = {};
  activity.started(foreign);
  activity.ended(foreign);
  assert.equal(activity.activity(foreign), "unknown");
});

test("the agent's command line started and ended: running, then exited (Ctrl+C, /exit)", () => {
  const { activity } = tracker();
  const terminal = {};
  activity.sent(terminal);
  activity.started(terminal);
  assert.equal(activity.activity(terminal), "running");
  activity.ended(terminal);
  assert.equal(activity.activity(terminal), "exited", "the shell is back at its prompt, but the agent was still called running");
});

test("just typed, start not reported yet: running for a moment, so a second press does not launch twice", () => {
  const { activity, advance } = tracker();
  const terminal = {};
  activity.sent(terminal);
  assert.equal(activity.activity(terminal), "running");
  advance(LAUNCH_GRACE_MS - 1);
  assert.equal(activity.activity(terminal), "running");
});

test("no shell integration: after the grace period it is unknown, never exited on the strength of silence", () => {
  const { activity, advance } = tracker();
  const terminal = {};
  activity.sent(terminal);
  advance(LAUNCH_GRACE_MS);
  assert.equal(activity.activity(terminal), "unknown");
});

test("an end whose start was missed (integration came up mid-command) still means the prompt is back", () => {
  const { activity } = tracker();
  const terminal = {};
  activity.sent(terminal);
  activity.ended(terminal);
  assert.equal(activity.activity(terminal), "exited");
});

test("a restart typed into an exited terminal: running again until its own end is reported", () => {
  const { activity, advance } = tracker();
  const terminal = {};
  activity.sent(terminal);
  activity.started(terminal);
  activity.ended(terminal);
  assert.equal(activity.activity(terminal), "exited");

  activity.sent(terminal);
  assert.equal(activity.activity(terminal), "running", "the restart's start is not reported yet");
  activity.started(terminal);
  advance(LAUNCH_GRACE_MS * 4);
  assert.equal(activity.activity(terminal), "running", "a long-running agent turned into something else");
  activity.ended(terminal);
  assert.equal(activity.activity(terminal), "exited");
});

test("a restart whose start is never reported is unknown after the grace, not exited", () => {
  const { activity, advance } = tracker();
  const terminal = {};
  activity.sent(terminal);
  activity.started(terminal);
  activity.ended(terminal);
  activity.sent(terminal);
  advance(LAUNCH_GRACE_MS);
  assert.equal(activity.activity(terminal), "unknown");
});

test("terminals are accounted for separately", () => {
  const { activity } = tracker();
  const first = {};
  const second = {};
  activity.sent(first);
  activity.started(first);
  activity.ended(first);
  activity.sent(second);
  activity.started(second);
  assert.deepEqual([activity.activity(first), activity.activity(second)], ["exited", "running"]);
});
