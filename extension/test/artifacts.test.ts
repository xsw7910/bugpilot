import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  ARTIFACTS,
  UNKNOWN_ARTIFACT_DESCRIPTION,
  artifactKind,
  artifactRow,
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

/** The flat list's rows, in order. */
function entriesOf(list: ArtifactList) {
  assert.equal(list.kind, "ready");
  return list.kind === "ready" ? list.entries : [];
}
const namesOf = (list: ArtifactList) => entriesOf(list).map((entry) => entry.name);
const entryOf = (list: ArtifactList, name: string) => entriesOf(list).find((entry) => entry.name === name);

/** The workflow's order for the eight canonical files (§37.88). */
const CANONICAL_ORDER = [
  "issue.json",
  "context.md",
  "task.md",
  "fix_report.md",
  "review_report.md",
  "verification_report.md",
  "retrieval.json",
  "run.json",
];

test("the canonical artifacts are exactly bugpilot's artifact contract", () => {
  // Every `*_ARTIFACT` name in bugpilot/core/artifacts.py is canonical here, and
  // nothing else is: a file added to the contract but not here would not be
  // listed before it is written.
  const source = readFileSync(new URL("../../bugpilot/core/artifacts.py", import.meta.url), "utf8");
  const python = [...source.matchAll(/^[A-Z_]+_ARTIFACT = "([^"]+)"/gm)].map((match) => match[1]!);
  assert.ok(python.length >= 8, "could not read the artifact constants from artifacts.py");
  const canonical = Object.keys(ARTIFACTS).filter((name) => ARTIFACTS[name]!.canonical);
  assert.deepEqual([...canonical].sort(), [...python].sort());
});

test("the result files bugpilot requires are canonical, so they are listed before they exist", () => {
  const source = readFileSync(new URL("../../bugpilot/core/workflow.py", import.meta.url), "utf8");
  const block = /REQUIRED_COPILOT_RESULT_FILES = \[([\s\S]*?)\]/.exec(source);
  assert.ok(block, "could not find REQUIRED_COPILOT_RESULT_FILES in workflow.py");
  const artifacts = readFileSync(new URL("../../bugpilot/core/artifacts.py", import.meta.url), "utf8");
  const fixReport = /^FIX_REPORT_ARTIFACT = "([^"]+)"/m.exec(artifacts);
  assert.ok(fixReport, "could not find FIX_REPORT_ARTIFACT in artifacts.py");
  const required = [...block[1]!.matchAll(/"([^"]+)"|FIX_REPORT_ARTIFACT/g)].map((match) => match[1] ?? fixReport[1]!);
  for (const name of required) assert.equal(ARTIFACTS[name]?.canonical, true, name);
});

test("one flat list: every file directly in it, in the workflow's order — no groups", () => {
  const list = buildArtifactList({ names: REAL_RUN });
  const entries = entriesOf(list);
  // Direct children: an entry is a file, never a category with entries of its own.
  for (const entry of entries) {
    assert.deepEqual(Object.keys(entry).filter((key) => key === "entries" || key === "group"), [], entry.name);
  }
  assert.deepEqual(namesOf(list), CANONICAL_ORDER);
  // The old category names are no row of it.
  for (const group of ["Hand off to an agent", "Agent results", "Investigation", "Run state"]) {
    assert.equal(entries.some((entry) => entry.name === group), false, group);
  }
});

test("every known artifact says what it is for, in plain words", () => {
  const expected: Record<string, string> = {
    "issue.json": "Issue details or manual bug description",
    "context.md": "Prepared context used by the AI",
    "task.md": "AI task and fix instructions",
    "fix_report.md": "Summary of the AI fix and changes",
    "review_report.md": "Saved review findings",
    "verification_report.md": "Recorded verification checks",
    "retrieval.json": "Investigation and retrieval details",
    "run.json": "Workflow execution metadata",
    "user_feedback.md": "Feedback provided for a new AI attempt",
    "agent_retry_prompt.md": "Instructions prepared for the next AI attempt",
    "jira_comment_draft.md": "Draft Jira comment prepared by BugPilot",
    "jira_comment_post_result.json": "Result of the Jira comment posting action",
    "email_draft.md": "Draft email prepared by BugPilot",
    "notification.eml": "Generated email notification",
    "jira_field_report.md": "Jira field inspection report",
  };
  assert.deepEqual(Object.keys(ARTIFACTS).sort(), Object.keys(expected).sort());
  for (const [name, description] of Object.entries(expected)) {
    assert.equal(ARTIFACTS[name]!.description, description, name);
    assert.notEqual(description.trim(), "");
  }
  // No internal words for a developer to decode.
  for (const info of Object.values(ARTIFACTS)) {
    assert.doesNotMatch(info.description, /canonical|payload|serializ|schema|artifact contract/i);
  }
});

