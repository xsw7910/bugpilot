/**
 * The one list the panel shows: investigation and the AI fix, as six steps —
 * and, since Batch 6, the place their results live.
 *
 * Before phase 5 the panel had an "Investigate" fieldset of checkboxes, a
 * "Progress" checklist that repeated the same five labels, and a "Hand off"
 * card. Phase 5 merged those into one row per step, carrying both the choice
 * and the outcome. The results still lived elsewhere, though — a Context Ready
 * card above the rows held the counts, the files, the terms, the context
 * actions and the Fix with AI button. Batch 6 finishes the merge: **a step owns
 * its result, its canonical artifact and its actions**, so each row here is a
 * `WorkflowStepResult` and the page renders nothing about a run that is not on
 * one of them.
 *
 * It is a view model, computed by the host on every push, because the page
 * cannot import any of this (no bundler — see `panel/messages.ts`). The page
 * owns exactly one thing about these rows: the checkbox.
 *
 * Every word a row says is derived from real state — the run's step marks (the
 * live stream, or `run.json` for a reopened work item), the files on disk, and
 * the two artifacts the host parses (`issue.json`, `retrieval.json`). Where no
 * structured result exists, the row says only what is known: Git history and
 * Similar fixes say "Completed", because their results live inside `context.md`
 * by design (§37, Batch 3) and are not parsed out of prose for a summary line.
 *
 * `fixWithAI` is not a CLI capability: it is an action the extension takes, so
 * its state comes from the controller. It never reports "complete" — the agent
 * runs in a terminal the extension does not own — and a prepared task that has
 * not been handed over is `ready`, never the green tick.
 */

import { CONTEXT_ARTIFACT, FIX_REPORT_ARTIFACT, TASK_ARTIFACT } from "./artifacts.ts";
import type { RelevantFile } from "./contextSummary.ts";
import type { UserFacingError } from "./failures.ts";
import type { FixReportPreview } from "./fixReport.ts";
import type { PlanState, Source } from "./form.ts";
import { HANDOFF_STARTED_TITLE } from "./handoff.ts";
import type { IssueSummary } from "./issue.ts";
import { ISSUE_ARTIFACT } from "./issue.ts";
import type { Capability, ProgressView, RowState } from "./progress.ts";
import { RETRIEVAL_ARTIFACT } from "./retrieval.ts";
import type { RetrievalTerm } from "./retrievalDetails.ts";

export type WorkflowStepId =
  | "issueDetails"
  | "codeSearch"
  | "gitHistory"
  | "similarFixes"
  | "buildContext"
  | "fixWithAI"
  | "fixResult";

/**
 * The six steps a developer chooses, top to bottom, which is also the order
 * they run in.
 *
 * `fixResult` is not among them: nobody ticks it and no run performs it. It is
 * a row that exists only while `fix_report.md` does (Batch 8), after these six.
 */
export const WORKFLOW_STEP_IDS: readonly Exclude<WorkflowStepId, "fixResult">[] = [
  "issueDetails",
  "codeSearch",
  "gitHistory",
  "similarFixes",
  "buildContext",
  "fixWithAI",
];

/**
 * How a row stands.
 *
 * `ready` exists for one row and one reason: a task on disk that nobody has
 * handed over yet. It is not `success` — the green tick is reserved for a
 * handoff that actually started — and not `idle`, which would hide that there
 * is something to press.
 */
export type StepStatus = "idle" | "running" | "success" | "ready" | "failed" | "skipped";

/** An action a row offers, once that row has produced what it acts on. */
export type StepActionId = "openContext" | "copyContext" | "fixWithAI" | "openFixReport";

/** What Code search found, from `retrieval.json`, for its two disclosures. */
export interface SearchContent {
  readonly files: readonly RelevantFile[];
  /** How many the artifact held beyond `files`, when it held more. */
  readonly moreFiles?: number;
  readonly terms: readonly RetrievalTerm[];
}

