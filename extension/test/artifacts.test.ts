import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  GROUP_ORDER,
  RESULT_FILES,
  artifactGroup,
  artifactKind,
  buildArtifactList,
  describeAge,
  historyFromPayload,
  historyOutcome,
  historyRow,
  OUTCOME_ICONS,
} from "../src/app/artifacts.ts";
import type { ArtifactList } from "../src/app/artifacts.ts";

/** The exact directory a prepare-only run leaves behind: the five-artifact contract. */
const REAL_RUN = [
  "task.md",
  "context.md",
  "issue.json",
  "retrieval.json",
  "run.json",
];

function sectionsOf(list: ArtifactList) {
  assert.equal(list.kind, "ready");
  return list.kind === "ready" ? list.sections : [];
}

test("the result files match the ones bugpilot requires", () => {
  // A result file added in Python but not here would stop being reported as
  // missing, which is the one thing this list is for.
  const source = readFileSync(new URL("../../bugpilot/core/workflow.py", import.meta.url), "utf8");
  const block = /REQUIRED_COPILOT_RESULT_FILES = \[([\s\S]*?)\]/.exec(source);
  assert.ok(block, "could not find REQUIRED_COPILOT_RESULT_FILES in workflow.py");
  // The Python list names artifact constants; resolve them from artifacts.py.
  const artifacts = readFileSync(new URL("../../bugpilot/core/artifacts.py", import.meta.url), "utf8");
  const fixReport = /^FIX_REPORT_ARTIFACT = "([^"]+)"/m.exec(artifacts);
  assert.ok(fixReport, "could not find FIX_REPORT_ARTIFACT in artifacts.py");
  const python = [...block[1]!.matchAll(/"([^"]+)"|FIX_REPORT_ARTIFACT/g)].map(
    (match) => match[1] ?? fixReport[1]!,
  );
  assert.deepEqual([...RESULT_FILES].sort(), python.sort());
});

test("the handoff file comes first, and run state comes last", () => {
  // task.md is what the Run button was for; an alphabetical listing puts
  // three files nobody opens above it.
  const sections = sectionsOf(buildArtifactList({ names: REAL_RUN }));
  assert.equal(sections[0]?.group, "handoff");
  assert.equal(sections[0]?.entries[0]?.name, "task.md");
  assert.equal(sections.at(-1)?.group, "state");
  // Sections keep the declared order regardless of what the run produced.
  const order = sections.map((section) => section.group);
  assert.deepEqual(
    order,
    GROUP_ORDER.filter((group) => order.includes(group)),
  );
});

test("missing result files are listed as missing once a handoff exists", () => {
  const sections = sectionsOf(buildArtifactList({ names: REAL_RUN }));
  const results = sections.find((section) => section.group === "results");
  assert.ok(results, "expected a results section");
  assert.deepEqual(
    results.entries.map((entry) => entry.name).sort(),
    [...RESULT_FILES].sort(),
  );
  assert.equal(
    results.entries.every((entry) => entry.missing === true),
    true,
  );
});

test("a run with no handoff does not invent five missing results", () => {
  // --only-issue-details produces no task.md, so there was never anything
  // to hand over; five red rows would be noise.
  const list = buildArtifactList({ names: ["issue.json", "run.json"] });
  assert.equal(
    sectionsOf(list).some((section) => section.group === "results"),
    false,
  );
});

test("a written report is shown as present instead of missing", () => {
  const sections = sectionsOf(buildArtifactList({ names: [...REAL_RUN, "fix_report.md"] }));
  const results = sections.find((section) => section.group === "results");
  assert.equal(results?.entries[0]?.name, "fix_report.md");
  assert.equal(results?.entries[0]?.missing, undefined);
});

test("an empty directory is an empty state, not an error", () => {
  const list = buildArtifactList({ names: [] });
  assert.equal(list.kind, "empty");
  assert.match(list.kind === "empty" ? list.detail : "", /Run BugPilot/);
});

