/**
 * The workflow model, and the agent the last step hands over to.
 *
 * These two are what the panel refactor turned into logic: what used to be an
 * "Investigate" fieldset, a "Progress" checklist and a "Hand off" card is now
 * one derived list, and the row that involves a model is chosen like any other
 * step. Both questions — what a row says, and what actually gets run — are
 * answered here rather than in the page, so both can be tested.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { buildWorkflow, canOpenFolder, overallStatus, REVIEW_NEXT_STEP, stepDescription, WORKFLOW_STEP_IDS } from "../src/app/workflow.ts";
import type { WorkflowInput, WorkflowStepResult } from "../src/app/workflow.ts";
import { isPlainPrompt, resolveAgent, KNOWN_AGENTS, PROMPT_PLACEHOLDER } from "../src/app/agents.ts";
import { DEFAULT_FORM } from "../src/app/form.ts";
import { CAPABILITIES, CAPABILITY_LABELS } from "../src/app/progress.ts";
import type { ProgressView, RowState } from "../src/app/progress.ts";

const rows = (states: Partial<Record<string, RowState>>): ProgressView["rows"] =>
  CAPABILITIES.map((capability) => ({
    capability,
    label: CAPABILITY_LABELS[capability],
    state: states[capability] ?? "pending",
  }));

const progress = (
  state: ProgressView["state"],
  states: Partial<Record<string, RowState>> = {},
): ProgressView => ({ state, rows: rows(states), artifacts: [] });

const input = (overrides: Partial<WorkflowInput> = {}): WorkflowInput => ({
  source: "jira",
  plan: DEFAULT_FORM.plan,
  fixWithAI: false,
  progress: progress("idle"),
  artifacts: [],
  ...overrides,
});

// --- the rows ---------------------------------------------------------------

test("the workflow is the six steps, in order, whatever the run did", () => {
  // The rows are the plan as well as the progress, so they exist before the
  // first run — that is the whole reason the two lists could merge.
  const steps = buildWorkflow(input());
  assert.deepEqual(
    steps.map((step) => step.id),
    [...WORKFLOW_STEP_IDS],
  );
  assert.deepEqual(
    steps.map((step) => step.status),
    ["idle", "idle", "idle", "idle", "idle", "idle"],
  );
  assert.equal(steps[0]!.required, true);
  assert.equal(steps[0]!.enabled, true);
});

test("issue details is required, and says what it will actually do", () => {
  // "Fetch Jira issue information" is untrue for a bug someone typed out, and
  // the row is the only place that difference is visible.
  assert.match(stepDescription("issueDetails", "jira"), /Fetch Jira/);
  assert.match(stepDescription("issueDetails", "manual"), /description you wrote/);
  assert.equal(buildWorkflow(input({ source: "manual" }))[0]!.description, stepDescription("issueDetails", "manual"));
});

test("an unticked step is enabled: false rather than missing", () => {
  // Missing would remove the row, and a row that vanishes when you untick it
  // takes the way to tick it again with it.
  const steps = buildWorkflow(
    input({ plan: { ...DEFAULT_FORM.plan, gitHistory: false } }),
  );
  const history = steps.find((step) => step.id === "gitHistory");
  assert.equal(history?.enabled, false);
  assert.equal(history?.status, "idle");
});

test("a run's states become the rows' states, name for name", () => {
  const steps = buildWorkflow(
    input({
      progress: progress("running", {
        issue_details: "done",
        code_search: "running",
        git_history: "skipped",
        build_context: "failed",
      }),
    }),
  );
  const status = Object.fromEntries(steps.map((step) => [step.id, step.status]));
  assert.deepEqual(status, {
    issueDetails: "success",
    codeSearch: "running",
    gitHistory: "skipped",
    similarFixes: "idle",
    buildContext: "failed",
    fixWithAI: "idle",
  });
});

test("a duration is carried through, and absent until there is one", () => {
  const withTiming = buildWorkflow(
    input({
      progress: {
        state: "done",
        rows: rows({ code_search: "done" }).map((row) =>
          row.capability === "code_search" ? { ...row, durationMs: 32_500 } : row,
        ),
        artifacts: [],
      },
    }),
  );
  assert.equal(withTiming.find((step) => step.id === "codeSearch")?.durationMs, 32_500);
  assert.equal(buildWorkflow(input()).find((step) => step.id === "codeSearch")?.durationMs, undefined);
});

// --- the row actions --------------------------------------------------------

const ALL_DONE = {
  issue_details: "done",
  code_search: "done",
  git_history: "done",
  similar_fixes: "done",
  build_context: "done",
} as const;

const stepIn = (steps: ReturnType<typeof buildWorkflow>, id: string) => steps.find((step) => step.id === id)!;

test("Build context's actions need the file they act on, and a finished step", () => {
  // Keyed off the file *and* the row's own state: the file alone could be the
  // last run's, and a row that has not finished has not produced anything.
  const finishedNoFile = buildWorkflow(input({ progress: progress("done", ALL_DONE), artifacts: ["task.md"] }));
  assert.deepEqual(stepIn(finishedNoFile, "buildContext").actions, []);

  const complete = buildWorkflow(input({ progress: progress("done", ALL_DONE), artifacts: ["task.md", "context.md"] }));
  assert.deepEqual(stepIn(complete, "buildContext").actions, ["openContext", "copyContext"]);
  assert.equal(stepIn(complete, "buildContext").artifact, "context.md");

  // A context.md on disk from before, while this run has not built one yet.
  const stale = buildWorkflow(input({ progress: progress("running", { issue_details: "running" }), artifacts: ["context.md"] }));
  assert.deepEqual(stepIn(stale, "buildContext").actions, []);
  assert.equal(stepIn(stale, "buildContext").artifact, undefined);
});

test("only Build context and Fix with AI ever offer actions, and never the folder", () => {
  // Open Folder is the work item's: it reveals every artifact, not Build
  // context's one file, so no row carries it.
  for (const step of buildWorkflow(input())) assert.deepEqual(step.actions, [], step.id);
  const steps = buildWorkflow(input({ progress: progress("done", ALL_DONE), artifacts: ["task.md", "context.md"] }));
  for (const step of steps) {
    if (step.id === "buildContext" || step.id === "fixWithAI") continue;
    assert.deepEqual(step.actions, [], step.id);
  }
  for (const step of steps) assert.equal((step.actions as readonly string[]).includes("openFolder"), false);
  assert.equal(canOpenFolder([]), false);
  assert.equal(canOpenFolder(["issue.json"]), true);
});

// --- each row's result (Batch 6) --------------------------------------------

const ISSUE = { id: "JR-12345", source: "jira", title: "WidgetController rejects the VDS output type" };

test("Issue details says what it is doing, then what it read", () => {
  const pending = stepIn(buildWorkflow(input()), "issueDetails");
  assert.equal(pending.summary, "Fetch Jira issue information");

  const running = stepIn(
    buildWorkflow(input({ workItemId: "JR-12345", progress: progress("running", { issue_details: "running" }) })),
    "issueDetails",
  );
  assert.equal(running.summary, "Loading JR-12345…");
  const manualRunning = stepIn(
    buildWorkflow(input({ source: "manual", progress: progress("running", { issue_details: "running" }) })),
    "issueDetails",
  );
  assert.equal(manualRunning.summary, "Reading the description…");

  const jira = stepIn(
    buildWorkflow(input({ progress: progress("done", ALL_DONE), artifacts: ["issue.json"], issue: ISSUE })),
    "issueDetails",
  );
  assert.equal(jira.summary, "JR-12345 · Jira issue");
  assert.equal(jira.detail, "WidgetController rejects the VDS output type");
  assert.equal(jira.artifact, "issue.json");

  const manual = stepIn(
    buildWorkflow(
      input({
        source: "manual",
        progress: progress("done", ALL_DONE),
        artifacts: ["issue.json"],
        issue: { id: "local_1", source: "manual", title: "Crash after reload" },
      }),
    ),
    "issueDetails",
  );
  assert.equal(manual.summary, "Manual bug description");
  assert.equal(manual.detail, "Crash after reload");
});

test("an issue that could not be read finishes as Completed, not as a guess", () => {
  const row = stepIn(buildWorkflow(input({ progress: progress("done", ALL_DONE) })), "issueDetails");
  // Completed once, as the status; no second line repeating it (§37.86).
  assert.equal(row.statusText, "Completed");
  assert.equal(row.summary, "");
  assert.equal(row.detail, undefined);
  assert.equal(row.artifact, undefined);
});

test("a failed step carries the run's card; the rows before it keep their results", () => {
  const card = { kind: "run", title: "Run failed", message: "bugpilot stopped." } as const;
  const failed: ProgressView = {
    ...progress("failed", { issue_details: "done", code_search: "failed" }),
    failure: { code: "INTERNAL_ERROR", summary: "stopped", retryable: true, capability: "code_search" },
  };
  const steps = buildWorkflow(
    input({ progress: failed, runError: card, artifacts: ["issue.json"], issue: ISSUE }),
  );
  assert.equal(stepIn(steps, "codeSearch").status, "failed");
  assert.equal(stepIn(steps, "codeSearch").statusText, "Failed");
  assert.equal(stepIn(steps, "codeSearch").summary, "", "Failed said twice");
  assert.equal(stepIn(steps, "codeSearch").error, card);
  assert.equal(stepIn(steps, "issueDetails").summary, "JR-12345 · Jira issue");
  assert.equal(stepIn(steps, "issueDetails").statusText, "Completed");
  assert.equal(stepIn(steps, "issueDetails").error, undefined);
  // Exactly one row owns it.
  assert.equal(steps.filter((step) => step.error !== undefined).length, 1);
});

test("a failure no step owns lands on no row", () => {
  const card = { kind: "run", title: "Run failed", message: "bugpilot stopped." } as const;
  const failed: ProgressView = {
    ...progress("failed", {}),
    failure: { code: "INTERNAL_ERROR", summary: "stopped", retryable: true },
  };
  const steps = buildWorkflow(input({ progress: failed, runError: card }));
  assert.equal(steps.filter((step) => step.error !== undefined).length, 0);
});

const SEARCH = {
  relevantFiles: 6,
  searchTerms: 11,
  content: {
    files: [{ path: "src/widgets/WidgetController.cpp", name: "WidgetController.cpp", documentation: false, matched: ["WidgetController"] }],
    terms: [{ term: "WidgetController", broad: false, empty: false }],
  },
};

test("Code search reports its two numbers and owns the files and terms", () => {
  assert.equal(stepIn(buildWorkflow(input()), "codeSearch").summary, "Search relevant code in the repository");
  const running = stepIn(
    buildWorkflow(input({ progress: progress("running", { code_search: "running" }), search: SEARCH })),
    "codeSearch",
  );
  assert.equal(running.summary, "Searching repository…");
  // Mid-run, the last run's files are not this search's.
  assert.equal(running.search, undefined);

  const done = stepIn(
    buildWorkflow(input({ progress: progress("done", ALL_DONE), artifacts: ["retrieval.json"], search: SEARCH })),
    "codeSearch",
  );
  assert.equal(done.summary, "11 terms · 6 relevant files");
  assert.equal(done.artifact, "retrieval.json");
  assert.equal(done.search?.files.length, 1);
  assert.equal(done.search?.terms.length, 1);
});

test("a search with no relevant files says 0, and a missing retrieval says only Completed", () => {
  const none = stepIn(
    buildWorkflow(
      input({
        progress: progress("done", ALL_DONE),
        search: { relevantFiles: 0, searchTerms: 4, content: { files: [], terms: [{ term: "x", broad: false, empty: true }] } },
      }),
    ),
    "codeSearch",
  );
  assert.equal(none.summary, "4 terms · 0 relevant files");
  const missing = stepIn(buildWorkflow(input({ progress: progress("done", ALL_DONE) })), "codeSearch");
  assert.equal(missing.statusText, "Completed");
  assert.equal(missing.summary, "");
  assert.equal(missing.search, undefined);
  // A retrieval with neither list readable is the same "Completed".
  const empty = stepIn(
    buildWorkflow(input({ progress: progress("done", ALL_DONE), search: { content: { files: [], terms: [] } } })),
    "codeSearch",
  );
  assert.equal(empty.statusText, "Completed");
  assert.equal(empty.summary, "");
  assert.equal(empty.search, undefined);
});

test("Git history and Similar fixes report only what is known", () => {
  // Their results live inside context.md by design; no count is parsed out of
  // prose to decorate a row.
  for (const [id, capability, runningText] of [
    ["gitHistory", "git_history", "Collecting git history…"],
    ["similarFixes", "similar_fixes", "Searching past fixes…"],
  ] as const) {
    assert.equal(stepIn(buildWorkflow(input({ progress: progress("running", { [capability]: "running" }) })), id).summary, runningText);
    const done = stepIn(buildWorkflow(input({ progress: progress("done", ALL_DONE), artifacts: ["context.md"] })), id);
    // One Completed, as the status: no second line that only says it again.
    assert.equal(done.statusText, "Completed");
    assert.equal(done.summary, "");
    assert.equal(done.detail, undefined);
    assert.equal(done.artifact, undefined);
    assert.equal(done.search, undefined);
    const skipped = stepIn(buildWorkflow(input({ progress: progress("done", { [capability]: "skipped" }) })), id);
    assert.equal(skipped.statusText, "Skipped");
    assert.equal(skipped.summary, "");
  }
});

test("Build context says Context ready only with its file, and Building while it works", () => {
  assert.equal(
    stepIn(buildWorkflow(input({ progress: progress("running", { build_context: "running" }) })), "buildContext").summary,
    "Building context…",
  );
  const ready = stepIn(buildWorkflow(input({ progress: progress("done", ALL_DONE), artifacts: ["context.md"] })), "buildContext");
  // Context ready once — the status — with context.md and its two actions under it.
  assert.deepEqual([ready.statusText, ready.summary, ready.artifact], ["Context ready", "", "context.md"]);
  assert.deepEqual([...ready.actions], ["openContext", "copyContext"]);
  // Finished, but the file is gone: no claim about a context that is not there.
  const gone = stepIn(buildWorkflow(input({ progress: progress("done", ALL_DONE), artifacts: [] })), "buildContext");
  assert.deepEqual([gone.statusText, gone.summary], ["Completed", ""]);
});

test("Fix with AI waits, is ready, starts, starts successfully, or fails — and says which", () => {
  const prepared = { progress: progress("done", ALL_DONE), artifacts: ["context.md", "task.md"], strategy: "Standard Fix" };

  assert.equal(stepIn(buildWorkflow(input({ progress: progress("running", {}) })), "fixWithAI").summary, "Waiting for task…");

  const ready = stepIn(buildWorkflow(input(prepared)), "fixWithAI");
  assert.equal(ready.status, "ready");
  assert.equal(ready.statusText, "Ready");
  assert.equal(ready.summary, "");
  // No button of its own: handing over is the panel's primary action now.
  assert.deepEqual([...ready.actions], []);
  assert.equal(ready.artifact, "task.md");
  assert.equal(ready.strategy, "Standard Fix");

  const starting = stepIn(buildWorkflow(input({ ...prepared, handoffBusy: true })), "fixWithAI");
  assert.equal(starting.status, "running");
  assert.equal(starting.statusText, "Running");
  // What it is doing, which "Running" does not say.
  assert.equal(starting.summary, "Starting AI fix…");
  assert.deepEqual([...starting.actions], [], "a second press while resolving");

  const started = stepIn(
    buildWorkflow(input({ ...prepared, fix: { status: "success", detail: "Handed to my-agent in a terminal." } })),
    "fixWithAI",
  );
  assert.equal(started.status, "success");
  // Started, not Completed: the agent runs in a terminal nobody here watches.
  assert.equal(started.statusText, "Started");
  assert.equal(started.summary, "", "AI fix started said twice");
  assert.equal(started.detail, "Handed to my-agent in a terminal.");
  assert.deepEqual([...started.actions], [], "a second terminal for the same package");

  const card = { kind: "agent", title: "AI agent unavailable", message: "Install one." } as const;
  const failed = stepIn(
    buildWorkflow(
      input({ ...prepared, fix: { status: "skipped", detail: "claude is not on PATH." }, handoffError: card }),
    ),
    "fixWithAI",
  );
  assert.equal(failed.status, "failed");
  assert.equal(failed.statusText, "Failed");
  // The reason, which "Failed" does not say.
  assert.equal(failed.summary, "Did not start");
  assert.equal(failed.error, card);
  assert.equal(failed.detail, "claude is not on PATH.");
  // Another try is the primary action's, which stays Fix with AI.
  assert.deepEqual([...failed.actions], []);

  const skipped = stepIn(
    buildWorkflow(input({ progress: progress("done", ALL_DONE), fix: { status: "skipped", detail: "No task.md was prepared." } })),
    "fixWithAI",
  );
  assert.equal(skipped.status, "skipped");
  assert.equal(skipped.summary, "No task.md was prepared.");
});

test("a task on disk is not ready unless this run built it", () => {
  // A failed run, or one still going, cannot hand over a task it did not write.
  const failed = stepIn(
    buildWorkflow(input({ progress: progress("failed", { issue_details: "failed" }), artifacts: ["task.md", "context.md"] })),
    "fixWithAI",
  );
  assert.notEqual(failed.status, "ready");
  assert.deepEqual([...failed.actions], []);
  const running = stepIn(
    buildWorkflow(input({ progress: progress("running", ALL_DONE), artifacts: ["task.md", "context.md"] })),
    "fixWithAI",
  );
  assert.notEqual(running.status, "ready");
});

// --- the compact status -----------------------------------------------------

test("the header counts the step in flight against the steps chosen", () => {
  const chosen = input({ fixWithAI: true, progress: progress("running", { issue_details: "done" }) });
  const steps = buildWorkflow(chosen);
  assert.deepEqual(overallStatus(steps, chosen.progress), { kind: "running", text: "Running 2/6…" });

  // Unticking two makes it out of four, not out of six: the denominator is
  // what this run will actually do.
  const fewer = input({
    plan: { ...DEFAULT_FORM.plan, gitHistory: false, similarFixes: false },
    progress: progress("running", { issue_details: "done" }),
  });
  assert.match(overallStatus(buildWorkflow(fewer), fewer.progress).text, /2\/3…$/);
});

test("the first row reads 1 of n while it is visibly working", () => {
  // 0/6 next to a spinning first row is a contradiction.
  const starting = input({ progress: progress("running") });
  assert.equal(overallStatus(buildWorkflow(starting), starting.progress).text, "Running 1/5…");
});

test("a context-only run says the context is ready", () => {
  const done = input({ progress: progress("done", { build_context: "done" }) });
  assert.deepEqual(overallStatus(buildWorkflow(done), done.progress), {
    kind: "done",
    text: "Context ready",
  });
});

test("a handed-over run says the fix started, and never that it is complete", () => {
  // The agent runs in a terminal this extension does not own, so "Complete"
  // would be a claim about work it cannot see.
  const handed = input({
    fixWithAI: true,
    progress: progress("done", { build_context: "done" }),
    fix: { status: "success", detail: "Handed to Claude Code in a terminal." },
  });
  const status = overallStatus(buildWorkflow(handed), handed.progress);
  assert.deepEqual(status, { kind: "done", text: "AI fix started" });
  assert.equal(/complete/i.test(status.text), false);
});

test("a failure and a stop are told apart", () => {
  const failed = input({ progress: progress("failed", { issue_details: "failed" }) });
  assert.deepEqual(overallStatus(buildWorkflow(failed), failed.progress), {
    kind: "failed",
    text: "Run failed",
  });
  const stopped = input({ progress: progress("stopped") });
  // Not a failure: somebody pressed Stop, and calling that an error would be
  // reporting their own decision back to them as a problem.
  assert.deepEqual(overallStatus(buildWorkflow(stopped), stopped.progress), {
    kind: "idle",
    text: "Stopped",
  });
});

test("an AI step that could not start is not reported as a finished run", () => {
  const stalled = input({
    fixWithAI: true,
    progress: progress("done", { build_context: "done" }),
    fix: { status: "failed", detail: "my-agent is not on PATH." },
  });
  assert.deepEqual(overallStatus(buildWorkflow(stalled), stalled.progress), {
    kind: "failed",
    text: "AI fix did not start",
  });
});

// --- Fix result (Batch 8) ---------------------------------------------------

/** What a prepare leaves, and the same with the agent's report beside it. */
const PREPARED_FILES = ["issue.json", "retrieval.json", "context.md", "task.md", "run.json"];
const WITH_REPORT = [...PREPARED_FILES, "fix_report.md"];

