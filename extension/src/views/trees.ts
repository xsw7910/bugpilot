/**
 * The two native tree views: this work item's artifacts, and the history.
 *
 * Native rather than more webview, for the reason §5.3 gives: a tree is what
 * VS Code's own TreeView is for, and reimplementing one in HTML would be worse
 * in every way — including the codicons, which come free here.
 *
 * All the shaping happened in `src/app/artifacts.ts`. These classes only turn
 * the resulting values into `TreeItem`s, which is why the three states each
 * view must have (§5.4) show up here as one placeholder row each.
 */

import * as vscode from "vscode";

import { GROUP_LABELS, historyRow } from "../app/artifacts.ts";
import type {
  ArtifactEntry,
  ArtifactList,
  ArtifactSection,
  HistoryList,
  HistoryRow,
} from "../app/artifacts.ts";
import { COMMANDS, HISTORY_ITEM_CONTEXT } from "../commands.ts";

type ArtifactNode =
  | { readonly kind: "section"; readonly section: ArtifactSection }
  | { readonly kind: "entry"; readonly entry: ArtifactEntry }
  | { readonly kind: "message"; readonly text: string };

export class ArtifactsTree implements vscode.TreeDataProvider<ArtifactNode>, vscode.Disposable {
  readonly #changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.#changed.event;
  readonly #read: () => ArtifactList;

  constructor(read: () => ArtifactList) {
    this.#read = read;
  }

  /** Disposing the tree view does not dispose an emitter we created. */
  dispose(): void {
    this.#changed.dispose();
  }

  refresh(): void {
    this.#changed.fire();
  }

  getChildren(node?: ArtifactNode): ArtifactNode[] {
    if (!node) {
      const list = this.#read();
      if (list.kind === "loading") return [{ kind: "message", text: "Scanning .ai/ …" }];
      if (list.kind === "empty" || list.kind === "error") {
        return [{ kind: "message", text: list.detail }];
      }
      return list.sections.map((section) => ({ kind: "section", section }));
    }
    if (node.kind === "section") {
      return node.section.entries.map((entry) => ({ kind: "entry", entry }));
    }
    return [];
  }

  getTreeItem(node: ArtifactNode): vscode.TreeItem {
    if (node.kind === "message") {
      const item = new vscode.TreeItem(node.text);
      item.iconPath = new vscode.ThemeIcon("info");
      return item;
    }
    if (node.kind === "section") {
      const item = new vscode.TreeItem(
        GROUP_LABELS[node.section.group],
        vscode.TreeItemCollapsibleState.Expanded,
      );
      item.contextValue = "bugpilot.section";
      return item;
    }

    const { entry } = node;
    const item = new vscode.TreeItem(entry.name);
    if (entry.missing) {
      // A result file the agent has not written yet. Shown, because "what is
      // still missing" is the question `check-results` answers.
      item.description = "not written yet";
      item.iconPath = new vscode.ThemeIcon("circle-outline");
      item.tooltip = `${entry.name} has not been written yet.`;
      return item;
    }
    item.iconPath = new vscode.ThemeIcon(
      entry.kind === "markdown" ? "markdown" : entry.kind === "json" ? "json" : "output",
    );
    item.command = {
      command: COMMANDS.openArtifact,
      title: "Open",
      arguments: [entry.name],
    };
    return item;
  }
}

/**
 * A history row.
 *
 * `workItemId` is first because it is also the argument: a context-menu command
 * receives this object, and that field is what it acts on.
 */
type HistoryNode = { readonly workItemId: string } & HistoryRow;



export class HistoryTree
  implements vscode.TreeDataProvider<HistoryNode | { message: string }>, vscode.Disposable
{
  readonly #changed = new vscode.EventEmitter<void>();
  readonly onDidChangeTreeData = this.#changed.event;
  readonly #load: () => Promise<HistoryList>;
  readonly #now: () => number;

  constructor(load: () => Promise<HistoryList>, now: () => number = Date.now) {
    this.#load = load;
    this.#now = now;
  }

  dispose(): void {
    this.#changed.dispose();
  }

  refresh(): void {
    this.#changed.fire();
  }

  async getChildren(node?: HistoryNode | { message: string }): Promise<(HistoryNode | { message: string })[]> {
    if (node) return [];
    const list = await this.#load();
    if (list.kind === "loading") return [{ message: "Loading …" }];
    if (list.kind === "empty") return [{ message: list.detail }];
    const now = this.#now();
    return list.items.map((item) => ({
      workItemId: item.workItemId,
      ...historyRow(item, now),
    }));
  }

  getTreeItem(node: HistoryNode | { message: string }): vscode.TreeItem {
    if ("message" in node) {
      const item = new vscode.TreeItem(node.message);
      item.iconPath = new vscode.ThemeIcon("info");
      return item;
    }
    const item = new vscode.TreeItem(node.label);
    item.description = node.description;
    // The outcome, so a successful investigation, a failed one and a directory
    // whose run died halfway are three different rows rather than three
    // identical ones.
    item.iconPath = new vscode.ThemeIcon(node.icon);
    // Joined here rather than in the model: the newline is this renderer's
    // business, and a MarkdownString would make the text a formatting language
    // that a Jira title has to be escaped for.
    item.tooltip = node.tooltip.join("\n");
    item.contextValue = HISTORY_ITEM_CONTEXT;
    item.command = {
      command: COMMANDS.showWorkItem,
      title: "Show",
      arguments: [node.workItemId],
    };
    return item;
  }
}
