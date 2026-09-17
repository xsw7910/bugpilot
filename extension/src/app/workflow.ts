/**
 * The one list the panel shows: investigation and the AI fix, as six steps.
 *
 * Before this, the panel had an "Investigate" fieldset of checkboxes, a
 * "Progress" checklist that repeated the same five labels, and a "Hand off"
 * card that appeared afterwards with three buttons. Three places to look for
 * one linear thing. This module is the merge: **one row per step, carrying both
 * the choice and the outcome**.
 *
 * It is a view model, computed by the host on every push, because the page
 * cannot import any of this (no bundler — see `panel/messages.ts`). The page
 * owns exactly one thing about these rows: the checkbox. Everything else here
 * is host-computed and the page only renders it.
 *
 * Two things are deliberately not symmetric with the rest:
 *
 *  - **`fixWithAI` is not a CLI capability.** The other five come out of the
 *    event stream; this one is an action the extension takes after the run, so
 *    its status comes from the controller rather than from a step event.
 *  - **It never reports "complete".** The agent runs in a terminal the
 *    extension does not own, so "the AI finished" is not knowable here. The
 *    honest end state is that it was handed over, which is what `detail` says.
 */

import type { PlanState, Source } from "./form.ts";
import type { ProgressView, RowState } from "./progress.ts";

export type WorkflowStepId =
  | "issueDetails"
  | "codeSearch"
  | "gitHistory"
  | "similarFixes"
  | "buildContext"
  | "fixWithAI";

/** Top to bottom, which is also the order they run in. */
export const WORKFLOW_STEP_IDS: readonly WorkflowStepId[] = [
  "issueDetails",
  "codeSearch",
  "gitHistory",
  "similarFixes",
  "buildContext",
  "fixWithAI",
];

export type StepStatus = "idle" | "running" | "success" | "failed" | "skipped";

/** An icon button offered on a step's own row, once that step has produced it. */
export type StepActionId = "openContext" | "copyHandoff" | "openFolder";

export interface WorkflowStep {
  readonly id: WorkflowStepId;
  readonly label: string;
  readonly description: string;
  readonly enabled: boolean;
  /** Runs whichever way the boxes are ticked: it is the input, not an option. */
  readonly required?: boolean;
  readonly status: StepStatus;
  readonly durationMs?: number;
  /**
   * What actually happened, when the status alone would be ambiguous.
   *
   * Only `fixWithAI` uses it today: "handed to claude in a terminal" and "no
   * agent CLI found, so the prompt is on the clipboard" are both non-failures
   * that a green tick would misrepresent.
   */
  readonly detail?: string;
  /** Empty until the step has something to offer. */
  readonly actions: readonly StepActionId[];
}

export const STEP_LABELS: Readonly<Record<WorkflowStepId, string>> = {
  issueDetails: "Issue details",
  codeSearch: "Code search",
  gitHistory: "Git history",
  similarFixes: "Similar fixes",
  buildContext: "Build context",
  fixWithAI: "Fix with AI",
};

const STEP_DESCRIPTIONS: Readonly<Record<Exclude<WorkflowStepId, "issueDetails">, string>> = {
  codeSearch: "Search relevant code in the repository",
  gitHistory: "Find recent related changes",
  similarFixes: "Search for similar issues and solutions",
  buildContext: "Prepare structured context for AI",
  fixWithAI: "Run the prepared context with your AI coding agent",
};

/**
 * One line under each label, saying what the step does.
 *
 * `issueDetails` depends on the input source: "Fetch Jira issue information" is
 * simply untrue for a bug the developer typed out.
 *
 * Exported because the markup carries these too. The host pushes the same text
 * on every render, but a page built before the first push would otherwise show
 * six labels with nothing under them — the same reason the checkboxes carry
 * their defaults in the markup.
 */
export function stepDescription(id: WorkflowStepId, source: Source): string {
  if (id !== "issueDetails") return STEP_DESCRIPTIONS[id];
  return source === "jira" ? "Fetch Jira issue information" : "Parse the description you wrote";
}

/** How the AI step ended, as the controller observed it. */
export interface FixWithAiOutcome {
  readonly status: StepStatus;
  readonly detail?: string;
}