export interface WorkflowStepResult {
  readonly id: WorkflowStepId;
  readonly label: string;
  /** What the step does. Also the markup's text before the first push. */
  readonly description: string;
  readonly enabled: boolean;
  /** Runs whichever way the boxes are ticked: it is the input, not an option. */
  readonly required?: boolean;
  readonly status: StepStatus;
  /**
   * The row's state in words, where the status's own word would say too little.
   *
   * Only Fix result sets it: "ready" is true of a report but does not say what
   * is ready, and the words are what a screen reader announces.
   */
  readonly statusLabel?: string;
  readonly durationMs?: number;
  /**
   * The row's secondary line, for the state it is in.
   *
   * The description while pending, what it is doing while running, and what it
   * produced once done — a finished step that still says what it plans to do is
   * a step that looks like it did nothing.
   */
  readonly summary: string;
  /** A quieter second line, when the result has one: the issue's title, which agent. */
  readonly detail?: string;
  /** The mode the task was prepared with. Fix with AI only: `task.md` carries it. */
  readonly strategy?: string;
  /**
   * The canonical artifact this step owns, once it produced it.
   *
   * A plain file name inside the work item directory, opened through the
   * constrained `openArtifact` message — never a path. Absent while the row
   * has not produced it, so a mid-run row cannot offer the last run's file.
   */
  readonly artifact?: string;
  readonly actions: readonly StepActionId[];
  /** Code search only: which files and which terms. */
  readonly search?: SearchContent;
  /**
   * A failure this row owns.
   *
   * The run's, on the row whose step was in flight when it failed; the
   * handoff's, on Fix with AI. The rows before it keep their results — a later
   * failure never replaces the whole workflow with one card.
   */
  readonly error?: UserFacingError;
}

export const STEP_LABELS: Readonly<Record<WorkflowStepId, string>> = {
  issueDetails: "Issue details",
  codeSearch: "Code search",
  gitHistory: "Git history",
  similarFixes: "Similar fixes",
  buildContext: "Build context",
  fixWithAI: "Fix with AI",
  fixResult: "Fix result",
};

const STEP_DESCRIPTIONS: Readonly<Record<Exclude<WorkflowStepId, "issueDetails">, string>> = {
  codeSearch: "Search relevant code in the repository",
  gitHistory: "Find recent related changes",
  similarFixes: "Search for similar issues and solutions",
  buildContext: "Prepare structured context for AI",
  fixWithAI: "Run the prepared context with your AI coding agent",
  fixResult: "The report the agent wrote in fix_report.md",
};

/** What a row says while it is the one working. */
const RUNNING_TEXT: Readonly<Record<Exclude<WorkflowStepId, "issueDetails" | "fixWithAI" | "fixResult">, string>> = {
  codeSearch: "Searching repository…",
  gitHistory: "Collecting git history…",
  similarFixes: "Searching past fixes…",
  buildContext: "Building context…",
};

/**
 * One line under each label, saying what the step does.
 *
 * `issueDetails` depends on the input source: "Fetch Jira issue information" is
 * simply untrue for a bug the developer typed out.
 *
 * Exported because the markup carries these too: a page built before the first
 * push would otherwise show six labels with nothing under them.
 */
export function stepDescription(id: WorkflowStepId, source: Source): string {
  if (id !== "issueDetails") return STEP_DESCRIPTIONS[id];
  return source === "jira" ? "Fetch Jira issue information" : "Parse the description you wrote";
}

/** How the AI step ended, as the controller observed it. */
export interface FixWithAiOutcome {
  readonly status: Exclude<StepStatus, "ready">;
  readonly detail?: string;
}

