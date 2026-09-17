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

/** The exact directory listing a real prepare-only run left behind. */
const REAL_RUN = [
  "agent_handoff.md",
  "agent_task.md",
  "agent_team_instructions.md",
  "bug_context.md",
  "bug_spec.json",
  "code_search.md",
  "execution.log",
  "extracted_keywords.json",
  "jira_parsed.md",
  "related_files.json",
  "search_quality.json",
  "workflow_status.json",
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
  const python = [...block[1]!.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
  assert.deepEqual([...RESULT_FILES].sort(), python.sort());
});

test("the handoff file comes first, and run state comes last", () => {
  // agent_task.md is what the Run button was for; an alphabetical listing puts
  // three files nobody opens above it.
  const sections = sectionsOf(buildArtifactList({ names: REAL_RUN }));
  assert.equal(sections[0]?.group, "handoff");
  assert.equal(sections[0]?.entries[0]?.name, "agent_task.md");
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
  // --only-issue-details produces no agent_task.md, so there was never anything
  // to hand over; five red rows would be noise.
  const list = buildArtifactList({ names: ["jira_parsed.md", "workflow_status.json"] });
  assert.equal(
    sectionsOf(list).some((section) => section.group === "results"),
    false,
  );
});

test("a written result file is shown as present, ahead of the missing ones", () => {
  const sections = sectionsOf(buildArtifactList({ names: [...REAL_RUN, "fix_summary.md"] }));
  const results = sections.find((section) => section.group === "results");
  assert.equal(results?.entries[0]?.name, "fix_summary.md");
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
  assert.equal(artifactGroup("workflow_status.json"), "state");
  assert.equal(artifactGroup("user_feedback.md"), "retry");
  assert.equal(artifactGroup("fix_summary.md"), "results");
});

test("file kinds drive the icon and the open action", () => {
  assert.equal(artifactKind("bug_context.md"), "markdown");
  assert.equal(artifactKind("related_files.json"), "json");
  assert.equal(artifactKind("execution.log"), "log");
  assert.equal(artifactKind("noext"), "other");
});

test("duplicate names collapse", () => {
  const sections = sectionsOf(buildArtifactList({ names: ["bug_context.md", "bug_context.md"] }));
  assert.equal(sections[0]?.entries.length, 1);
});

// --- history ---------------------------------------------------------------

const LIST_PAYLOAD = {
  schema_version: 1,
  ok: true,
  command: "list",
  work_items: [
    { work_item_id: "JR-23477", source: "jira", title: "Save crash", prepared: true },
    { work_item_id: "local_20260904160612", source: "manual", title: "Save crash", prepared: true },
    { work_item_id: "JR-1", source: null, title: null, prepared: false },
  ],
};

test("history is built from list --json, newest first", () => {
  const times: Record<string, number> = {
    "JR-23477": 100,
    local_20260904160612: 300,
    "JR-1": 200,
  };
  const list = historyFromPayload(LIST_PAYLOAD, (id) => times[id]);
  assert.equal(list.kind, "ready");
  if (list.kind !== "ready") return;
  assert.deepEqual(
    list.items.map((item) => item.workItemId),
    ["local_20260904160612", "JR-1", "JR-23477"],
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
    ["local_20260904160612", "JR-23477", "JR-1"],
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
  assert.deepEqual(historyOutcome({ files: ["jira.json"] }), { outcome: "incomplete" });
  assert.deepEqual(historyOutcome({ files: [] }), { outcome: "incomplete" });
});

test("a recorded failure names the step that failed", () => {
  assert.deepEqual(
    historyOutcome({
      files: ["workflow_status.json"],
      status: { steps: { fetch: "pass", code_search: "fail" } },
    }),
    { outcome: "failed", failedStep: "code_search" },
  );
});

test("a prepared run that nobody acted on says exactly that", () => {
  assert.deepEqual(
    historyOutcome({
      files: ["workflow_status.json", "agent_task.md"],
      status: { steps: { fetch: "pass", context: "pass" } },
    }),
    { outcome: "prepared" },
  );
});

test("a fix summary is what tells the loop closed", () => {
  assert.deepEqual(
    historyOutcome({
      files: ["workflow_status.json", "fix_summary.md"],
      status: { steps: { context: "pass" } },
    }),
    { outcome: "fixed" },
  );
});

test("the retry loop outranks the fix it followed", () => {
  // Somebody read that fix summary and said it was wrong, which is the newer
  // of the two facts.
  assert.deepEqual(
    historyOutcome({
      files: ["workflow_status.json", "fix_summary.md", "user_feedback.md"],
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
    files: ["workflow_status.json", "user_feedback.md"],
    status: { steps: { context: "pass" } },
  });
  const built = historyOutcome({
    files: ["workflow_status.json", "user_feedback.md", "agent_retry_prompt.md"],
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
    historyOutcome({ files: ["workflow_status.json", "fix_summary.md"], status: undefined }),
    { outcome: "fixed" },
  );
  assert.deepEqual(
    historyOutcome({ files: ["workflow_status.json"], status: "not an object" }),
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
    () => ({ files: ["workflow_status.json"], status: { steps: { code_search: "fail" } } }),
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
 * The exact listing from the first real MCP session: JR-12345, fetched from
 * the company Jira. Phase 5's grouping was built from a *manual* run's twelve
 * files, which turned out to be the smaller half — this one writes twenty-two.
 */
const REAL_JIRA_RUN = [
  "agent_handoff.md",
  "agent_task.md",
  "agent_team_instructions.md",
  "bug_context.md",
  "bug_spec.json",
  "code_search.md",
  "copilot_analysis_prompt.md",
  "copilot_fix_prompt.md",
  "copilot_handoff.md",
  "copilot_task.md",
  "copilot_team_instructions.md",
  "execution.log",
  "extracted_keywords.json",
  "jira.json",
  "jira_parsed.md",
  "jira_summary.md",
  "memory_entry.md",
  "related_files.json",
  "review_prompt.md",
  "search_quality.json",
  "test_plan.md",
  "workflow_status.json",
];

test("every file a real Jira run writes has a group of its own", () => {
  // Nine of these had none and fell into Investigation next to bug_context.md,
  // which is the one file that section exists for. The fallback is deliberate
  // — a new artifact stays visible — but it is not a place for nine known files
  // to live.
  const ungrouped = REAL_JIRA_RUN.filter((name) => artifactGroup(name) === "context");
  assert.deepEqual(
    ungrouped.sort(),
    [
      "bug_context.md",
      "code_search.md",
      "extracted_keywords.json",
      "jira_parsed.md",
      "jira_summary.md",
      "related_files.json",
      "search_quality.json",
    ],
    "only the investigation artifacts belong in Investigation",
  );
});

test("the copilot prompts do not crowd the file a developer opens", () => {
  const sections = sectionsOf(buildArtifactList({ names: REAL_JIRA_RUN }));
  const order = sections.map((section) => section.group);

  assert.equal(sections[0]?.group, "handoff");
  assert.equal(sections[0]?.entries[0]?.name, "agent_task.md");
  // Five files a Claude user never opens, kept out of the first section and out
  // of Investigation.
  const copilot = sections.find((section) => section.group === "copilot");
  assert.equal(copilot?.entries.length, 5);
  assert.ok(order.indexOf("copilot") > order.indexOf("context"));
});

test("the raw Jira payload is bookkeeping, not investigation", () => {
  // It is also the file the safety rules single out as never to be committed;
  // showing it beside bug_context.md invites opening it as if it were a reading.
  assert.equal(artifactGroup("jira.json"), "state");
  assert.equal(artifactGroup("memory_entry.md"), "state");
});