test("an unknown file is grouped where it stays visible", () => {
  // Hiding a file bugpilot started writing is worse than putting it in the
  // wrong section; the section it lands in is the one people read.
  assert.equal(artifactGroup("something_new.md"), "context");
  assert.equal(artifactGroup("run.json"), "state");
  // Phase-era runtime files from a directory prepared before run.json.
  assert.equal(artifactGroup("workflow_status.json"), "state");
  assert.equal(artifactGroup("execution.log"), "state");
  assert.equal(artifactGroup("user_feedback.md"), "retry");
  assert.equal(artifactGroup("fix_report.md"), "results");
  // Agent results from a pre-Batch-5 directory still land in Results.
  assert.equal(artifactGroup("fix_summary.md"), "results");
  assert.equal(artifactGroup("result_summary.md"), "results");
});

test("file kinds drive the icon and the open action", () => {
  assert.equal(artifactKind("context.md"), "markdown");
  assert.equal(artifactKind("retrieval.json"), "json");
  assert.equal(artifactKind("execution.log"), "log");
  assert.equal(artifactKind("noext"), "other");
});

test("duplicate names collapse", () => {
  const sections = sectionsOf(buildArtifactList({ names: ["context.md", "context.md"] }));
  assert.equal(sections[0]?.entries.length, 1);
});

// --- history ---------------------------------------------------------------

const LIST_PAYLOAD = {
  schema_version: 1,
  ok: true,
  command: "list",
  work_items: [
    { work_item_id: "JR-34567", source: "jira", title: "Save crash", prepared: true },
    { work_item_id: "local_20260904160612", source: "manual", title: "Save crash", prepared: true },
    { work_item_id: "JR-1", source: null, title: null, prepared: false },
  ],
};

test("history is built from list --json, newest first", () => {
  const times: Record<string, number> = {
    "JR-34567": 100,
    local_20260904160612: 300,
    "JR-1": 200,
  };
  const list = historyFromPayload(LIST_PAYLOAD, (id) => times[id]);
  assert.equal(list.kind, "ready");
  if (list.kind !== "ready") return;
  assert.deepEqual(
    list.items.map((item) => item.workItemId),
    ["local_20260904160612", "JR-1", "JR-34567"],
  );
});

test("with no timestamps the order is stable rather than arbitrary", () => {
  const list = historyFromPayload(LIST_PAYLOAD);
  assert.equal(list.kind, "ready");
  if (list.kind !== "ready") return;
  // Descending by id: local ids embed their timestamp, so this is still roughly
  // chronological, and it never reorders between two renders.
  assert.deepEqual(
    list.items.map((item) => item.workItemId),
    ["local_20260904160612", "JR-34567", "JR-1"],
  );
});

test("a corrupt payload degrades to an empty list, not an error", () => {
  // §5.4: History degrades; it is a list of past work, and failing to show it
  // must not be the thing that stops a developer from starting a new run.
  for (const payload of [undefined, null, 7, "text", {}, { work_items: "nope" }]) {
    assert.equal(historyFromPayload(payload).kind, "empty");
  }
});

test("entries with no id are dropped instead of rendering blank rows", () => {
  const list = historyFromPayload({ work_items: [{ source: "jira" }, { work_item_id: "JR-2" }] });
  assert.equal(list.kind, "ready");
  if (list.kind !== "ready") return;
  assert.deepEqual(
    list.items.map((item) => item.workItemId),
    ["JR-2"],
  );
});

const NOW = Date.parse("2026-09-08T12:00:00Z");
const HOUR = 3_600_000;

test("a local id shows its title, because the id itself says nothing", () => {
  // §3.4: a local id carries no readable slug on purpose.
  const local = historyRow(
    { workItemId: "local_20260904160612", title: "Save crash", prepared: true },
    NOW,
  );
  assert.equal(local.label, "local_20260904160612");
  assert.equal(local.description, "Save crash");

  const bare = historyRow({ workItemId: "JR-1", prepared: false }, NOW);
  assert.equal(bare.description, "incomplete run");
});

// --- what became of a work item --------------------------------------------

test("no status file means the run never finished", () => {
  // Said before anything else, because everything else reads that file.
  assert.deepEqual(historyOutcome({ files: ["issue.json"] }), { outcome: "incomplete" });
  assert.deepEqual(historyOutcome({ files: [] }), { outcome: "incomplete" });
});