const finished = (overrides: Partial<WorkflowInput> = {}) =>
  buildWorkflow(input({ progress: progress("done", ALL_DONE), artifacts: PREPARED_FILES, ...overrides }));

test("no report, no Fix result row: the prepare workflow is still six steps", () => {
  const steps = finished();
  assert.deepEqual(steps.map((step) => step.id), [...WORKFLOW_STEP_IDS]);
  assert.equal(steps.some((step) => step.id === "fixResult"), false);
});

test("a report on disk adds exactly one Fix result row, straight after Fix with AI", () => {
  const steps = finished({ artifacts: WITH_REPORT, fixReport: { readable: true, summary: "Fixed it." } });
  assert.deepEqual(steps.map((step) => step.id), [...WORKFLOW_STEP_IDS, "fixResult"]);
  assert.equal(steps.filter((step) => step.id === "fixResult").length, 1);
});

test("the row is the listing's to create, not the preview's", () => {
  // A preview with no file listed is a leftover, not a report.
  const steps = finished({ fixReport: { readable: true, summary: "Fixed it." } });
  assert.equal(steps.some((step) => step.id === "fixResult"), false);
});

test("Fix result is ready, never the green tick, whatever the report says", () => {
  // A report means there is something to read. An investigation, a no-op and
  // an attempt whose tests still fail all write the same file, and the row
  // says so in their words, in one and the same state.
  for (const [summary, tests] of [
    ["Fixed the output-type validation regression.", "24 passed."],
    ["Investigation complete; no source changes applied.", "Not run: investigation-only mode."],
    ["Attempted fix; validation still fails.", "pytest: 2 failed, 18 passed."],
    ["No code change was required.", "Not run: no code changed."],
  ] as const) {
    const row = stepIn(finished({ artifacts: WITH_REPORT, fixReport: { readable: true, summary, tests } }), "fixResult");
    assert.equal(row.status, "ready", summary);
    assert.equal(row.statusText, "Report available");
    assert.equal(row.summary, summary);
    assert.equal(row.detail, `Tests: ${tests}`);
    assert.equal(row.artifact, "fix_report.md");
    assert.deepEqual([...row.actions], ["openFixReport", "copyReviewPrompt", "reviewWithAI"]);
    assert.equal(row.error, undefined);
    assert.equal(row.enabled, true);
  }
});

