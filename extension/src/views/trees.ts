/**
 * The native tree view: Results, with this work item's artifacts (Current),
 * the history and the diagnostics, as three groups of one view (§37.106,
 * §37.110).
 *
 * Native rather than more webview, for the reason §5.3 gives: a tree is what
 * VS Code's own TreeView is for, and reimplementing one in HTML would be worse
 * in every way — including the codicons, which come free here.
 *
 * All the shaping happened in `src/app/artifacts.ts` and `src/app/results.ts`.
 * This class only turns the resulting values into `TreeItem`s.
 */

import * as vscode from "vscode";

import { CURRENT_GROUP, DIAGNOSTICS_GROUP, resultsChildren, resultsItem } from "../app/results.ts";
import type { ResultsItem, ResultsNode, ResultsSources } from "../app/results.ts";

const COLLAPSIBLE: Readonly<Record<ResultsItem["collapsible"], vscode.TreeItemCollapsibleState>> = {
  none: vscode.TreeItemCollapsibleState.None,
  collapsed: vscode.TreeItemCollapsibleState.Collapsed,
  expanded: vscode.TreeItemCollapsibleState.Expanded,
};

export class ResultsTree implements vscode.TreeDataProvider<ResultsNode>, vscode.Disposable {
  readonly #changed = new vscode.EventEmitter<ResultsNode | undefined>();
  readonly onDidChangeTreeData = this.#changed.event;
  readonly #sources: ResultsSources;
  readonly #workItemId: () => string | undefined;
  /** The diagnostics last drawn, as JSON, so an unchanged push redraws nothing. */
  #shownDiagnostics: string | undefined;

  constructor(sources: ResultsSources, workItemId: () => string | undefined) {
    this.#sources = sources;
    this.#workItemId = workItemId;
  }

  /** Disposing the tree view does not dispose an emitter we created. */
  dispose(): void {
    this.#changed.dispose();
  }

  /** Both groups. History is read again only if it is expanded. */
  refresh(): void {
    this.#changed.fire(undefined);
  }

  /** Current alone — its files and the id on its row — without a `bugpilot list`. */
  refreshCurrent(): void {
    this.#changed.fire(CURRENT_GROUP);
  }

  /**
   * Diagnostics alone, and only when what it shows has changed (§37.110).
   *
   * Called with every panel push, which is when the host's state changes — a
   * credential saved, a repository found, an agent resolved, a work item
   * opened. It compares state the host already holds and fires nothing for an
   * unchanged push: no timer, no request, and never `bugpilot list`.
   */
  syncDiagnostics(): void {
    const next = JSON.stringify(this.#sources.diagnostics());
    if (next === this.#shownDiagnostics) return;
    this.#shownDiagnostics = next;
    this.#changed.fire(DIAGNOSTICS_GROUP);
  }

  async getChildren(node?: ResultsNode): Promise<ResultsNode[]> {
    return [...(await resultsChildren(node, this.#sources))];
  }

  getTreeItem(node: ResultsNode): vscode.TreeItem {
    const view = resultsItem(node, this.#workItemId());
    const item = new vscode.TreeItem(view.label, COLLAPSIBLE[view.collapsible]);
    if (view.id !== undefined) item.id = view.id;
    if (view.description !== undefined) item.description = view.description;
    if (view.tooltip !== undefined) item.tooltip = view.tooltip;
    if (view.accessibleName !== undefined) item.accessibilityInformation = { label: view.accessibleName };
    item.iconPath = new vscode.ThemeIcon(view.icon);
    if (view.contextValue !== undefined) item.contextValue = view.contextValue;
    if (view.command !== undefined) item.command = { ...view.command, arguments: [...view.command.arguments] };
    return item;
  }
}