test("a canonical file not written yet is listed as Not written yet — never Missing — and opens nothing", () => {
  const list = buildArtifactList({ names: REAL_RUN });
  const report = entryOf(list, "fix_report.md")!;
  assert.equal(report.written, false);
  const row = artifactRow(report);
  // The status alone on the line; the purpose is the tooltip's (§37.90).
  assert.equal(row.description, "Not written yet");
  assert.match(row.tooltip, /^fix_report\.md\nSummary of the AI fix and changes\n/);
  assert.equal(row.opens, false, "a file not written yet would open as an empty file");
  assert.match(row.tooltip, /Status: Not written yet/);
  assert.match(row.tooltip, /Written by the AI agent when it finishes an attempt\./);
  const said = JSON.stringify(row);
  assert.doesNotMatch(said, /Missing|Failed/);
  // The review and the verification too — they are part of the workflow to come.
  for (const name of ["review_report.md", "verification_report.md"]) {
    assert.equal(artifactRow(entryOf(list, name)!).description, "Not written yet", name);
  }
});

test("a written file is Written, once, and opens", () => {
  const list = buildArtifactList({ names: [...REAL_RUN, "fix_report.md"] });
  const row = artifactRow(entryOf(list, "fix_report.md")!);
  assert.equal(row.label, "fix_report.md");
  assert.equal(row.description, "Written");
  assert.equal(row.opens, true);
  assert.equal(row.icon, "markdown");
  assert.equal(row.tooltip, "fix_report.md\nSummary of the AI fix and changes\nStatus: Written");
  // The purpose is not on the line any more, and a screen reader still hears it.
  assert.equal(row.accessibleName, "fix_report.md — Summary of the AI fix and changes — Written");
});

test("a file created or deleted changes its row: the list is rebuilt from what is on disk", () => {
  const before = buildArtifactList({ names: REAL_RUN });
  const created = buildArtifactList({ names: [...REAL_RUN, "review_report.md"] });
  const deleted = buildArtifactList({ names: REAL_RUN.filter((name) => name !== "context.md") });
  assert.equal(entryOf(before, "review_report.md")!.written, false);
  assert.equal(entryOf(created, "review_report.md")!.written, true);
  assert.equal(entryOf(deleted, "context.md")!.written, false);
  // And the order does not move when a file arrives.
  assert.deepEqual(namesOf(created), CANONICAL_ORDER);
});

test("side-band files appear when they exist, in their place after the canonical ones", () => {
  const list = buildArtifactList({
    names: [...REAL_RUN, "notification.eml", "user_feedback.md", "jira_comment_draft.md", "agent_retry_prompt.md"],
  });
  assert.deepEqual(namesOf(list), [
    ...CANONICAL_ORDER,
    "user_feedback.md",
    "agent_retry_prompt.md",
    "jira_comment_draft.md",
    "notification.eml",
  ]);
  assert.equal(artifactRow(entryOf(list, "notification.eml")!).icon, "mail");
  // Not listed before they exist.
  assert.equal(namesOf(buildArtifactList({ names: REAL_RUN })).includes("user_feedback.md"), false);
});

test("an unknown file is listed, after every known one, with a neutral description — sorted by name", () => {
  const list = buildArtifactList({ names: ["zeta_notes.md", ...REAL_RUN, "alpha.log", "copilot_task.md", "email_draft.md"] });
  const names = namesOf(list);
  assert.deepEqual(names.slice(-3), ["alpha.log", "copilot_task.md", "zeta_notes.md"]);
  assert.ok(names.indexOf("email_draft.md") < names.indexOf("alpha.log"), "an unknown file interrupted the known ones");
  const unknown = entryOf(list, "zeta_notes.md")!;
  assert.equal(unknown.description, UNKNOWN_ARTIFACT_DESCRIPTION);
  assert.equal(UNKNOWN_ARTIFACT_DESCRIPTION, "Additional BugPilot artifact");
  const row = artifactRow(unknown);
  assert.equal(row.opens, true, "a written unknown file did not open");
  assert.equal(artifactRow(entryOf(list, "alpha.log")!).icon, "output");
});