test("a report with no Summary says only that it is there", () => {
  const row = stepIn(finished({ artifacts: WITH_REPORT, fixReport: { readable: true } }), "fixResult");
  // The status says it; a second line saying "Fix report available" would too.
  assert.equal(row.statusText, "Report available");
  assert.equal(row.summary, "");
  assert.equal(row.detail, undefined, "a Tests line was invented");
  assert.equal(row.artifact, "fix_report.md");
});

test("a report with a Summary and no Tests shows no Tests line", () => {
  const row = stepIn(finished({ artifacts: WITH_REPORT, fixReport: { readable: true, summary: "Fixed it." } }), "fixResult");
  assert.equal(row.detail, undefined);
});

test("a listed report that could not be read is still a report to open", () => {
  for (const fixReport of [{ readable: false }, undefined]) {
    const row = stepIn(finished({ artifacts: WITH_REPORT, ...(fixReport ? { fixReport } : {}) }), "fixResult");
    assert.equal(row.statusText, "Report available");
    assert.equal(row.summary, "");
    assert.equal(row.detail, "Preview unavailable");
    assert.equal(row.status, "ready");
    assert.deepEqual([...row.actions], ["openFixReport", "copyReviewPrompt", "reviewWithAI"]);
    assert.equal(row.error, undefined, "an unreadable preview became a failure");
  }
});

