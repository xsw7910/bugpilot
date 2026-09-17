import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  CAPABILITIES,
  CAPABILITY_MARKER_STEPS,
  ProgressTracker,
  viewFromStatus,
} from "../src/app/progress.ts";
import type { Capability, Row } from "../src/app/progress.ts";
import { DEFAULT_FORM } from "../src/app/form.ts";
import type { PlanState } from "../src/app/form.ts";
import type { StreamEvent } from "../src/protocol.ts";

const FULL_PLAN = DEFAULT_FORM.plan;

/** A clock the test drives, so durations are asserted rather than tolerated. */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let value = 1_000;
  return {
    now: () => value,
    advance: (ms: number) => {
      value += ms;
    },
  };
}

function rowFor(rows: readonly Row[], capability: Capability): Row {
  const row = rows.find((candidate) => candidate.capability === capability);
  assert.ok(row, `no row for ${capability}`);
  return row;
}

const started: StreamEvent = { type: "started", work_item_id: "JR-1", source: "jira" };
const step = (type: "step_started" | "step_completed", name: string): StreamEvent =>
  ({ type, step: name }) as StreamEvent;

// --- the step/capability mapping is shared with Python --------------------

test("the marker steps are a subset of bugpilot's capability steps", () => {
  // The UI shows capabilities; the stream reports implementation steps. If the
  // Python table gains a step for a capability, this test says so — and if it
  // renames one, the row would silently never light up without it.
  const source = readFileSync(new URL("../../bugpilot/core/models.py", import.meta.url), "utf8");
  const block = /CAPABILITY_STEPS: dict\[str, tuple\[str, \.\.\.\]\] = \{([\s\S]*?)\n\}/.exec(source);
  assert.ok(block, "could not find CAPABILITY_STEPS in bugpilot/core/models.py");

  const python = new Map<string, string[]>();
  for (const line of block[1]!.split("\n")) {
    const entry = /"([a-z_]+)":\s*\(([^)]*)\)/.exec(line);
    if (!entry) continue;
    python.set(
      entry[1]!,
      [...entry[2]!.matchAll(/"([a-z_]+)"/g)].map((match) => match[1]!),
    );
  }

  assert.deepEqual([...python.keys()].sort(), [...CAPABILITIES].sort());
  for (const capability of CAPABILITIES) {
    const theirs = python.get(capability)!;
    for (const step of CAPABILITY_MARKER_STEPS[capability]) {
      assert.ok(theirs.includes(step), `${step} is not one of ${capability}'s steps in Python`);
    }
  }
});

test("only steps shared between capabilities are left out of the rows", () => {
  // `keywords` belongs to both code search and similar fixes, so it cannot mark
  // either row without lying about the other. Anything else missing is a bug.
  const source = readFileSync(new URL("../../bugpilot/core/models.py", import.meta.url), "utf8");
  const block = /CAPABILITY_STEPS: dict\[str, tuple\[str, \.\.\.\]\] = \{([\s\S]*?)\n\}/.exec(source);
  const counts = new Map<string, number>();
  for (const line of block![1]!.split("\n")) {
    const entry = /"([a-z_]+)":\s*\(([^)]*)\)/.exec(line);
    if (!entry) continue;
    for (const match of entry[2]!.matchAll(/"([a-z_]+)"/g)) {
      counts.set(match[1]!, (counts.get(match[1]!) ?? 0) + 1);
    }
  }
  const marked = new Set(CAPABILITIES.flatMap((capability) => CAPABILITY_MARKER_STEPS[capability]));
  for (const [step, count] of counts) {
    if (marked.has(step)) continue;
    assert.ok(count > 1, `${step} belongs to one capability but marks no row`);
  }
});

// --- a live run ------------------------------------------------------------

