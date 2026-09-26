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

import { buildWorkflow, canOpenFolder, overallStatus, stepDescription, WORKFLOW_STEP_IDS } from "../src/app/workflow.ts";
import type { WorkflowInput } from "../src/app/workflow.ts";
import { resolveAgent, KNOWN_AGENTS, PROMPT_PLACEHOLDER } from "../src/app/agents.ts";
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
  assert.equal(row.summary, "Completed");
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
  assert.equal(stepIn(steps, "codeSearch").summary, "Failed");
  assert.equal(stepIn(steps, "codeSearch").error, card);
  assert.equal(stepIn(steps, "issueDetails").summary, "JR-12345 · Jira issue");
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
  assert.equal(missing.summary, "Completed");
  assert.equal(missing.search, undefined);
  // A retrieval with neither list readable is the same "Completed".
  const empty = stepIn(
    buildWorkflow(input({ progress: progress("done", ALL_DONE), search: { content: { files: [], terms: [] } } })),
    "codeSearch",
  );
  assert.equal(empty.summary, "Completed");
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
    assert.equal(done.summary, "Completed");
    assert.equal(done.detail, undefined);
    assert.equal(done.artifact, undefined);
    assert.equal(done.search, undefined);
    const skipped = stepIn(buildWorkflow(input({ progress: progress("done", { [capability]: "skipped" }) })), id);
    assert.equal(skipped.summary, "Skipped");
  }
});

test("Build context says Context ready only with its file, and Building while it works", () => {
  assert.equal(
    stepIn(buildWorkflow(input({ progress: progress("running", { build_context: "running" }) })), "buildContext").summary,
    "Building context…",
  );
  assert.equal(
    stepIn(buildWorkflow(input({ progress: progress("done", ALL_DONE), artifacts: ["context.md"] })), "buildContext").summary,
    "Context ready",
  );
  // Finished, but the file is gone: no claim about a context that is not there.
  assert.equal(
    stepIn(buildWorkflow(input({ progress: progress("done", ALL_DONE), artifacts: [] })), "buildContext").summary,
    "Completed",
  );
});

test("Fix with AI waits, is ready, starts, starts successfully, or fails — and says which", () => {
  const prepared = { progress: progress("done", ALL_DONE), artifacts: ["context.md", "task.md"], strategy: "Standard Fix" };

  assert.equal(stepIn(buildWorkflow(input({ progress: progress("running", {}) })), "fixWithAI").summary, "Waiting for task…");

  const ready = stepIn(buildWorkflow(input(prepared)), "fixWithAI");
  assert.equal(ready.status, "ready");
  assert.equal(ready.summary, "Ready");
  assert.deepEqual([...ready.actions], ["fixWithAI"]);
  assert.equal(ready.artifact, "task.md");
  assert.equal(ready.strategy, "Standard Fix");

  const starting = stepIn(buildWorkflow(input({ ...prepared, handoffBusy: true })), "fixWithAI");
  assert.equal(starting.status, "running");
  assert.equal(starting.summary, "Starting AI fix…");
  assert.deepEqual([...starting.actions], [], "a second press while resolving");

  const started = stepIn(
    buildWorkflow(input({ ...prepared, fix: { status: "success", detail: "Handed to my-agent in a terminal." } })),
    "fixWithAI",
  );
  assert.equal(started.status, "success");
  assert.equal(started.summary, "AI fix started");
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
  assert.equal(failed.summary, "Did not start");
  assert.equal(failed.error, card);
  assert.equal(failed.detail, "claude is not on PATH.");
  assert.deepEqual([...failed.actions], ["fixWithAI"], "the retry button went away");

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
    assert.equal(row.statusLabel, "report available");
    assert.equal(row.summary, summary);
    assert.equal(row.detail, `Tests: ${tests}`);
    assert.equal(row.artifact, "fix_report.md");
    assert.deepEqual([...row.actions], ["openFixReport"]);
    assert.equal(row.error, undefined);
    assert.equal(row.enabled, true);
  }
});

test("a report with no Summary says only that it is there", () => {
  const row = stepIn(finished({ artifacts: WITH_REPORT, fixReport: { readable: true } }), "fixResult");
  assert.equal(row.summary, "Fix report available");
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
    assert.equal(row.summary, "Fix report available");
    assert.equal(row.detail, "Preview unavailable");
    assert.equal(row.status, "ready");
    assert.deepEqual([...row.actions], ["openFixReport"]);
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

test("a report does not change any of the six rows", () => {
  const without = finished();
  const withReport = finished({ artifacts: WITH_REPORT, fixReport: { readable: true, summary: "Fixed it." } });
  assert.deepEqual(withReport.slice(0, 6), without);
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
    prompt: 'fix "the" thing',
    canRun: async (command) => {
      asked.push(command);
      return true;
    },
  });

  // Probed by the first word: `wsl claude ...` lives or dies by `wsl`.
  assert.deepEqual(asked, ["wsl"]);
  assert.equal(
    plan.kind === "run" ? plan.commandLine : "",
    'wsl my-agent --prompt "fix \\"the\\" thing" --yes',
  );
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
    /Advanced settings/,
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