test("a listed report is a row while a run is in flight too", () => {
  // The rule is the file: listed, a row; not listed, none. Which listing a run
  // keeps is the controller's business (only a report known to survive).
  const running = progress("running", { issue_details: "done", code_search: "running" });
  const steps = buildWorkflow(input({ progress: running, artifacts: WITH_REPORT, fixReport: { readable: true, summary: "Fixed it." } }));
  assert.equal(stepIn(steps, "fixResult").summary, "Fixed it.");
  // It is a file, not a step: it adds nothing to the count, which is of the
  // chosen steps — five here, with Fix with AI unticked.
  const without = buildWorkflow(input({ progress: running, artifacts: PREPARED_FILES }));
  assert.equal(overallStatus(without, running).text, "Running 2/5…");
  assert.equal(overallStatus(steps, running).text, "Running 2/5…");
});

test("a report changes none of the five capability rows, and Fix with AI only says it is there", () => {
  const without = finished();
  const withReport = finished({ artifacts: WITH_REPORT, fixReport: { readable: true, summary: "Fixed it." } });
  assert.deepEqual(withReport.slice(0, 5), without.slice(0, 5));
  // An attempt this session did not see start wrote it: the row says a report is
  // available, which is all that is known — not started, not fixed, not the tick.
  const fix = stepIn(withReport, "fixWithAI");
  assert.deepEqual(
    { status: fix.status, statusText: fix.statusText, summary: fix.summary },
    { status: "ready", statusText: "Ready", summary: "Fix report available" },
  );
  assert.equal(fix.artifact, "task.md");
  assert.deepEqual([...fix.actions], []);
});

test("the header says a report is available, and never that the bug is fixed", () => {
  const report = { readable: true, summary: "Fixed it." };
  const withReport = finished({ artifacts: WITH_REPORT, fixReport: report });
  assert.deepEqual(overallStatus(withReport, progress("done", ALL_DONE)), { kind: "done", text: "Fix report available" });

  // A reopened work item with no run.json to read still has its report.
  const restored = buildWorkflow(input({ artifacts: WITH_REPORT, fixReport: report }));
  assert.deepEqual(overallStatus(restored, progress("idle")), { kind: "done", text: "Fix report available" });

  // Without a report the header is what it was.
  assert.deepEqual(overallStatus(finished(), progress("done", ALL_DONE)), { kind: "done", text: "Context ready" });
});