test("a recorded failure names the step that failed", () => {
  assert.deepEqual(
    historyOutcome({
      files: ["run.json"],
      status: { steps: { fetch: "pass", code_search: "fail" } },
    }),
    { outcome: "failed", failedStep: "code_search" },
  );
});

test("a prepared run that nobody acted on says exactly that", () => {
  assert.deepEqual(
    historyOutcome({
      files: ["run.json", "task.md"],
      status: { steps: { fetch: "pass", context: "pass" } },
    }),
    { outcome: "prepared" },
  );
});

test("the lifecycle outranks the marks: a failed run with no fail mark is failed", () => {
  // A run can fail outside any step; the authoritative status still says so.
  assert.deepEqual(
    historyOutcome({ files: ["run.json"], status: { status: "failed", steps: { doctor: "pass" } } }),
    { outcome: "failed" },
  );
});

test("a run still marked running has no outcome to report yet", () => {
  assert.deepEqual(
    historyOutcome({ files: ["run.json"], status: { status: "running", steps: { doctor: "pass" } } }),
    { outcome: "incomplete" },
  );
});

test("a directory prepared before run.json is incomplete, not silently adopted", () => {
  // No fallback: the old runtime files do not make a finished run under the
  // current contract, however complete the directory looks otherwise.
  assert.deepEqual(
    historyOutcome({
      files: ["workflow_status.json", "execution.log", "task.md", "context.md", "issue.json"],
      status: undefined,
    }),
    { outcome: "incomplete" },
  );
});

test("the agent's report is what tells the loop closed", () => {
  assert.deepEqual(
    historyOutcome({
      files: ["run.json", "fix_report.md"],
      status: { steps: { context: "pass" } },
    }),
    { outcome: "fixed" },
  );
});

test("the retry loop outranks the fix it followed", () => {
  // Somebody read that report and said it was wrong, which is the newer
  // of the two facts.
  assert.deepEqual(
    historyOutcome({
      files: ["run.json", "fix_report.md", "user_feedback.md"],
      status: { steps: { context: "pass" } },
    }),
    { outcome: "retrying" },
  );
});

test("a built retry package is not the same state as a waiting one", () => {
  // Found by running this over a real `.ai/`: two work items reported "a retry
  // is open" while both already had agent_retry_prompt.md, so nothing was
  // waiting on anybody. The next move differs — write feedback, or hand the
  // package over — so the row has to.
  const waiting = historyOutcome({
    files: ["run.json", "user_feedback.md"],
    status: { steps: { context: "pass" } },
  });
  const built = historyOutcome({
    files: ["run.json", "user_feedback.md", "agent_retry_prompt.md"],
    status: { steps: { context: "pass" } },
  });

  assert.deepEqual(waiting, { outcome: "retrying" });
  assert.deepEqual(built, { outcome: "retried" });
  assert.notEqual(OUTCOME_ICONS.retrying, OUTCOME_ICONS.retried);
  assert.match(
    historyRow({ workItemId: "JR-1", prepared: true, ...waiting }, NOW).tooltip.join(" "),
    /waiting on you/,
  );
  assert.match(
    historyRow({ workItemId: "JR-1", prepared: true, ...built }, NOW).tooltip.join(" "),
    /second attempt is prepared/,
  );
});

test("a corrupt status file leaves the outcome to the file list", () => {
  // The row still has to render: a truncated JSON is not a reason to lose a
  // work item from the list.
  assert.deepEqual(
    historyOutcome({ files: ["run.json", "fix_report.md"], status: undefined }),
    { outcome: "fixed" },
  );
  assert.deepEqual(
    historyOutcome({ files: ["run.json"], status: "not an object" }),
    { outcome: "prepared" },
  );
});

