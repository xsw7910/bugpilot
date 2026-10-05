import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { artifactRow, buildArtifactList, historyFromPayload, historyRow } from "../src/app/artifacts.ts";
import type { ArtifactList, HistoryList } from "../src/app/artifacts.ts";
import { CURRENT_GROUP, HISTORY_GROUP, resultsChildren, resultsItem } from "../src/app/results.ts";
import type { ResultsNode, ResultsSources } from "../src/app/results.ts";
import { COMMANDS, HISTORY_ITEM_CONTEXT, workItemFromTree } from "../src/commands.ts";

/**
 * The Results tree (§37.106): Current and History as two groups of one view.
 * The rows themselves are `artifacts.ts`'s, and `test/artifacts.test.ts` pins
 * them; this file pins the tree around them, and that the rows reach it
 * unchanged.
 */

const NOW = Date.UTC(2026, 9, 5, 12);
const HOUR = 3_600_000;

/** The exact directory a prepare-only run leaves behind. */
const PREPARED = ["task.md", "context.md", "issue.json", "retrieval.json", "run.json"];

const NOTHING_OPEN: ArtifactList = { kind: "empty", detail: "No work item selected yet." };
const NO_HISTORY: HistoryList = { kind: "empty", detail: "No work items yet. The first run creates one." };

const THREE = historyFromPayload(
  {
    ok: true,
    work_items: [
      { work_item_id: "JR-12345", source: "jira", title: "Fix VDS output", prepared: true },
      { work_item_id: "local_20260904160612", source: "manual", title: "Crash on import", prepared: true },
      { work_item_id: "JR-9999", source: "jira", title: null, prepared: false },
    ],
  },
  (id) => ({ "JR-12345": NOW - 3 * HOUR, local_20260904160612: NOW - HOUR, "JR-9999": NOW - 50 * HOUR })[id],
);

/** Sources that count how often History was read. */
function sources(artifacts: ArtifactList, history: HistoryList = NO_HISTORY) {
  const reads = { history: 0 };
  const value: ResultsSources = {
    artifacts: () => artifacts,
    history: async () => {
      reads.history += 1;
      return history;
    },
    now: () => NOW,
  };
  return { sources: value, reads };
}

const labels = (nodes: readonly ResultsNode[], workItemId?: string) =>
  nodes.map((node) => resultsItem(node, workItemId).label);

// --- the root -----------------------------------------------------------------

test("the root is Current then History, always, whatever is open", async () => {
  for (const artifacts of [NOTHING_OPEN, buildArtifactList({ names: PREPARED }), { kind: "loading" } as const]) {
    const root = await resultsChildren(undefined, sources(artifacts).sources);
    assert.deepEqual(labels(root), ["Current", "History"]);
    // The same two objects every time: VS Code finds the node to refresh by
    // identity, and `refreshCurrent` names CURRENT_GROUP.
    assert.equal(root[0], CURRENT_GROUP);
    assert.equal(root[1], HISTORY_GROUP);
  }
});

test("Current is expanded and History collapsed, each with a stable id and its own icon", () => {
  const current = resultsItem(CURRENT_GROUP, undefined);
  const history = resultsItem(HISTORY_GROUP, undefined);
  assert.equal(current.collapsible, "expanded");
  assert.equal(history.collapsible, "collapsed");
  // A stable id is what keeps a group the way the developer left it across refreshes.
  assert.equal(current.id, "bugpilot.results.current");
  assert.equal(history.id, "bugpilot.results.history");
  assert.equal(current.icon, "folder-active");
  assert.equal(history.icon, "history");
  // No context value: the History row menu is for work items, not for a group.
  assert.equal(current.contextValue, undefined);
  assert.equal(history.contextValue, undefined);
  assert.equal(current.command, undefined);
  assert.equal(history.command, undefined);
});

test("Current names the work item open in the panel; nothing open, it names nothing", () => {
  const open = resultsItem(CURRENT_GROUP, "JR-12345");
  assert.equal(open.description, "JR-12345");
  assert.equal(open.accessibleName, "Current, JR-12345");
  assert.match(open.tooltip ?? "", /JR-12345/);

  const none = resultsItem(CURRENT_GROUP, undefined);
  assert.equal(none.description, undefined);
  assert.equal(none.accessibleName, "Current");
  assert.match(none.tooltip ?? "", /None is open/);
  // History does not depend on what is open.
  assert.deepEqual(resultsItem(HISTORY_GROUP, "JR-12345"), resultsItem(HISTORY_GROUP, undefined));
});