test("what this session saw of the handoff outranks the report; a run failure outranks both", () => {
  const report = { readable: true, summary: "Fixed it." };
  const started = finished({ artifacts: WITH_REPORT, fixReport: report, fix: { status: "success", detail: "Handed to Claude Code in a terminal." } });
  assert.equal(overallStatus(started, progress("done", ALL_DONE)).text, "AI fix started");

  const notStarted = finished({
    artifacts: WITH_REPORT,
    fixReport: report,
    fix: { status: "skipped", detail: "claude is not on PATH." },
    handoffError: { kind: "agent", title: "AI agent unavailable", message: "x" },
  });
  assert.equal(overallStatus(notStarted, progress("done", ALL_DONE)).text, "AI fix did not start");

  const failedRun = buildWorkflow(input({ progress: progress("failed", { issue_details: "failed" }), artifacts: WITH_REPORT, fixReport: report }));
  assert.equal(overallStatus(failedRun, progress("failed", { issue_details: "failed" })).text, "Run failed");
});

test("none of the header's words claim more than a report exists", () => {
  const steps = finished({ artifacts: WITH_REPORT, fixReport: { readable: true, summary: "Fixed it." } });
  const text = overallStatus(steps, progress("done", ALL_DONE)).text.toLowerCase();
  for (const claim of ["fixed", "complete", "verified", "resolved", "passed", "success"]) {
    assert.equal(text.includes(claim), false, claim);
  }
});

// --- which agent, and how -------------------------------------------------

const never = async () => false;
const always = async () => true;

test("auto takes the first known agent that is actually installed", async () => {
  const asked: string[] = [];
  const plan = await resolveAgent({
    choice: "auto",
    customCommand: "",
    prompt: "Read .ai/JR-1/task.md and complete the workflow.",
    canRun: async (command) => {
      asked.push(command);
      return true;
    },
  });

  assert.equal(plan.kind, "run");
  assert.deepEqual(asked, [KNOWN_AGENTS[0]!.command]);
  assert.equal(
    plan.kind === "run" ? plan.commandLine : "",
    'claude "Read .ai/JR-1/task.md and complete the workflow."',
  );
});

test("nothing installed produces a reason, never a command line", async () => {
  // The whole point of asking first: a terminal printing "command not found"
  // reads as a bug in this extension rather than as a missing tool.
  const plan = await resolveAgent({
    choice: "auto",
    customCommand: "",
    prompt: "x",
    canRun: never,
  });
  assert.equal(plan.kind, "unavailable");
  assert.match(plan.kind === "unavailable" ? plan.reason : "", /not on PATH|No AI coding agent/);
});

test("a named agent is not silently replaced by another one", async () => {
  const asked: string[] = [];
  await resolveAgent({
    choice: "claude",
    customCommand: "",
    prompt: "x",
    canRun: async (command) => {
      asked.push(command);
      return false;
    },
  });
  assert.deepEqual(asked, ["claude"], "only the chosen agent may be probed");
});

test("a custom command is substituted, quoted, and probed by its own program", async () => {
  const asked: string[] = [];
  const plan = await resolveAgent({
    choice: "custom",
    customCommand: `wsl my-agent --prompt ${PROMPT_PLACEHOLDER} --yes`,
    prompt: "Read .ai/JR-1/task.md and complete the workflow.",
    canRun: async (command) => {
      asked.push(command);
      return true;
    },
  });

  // Probed by the first word: `wsl claude ...` lives or dies by `wsl`.
  assert.deepEqual(asked, ["wsl"]);
  assert.equal(
    plan.kind === "run" ? plan.commandLine : "",
    'wsl my-agent --prompt "Read .ai/JR-1/task.md and complete the workflow." --yes',
  );
});

test("a prompt a shell could act on is refused before any agent is looked for, by every handoff", async () => {
  // The one gate Fix with AI and Review with AI share (§37.70): quotes, `$(…)`,
  // backticks and the rest never reach a command line, whichever agent is
  // chosen — refused, not escaped.
  for (const choice of ["auto", "claude", "custom"] as const) {
    for (const prompt of ['fix "the" thing', "Read .ai/x$(calc)/task.md and complete the workflow.", "Read `id`", "-rf now", ""]) {
      const asked: string[] = [];
      const plan = await resolveAgent({
        choice,
        customCommand: `my-agent ${PROMPT_PLACEHOLDER}`,
        prompt,
        canRun: async (command) => {
          asked.push(command);
          return true;
        },
      });
      assert.equal(plan.kind, "refused", `${choice}: ${JSON.stringify(prompt)}`);
      assert.deepEqual(asked, [], `${choice}: an agent was probed for a refused prompt`);
    }
  }
  // And both of today's prompts pass it.
  for (const prompt of ["Read .ai/JR-12345/task.md and complete the workflow.", "Read .ai/local_20260926010922/task.md and complete the workflow.", "# Final Review Request\n\nReview the BugPilot result for work item JR-12345.\n"]) {
    assert.equal(isPlainPrompt(prompt), true, prompt);
  }
});

test("a custom command without the placeholder is refused", async () => {
  // Running it would start an agent with no idea what to work on, which looks
  // like the agent ignoring us.
  const plan = await resolveAgent({
    choice: "custom",
    customCommand: "my-agent --resume",
    prompt: "x",
    canRun: always,
  });
  assert.equal(plan.kind, "unavailable");
  assert.match(plan.kind === "unavailable" ? plan.reason : "", /\{prompt\}/);
});

test("an empty custom command says what to do about it", async () => {
  const plan = await resolveAgent({
    choice: "custom",
    customCommand: "   ",
    prompt: "x",
    canRun: always,
  });
  assert.match(
    plan.kind === "unavailable" ? plan.reason : "",
    /Advanced Settings → Fix with AI/,
    "the reason has to name where the setting lives",
  );
});

test("a multi-line prompt becomes one line before it reaches a shell", async () => {
  // A raw newline inside a quoted argument is submitted as a second command,
  // which turns a handoff prompt into an accidental shell invocation.
  const plan = await resolveAgent({
    choice: "auto",
    customCommand: "",
    prompt: "Read the task.\n\n  Then fix it.\n",
    canRun: always,
  });
  const commandLine = plan.kind === "run" ? plan.commandLine : "";
  assert.equal(commandLine, 'claude "Read the task. Then fix it."');
  assert.equal(commandLine.includes("\n"), false);
});

// --- Review with AI on Fix result (Batch 10) --------------------------------

const reviewed = (review?: WorkflowInput["review"]) =>
  finished({ artifacts: WITH_REPORT, fixReport: { readable: true, summary: "Fixed it." }, ...(review ? { review } : {}) });