/** What `retrieval.json` said, already projected by the host. */
export interface SearchResult {
  readonly relevantFiles?: number;
  readonly searchTerms?: number;
  readonly content: SearchContent;
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
   * What decides whether a row can offer an artifact or an action: an action is
   * offered because the file it opens is there, and — together with the row's
   * own state — because this run produced it.
   */
  readonly artifacts: readonly string[];
  readonly workItemId?: string;
  /** `issue.json`, parsed; absent when it is missing or unreadable. */
  readonly issue?: IssueSummary;
  /** `retrieval.json`, projected; absent when it is missing or unreadable. */
  readonly search?: SearchResult;
  /** True while a handoff is being resolved, which spawns a probe. */
  readonly handoffBusy?: boolean;
  /** Why the last handoff could not start. */
  readonly handoffError?: UserFacingError;
  /** Why the last run did not finish, when a row can own it. */
  readonly runError?: UserFacingError;
  /** The prepared Fix Mode, as one line. */
  readonly strategy?: string;
  /**
   * `fix_report.md`, projected to two lines; absent when it was not read.
   *
   * Whether the Fix result row exists is the listing's to say, not this: a
   * listed report that could not be read still gets its row.
   */
  readonly fixReport?: FixReportPreview;
}

/** The five capability rows, in `progress.ts` terms. */
const CAPABILITY_OF: Readonly<Record<Exclude<WorkflowStepId, "fixWithAI" | "fixResult">, Capability>> = {
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

/** A finished row with no summary of its own says this, and nothing invented. */
const FINISHED_TEXT: Readonly<Record<StepStatus, string>> = {
  idle: "",
  running: "",
  success: "Completed",
  ready: "Ready",
  failed: "Failed",
  skipped: "Skipped",
};

export function buildWorkflow(input: WorkflowInput): readonly WorkflowStepResult[] {
  const rows = new Map(input.progress.rows.map((row) => [row.capability as string, row]));
  const present = new Set(input.artifacts);
  const running = input.progress.state === "running";
  const failedCapability = input.progress.failure?.capability;

  const capabilityRows = new Map<WorkflowStepId, WorkflowStepResult>();
  for (const id of WORKFLOW_STEP_IDS) {
    if (id === "fixWithAI") continue;
    const row = rows.get(CAPABILITY_OF[id]);
    const required = id === "issueDetails";
    const status: StepStatus = row ? STATUS_OF_ROW[row.state] : "idle";
    const base = {
      id,
      label: STEP_LABELS[id],
      description: stepDescription(id, input.source),
      enabled: required ? true : input.plan[id],
      ...(required ? { required: true } : {}),
      status,
      ...(row?.durationMs === undefined ? {} : { durationMs: row.durationMs }),
      // The run's card, on the row whose step was in flight when it failed.
      ...(status === "failed" && input.runError && failedCapability === CAPABILITY_OF[id]
        ? { error: input.runError }
        : {}),
    };
    capabilityRows.set(id, { ...base, ...resultOf(id, status, input, present) });
  }

  const steps = WORKFLOW_STEP_IDS.map((id) =>
    id === "fixWithAI" ? fixWithAiRow(input, present, running, capabilityRows) : capabilityRows.get(id)!,
  );
  // Exactly while the report is on disk: listed, a row; not listed, none —
  // a run in flight included. Which listing a run keeps is the controller's.
  if (present.has(FIX_REPORT_ARTIFACT)) steps.push(fixResultRow(input));
  return steps;
}

/**
 * The seventh row, present only while `fix_report.md` is: what the report says.
 *
 * `ready`, never `success`: a report being there means there is something to
 * read, not that the bug is fixed — an investigation-only pass, a no-op and an
 * attempt whose tests still fail all write the same file. The summary and the
 * tests line are the agent's own first lines, unclassified; a report with
 * neither, or one that could not be read, is still a report to open.
 */
function fixResultRow(input: WorkflowInput): WorkflowStepResult {
  const report = input.fixReport;
  const detail = report === undefined || !report.readable
    ? "Preview unavailable"
    : report.tests === undefined
      ? undefined
      : `Tests: ${report.tests}`;
  return {
    id: "fixResult",
    label: STEP_LABELS.fixResult,
    description: STEP_DESCRIPTIONS.fixResult,
    enabled: true,
    status: "ready",
    statusLabel: "report available",
    summary: report?.summary ?? "Fix report available",
    ...(detail === undefined ? {} : { detail }),
    artifact: FIX_REPORT_ARTIFACT,
    actions: ["openFixReport"],
  };
}

/** What a capability row says and offers, for the state it is in. */
function resultOf(
  id: Exclude<WorkflowStepId, "fixWithAI" | "fixResult">,
  status: StepStatus,
  input: WorkflowInput,
  present: ReadonlySet<string>,
): Pick<WorkflowStepResult, "summary" | "detail" | "artifact" | "actions" | "search"> {
  const description = stepDescription(id, input.source);
  if (status === "idle") return { summary: description, actions: [] };
  if (status === "running") return { summary: runningText(id, input), actions: [] };
  if (status !== "success") return { summary: FINISHED_TEXT[status], actions: [] };

  // Finished, so the row says what it produced — from the artifacts, never
  // from what the step was supposed to do.
  switch (id) {
    case "issueDetails": {
      const issue = input.issue;
      const artifact = present.has(ISSUE_ARTIFACT) ? { artifact: ISSUE_ARTIFACT } : {};
      if (!issue) return { summary: FINISHED_TEXT.success, actions: [], ...artifact };
      const summary = issue.source === "jira" ? `${issue.id} · Jira issue` : "Manual bug description";
      return {
        summary,
        ...(issue.title === "" ? {} : { detail: issue.title }),
        actions: [],
        ...artifact,
      };
    }
    case "codeSearch": {
      const search = input.search;
      const artifact = present.has(RETRIEVAL_ARTIFACT) ? { artifact: RETRIEVAL_ARTIFACT } : {};
      const counted = search ? describeSearch(search) : "";
      const content = search?.content;
      const hasContent = content !== undefined && (content.files.length > 0 || content.terms.length > 0);
      return {
        summary: counted || FINISHED_TEXT.success,
        actions: [],
        ...artifact,
        ...(hasContent ? { search: content } : {}),
      };
    }
    case "buildContext": {
      // The actions arrive with the file rather than sitting there greyed out
      // from the start — a disabled button invites a click that explains nothing.
      if (!present.has(CONTEXT_ARTIFACT)) return { summary: FINISHED_TEXT.success, actions: [] };
      return {
        summary: "Context ready",
        artifact: CONTEXT_ARTIFACT,
        actions: ["openContext", "copyContext"],
      };
    }
    default:
      // Git history and Similar fixes: their results are inside `context.md`,
      // and there is no structured count to report without parsing prose.
      return { summary: FINISHED_TEXT.success, actions: [] };
  }
}

function runningText(id: Exclude<WorkflowStepId, "fixWithAI" | "fixResult">, input: WorkflowInput): string {
  if (id !== "issueDetails") return RUNNING_TEXT[id];
  if (input.source !== "jira") return "Reading the description…";
  return input.workItemId ? `Loading ${input.workItemId}…` : "Loading the Jira issue…";
}

/**
 * "11 terms · 6 relevant files", or nothing.
 *
 * Only the two numbers a developer can act on. Singular and plural are spelled
 * out because "1 relevant files" is the kind of detail that makes a panel look
 * unfinished; a list the artifact did not carry is left out, not reported as 0.
 */
export function describeSearch(search: Pick<SearchResult, "relevantFiles" | "searchTerms">): string {
  const parts: string[] = [];
  if (search.searchTerms !== undefined) parts.push(plural(search.searchTerms, "term"));
  if (search.relevantFiles !== undefined) parts.push(plural(search.relevantFiles, "relevant file"));
  return parts.join(" · ");
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

/**
 * The last row: what the extension did with the task, or can do with it.
 *
 * In order of precedence: a handoff being resolved, one that started, one that
 * could not start, one that was skipped, a task ready to hand over, and
 * otherwise waiting for a run to produce one.
 */
function fixWithAiRow(
  input: WorkflowInput,
  present: ReadonlySet<string>,
  running: boolean,
  rows: ReadonlyMap<WorkflowStepId, WorkflowStepResult>,
): WorkflowStepResult {
  const id: WorkflowStepId = "fixWithAI";
  const base = {
    id,
    label: STEP_LABELS[id],
    description: stepDescription(id, input.source),
    enabled: input.fixWithAI,
  };
  // A task this run produced: the file is there, the step that writes it
  // finished, and nothing is running that could replace it.
  const taskReady =
    !running && present.has(TASK_ARTIFACT) && rows.get("buildContext")?.status === "success";
  const prepared = {
    ...(taskReady ? { artifact: TASK_ARTIFACT } : {}),
    ...(taskReady && input.strategy ? { strategy: input.strategy } : {}),
  };

  if (input.handoffBusy) {
    return { ...base, status: "running", summary: "Starting AI fix…", actions: [], ...prepared };
  }
  const fix = input.fix;
  if (fix?.status === "success") {
    // "Started", and nothing further: the agent runs in a terminal this
    // extension does not own. No second press — it would open a second
    // terminal for the same package.
    return {
      ...base,
      status: "success",
      summary: HANDOFF_STARTED_TITLE,
      ...(fix.detail ? { detail: fix.detail } : {}),
      actions: [],
      ...prepared,
    };
  }
  if (input.handoffError) {
    // The card says what failed and what to do, under its own title; the row's
    // line says only the outcome, as the header does. The button stays for a
    // retry.
    // The detail line keeps what happened instead — the prompt went to the
    // clipboard — which the card, about what failed, does not say.
    return {
      ...base,
      status: "failed",
      summary: "Did not start",
      ...(fix?.detail ? { detail: fix.detail } : {}),
      error: input.handoffError,
      actions: taskReady ? ["fixWithAI"] : [],
      ...prepared,
    };
  }
  if (fix && fix.status !== "idle") {
    return { ...base, status: fix.status, summary: fix.detail || FINISHED_TEXT[fix.status], actions: [] };
  }
  if (taskReady) {
    return { ...base, status: "ready", summary: FINISHED_TEXT.ready, actions: ["fixWithAI"], ...prepared };
  }
  if (running) return { ...base, status: "idle", summary: "Waiting for task…", actions: [] };
  return { ...base, status: "idle", summary: base.description, actions: [] };
}

/** Whether the work item directory has anything to reveal. */
export function canOpenFolder(artifacts: readonly string[]): boolean {
  return artifacts.length > 0;
}

export type OverallKind = "idle" | "running" | "done" | "failed";

/** What the header says while a report exists: that it does, and no more. */
export const FIX_REPORT_AVAILABLE = "Fix report available";

export interface OverallStatus {
  readonly kind: OverallKind;
  /** Short enough for the corner of the workflow header. */
  readonly text: string;
}

/**
 * The compact status in the workflow header — the one global status.
 *
 * "Complete" is not among the answers, and that is the point: once the handoff
 * reaches a terminal, the extension has no way to know what the agent did with
 * it. "AI fix started" is the last thing it can honestly claim.
 *
 * The handoff's outcome is reported whether or not the box was ticked: since
 * the button moved onto the row, pressing it is a choice in its own right, and
 * a header reading "Context ready" over a failed handoff would contradict the
 * row below it.
 */
export function overallStatus(
  steps: readonly WorkflowStepResult[],
  progress: ProgressView,
): OverallStatus {
  // The steps a run performs: Fix result is a file, not a step, so it never
  // counts towards "Running 3/6…".
  const chosen = steps.filter((step) => step.enabled && step.id !== "fixResult");
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
  // A report on disk is the newest fact BugPilot can state about a work item
  // after the handoff this session saw — and the only one about a reopened
  // one, whose handoff nobody recorded. Factual, never "fixed".
  const report = steps.some((step) => step.id === "fixResult");
  if (progress.state === "done") {
    const fix = steps.find((step) => step.id === "fixWithAI");
    if (fix?.status === "success") return { kind: "done", text: HANDOFF_STARTED_TITLE };
    if (fix?.status === "failed") return { kind: "failed", text: "AI fix did not start" };
    if (report) return { kind: "done", text: FIX_REPORT_AVAILABLE };
    return { kind: "done", text: "Context ready" };
  }
  if (report) return { kind: "done", text: FIX_REPORT_AVAILABLE };
  return { kind: "idle", text: "Ready to run" };
}
