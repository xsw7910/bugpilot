/**
 * What the page draws for Effective Output and Protected Rules (0.1.4): the
 * three Advanced Settings rows and the three read-only views, built from what
 * the CLI said (through `Pane`) and from what the host already knows. The page
 * decides nothing — not whether a context is current, not which section is
 * protected.
 *
 * Node-only: no `vscode` import.
 */

import type { PaneState, PaneStatus } from "./effectivePane.ts";
import type { TaskPreviewSnapshot, TaskPreviewView } from "./effectiveTask.ts";
import { taskPreviewView } from "./effectiveTask.ts";
import type { ContextPreviewSnapshot, ContextStatusView, PanelFreshness } from "./effectiveContext.ts";
import { contextStatusView } from "./effectiveContext.ts";
import type { ProtectedRulesSnapshot } from "./protectedRules.ts";

/** Said when the installed CLI predates a view. Never a reason to block preparing a task. */
export const EFFECTIVE_UNSUPPORTED = {
  task: "The installed BugPilot CLI cannot preview the AI task. Update it to see the Effective AI Task here.",
  context: "The installed BugPilot CLI cannot show the generated context. Update it to see the Effective Context here.",
  rules: "The installed BugPilot CLI cannot list its protected rules. Update it to see them here.",
} as const;

/** One Advanced Settings row: a line of state, and whether View opens anything. */
export interface EffectiveRowView {
  readonly status: string;
  readonly canView: boolean;
  /** Why View is off, when it is: an older CLI, or BugPilot not ready. */
  readonly unavailable: string;
}

export interface EffectiveRowsView {
  readonly task: EffectiveRowView;
  readonly context: EffectiveRowView;
  readonly rules: EffectiveRowView;
}

export const EFFECTIVE_ROWS_EMPTY: EffectiveRowsView = {
  task: { status: "", canView: false, unavailable: "" },
  context: { status: "", canView: false, unavailable: "" },
  rules: { status: "", canView: false, unavailable: "" },
};

/** The rows, from the host's own state: no CLI is asked to draw them. */
export function effectiveRowsView(options: {
  readonly ready: boolean;
  readonly supports: { readonly task: boolean; readonly context: boolean; readonly rules: boolean };
  /** The work item on screen, if any. */
  readonly workItemId?: string;
  /** Its package is prepared, and by the panel's fingerprints it needs a rebuild. */
  readonly prepared: boolean;
  readonly needsRebuild: boolean;
}): EffectiveRowsView {
  if (!options.ready) return EFFECTIVE_ROWS_EMPTY;
  const row = (supported: boolean, unsupported: string, status: string): EffectiveRowView =>
    supported ? { status, canView: true, unavailable: "" } : { status: "", canView: false, unavailable: unsupported };
  const id = options.workItemId;
  const taskStatus = id === undefined ? "Template — no work item selected" : `For ${id}${options.prepared && options.needsRebuild ? " · Needs rebuild" : ""}`;
  // Only what the panel knows for certain: whether it is current is the view's to say, with the CLI.
  const contextStatus =
    id === undefined
      ? "No work item selected"
      : !options.prepared
        ? `${id} · not prepared yet`
        : options.needsRebuild
          ? `${id} · Needs rebuild`
          : `${id} · prepared`;
  return {
    task: row(options.supports.task, EFFECTIVE_UNSUPPORTED.task, taskStatus),
    context: row(options.supports.context, EFFECTIVE_UNSUPPORTED.context, contextStatus),
    rules: row(options.supports.rules, EFFECTIVE_UNSUPPORTED.rules, "Built into BugPilot · read-only"),
  };
}

interface PaneBase {
  readonly token: number;
  readonly status: PaneStatus;
  /** A failure in one sentence, or why the view is unavailable. */
  readonly message: string;
  readonly refreshing: boolean;
  /** BugPilot is busy: what is shown is from before, not current, and is asked again after. */
  readonly held: boolean;
  /** What is shown answers the current request: only then may it be copied. */
  readonly current: boolean;
}

export interface EffectiveTaskPaneView extends PaneBase {
  readonly view?: TaskPreviewView;
  /** The panel's own verdict for the work item on screen: a rebuild is needed before an agent is handed it. */
  readonly needsRebuild: boolean;
}

export interface EffectiveContextPaneView extends PaneBase {
  readonly view?: ContextStatusView;
}

export interface ProtectedRulesPaneView extends PaneBase {
  readonly rules?: ProtectedRulesSnapshot;
}

function base<T>(pane: PaneState<T>, unsupported: string): PaneBase {
  return {
    token: pane.token,
    status: pane.status,
    message: pane.status === "unsupported" ? unsupported : pane.message ?? "",
    refreshing: pane.refreshing,
    held: pane.held,
    current: pane.current,
  };
}

export function effectiveTaskPaneView(pane: PaneState<TaskPreviewSnapshot>, needsRebuild: boolean): EffectiveTaskPaneView {
  const snapshot = pane.snapshot;
  return {
    ...base(pane, EFFECTIVE_UNSUPPORTED.task),
    ...(snapshot === undefined ? {} : { view: taskPreviewView(snapshot) }),
    // Only a work item's task can need a rebuild; a template is built fresh every time.
    needsRebuild: snapshot?.kind === "active-work-item" && needsRebuild,
  };
}

export function effectiveContextPaneView(
  pane: PaneState<ContextPreviewSnapshot>,
  panel: (snapshot: ContextPreviewSnapshot) => PanelFreshness,
): EffectiveContextPaneView {
  const snapshot = pane.snapshot;
  return {
    ...base(pane, EFFECTIVE_UNSUPPORTED.context),
    ...(snapshot === undefined ? {} : { view: contextStatusView(snapshot, panel(snapshot)) }),
  };
}

export function protectedRulesPaneView(pane: PaneState<ProtectedRulesSnapshot>): ProtectedRulesPaneView {
  return {
    ...base(pane, EFFECTIVE_UNSUPPORTED.rules),
    ...(pane.snapshot === undefined ? {} : { rules: pane.snapshot }),
  };
}