test("an empty directory is an empty state, not an error", () => {
  const list = buildArtifactList({ names: [] });
  assert.equal(list.kind, "empty");
  assert.match(list.kind === "empty" ? list.detail : "", /Run BugPilot/);
});

test("file kinds drive the icon and the open action", () => {
  assert.equal(artifactKind("context.md"), "markdown");
  assert.equal(artifactKind("retrieval.json"), "json");
  assert.equal(artifactKind("notification.eml"), "mail");
  assert.equal(artifactKind("execution.log"), "log");
  assert.equal(artifactKind("noext"), "other");
  assert.equal(artifactRow({ name: "noext", kind: "other", description: "x", written: true }).icon, "file");
});

test("duplicate names collapse", () => {
  const list = buildArtifactList({ names: ["context.md", "context.md", "notes.txt", "notes.txt"] });
  assert.equal(namesOf(list).filter((name) => name === "context.md").length, 1);
  assert.equal(namesOf(list).filter((name) => name === "notes.txt").length, 1);
});

test("a tooltip holds names and fixed sentences only, never a path or contents", () => {
  for (const entry of entriesOf(buildArtifactList({ names: [...REAL_RUN, "fix_report.md", "odd.md"] }))) {
    const row = artifactRow(entry);
    assert.doesNotMatch(row.tooltip, /[\\/]/, entry.name);
  }
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

test("a phase-era Jira directory lists its old files after every known one, and never ahead of task.md", () => {
  // Nine files a current run no longer writes: shown, since they are there, but
  // as additional artifacts at the end rather than dressed up with a purpose.
  const names = namesOf(buildArtifactList({ names: REAL_JIRA_RUN }));
  assert.deepEqual(names.slice(0, CANONICAL_ORDER.length), CANONICAL_ORDER);
  const extra = names.slice(CANONICAL_ORDER.length);
  assert.deepEqual(extra, [...extra].sort(), "the old files are not in name order");
  assert.equal(extra.length, REAL_JIRA_RUN.length - 5);
  for (const name of extra) {
    assert.equal(entryOf(buildArtifactList({ names: REAL_JIRA_RUN }), name)!.description, UNKNOWN_ARTIFACT_DESCRIPTION, name);
  }
});

test("the copilot prompts do not crowd the file a developer opens", () => {
  const names = namesOf(buildArtifactList({ names: REAL_JIRA_RUN }));
  // task.md where the workflow puts it; the five prompts after run.json.
  assert.equal(names.indexOf("task.md"), 2);
  for (const name of names.filter((each) => each.startsWith("copilot_"))) {
    assert.ok(names.indexOf(name) > names.indexOf("run.json"), name);
  }
});

test("the normalized issue comes first: it is what every later step reads the bug from", () => {
  assert.equal(namesOf(buildArtifactList({ names: ["run.json", "memory_entry.md", "issue.json"] }))[0], "issue.json");
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

// --- Batch 11: review_report.md ------------------------------------------------

test("a recorded review follows the fix report; before it is saved it is Not written yet, never missing", () => {
  const list = buildArtifactList({ names: ["task.md", "fix_report.md", "review_report.md", "context.md"] });
  const names = namesOf(list);
  assert.equal(names.indexOf("review_report.md"), names.indexOf("fix_report.md") + 1);
  assert.equal(entryOf(list, "review_report.md")!.written, true);
  const withoutReview = buildArtifactList({ names: ["task.md", "fix_report.md"] });
  const row = artifactRow(entryOf(withoutReview, "review_report.md")!);
  assert.equal(row.description, "Not written yet");
  assert.match(row.tooltip, /Saved review findings/);
  assert.doesNotMatch(JSON.stringify(row), /missing/i);
});

test("History's outcome ignores a recorded review", () => {
  const status = { status: "prepared", steps: { prepare: "pass" } };
  for (const files of [
    ["run.json", "task.md"],
    ["run.json", "task.md", "fix_report.md"],
    ["run.json", "task.md", "fix_report.md", "user_feedback.md"],
  ]) {
    assert.deepEqual(
      historyOutcome({ files: [...files, "review_report.md"], status }),
      historyOutcome({ files, status }),
      files.join(", "),
    );
  }
});

// --- Batch 12: verification_report.md -----------------------------------------

test("recorded evidence follows the review; before it is recorded it is Not written yet, never missing", () => {
  const list = buildArtifactList({
    names: ["task.md", "verification_report.md", "fix_report.md", "review_report.md", "context.md"],
  });
  const names = namesOf(list);
  assert.deepEqual(names.slice(names.indexOf("fix_report.md"), names.indexOf("fix_report.md") + 3), ["fix_report.md", "review_report.md", "verification_report.md"]);
  const without = buildArtifactList({ names: ["task.md", "fix_report.md"] });
  const row = artifactRow(entryOf(without, "verification_report.md")!);
  assert.equal(row.description, "Not written yet");
  assert.match(row.tooltip, /Recorded verification checks/);
  assert.doesNotMatch(JSON.stringify(row), /missing/i);
});

test("History's outcome ignores recorded evidence, with or without a review", () => {
  const status = { status: "prepared", steps: { prepare: "pass" } };
  for (const files of [
    ["run.json", "task.md"],
    ["run.json", "task.md", "fix_report.md"],
    ["run.json", "task.md", "fix_report.md", "review_report.md"],
    ["run.json", "task.md", "fix_report.md", "user_feedback.md"],
  ]) {
    assert.deepEqual(
      historyOutcome({ files: [...files, "verification_report.md"], status }),
      historyOutcome({ files, status }),
      files.join(", "),
    );
  }
});

test("no History icon claims a fix was verified or passed", () => {
  // A work item with fix_report.md is one an agent reported on — not a verified
  // fix. The icon was the check-badge "verified" until release stabilization.
  for (const [outcome, icon] of Object.entries(OUTCOME_ICONS)) {
    const claims = icon.split("-").filter((part) => ["verified", "pass", "check", "shield", "thumbsup", "star"].includes(part));
    assert.deepEqual(claims, [], `${outcome} uses ${icon}`);
  }
  assert.equal(OUTCOME_ICONS.fixed, "file-text");
});

// --- Artifacts rows: file name and status only (§37.90) ---------------------

test("every row's line is its status and nothing else; the purpose is in the tooltip and the name", () => {
  const list = buildArtifactList({ names: [...REAL_RUN, "user_feedback.md", "zz_custom_output.json"] });
  for (const entry of entriesOf(list)) {
    const row = artifactRow(entry);
    assert.ok(row.description === "Written" || row.description === "Not written yet", `${entry.name}: "${row.description}"`);
    assert.equal(row.description.includes(entry.description), false, `${entry.name}: the purpose is back on the line`);
    const lines = row.tooltip.split("\n");
    assert.equal(lines[0], entry.name, "the full file name, which a narrow sidebar cuts");
    assert.equal(lines[1], entry.description);
    assert.equal(lines[2], `Status: ${row.description}`);
    assert.equal(row.accessibleName, `${entry.name} — ${entry.description} — ${row.description}`);
  }
});

test("the tooltips say, briefly, what each standard file is for", () => {
  const list = buildArtifactList({ names: REAL_RUN });
  const purposes = Object.fromEntries(entriesOf(list).map((entry) => [entry.name, artifactRow(entry).tooltip.split("\n")[1]]));
  assert.deepEqual(purposes, {
    "issue.json": "Issue details or manual bug description",
    "context.md": "Prepared context used by the AI",
    "task.md": "AI task and fix instructions",
    "fix_report.md": "Summary of the AI fix and changes",
    "review_report.md": "Saved review findings",
    "verification_report.md": "Recorded verification checks",
    "retrieval.json": "Investigation and retrieval details",
    "run.json": "Workflow execution metadata",
  });
});

test("the longest name, and an unknown file, are whole in the tooltip", () => {
  const list = buildArtifactList({ names: [...REAL_RUN, "verification_report.md", "a_rather_long_generated_output_name.json"] });
  assert.equal(artifactRow(entryOf(list, "verification_report.md")!).tooltip, "verification_report.md\nRecorded verification checks\nStatus: Written");
  assert.equal(
    artifactRow(entryOf(list, "a_rather_long_generated_output_name.json")!).tooltip,
    "a_rather_long_generated_output_name.json\nAdditional BugPilot artifact\nStatus: Written",
  );
});