test("Review with AI is offered with any report, again after a failure, and not while one starts or once one started", () => {
  const error = { kind: "agent" as const, title: "AI review did not start", message: "No agent." };
  for (const [review, offered] of [
    [undefined, true],
    [{ state: "failed", error }, true],
    [{ state: "starting" }, false],
    [{ state: "started", agent: "Claude Code" }, false],
  ] as const) {
    const row = stepIn(reviewed(review), "fixResult");
    assert.equal(row.actions.includes("reviewWithAI"), offered, JSON.stringify(review));
    // Third, after reading the report and copying its prompt.
    assert.deepEqual(row.actions.slice(0, 2), ["openFixReport", "copyReviewPrompt"]);
  }
});

test("the row carries the review handoff in its own words, and says started — nothing more", () => {
  assert.equal(stepIn(reviewed(), "fixResult").review, undefined);
  assert.deepEqual(stepIn(reviewed({ state: "starting" }), "fixResult").review, { state: "starting" });
  assert.deepEqual(stepIn(reviewed({ state: "started", agent: "Codex" }), "fixResult").review, {
    state: "started",
    summary: "AI review started",
    detail: "Handed to Codex in a terminal.",
    next: REVIEW_NEXT_STEP,
  });
  const error = { kind: "agent" as const, title: "AI review did not start", message: "No agent." };
  const failed = stepIn(reviewed({ state: "failed", error }), "fixResult");
  assert.deepEqual(failed.review, { state: "failed", error });
  // The review's card is the review's: never the row's own failure.
  assert.equal(failed.error, undefined);
  assert.equal(failed.status, "ready");
  assert.equal(failed.summary, "Fixed it.");
});

test("a review handoff moves neither Fix with AI nor the workflow header", () => {
  const plain = reviewed();
  const error = { kind: "agent" as const, title: "AI review did not start", message: "No agent." };
  for (const review of [{ state: "starting" }, { state: "started", agent: "Claude Code" }, { state: "failed", error }] as const) {
    const steps = reviewed(review);
    assert.deepEqual(stepIn(steps, "fixWithAI"), stepIn(plain, "fixWithAI"), review.state);
    assert.deepEqual(overallStatus(steps, progress("done", ALL_DONE)), { kind: "done", text: "Fix report available" });
  }
});

// --- Batch 11: Review Result on Fix result ---------------------------------------

const WITH_REVIEW = [...WITH_REPORT, "review_report.md"];
const REVIEWED = {
  readable: true,
  summary: "The change reads correctly.",
  findings: "One duplicate null check.",
  validationNotes: false,
  recommendations: true,
} as const;

test("no review_report.md, no Review Result", () => {
  const row = stepIn(finished({ artifacts: WITH_REPORT, reviewReport: REVIEWED }), "fixResult");
  assert.equal(row.reviewResult, undefined, "a preview with no file listed became a Review Result");
});

test("a listed review is exactly one Review Result, in the report's own words", () => {
  const steps = finished({ artifacts: WITH_REVIEW, reviewReport: REVIEWED });
  // No row of its own: the workflow is still the six steps and Fix result.
  assert.deepEqual(steps.map((step) => step.id), [...WORKFLOW_STEP_IDS, "fixResult"]);
  assert.deepEqual(stepIn(steps, "fixResult").reviewResult, {
    status: "Review result saved",
    artifact: "review_report.md",
    summary: "The change reads correctly.",
    detail: "Findings: One duplicate null check.",
    alsoRecorded: "Also recorded: recommendations",
  });
});

test("a review with no Summary leads with its findings, and an unreadable one only says it is there", () => {
  const findingsOnly = stepIn(
    finished({ artifacts: WITH_REVIEW, reviewReport: { readable: true, findings: "Only this.", validationNotes: false, recommendations: false } }),
    "fixResult",
  ).reviewResult!;
  assert.equal(findingsOnly.summary, "Only this.");
  assert.equal(findingsOnly.detail, undefined);
  assert.equal(findingsOnly.alsoRecorded, undefined);
  for (const reviewReport of [{ readable: false, validationNotes: false, recommendations: false }, undefined]) {
    const view = stepIn(finished({ artifacts: WITH_REVIEW, ...(reviewReport ? { reviewReport } : {}) }), "fixResult").reviewResult!;
    assert.equal(view.summary, "Review result saved");
    assert.equal(view.detail, "Preview unavailable");
  }
});

test("Record, Open and Replace follow the file and the host's say-so", () => {
  const actions = (overrides: Partial<WorkflowInput>) => [...stepIn(finished(overrides), "fixResult").actions];
  assert.deepEqual(actions({ artifacts: WITH_REPORT, canRecordReview: true }), [
    "openFixReport", "copyReviewPrompt", "reviewWithAI", "pasteReviewOutput", "recordReviewResult",
  ]);
  assert.deepEqual(actions({ artifacts: WITH_REVIEW, reviewReport: REVIEWED, canRecordReview: true }), [
    "openFixReport", "copyReviewPrompt", "reviewWithAI", "openReviewReport", "pasteReviewOutput", "replaceReviewResult",
  ]);
  // A run or a recording in flight: nothing to record, but the file still opens.
  assert.deepEqual(actions({ artifacts: WITH_REVIEW, reviewReport: REVIEWED, canRecordReview: false }), [
    "openFixReport", "copyReviewPrompt", "reviewWithAI", "openReviewReport",
  ]);
});

test("a recorded review changes nothing Fix result or the header says about the fix", () => {
  const without = finished({ artifacts: WITH_REPORT, fixReport: { readable: true, summary: "Fixed it.", tests: "3 passed." } });
  const withReview = finished({
    artifacts: WITH_REVIEW,
    fixReport: { readable: true, summary: "Fixed it.", tests: "3 passed." },
    reviewReport: REVIEWED,
  });
  const row = stepIn(withReview, "fixResult");
  const before = stepIn(without, "fixResult");
  assert.deepEqual(
    [row.status, row.statusText, row.summary, row.detail, row.artifact, row.error],
    [before.status, before.statusText, before.summary, before.detail, before.artifact, before.error],
  );
  const doneProgress = progress("done", ALL_DONE);
  assert.deepEqual(overallStatus(withReview, doneProgress), overallStatus(without, doneProgress));
});

test("a recording's state rides on Fix result, and says nothing about the review", () => {
  const recording = stepIn(finished({ artifacts: WITH_REPORT, reviewCapture: { state: "recording" } }), "fixResult");
  assert.deepEqual(recording.reviewCapture, { state: "recording" });
  const failed = stepIn(
    finished({ artifacts: WITH_REPORT, reviewCapture: { state: "failed", message: "Review result was not recorded: x" } }),
    "fixResult",
  );
  assert.equal(failed.error, undefined, "a recording failure became the row's failure");
  assert.equal(failed.status, "ready");
});