test("a collapsed History costs nothing: the root and Current never read it", async () => {
  const { sources: from, reads } = sources(buildArtifactList({ names: PREPARED }), THREE);
  await resultsChildren(undefined, from);
  await resultsChildren(CURRENT_GROUP, from);
  assert.equal(reads.history, 0, "History was read without being expanded");
  await resultsChildren(HISTORY_GROUP, from);
  assert.equal(reads.history, 1);
});

// --- Current ------------------------------------------------------------------

test("nothing open: Current is one row saying so, which opens nothing", async () => {
  const rows = await resultsChildren(CURRENT_GROUP, sources(NOTHING_OPEN).sources);
  assert.deepEqual(rows, [{ kind: "message", text: "No work item selected yet." }]);
  const item = resultsItem(rows[0]!, undefined);
  assert.equal(item.icon, "info");
  assert.equal(item.collapsible, "none");
  assert.equal(item.command, undefined);
  assert.equal(item.contextValue, undefined);
});

test("Current's loading, empty and unreadable states are one row each, as the Artifacts view had them", async () => {
  const cases: [ArtifactList, string][] = [
    [{ kind: "loading" }, "Scanning .ai/ …"],
    [buildArtifactList({ names: [] }), "No artifacts yet. Run BugPilot on this work item to produce them."],
    [{ kind: "error", detail: ".ai/JR-1/ could not be read: EACCES" }, ".ai/JR-1/ could not be read: EACCES"],
  ];
  for (const [list, text] of cases) {
    assert.deepEqual(await resultsChildren(CURRENT_GROUP, sources(list).sources), [{ kind: "message", text }]);
  }
});

test("an open work item: Current lists its files in the Artifacts order, rows unchanged", async () => {
  const list = buildArtifactList({ names: PREPARED });
  assert.equal(list.kind, "ready");
  const entries = list.kind === "ready" ? list.entries : [];
  const rows = await resultsChildren(CURRENT_GROUP, sources(list).sources);
  assert.deepEqual(labels(rows, "JR-12345"), [
    "issue.json",
    "context.md",
    "task.md",
    "fix_report.md",
    "review_report.md",
    "verification_report.md",
    "retrieval.json",
    "run.json",
  ]);
  // Each row is artifactRow's, field for field: the name, its status, the
  // tooltip, the accessible name and the file type's icon.
  rows.forEach((node, index) => {
    const row = artifactRow(entries[index]!);
    const item = resultsItem(node, "JR-12345");
    assert.equal(item.label, row.label);
    assert.equal(item.description, row.description);
    assert.equal(item.tooltip, row.tooltip);
    assert.equal(item.accessibleName, row.accessibleName);
    assert.equal(item.icon, row.icon);
    assert.equal(item.collapsible, "none");
    assert.equal(item.contextValue, undefined, "an artifact row got the History row menu");
  });
});

test("a written artifact opens through Open Artifact, by name; one not written yet opens nothing", async () => {
  const rows = await resultsChildren(CURRENT_GROUP, sources(buildArtifactList({ names: PREPARED })).sources);
  const item = (name: string) => resultsItem(rows.find((node) => resultsItem(node, "JR-1").label === name)!, "JR-1");
  assert.deepEqual(item("task.md").command, { command: COMMANDS.openArtifact, title: "Open", arguments: ["task.md"] });
  assert.equal(item("task.md").description, "Written");
  assert.equal(item("fix_report.md").command, undefined);
  assert.equal(item("fix_report.md").description, "Not written yet");
});

// --- History ------------------------------------------------------------------

test("no history: History is one row saying so", async () => {
  const rows = await resultsChildren(HISTORY_GROUP, sources(NOTHING_OPEN, NO_HISTORY).sources);
  assert.deepEqual(labels(rows), ["No work items yet. The first run creates one."]);
  assert.equal(resultsItem(rows[0]!, undefined).contextValue, undefined, "a placeholder got the History row menu");
  // And the other two things History can say instead of rows.
  for (const detail of ["Open the repository you are fixing bugs in.", "The work item list could not be read."]) {
    const said = await resultsChildren(HISTORY_GROUP, sources(NOTHING_OPEN, { kind: "empty", detail }).sources);
    assert.deepEqual(labels(said), [detail]);
  }
  assert.deepEqual(labels(await resultsChildren(HISTORY_GROUP, sources(NOTHING_OPEN, { kind: "loading" }).sources)), ["Loading …"]);
});

