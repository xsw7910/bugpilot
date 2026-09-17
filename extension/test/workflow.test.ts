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

import { buildWorkflow, overallStatus, stepDescription, WORKFLOW_STEP_IDS } from "../src/app/workflow.ts";
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

test("each icon appears only when the file it opens is there", () => {
  // Keyed off the files rather than off a step event, so a run that stopped
  // after writing one of them offers exactly one icon.
  const partial = buildWorkflow(input({ artifacts: ["agent_task.md"] }));
  assert.deepEqual(partial.find((step) => step.id === "buildContext")?.actions, [
    "copyHandoff",
    "openFolder",
  ]);

  const complete = buildWorkflow(input({ artifacts: ["agent_task.md", "bug_context.md"] }));
  assert.deepEqual(complete.find((step) => step.id === "buildContext")?.actions, [
    "openContext",
    "copyHandoff",
    "openFolder",
  ]);
});

test("no files means no icons, and no other row ever has any", () => {
  for (const step of buildWorkflow(input())) assert.deepEqual(step.actions, [], step.id);
  const steps = buildWorkflow(input({ artifacts: ["agent_task.md", "bug_context.md"] }));
  for (const step of steps.filter((entry) => entry.id !== "buildContext")) {
    assert.deepEqual(step.actions, [], step.id);
  }
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

// --- which agent, and how -------------------------------------------------

const never = async () => false;
const always = async () => true;

test("auto takes the first known agent that is actually installed", async () => {
  const asked: string[] = [];
  const plan = await resolveAgent({
    choice: "auto",
    customCommand: "",
    prompt: "Read .ai/JR-1/agent_task.md and complete the workflow.",
    canRun: async (command) => {
      asked.push(command);
      return true;
    },
  });

  assert.equal(plan.kind, "run");
  assert.deepEqual(asked, [KNOWN_AGENTS[0]!.command]);
  assert.equal(
    plan.kind === "run" ? plan.commandLine : "",
    'claude "Read .ai/JR-1/agent_task.md and complete the workflow."',
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