test("nothing on Review Result claims a review passed, finished or verified anything", () => {
  const view = stepIn(finished({ artifacts: WITH_REVIEW, reviewReport: { readable: false, validationNotes: false, recommendations: false } }), "fixResult").reviewResult!;
  const words = JSON.stringify(view).toLowerCase();
  for (const claim of ["passed", "verified", "approved", "complete", "reviewed"]) {
    assert.equal(words.includes(claim), false, claim);
  }
});

// --- Batch 12: Verification Evidence on Fix result --------------------------------

const WITH_EVIDENCE = [...WITH_REPORT, "verification_report.md"];
const EVIDENCE = {
  readable: true,
  passed: 2,
  failed: 0,
  notRun: 1,
  preview: [
    { name: "Unit tests", status: "passed", type: "automated" },
    { name: "Soak", status: "not_run", type: "other" },
    { name: "Hand-edited" },
  ],
  more: 6,
} as const;

test("no verification_report.md, no Verification Evidence", () => {
  const row = stepIn(finished({ artifacts: WITH_REPORT, verificationReport: EVIDENCE }), "fixResult");
  assert.equal(row.verificationResult, undefined, "a preview with no file listed became evidence");
});

test("listed evidence is counts, the scoped phrase, five checks and how many more — no new row", () => {
  const steps = finished({ artifacts: WITH_EVIDENCE, verificationReport: EVIDENCE });
  assert.deepEqual(steps.map((step) => step.id), [...WORKFLOW_STEP_IDS, "fixResult"]);
  assert.deepEqual(stepIn(steps, "fixResult").verificationResult, {
    artifact: "verification_report.md",
    counts: "Recorded checks: 2 passed, 1 not run",
    overall: "Recorded checks have mixed or incomplete status.",
    checks: [
      { name: "Unit tests", status: "Passed", type: "Automated" },
      { name: "Soak", status: "Not Run", type: "Other" },
      { name: "Hand-edited", status: "Status not recorded" },
    ],
    more: "+6 more in verification_report.md",
  });
});

test("unreadable evidence, or evidence with no recorded status, only says it is there", () => {
  for (const verificationReport of [
    { readable: false, passed: 0, failed: 0, notRun: 0, preview: [], more: 0 },
    { readable: true, passed: 0, failed: 0, notRun: 0, preview: [{ name: "x" }], more: 0 },
    undefined,
  ]) {
    const view = stepIn(
      finished({ artifacts: WITH_EVIDENCE, ...(verificationReport ? { verificationReport } : {}) }),
      "fixResult",
    ).verificationResult!;
    assert.deepEqual(view, { artifact: "verification_report.md", counts: "Recorded checks: preview unavailable", checks: [] });
  }
});

test("Record, Open and Edit follow the file and the host's say-so, after Review Result's", () => {
  const actions = (overrides: Partial<WorkflowInput>) => [...stepIn(finished(overrides), "fixResult").actions];
  assert.deepEqual(actions({ artifacts: WITH_REPORT, canRecordReview: true, canRecordVerification: true }), [
    "openFixReport", "copyReviewPrompt", "reviewWithAI", "pasteReviewOutput", "recordReviewResult", "recordVerification",
  ]);
  assert.deepEqual(
    actions({ artifacts: [...WITH_EVIDENCE, "review_report.md"], verificationReport: EVIDENCE, canRecordReview: true, canRecordVerification: true }),
    ["openFixReport", "copyReviewPrompt", "reviewWithAI", "openReviewReport", "pasteReviewOutput", "replaceReviewResult", "openVerificationReport", "editVerification"],
  );
  // A run or an artifact write in flight: nothing to record or edit, but the file still opens.
  assert.deepEqual(actions({ artifacts: WITH_EVIDENCE, verificationReport: EVIDENCE, canRecordVerification: false }), [
    "openFixReport", "copyReviewPrompt", "reviewWithAI", "openVerificationReport",
  ]);
});

test("recorded evidence changes nothing Fix result or the header says about the fix", () => {
  const fixReport = { readable: true, summary: "Fixed it.", tests: "3 passed." };
  const without = finished({ artifacts: WITH_REPORT, fixReport });
  const withEvidence = finished({ artifacts: WITH_EVIDENCE, fixReport, verificationReport: { ...EVIDENCE, passed: 3, notRun: 0 } });
  const strip = (row: WorkflowStepResult) => {
    const { actions: _actions, verificationResult: _result, ...rest } = row;
    return rest;
  };
  assert.deepEqual(strip(stepIn(withEvidence, "fixResult")), strip(stepIn(without, "fixResult")));
  assert.deepEqual(overallStatus(withEvidence, progress("done", ALL_DONE)), overallStatus(without, progress("done", ALL_DONE)));
  assert.equal(stepIn(withEvidence, "fixResult").status, "ready");
  // Every check recorded as Passed is said as exactly that, scoped — never a verdict on the fix.
  const said = JSON.stringify(withEvidence);
  assert.ok(said.includes("All recorded checks passed."));
  for (const verdict of ["verified", "Verified", "safe to merge", "Approved", "Fix is correct"]) {
    assert.equal(said.includes(verdict), false, verdict);
  }
});

test("a pasted review's answer rides on Fix result once, and changes nothing else it says", () => {
  const fixReport = { readable: true, summary: "Fixed it.", tests: "3 passed." };
  const entry = { summary: "PASS, approved.", findings: "", validationNotes: "Read the diff.", recommendations: "" };
  const without = finished({ artifacts: WITH_REPORT, fixReport, canRecordReview: true });
  const prefilled = finished({ artifacts: WITH_REPORT, fixReport, canRecordReview: true, reviewPrefill: { token: 3, entry } });
  const row = stepIn(prefilled, "fixResult");
  assert.deepEqual(row.reviewPrefill, { token: 3, entry });
  const { reviewPrefill: _prefill, ...rest } = row;
  assert.deepEqual(rest, stepIn(without, "fixResult"), "a prefill changed the row");
  assert.equal(row.reviewResult, undefined, "a pasted review is not a saved one");
  assert.deepEqual(overallStatus(prefilled, progress("done", ALL_DONE)), overallStatus(without, progress("done", ALL_DONE)));
  // Offered only on the host's say-so, like Add Review Result.
  const busy = stepIn(finished({ artifacts: WITH_REPORT, fixReport, canRecordReview: false }), "fixResult");
  assert.equal(busy.actions.includes("pasteReviewOutput"), false);
});