test("one work item: one row, the History view's row, which reopens it on click", async () => {
  const one = historyFromPayload({ ok: true, work_items: [{ work_item_id: "JR-12345", source: "jira", title: "Fix VDS output", prepared: true }] });
  const rows = await resultsChildren(HISTORY_GROUP, sources(NOTHING_OPEN, one).sources);
  assert.equal(rows.length, 1);
  const item = resultsItem(rows[0]!, undefined);
  const row = historyRow(one.kind === "ready" ? one.items[0]! : assert.fail("not ready"), NOW);
  assert.equal(item.label, "JR-12345");
  assert.equal(item.description, "Fix VDS output");
  assert.equal(item.icon, row.icon);
  assert.equal(item.tooltip, row.tooltip.join("\n"));
  assert.equal(item.collapsible, "none", "a History row is a leaf in this version");
  assert.equal(item.contextValue, HISTORY_ITEM_CONTEXT);
  assert.deepEqual(item.command, { command: COMMANDS.showWorkItem, title: "Show", arguments: ["JR-12345"] });
});

test("several work items: History keeps the list's order, newest first, and every row's text", async () => {
  const rows = await resultsChildren(HISTORY_GROUP, sources(NOTHING_OPEN, THREE).sources);
  assert.deepEqual(labels(rows), ["local_20260904160612", "JR-12345", "JR-9999"]);
  assert.deepEqual(
    rows.map((node) => resultsItem(node, undefined).description),
    ["Crash on import", "Fix VDS output", "incomplete run"],
  );
  // What it changed is in the hover, as before.
  assert.match(resultsItem(rows[0]!, undefined).tooltip ?? "", /Last changed an hour ago/);
});

test("a History row is still the argument its context menu acts on", async () => {
  // Retry, Clean and the rest read the work item from the node they were
  // handed; a group, an artifact or a placeholder names none.
  const history = await resultsChildren(HISTORY_GROUP, sources(NOTHING_OPEN, THREE).sources);
  assert.deepEqual(history.map(workItemFromTree), ["local_20260904160612", "JR-12345", "JR-9999"]);
  const current = await resultsChildren(CURRENT_GROUP, sources(buildArtifactList({ names: PREPARED })).sources);
  for (const node of [CURRENT_GROUP, HISTORY_GROUP, ...current, { kind: "message", text: "Loading …" } as const]) {
    assert.equal(workItemFromTree(node), undefined, JSON.stringify(node));
  }
});

test("rows have no children: only the two groups expand", async () => {
  const { sources: from, reads } = sources(buildArtifactList({ names: PREPARED }), THREE);
  const all = [...(await resultsChildren(CURRENT_GROUP, from)), ...(await resultsChildren(HISTORY_GROUP, from))];
  for (const node of all) assert.deepEqual(await resultsChildren(node, from), []);
  assert.equal(reads.history, 1, "a row read History again");
});

test("the same work item can be both Current and a History row, each in its own role", async () => {
  const { sources: from } = sources(buildArtifactList({ names: PREPARED }), THREE);
  const current = await resultsChildren(CURRENT_GROUP, from);
  const history = await resultsChildren(HISTORY_GROUP, from);
  // Current is its files, never a second JR-12345 row; History lists it once.
  assert.equal(labels(current, "JR-12345").includes("JR-12345"), false);
  assert.equal(labels(history, "JR-12345").filter((label) => label === "JR-12345").length, 1);
  assert.equal(resultsItem(CURRENT_GROUP, "JR-12345").description, "JR-12345");
});

// --- what the developer reads ---------------------------------------------------

test("no message sends the developer to the Artifacts or History view, which no longer exist", () => {
  // Found once already: a failed reset said "the Artifacts view shows what is
  // left". History and Current are groups; a sentence may name those.
  const extension = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));
  const files = [
    ...readdirSync(path.join(extension, "src"), { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".ts"))
      .map((file) => path.join(extension, "src", file)),
    path.join(extension, "media", "panel.js"),
  ];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    assert.doesNotMatch(text, /\b(Artifacts|History) view\b/, path.relative(extension, file));
  }
});
