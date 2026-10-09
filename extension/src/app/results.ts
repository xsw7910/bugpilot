/**
 * The Results tree: the work item on screen (Current), every work item under
 * `.ai/` (History), and what BugPilot is configured with (Diagnostics), as
 * three groups of one native view (§37.106, §37.110).
 *
 * They were two views, Artifacts and History. VS Code gives every expanded view
 * the same minimum height whatever it holds — 148px in VS Code 1.140, measured —
 * so "No work item selected yet." and a one-row History cost that twice. One
 * view with two groups costs it once.
 *
 * Pure like `artifacts.ts`, whose row shaping it reuses unchanged: this module
 * decides the tree's shape — which nodes, in which order, expanded or not — and
 * `src/views/trees.ts` only turns each `ResultsItem` into a `TreeItem`.
 */

import { artifactRow, historyRow } from "./artifacts.ts";
import type { ArtifactEntry, ArtifactList, HistoryList, HistoryRow } from "./artifacts.ts";
import { diagnosticTooltip } from "./diagnostics.ts";
import type { DiagnosticsRow, DiagnosticsView } from "./diagnostics.ts";
import { COMMANDS, HISTORY_ITEM_CONTEXT } from "../commands.ts";

/**
 * One node of the tree.
 *
 * A history row keeps `workItemId` as a field of the node itself because the
 * node is also the argument: a context-menu command receives this object, and
 * `workItemFromTree` reads that field to know which work item it acts on.
 */
export type ResultsNode =
  | { readonly kind: "group"; readonly group: "current" | "history" | "diagnostics" }
  | { readonly kind: "artifact"; readonly entry: ArtifactEntry }
  /** One fact about the environment, under Diagnostics: status only, no command. */
  | { readonly kind: "diagnostic"; readonly row: DiagnosticsRow }
  | ({ readonly kind: "workItem"; readonly workItemId: string } & HistoryRow)
  /** The one placeholder row a loading, empty or unreadable group shows. */
  | { readonly kind: "message"; readonly text: string };

/**
 * The three groups, as the same three objects every time.
 *
 * VS Code finds a node to refresh by identity, so `refreshCurrent` can only
 * name the group it handed out — and a stable `id` is what keeps a group
 * expanded or collapsed the way the developer left it across refreshes.
 */
export const CURRENT_GROUP: ResultsNode = { kind: "group", group: "current" };
export const HISTORY_GROUP: ResultsNode = { kind: "group", group: "history" };
export const DIAGNOSTICS_GROUP: ResultsNode = { kind: "group", group: "diagnostics" };

export interface ResultsSources {
  /** The controller's listing of the work item on screen. */
  readonly artifacts: () => ArtifactList;
  /** `bugpilot list`, read by the host. Called only when History is expanded. */
  readonly history: () => Promise<HistoryList>;
  /**
   * The controller's diagnostics: state it already holds, built when asked. No
   * request, no probe, no file read — expanding Diagnostics costs nothing.
   */
  readonly diagnostics: () => DiagnosticsView;
  readonly now: () => number;
}

/**
 * A node's children. History's are read only when VS Code asks for them, which
 * it does only while the group is expanded: collapsed, it costs no `bugpilot
 * list` at all.
 */
export async function resultsChildren(
  node: ResultsNode | undefined,
  sources: ResultsSources,
): Promise<readonly ResultsNode[]> {
  if (node === undefined) return [CURRENT_GROUP, HISTORY_GROUP, DIAGNOSTICS_GROUP];
  if (node.kind !== "group") return [];
  if (node.group === "current") return currentChildren(sources.artifacts());
  if (node.group === "diagnostics") return sources.diagnostics().rows.map((row) => ({ kind: "diagnostic", row }));
  return historyChildren(await sources.history(), sources.now());
}

function currentChildren(list: ArtifactList): ResultsNode[] {
  if (list.kind === "loading") return [{ kind: "message", text: "Scanning .ai/ …" }];
  if (list.kind === "empty" || list.kind === "error") return [{ kind: "message", text: list.detail }];
  return list.entries.map((entry) => ({ kind: "artifact", entry }));
}

function historyChildren(list: HistoryList, nowMs: number): ResultsNode[] {
  if (list.kind === "loading") return [{ kind: "message", text: "Loading …" }];
  if (list.kind === "empty") return [{ kind: "message", text: list.detail }];
  return list.items.map((item) => ({
    kind: "workItem",
    workItemId: item.workItemId,
    ...historyRow(item, nowMs),
  }));
}