test("Review with AI is offered once per fix: hidden once an attempt started, whatever became of it", () => {
  const fixReport = { readable: true, summary: "Fixed it.", tests: "3 passed." };
  const offers = (overrides: Partial<WorkflowInput>) =>
    stepIn(finished({ artifacts: WITH_REPORT, fixReport, canRecordReview: true, ...overrides }), "fixResult").actions.includes("reviewWithAI");
  const error = { kind: "agent" as const, title: "AI review did not start", message: "No agent." };
  // A new fix, never reviewed: offered; a launch that failed: offered again.
  assert.equal(offers({}), true);
  assert.equal(offers({ review: { state: "failed", error } }), true);
  // Starting, reviewing, handed to a terminal, captured, a capture with no draft: not.
  for (const review of [
    { state: "starting" },
    { state: "reviewing", agent: "Claude Code", startedAt: 1_000 },
    { state: "started", agent: "Claude Code" },
    { state: "captured", agent: "Claude Code" },
    { state: "captureFailed", agent: "Claude Code", title: "t", detail: "d" },
  ] as const) {
    assert.equal(offers({ review, reviewedCurrentFix: true }), false, review.state);
  }
  // An earlier session's attempt for this fix: not, and the row says why.
  assert.equal(offers({ reviewedCurrentFix: true }), false);
  const earlier = stepIn(finished({ artifacts: WITH_REPORT, fixReport, reviewedCurrentFix: true }), "fixResult").review;
  assert.equal(earlier?.state, "earlier");
  assert.equal((earlier as { summary: string }).summary, "AI review already started for this fix");
  // Once a review is saved, the earlier-attempt line points at nothing it cannot offer.
  const saved = stepIn(
    finished({ artifacts: [...WITH_REPORT, "review_report.md"], fixReport, reviewedCurrentFix: true }),
    "fixResult",
  ).review as { state: string; next?: string };
  assert.equal(saved.state, "earlier");
  assert.equal(saved.next, undefined);
  const failedSaved = stepIn(
    finished({
      artifacts: [...WITH_REPORT, "review_report.md"],
      fixReport,
      reviewedCurrentFix: true,
      review: { state: "captureFailed", agent: "Claude Code", title: "t", detail: "d" },
    }),
    "fixResult",
  ).review as { next?: string };
  assert.match(failedSaved.next ?? "", /Replace Review Result/);
  // No report, no button, however the flag reads.
  assert.equal(stepIn(finished({ artifacts: PREPARED_FILES }), "fixResult"), undefined);
});

test("the captured review's words: Reviewing…, finished, or a capture that gave no draft — never a verdict", () => {
  const fixReport = { readable: true, summary: "Fixed it.", tests: "3 passed." };
  const view = (review: NonNullable<WorkflowInput["review"]>) =>
    stepIn(finished({ artifacts: WITH_REPORT, fixReport, review, reviewedCurrentFix: true }), "fixResult").review as {
      state: string;
      summary: string;
      detail: string;
      next?: string;
      reply?: string;
    };
  assert.equal(view({ state: "reviewing", agent: "Claude Code", startedAt: 1_000 }).summary, "Reviewing with Claude Code…");
  // Only a name the host resolved: none, and it is the AI.
  assert.equal(view({ state: "reviewing", agent: "", startedAt: 1_000 }).summary, "Reviewing with AI…");
  assert.equal(view({ state: "captured", agent: "Claude Code" }).summary, "AI review finished");
  // "Check it, then save it" only while the reply is still a draft; saved or discarded, just captured.
  assert.equal(view({ state: "captured", agent: "Claude Code" }).detail, "Claude Code's reply was captured.");
  const drafted = stepIn(
    finished({
      artifacts: WITH_REPORT,
      fixReport,
      review: { state: "captured", agent: "Claude Code" },
      reviewedCurrentFix: true,
      reviewPrefill: { token: 1, entry: { summary: "A.", findings: "", validationNotes: "", recommendations: "" }, source: "ai" },
    }),
    "fixResult",
  ).review as { detail: string };
  assert.match(drafted.detail, /Check it, then save it\.$/);
  const failed = view({ state: "captureFailed", agent: "Claude Code", title: "Review result could not be captured automatically.", detail: "Missing ## Findings." });
  assert.equal(failed.summary, "Review result could not be captured automatically.");
  assert.match(failed.next ?? "", /Paste Review Output/);
  const withReply = view({ state: "captureFailed", agent: "Claude Code", title: "t", detail: "d", reply: "## Summary" });
  assert.equal(withReply.reply, "## Summary");
  assert.match(withReply.next ?? "", /The reply is in Paste Review Output/);
  const said = JSON.stringify([failed, withReply, view({ state: "captured", agent: "Claude Code" })]);
  for (const verdict of ["Passed", "Approved", "Verified", "safe to merge", "Review failed", "Rejected"]) {
    assert.equal(said.includes(verdict), false, verdict);
  }
});

// --- one status per row (§37.86) --------------------------------------------

test("every row states its status once: the status words never reappear as its second line", () => {
  const words = ["Completed", "Skipped", "Running", "Failed", "Context ready", "Ready", "Started", "Report available"];
  const cases = [
    input(),
    input({ progress: progress("running", { issue_details: "done", code_search: "running" }) }),
    input({ progress: progress("done", ALL_DONE), artifacts: ["context.md", "task.md"] }),
    input({ progress: progress("done", { ...ALL_DONE, code_search: "skipped" }), artifacts: ["context.md"] }),
    input({ progress: progress("failed", { issue_details: "done", code_search: "failed" }) }),
    input({ progress: progress("done", ALL_DONE), artifacts: ["context.md", "task.md"], fix: { status: "success", detail: "Handed to my-agent in a terminal." } }),
    input({ progress: progress("done", ALL_DONE), artifacts: WITH_REPORT, fixReport: { readable: true } }),
  ];
  for (const [index, each] of cases.entries()) {
    for (const row of buildWorkflow(each)) {
      assert.ok(!words.includes(row.summary), `case ${index}: ${row.id} says "${row.summary}" twice`);
      assert.ok(row.statusText === "" || words.includes(row.statusText), `case ${index}: ${row.id} "${row.statusText}"`);
      // A step that has not started has no status to state.
      if (row.status === "idle") assert.equal(row.statusText, "", `case ${index}: ${row.id}`);
    }
  }
});

test("a pending row keeps its description as its only line, and states no status", () => {
  for (const row of buildWorkflow(input())) {
    if (row.id === "fixResult") continue;
    assert.equal(row.statusText, "");
    assert.equal(row.summary, row.description, row.id);
  }
});

test("the statuses are the concise ones — no global verdict among them", () => {
  const done = buildWorkflow(input({ progress: progress("done", ALL_DONE), artifacts: WITH_REPORT, fixReport: { readable: true, summary: "Fixed it." } }));
  const said = done.map((row) => row.statusText).join(" ");
  for (const verdict of ["Success", "Successful", "Passed", "Verified", "Approved", "Done"]) {
    assert.equal(said.includes(verdict), false, verdict);
  }
});