test("a full successful run lights every row and measures each one", () => {
  const time = clock();
  const tracker = new ProgressTracker(FULL_PLAN, time.now);

  tracker.apply(started);
  tracker.apply(step("step_started", "doctor"));
  assert.equal(tracker.view().activity, "Checking environment");
  tracker.apply(step("step_completed", "doctor"));

  tracker.apply(step("step_started", "fetch"));
  time.advance(400);
  tracker.apply(step("step_completed", "fetch"));
  tracker.apply(step("step_started", "parse"));
  time.advance(100);
  tracker.apply(step("step_completed", "parse"));

  for (const [name, ms] of [
    ["keywords", 50],
    ["memory_search", 200],
    ["code_search", 900],
    ["git_context", 300],
    ["context", 150],
    ["prompt", 100],
  ] as const) {
    tracker.apply(step("step_started", name));
    time.advance(ms);
    tracker.apply(step("step_completed", name));
  }
  tracker.apply({ type: "artifact", path: ".ai/JR-1/agent_task.md" });
  tracker.apply({ type: "completed", ok: true });

  const view = tracker.view();
  assert.equal(view.state, "done");
  assert.deepEqual(
    view.rows.map((row) => row.state),
    ["done", "done", "done", "done", "done"],
  );
  // issue_details spans fetch and parse, so its duration covers both.
  assert.equal(rowFor(view.rows, "issue_details").durationMs, 500);
  assert.equal(rowFor(view.rows, "code_search").durationMs, 900);
  assert.deepEqual(view.artifacts, [".ai/JR-1/agent_task.md"]);
  assert.equal(view.workItemId, "JR-1");
  assert.equal(view.activity, undefined, "a finished run has no current activity");
});

test("a capability the plan turned off starts skipped, not pending", () => {
  // A row that sits at pending forever reads as "stuck", which is how a partial
  // plan looks like a hung run.
  const plan: PlanState = { ...FULL_PLAN, gitHistory: false };
  const view = new ProgressTracker(plan, clock().now).view();
  assert.equal(rowFor(view.rows, "git_history").state, "skipped");
  assert.equal(rowFor(view.rows, "code_search").state, "pending");
});

test("a skip event marks the row even when the plan said otherwise", () => {
  const tracker = new ProgressTracker(FULL_PLAN, clock().now);
  tracker.apply({ type: "step_skipped", step: "git_context", reason: "plan" });
  assert.equal(rowFor(tracker.view().rows, "git_history").state, "skipped");
});

test("a step with no event of its own does not leave a row unfinished", () => {
  // Observed on a real run: memory_add reported `pass` in workflow_status.json
  // having emitted no step_started at all. A success must therefore close
  // whatever is still open, or Build context would stay spinning forever.
  const tracker = new ProgressTracker(FULL_PLAN, clock().now);
  tracker.apply(started);
  tracker.apply(step("step_started", "context"));
  tracker.apply({ type: "completed", ok: true });

  assert.equal(rowFor(tracker.view().rows, "build_context").state, "done");
});

test("the failing step is marked in place, with an explanation", () => {
  const tracker = new ProgressTracker(FULL_PLAN, clock().now);
  tracker.apply(started);
  tracker.apply(step("step_started", "fetch"));
  tracker.apply({
    type: "completed",
    ok: false,
    error: { code: "JIRA_AUTH_FAILED", message: "401 from Jira" },
  });

  const view = tracker.view();
  assert.equal(view.state, "failed");
  assert.equal(rowFor(view.rows, "issue_details").state, "failed");
  // Rows the run never reached stay pending rather than being blamed.
  assert.equal(rowFor(view.rows, "code_search").state, "pending");
  assert.equal(view.failure?.code, "JIRA_AUTH_FAILED");
  assert.match(view.failure?.summary ?? "", /Jira/i);
  assert.equal(view.failure?.capability, "issue_details");
  // The raw CLI message is not what the developer is shown (§5.4).
  assert.notEqual(view.failure?.summary, "401 from Jira");
});

test("a failure between capabilities still reports, with no row blamed", () => {
  // `keywords` marks no row; a failure there must not silently vanish.
  const tracker = new ProgressTracker(FULL_PLAN, clock().now);
  tracker.apply(started);
  tracker.apply(step("step_started", "keywords"));
  tracker.apply({
    type: "completed",
    ok: false,
    error: { code: "RIPGREP_MISSING", message: "rg not found" },
  });

  const view = tracker.view();
  assert.equal(view.state, "failed");
  assert.equal(view.failure?.capability, undefined);
  assert.equal(
    view.rows.every((row) => row.state !== "failed"),
    true,
  );
  assert.ok(view.failure?.action, "a failure the developer can act on must say how");
});

