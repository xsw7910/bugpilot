/**
 * One read-only view's bookkeeping (0.1.4): asked once per request key, the
 * newest request's answer is the only one shown, an older CLI is never asked,
 * and an `outdated` answer is never asked again while the view is open.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { Pane } from "../src/app/effectivePane.ts";
import type { PaneOutcome } from "../src/app/effectivePane.ts";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

function harness() {
  const asked: string[] = [];
  const pending = new Map<string, (outcome: PaneOutcome<string>) => void>();
  let changes = 0;
  const pane = new Pane<string, string>(
    (request) => {
      asked.push(request);
      return new Promise((resolve) => pending.set(request, resolve));
    },
    () => {
      changes += 1;
    },
  );
  return { pane, asked, answer: (request: string, outcome: PaneOutcome<string>) => pending.get(request)!(outcome), changes: () => changes };
}

test("closed, it asks nothing and shows nothing", () => {
  const h = harness();
  h.pane.sync({ key: "a", request: "a" });
  assert.deepEqual(h.asked, []);
  assert.equal(h.pane.view(), undefined);
});

test("open, it asks once per key and shows the answer", async () => {
  const h = harness();
  h.pane.open();
  assert.deepEqual(h.pane.view(), { token: 1, status: "loading", refreshing: false, held: false, current: false });
  h.pane.sync({ key: "a", request: "a" });
  h.pane.sync({ key: "a", request: "a" });
  assert.deepEqual(h.asked, ["a"]);
  assert.equal(h.pane.view()!.refreshing, true);
  h.answer("a", { kind: "loaded", snapshot: "A" });
  await tick();
  assert.deepEqual(h.pane.view(), { token: 1, status: "loaded", snapshot: "A", refreshing: false, held: false, current: true });
  assert.equal(h.changes(), 1);
  // A new key asks again; the last answer stays on screen meanwhile.
  h.pane.sync({ key: "b", request: "b" });
  assert.deepEqual(h.pane.view(), { token: 1, status: "loaded", snapshot: "A", refreshing: true, held: false, current: false });
  h.pane.invalidate();
  h.pane.sync({ key: "b", request: "b" });
  assert.deepEqual(h.asked, ["a", "b", "b"]);
});

test("only the newest request's answer is shown, whatever order they arrive in", async () => {
  const h = harness();
  h.pane.open();
  h.pane.sync({ key: "first", request: "first" });
  h.pane.sync({ key: "second", request: "second" });
  h.answer("second", { kind: "loaded", snapshot: "SECOND" });
  await tick();
  h.answer("first", { kind: "loaded", snapshot: "FIRST" });
  await tick();
  assert.equal(h.pane.view()!.snapshot, "SECOND");
  assert.equal(h.changes(), 1, "the late answer was drawn");
});

test("an answer after a close, or after a reopen, is dropped", async () => {
  const h = harness();
  h.pane.open();
  h.pane.sync({ key: "a", request: "a" });
  h.pane.close();
  h.answer("a", { kind: "loaded", snapshot: "A" });
  await tick();
  assert.equal(h.pane.view(), undefined);
  h.pane.open();
  assert.equal(h.pane.view()!.token, 2);
  assert.equal(h.pane.view()!.status, "loading");
  assert.equal(h.changes(), 0);
});

test("unsupported is never asked; outdated is never asked again; a failure keeps the last answer and says why", async () => {
  const h = harness();
  h.pane.open();
  h.pane.sync("unsupported");
  assert.deepEqual(h.asked, []);
  assert.equal(h.pane.view()!.status, "unsupported");

  const o = harness();
  o.pane.open();
  o.pane.sync({ key: "a", request: "a" });
  o.answer("a", { kind: "outdated" });
  await tick();
  o.pane.sync({ key: "b", request: "b" });
  assert.deepEqual(o.asked, ["a"]);
  assert.equal(o.pane.view()!.status, "unsupported");

  const f = harness();
  f.pane.open();
  f.pane.sync({ key: "a", request: "a" });
  f.answer("a", { kind: "loaded", snapshot: "A" });
  await tick();
  f.pane.sync({ key: "b", request: "b" });
  f.answer("b", { kind: "failed", message: "bugpilot returned no task preview." });
  await tick();
  assert.deepEqual(f.pane.view(), { token: 1, status: "failed", snapshot: "A", message: "bugpilot returned no task preview.", refreshing: false, held: false, current: false });
  // Held: nothing is asked.
  f.pane.sync(undefined);
  assert.deepEqual(f.asked, ["a", "b"]);
});

test("held while BugPilot is busy: an answer on its way is dropped, the last one stays marked held, and the request is asked again after", async () => {
  const h = harness();
  h.pane.open();
  h.pane.sync({ key: "a", request: "a" });
  h.answer("a", { kind: "loaded", snapshot: "A" });
  await tick();
  h.pane.invalidate();
  h.pane.sync({ key: "a", request: "a" });
  assert.equal(h.pane.view()!.refreshing, true);
  // A run starts, or the CLI is being checked again: hold.
  h.pane.sync(undefined);
  h.pane.sync(undefined);
  assert.deepEqual(h.pane.view(), { token: 1, status: "loaded", snapshot: "A", refreshing: false, held: true, current: false });
  const changes = h.changes();
  h.answer("a", { kind: "loaded", snapshot: "A-late" });
  await tick();
  assert.equal(h.pane.view()!.snapshot, "A", "an answer asked before the hold was shown");
  assert.equal(h.changes(), changes);
  // The hold ends with the same request: asked again, and only then current.
  h.pane.sync({ key: "a", request: "a" });
  assert.deepEqual(h.asked, ["a", "a", "a"]);
  assert.equal(h.pane.view()!.held, false);
  h.answer("a", { kind: "loaded", snapshot: "A2" });
  await tick();
  assert.deepEqual(h.pane.view(), { token: 1, status: "loaded", snapshot: "A2", refreshing: false, held: false, current: true });
});

test("current: only the snapshot answering the current request — never the previous work item's, a late one, a failed refresh's or a Refresh's (L-1)", async () => {
  const h = harness();
  h.pane.open();
  h.pane.sync({ key: "work-item:JR-1|0", request: "JR-1" });
  h.answer("JR-1", { kind: "loaded", snapshot: "TASK-1" });
  await tick();
  assert.equal(h.pane.view()!.current, true);

  // The developer picks another work item: JR-1's task stays on screen while JR-2's loads, not current.
  h.pane.sync({ key: "work-item:JR-2|0", request: "JR-2" });
  assert.deepEqual([h.pane.view()!.snapshot, h.pane.view()!.refreshing, h.pane.view()!.current], ["TASK-1", true, false]);
  // It fails: the last good answer is still shown and said to have failed — still not current.
  h.answer("JR-2", { kind: "failed", message: "bugpilot could not read issue.json." });
  await tick();
  assert.deepEqual([h.pane.view()!.status, h.pane.view()!.snapshot, h.pane.view()!.current], ["failed", "TASK-1", false]);
  // Back to JR-1 while a slow JR-3 request is overtaken: the late answer is dropped, JR-1's is current.
  h.pane.sync({ key: "work-item:JR-3|0", request: "JR-3" });
  h.pane.sync({ key: "work-item:JR-1|1", request: "JR-1b" });
  h.answer("JR-3", { kind: "loaded", snapshot: "TASK-3" });
  await tick();
  assert.deepEqual([h.pane.view()!.snapshot, h.pane.view()!.current], ["TASK-1", false], "a late answer for an earlier request was taken");
  h.answer("JR-1b", { kind: "loaded", snapshot: "TASK-1 again" });
  await tick();
  assert.deepEqual([h.pane.view()!.snapshot, h.pane.view()!.current], ["TASK-1 again", true]);

  // A Refresh asks again for the same request: not current until its answer comes.
  h.pane.invalidate();
  assert.equal(h.pane.view()!.current, false);
  h.pane.sync({ key: "work-item:JR-1|1", request: "JR-1c" });
  assert.equal(h.pane.view()!.current, false);
  h.answer("JR-1c", { kind: "loaded", snapshot: "TASK-1 refreshed" });
  await tick();
  assert.deepEqual([h.pane.view()!.snapshot, h.pane.view()!.current], ["TASK-1 refreshed", true]);
});

test("current: an answer that lands after a Refresh was asked for is shown, but not current until asked again", async () => {
  const h = harness();
  h.pane.open();
  h.pane.sync({ key: "k", request: "first" });
  // Refresh while the first request is still on its way: its answer is about inputs that may have changed.
  h.pane.invalidate();
  h.answer("first", { kind: "loaded", snapshot: "FIRST" });
  await tick();
  assert.deepEqual([h.pane.view()!.snapshot, h.pane.view()!.current], ["FIRST", false]);
  h.pane.sync({ key: "k", request: "second" });
  assert.deepEqual(h.asked, ["first", "second"]);
  h.answer("second", { kind: "loaded", snapshot: "SECOND" });
  await tick();
  assert.deepEqual([h.pane.view()!.snapshot, h.pane.view()!.current], ["SECOND", true]);
});

test("current: an older CLI, an outdated answer and a reopen are never current", async () => {
  const h = harness();
  h.pane.open();
  h.pane.sync("unsupported");
  assert.equal(h.pane.view()!.current, false);

  const o = harness();
  o.pane.open();
  o.pane.sync({ key: "a", request: "a" });
  o.answer("a", { kind: "loaded", snapshot: "A" });
  await tick();
  o.pane.sync({ key: "b", request: "b" });
  o.answer("b", { kind: "outdated" });
  await tick();
  assert.deepEqual([o.pane.view()!.status, o.pane.view()!.snapshot, o.pane.view()!.current], ["unsupported", undefined, false]);

  const r = harness();
  r.pane.open();
  r.pane.sync({ key: "a", request: "a" });
  r.answer("a", { kind: "loaded", snapshot: "A" });
  await tick();
  r.pane.close();
  r.pane.open();
  assert.deepEqual([r.pane.view()!.snapshot, r.pane.view()!.current], [undefined, false]);
});

test("a hold never makes an older CLI's refusal be asked again", async () => {
  const h = harness();
  h.pane.open();
  h.pane.sync({ key: "a", request: "a" });
  h.answer("a", { kind: "outdated" });
  await tick();
  h.pane.sync(undefined);
  h.pane.sync({ key: "a", request: "a" });
  assert.deepEqual(h.asked, ["a"]);
  assert.equal(h.pane.view()!.status, "unsupported");
});