test("every outcome has an icon, so no row can render blank", () => {
  // A ThemeIcon with a name VS Code does not know draws nothing at all, and a
  // missing entry here would do the same.
  const outcomes = ["incomplete", "failed", "retried", "retrying", "fixed", "prepared"] as const;
  assert.deepEqual(Object.keys(OUTCOME_ICONS).sort(), [...outcomes].sort());
  for (const outcome of outcomes) {
    assert.match(OUTCOME_ICONS[outcome], /^[a-z][a-z-]*$/, outcome);
  }
  // Five states, five distinguishable rows: two sharing an icon would put the
  // list back where it started.
  assert.equal(new Set(Object.values(OUTCOME_ICONS)).size, outcomes.length);
});

test("the outcome reaches the row from the payload", () => {
  const list = historyFromPayload(
    { work_items: [{ work_item_id: "JR-1", title: "Crash", prepared: true }] },
    () => NOW - HOUR,
    () => ({ files: ["run.json"], status: { steps: { code_search: "fail" } } }),
  );
  assert.equal(list.kind, "ready");
  if (list.kind !== "ready") return;
  assert.equal(list.items[0]!.outcome, "failed");
  assert.equal(list.items[0]!.failedStep, "code_search");
  assert.equal(historyRow(list.items[0]!, NOW).icon, OUTCOME_ICONS.failed);
});

test("an unprobed row still gets an icon from what the CLI said", () => {
  // History is listed before the directories are read; a row with no outcome
  // must not be a hole.
  assert.equal(historyRow({ workItemId: "JR-1", prepared: true }, NOW).icon, OUTCOME_ICONS.prepared);
  assert.equal(
    historyRow({ workItemId: "JR-2", prepared: false }, NOW).icon,
    OUTCOME_ICONS.incomplete,
  );
});

// --- the hover -------------------------------------------------------------

test("the hover says what it is, when it changed, and how it went", () => {
  const tooltip = historyRow(
    {
      workItemId: "JR-12345",
      source: "jira",
      title: "Crash on save",
      prepared: true,
      modifiedMs: NOW - 2 * HOUR,
      outcome: "failed",
      failedStep: "fetch",
    },
    NOW,
  ).tooltip;

  assert.deepEqual(tooltip, [
    "JR-12345 · Jira issue",
    "Crash on save",
    "Last changed 2 hours ago",
    "The run failed at the fetch step.",
    "Click to reopen it in the panel.",
  ]);
});

test("the source finally appears somewhere a developer can read it", () => {
  // It was fetched from list --json, parsed into the model, and displayed
  // nowhere at all — the fifth time this project carried a value it never used.
  const manual = historyRow(
    { workItemId: "local_1", source: "manual", prepared: true, outcome: "prepared" },
    NOW,
  );
  assert.equal(manual.tooltip[0], "local_1 · Bug description");
});

test("the hover leaves out what it does not know", () => {
  // No title, no timestamp, no probe: four confident lines beat four lines
  // where three say "unknown".
  assert.deepEqual(historyRow({ workItemId: "JR-1", prepared: true }, NOW).tooltip, [
    "JR-1",
    "Click to reopen it in the panel.",
  ]);
});

test("ages are coarse, because the timestamp is the directory's", () => {
  // It moves whenever anything writes into the work item, so a precise clock
  // time would imply a precision about what happened that it does not have.
  const cases: [number, string][] = [
    [30_000, "just now"],
    [10 * 60_000, "10 minutes ago"],
    [HOUR, "an hour ago"],
    [5 * HOUR, "5 hours ago"],
    [26 * HOUR, "yesterday"],
    [4 * 24 * HOUR, "4 days ago"],
    [40 * 24 * HOUR, "last month"],
    [200 * 24 * HOUR, "7 months ago"],
  ];
  for (const [ago, expected] of cases) {
    assert.equal(describeAge(NOW - ago, NOW), expected, String(ago));
  }
  // A clock that disagrees between two machines must not produce "in 3 hours".
  assert.equal(describeAge(NOW + HOUR, NOW), "just now");
});

// --- what a real Jira run actually produces --------------------------------

/**
 * The listing from the first real MCP session (JR-12345), with its four issue
 * files replaced by the `issue.json` that consolidated them, and its context
 * and handoff files by `context.md` and `task.md`. Phase 5's grouping
 * was built from a *manual* run's twelve files, which turned out to be the
 * smaller half of the story.
 */