/** Everything a `TreeItem` needs, as plain values. */
export interface ResultsItem {
  readonly label: string;
  /** Only the groups have one: a row's identity is its place under its group. */
  readonly id?: string;
  readonly description?: string;
  readonly tooltip?: string;
  readonly accessibleName?: string;
  /** A codicon name. */
  readonly icon: string;
  readonly collapsible: "none" | "collapsed" | "expanded";
  readonly contextValue?: string;
  readonly command?: { readonly command: string; readonly title: string; readonly arguments: readonly unknown[] };
}

/** How one node is drawn. `workItemId` is the work item open in the panel. */
export function resultsItem(node: ResultsNode, workItemId: string | undefined): ResultsItem {
  switch (node.kind) {
    case "group":
      return node.group === "current"
        ? currentGroupItem(workItemId)
        : node.group === "history"
          ? HISTORY_GROUP_ITEM
          : DIAGNOSTICS_GROUP_ITEM;
    case "diagnostic":
      // The label, the value beside it, the rest on hover. No command and no
      // context value: these rows say how things stand. Jira is set from the
      // Workflow row, which the Jira row's tooltip says.
      return {
        label: node.row.label,
        description: node.row.value,
        tooltip: diagnosticTooltip(node.row),
        accessibleName: `${node.row.label}, ${node.row.value}`,
        icon: DIAGNOSTIC_ICONS[node.row.label] ?? "info",
        collapsible: "none",
      };
    case "artifact": {
      const row = artifactRow(node.entry);
      return {
        label: row.label,
        description: row.description,
        tooltip: row.tooltip,
        accessibleName: row.accessibleName,
        icon: row.icon,
        collapsible: "none",
        // A file not written yet opens nothing: there is no empty file to make.
        ...(row.opens ? { command: { command: COMMANDS.openArtifact, title: "Open", arguments: [row.label] } } : {}),
      };
    }
    case "workItem":
      return {
        label: node.label,
        description: node.description,
        // Joined here rather than in the model: the newline is this renderer's
        // business, and a MarkdownString would make the text a formatting
        // language that a Jira title has to be escaped for.
        tooltip: node.tooltip.join("\n"),
        // The outcome, so a successful investigation, a failed one and a
        // directory whose run died halfway are three different rows.
        icon: node.icon,
        collapsible: "none",
        contextValue: HISTORY_ITEM_CONTEXT,
        command: { command: COMMANDS.showWorkItem, title: "Show", arguments: [node.workItemId] },
      };
    case "message":
      return { label: node.text, icon: "info", collapsible: "none" };
  }
}

/**
 * Current: always there and expanded, so the tree keeps its shape with nothing
 * open. Its description is the work item's id — otherwise a developer with two
 * work items in History cannot tell whose files these are.
 */
function currentGroupItem(workItemId: string | undefined): ResultsItem {
  return {
    label: "Current",
    id: "bugpilot.results.current",
    ...(workItemId === undefined ? {} : { description: workItemId }),
    tooltip:
      workItemId === undefined
        ? "The files of the work item open in the Workflow panel. None is open."
        : `The files of the work item open in the Workflow panel: ${workItemId}.`,
    accessibleName: workItemId === undefined ? "Current" : `Current, ${workItemId}`,
    icon: "folder-active",
    collapsible: "expanded",
  };
}

/** History: collapsed until the developer opens it, which is when it is read. */
const HISTORY_GROUP_ITEM: ResultsItem = {
  label: "History",
  id: "bugpilot.results.history",
  tooltip: "Every work item in this repository's .ai/, most recently changed first. Click one to reopen it.",
  accessibleName: "History",
  icon: "history",
  collapsible: "collapsed",
};

/**
 * Diagnostics (§37.110): last and collapsed, because it is reference — which
 * repository, which CLI, which agent — and not something a developer reads on
 * every run. It was a disclosure at the foot of the Workflow panel.
 */
const DIAGNOSTICS_GROUP_ITEM: ResultsItem = {
  label: "Diagnostics",
  id: "bugpilot.results.diagnostics",
  tooltip: "What BugPilot is configured with: the repository, Jira, the AI agent, the work item, the versions, where the CLI comes from and the BugPilot runtime. Nothing here checks anything.",
  accessibleName: "Diagnostics",
  icon: "pulse",
  collapsible: "collapsed",
};

/**
 * Each diagnostic's icon, by its label. Checked against the codicon font's own
 * glyph names: a name VS Code does not know renders as nothing at all. Jira's
 * is the key the Workflow row wears; the work item's, the Issue field's.
 */
const DIAGNOSTIC_ICONS: Readonly<Record<string, string>> = {
  Repository: "repo",
  Jira: "key",
  "AI agent": "hubot",
  "Work item": "issues",
  Extension: "extensions",
  "BugPilot CLI": "terminal",
  "CLI source": "location",
  "BugPilot runtime": "package",
};