test("a killed run is stopped, not failed, and does not accuse a step", () => {
  // Pressing Stop is not an error; showing a red row for it would train the
  // developer to ignore red rows.
  const tracker = new ProgressTracker(FULL_PLAN, clock().now);
  tracker.apply(started);
  tracker.apply(step("step_started", "code_search"));
  tracker.interrupted("stopped");

  const view = tracker.view();
  assert.equal(view.state, "stopped");
  assert.equal(rowFor(view.rows, "code_search").state, "pending");
  assert.equal(view.failure, undefined);
});

test("a stream that ends with no terminal event is a failure, not a spinner", () => {
  const tracker = new ProgressTracker(FULL_PLAN, clock().now);
  tracker.apply(started);
  tracker.apply(step("step_started", "code_search"));
  tracker.interrupted("crashed");

  const view = tracker.view();
  assert.equal(view.state, "failed");
  assert.equal(rowFor(view.rows, "code_search").state, "failed");
  assert.match(view.failure?.summary ?? "", /stopped before finishing/);
});

test("an interruption after the run finished is ignored", () => {
  // The child's exit arrives after its `completed` event; treating that as an
  // interruption would turn every successful run into a crash.
  const tracker = new ProgressTracker(FULL_PLAN, clock().now);
  tracker.apply(started);
  tracker.apply({ type: "completed", ok: true });
  tracker.interrupted("crashed");
  assert.equal(tracker.view().state, "done");
});

test("a newer event contract says update the extension, not crashed", () => {
  const tracker = new ProgressTracker(FULL_PLAN, clock().now);
  tracker.foreign(2);
  const view = tracker.view();
  assert.equal(view.state, "failed");
  assert.match(view.failure?.summary ?? "", /v2/);
  assert.match(view.failure?.action ?? "", /Update the BugPilot extension/);
});

// --- restoring after a restart --------------------------------------------

test("the checklist is rebuilt from workflow_status.json", () => {
  // Verbatim shape from a real run, including the steps the extension ignores.
  const view = viewFromStatus({
    issue_key: "local_20260904160612",
    mode: "prepare-only",
    steps: {
      doctor: "pass",
      fetch: "skipped",
      parse: "pass",
      keywords: "pass",
      memory_search: "pass",
      code_search: "pass",
      git_context: "skipped",
      context: "pass",
      prompt: "pass",
      memory_add: "pass",
      delivery_check: "skipped",
    },
    generated_files: [".ai/local_20260904160612/agent_task.md", ".ai_memory/bugs/x.md"],
  });

  assert.equal(view.state, "done");
  // parse passed, so the capability ran even though fetch was skipped — which
  // is exactly what a hand-written bug looks like.
  assert.equal(rowFor(view.rows, "issue_details").state, "done");
  assert.equal(rowFor(view.rows, "git_history").state, "skipped");
  assert.equal(rowFor(view.rows, "build_context").state, "done");
  assert.equal(view.rows.every((row) => row.durationMs === undefined), true);
  assert.equal(view.artifacts.length, 2);
});

test("a failed step in the status file is restored as failed", () => {
  const view = viewFromStatus({ steps: { code_search: "fail", parse: "pass" } });
  assert.equal(rowFor(view.rows, "code_search").state, "failed");
});

test("unreadable status degrades to an idle checklist rather than throwing", () => {
  for (const input of [undefined, null, "nonsense", 42, { steps: "not a map" }, {}]) {
    const view = viewFromStatus(input);
    assert.equal(view.state, "idle");
    assert.equal(view.rows.length, CAPABILITIES.length);
    assert.deepEqual(view.artifacts, []);
  }
});

test("a restored run that failed is not reported as done", () => {
  // The status file carries no error detail, so the red row is the whole
  // story — but calling the run "done" would contradict the row next to it.
  const view = viewFromStatus({ steps: { parse: "pass", code_search: "fail" } });
  assert.equal(view.state, "failed");
});

test("a timeout blames the step in flight and says how to make it faster", () => {
  const tracker = new ProgressTracker(FULL_PLAN, clock().now);
  tracker.apply(started);
  tracker.apply(step("step_started", "code_search"));
  tracker.interrupted("timeout");

  const view = tracker.view();
  assert.equal(view.state, "failed");
  assert.equal(rowFor(view.rows, "code_search").state, "failed");
  assert.equal(view.failure?.retryable, true);
  assert.match(view.failure?.action ?? "", /Max files|ignore/);
});