export interface WorkflowInput {
  readonly source: Source;
  readonly plan: PlanState;
  /** Whether the developer ticked the last row. */
  readonly fixWithAI: boolean;
  readonly progress: ProgressView;
  /** Absent until the AI step has been attempted. */
  readonly fix?: FixWithAiOutcome;
  /**
   * The file names currently in `.ai/<work_item>/`.
   *
   * What decides whether a row can offer an action, in preference to the run's
   * own state: an icon is offered because the file it opens is there. Keying
   * off a step event instead would put an icon on screen for a file the run did
   * not get around to writing — and would hide the icons for a work item
   * restored from History, where there is no event stream at all.
   */
  readonly artifacts: readonly string[];
}

/** Which file each icon needs before it is worth offering. */
const ACTION_REQUIREMENTS: readonly { readonly id: StepActionId; readonly file?: string }[] = [
  { id: "openContext", file: "bug_context.md" },
  { id: "copyHandoff", file: "agent_task.md" },
  // The directory itself, which exists as soon as anything is in it.
  { id: "openFolder" },
];

/** The five capability rows, in `progress.ts` terms. */
const CAPABILITY_OF: Readonly<Record<Exclude<WorkflowStepId, "fixWithAI">, string>> = {
  issueDetails: "issue_details",
  codeSearch: "code_search",
  gitHistory: "git_history",
  similarFixes: "similar_fixes",
  buildContext: "build_context",
};

const STATUS_OF_ROW: Readonly<Record<RowState, StepStatus>> = {
  pending: "idle",
  running: "running",
  done: "success",
  skipped: "skipped",
  failed: "failed",
};

export function buildWorkflow(input: WorkflowInput): readonly WorkflowStep[] {
  const rows = new Map(input.progress.rows.map((row) => [row.capability as string, row]));
  const present = new Set(input.artifacts);
  const available = ACTION_REQUIREMENTS.filter(
    (action) => (action.file ? present.has(action.file) : present.size > 0),
  ).map((action) => action.id);

  return WORKFLOW_STEP_IDS.map((id): WorkflowStep => {
    if (id === "fixWithAI") {
      return {
        id,
        label: STEP_LABELS[id],
        description: stepDescription(id, input.source),
        enabled: input.fixWithAI,
        status: input.fix?.status ?? "idle",
        ...(input.fix?.detail === undefined ? {} : { detail: input.fix.detail }),
        actions: [],
      };
    }
    const row = rows.get(CAPABILITY_OF[id]);
    const required = id === "issueDetails";
    return {
      id,
      label: STEP_LABELS[id],
      description: stepDescription(id, input.source),
      enabled: required ? true : input.plan[id],
      ...(required ? { required: true } : {}),
      status: row ? STATUS_OF_ROW[row.state] : "idle",
      ...(row?.durationMs === undefined ? {} : { durationMs: row.durationMs }),
      // The icons arrive with the files rather than sitting there greyed out
      // from the start — a disabled icon invites a click that explains nothing.
      actions: id === "buildContext" ? available : [],
    };
  });
}

export type OverallKind = "idle" | "running" | "done" | "failed";

export interface OverallStatus {
  readonly kind: OverallKind;
  /** Short enough for the corner of the workflow header. */
  readonly text: string;
}

/**
 * The compact status in the workflow header.
 *
 * "Complete" is not among the answers, and that is the point: once the handoff
 * reaches a terminal, the extension has no way to know what the agent did with
 * it. "AI fix started" is the last thing it can honestly claim.
 */
export function overallStatus(
  steps: readonly WorkflowStep[],
  progress: ProgressView,
): OverallStatus {
  const chosen = steps.filter((step) => step.enabled);
  if (progress.state === "running") {
    const finished = chosen.filter((step) =>
      step.status === "success" || step.status === "skipped",
    ).length;
    // 1-based on the step in flight, so the first row reads "1/6" rather than
    // "0/6" while it is visibly working.
    const at = Math.min(finished + 1, chosen.length);
    return { kind: "running", text: `Running ${at}/${chosen.length}…` };
  }
  if (progress.state === "failed") return { kind: "failed", text: "Run failed" };
  if (progress.state === "stopped") return { kind: "idle", text: "Stopped" };
  if (progress.state === "done") {
    const fix = steps.find((step) => step.id === "fixWithAI");
    if (fix?.enabled && fix.status === "success") {
      return { kind: "done", text: "AI fix started" };
    }
    if (fix?.enabled && fix.status === "failed") {
      return { kind: "failed", text: "AI fix did not start" };
    }
    return { kind: "done", text: "Context ready" };
  }
  return { kind: "idle", text: "Ready to run" };
}