const REAL_JIRA_RUN = [
  "task.md",
  "context.md",
  "copilot_analysis_prompt.md",
  "copilot_fix_prompt.md",
  "copilot_handoff.md",
  "copilot_task.md",
  "copilot_team_instructions.md",
  "issue.json",
  "memory_entry.md",
  "retrieval.json",
  "review_prompt.md",
  "run.json",
  "test_plan.md",
];

test("every file a real Jira run writes has a group of its own", () => {
  // Nine of these had none and fell into Investigation next to context.md,
  // which is the one file that section exists for. The fallback is deliberate
  // — a new artifact stays visible — but it is not a place for nine known files
  // to live.
  const ungrouped = REAL_JIRA_RUN.filter((name) => artifactGroup(name) === "context");
  assert.deepEqual(
    ungrouped.sort(),
    ["context.md", "issue.json", "retrieval.json"],
    "only the investigation artifacts belong in Investigation",
  );
});

test("the copilot prompts do not crowd the file a developer opens", () => {
  const sections = sectionsOf(buildArtifactList({ names: REAL_JIRA_RUN }));
  const order = sections.map((section) => section.group);

  assert.equal(sections[0]?.group, "handoff");
  assert.equal(sections[0]?.entries[0]?.name, "task.md");
  // Five files a Claude user never opens, kept out of the first section and out
  // of Investigation.
  const copilot = sections.find((section) => section.group === "copilot");
  assert.equal(copilot?.entries.length, 5);
  assert.ok(order.indexOf("copilot") > order.indexOf("context"));
});

test("the normalized issue is investigation input, not bookkeeping", () => {
  // It is what every later step reads the bug from, so it sits with the
  // investigation rather than with run state.
  assert.equal(artifactGroup("issue.json"), "context");
  assert.equal(artifactGroup("memory_entry.md"), "state");
});

// --- History takes only work item ids (§37.70) -------------------------------

test("a folder name that is not a work item id never becomes a History row, nor is probed", () => {
  // `bugpilot list` skips them now; this is the extension's own check, for an
  // older CLI or a hand-edited payload. A row can be reopened, and reopening
  // leads to a handoff's command line.
  const probed: string[] = [];
  const list = historyFromPayload(
    {
      work_items: [
        { work_item_id: "JR-12345", source: "jira", title: "Kept", prepared: true },
        { work_item_id: "x$(calc)", source: null, title: null, prepared: false },
        { work_item_id: "../JR-1", source: null, title: null, prepared: false },
        { work_item_id: "JR-1\n", source: null, title: null, prepared: false },
        { work_item_id: "scratch notes", source: null, title: null, prepared: false },
      ],
    },
    () => undefined,
    (id) => {
      probed.push(id);
      return undefined;
    },
  );
  assert.equal(list.kind, "ready");
  if (list.kind !== "ready") return;
  assert.deepEqual(list.items.map((item) => item.workItemId), ["JR-12345"]);
  assert.deepEqual(probed, ["JR-12345"], "a name that is not a work item id was probed on disk");
});

test("a summarized package keeps its History outcome: the marks that stopped do not move it", () => {
  // summarize-results now records only `result_summary` (the overview was
  // rendered); `manual_validation` and `final_review_prompt` are gone (§37.70).
  // Neither the report's row nor the outcome may move because of that.
  const files = ["issue.json", "retrieval.json", "context.md", "task.md", "run.json", "fix_report.md"];
  const steps = { fetch: "pass", parse: "pass", context: "pass", prompt: "pass" };
  const before = historyOutcome({ files, status: { status: "prepared", steps: { ...steps, result_summary: "pass", manual_validation: "pass", final_review_prompt: "pass" } } });
  const after = historyOutcome({ files, status: { status: "prepared", steps: { ...steps, result_summary: "pass" } } });
  const never = historyOutcome({ files, status: { status: "prepared", steps } });
  assert.deepEqual(after, before);
  assert.deepEqual(after, never);
  assert.equal(after.outcome === "failed" || after.outcome === "incomplete", false);
});
