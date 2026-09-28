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

import {
  CONTEXT_ARTIFACT,
  FIX_REPORT_ARTIFACT,
  REVIEW_REPORT_ARTIFACT,
  TASK_ARTIFACT,
  VERIFICATION_REPORT_ARTIFACT,
} from "./artifacts.ts";
import type { RelevantFile } from "./contextSummary.ts";
import type { UserFacingError } from "./failures.ts";
import type { FixReportPreview } from "./fixReport.ts";
import type { ValidationChecklist } from "./reviewPackage.ts";
import type { ReviewCapture } from "./reviewCapture.ts";
import type { ReviewReportPreview } from "./reviewReport.ts";
import type { VerificationCapture } from "./verificationCapture.ts";
import { STATUS_LABELS, TYPE_LABELS, overallPhrase } from "./verificationReport.ts";
import type { VerificationCheckEntry, VerificationReportPreview } from "./verificationReport.ts";
import type { PlanState, Source } from "./form.ts";
import type { FeedbackHelperId } from "./nextAction.ts";
import { HANDOFF_STARTED_TITLE, REVIEW_STARTED_TITLE } from "./handoff.ts";
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

/**
 * An action a row offers, once that row has produced what it acts on.
 *
 * Fix with AI is not among them any more: handing the task over is the panel's
 * primary action (`nextAction.ts`), and a second primary button inside the row
 * was a competing answer to "what do I do next?".
 */
export type StepActionId =
  | "openContext"
  | "copyContext"
  | "openFixReport"
  | "copyReviewPrompt"
  | "reviewWithAI"
  // Review Result (Batch 11): record one, replace the one recorded, open it.
  | "recordReviewResult"
  | "replaceReviewResult"
  | "openReviewReport"
  // Verification Evidence (Batch 12): record it, edit the recorded checks, open it.
  | "recordVerification"
  | "editVerification"
  | "openVerificationReport";

/** What Fix result says once a review result is recorded, and only then. */
export const REVIEW_RESULT_RECORDED = "Review result recorded";

/**
 * Fix result's Review Result, present exactly while `review_report.md` is
 * listed (Batch 11).
 *
 * Recorded, never inferred: this says somebody recorded what a review said, in
 * that person's words — the summary line and the findings line are the report's
 * own first lines, unclassified. Nothing here means reviewed, passed, verified
 * or applied.
 */
export interface ReviewResultView {
  readonly status: typeof REVIEW_RESULT_RECORDED;
  /** The canonical file, opened through the constrained `openReviewReport` action. */
  readonly artifact: string;
  readonly summary: string;
  readonly detail?: string;
  /** Which of the other sections hold something, in words; absent when neither does. */
  readonly alsoRecorded?: string;
}

/**
 * Fix result's Verification Evidence, present exactly while
 * `verification_report.md` is listed (Batch 12).
 *
 * Counts of recorded statuses and the checks' names — what the user recorded,
 * scoped to each check. No global badge: the overall line is one of the four
 * generated phrases, computed from the counts, never read from the file, and
 * never "verified", "approved" or "safe to merge".
 */
export interface VerificationResultView {
  /** The canonical file, opened through the constrained `openVerificationReport` action. */
  readonly artifact: string;
  /** "Recorded checks: 2 passed, 1 failed", or that the preview is unavailable. */
  readonly counts: string;
  /** The generated phrase; absent when no recorded status could be read. */
  readonly overall?: string;
  /** Up to five checks, in the report's order. */
  readonly checks: readonly VerificationCheckView[];
  /** "+N more in verification_report.md", beyond the preview. */
  readonly more?: string;
}

export interface VerificationCheckView {
  readonly name: string;
  /** "Passed", "Failed", "Not Run" — or "Status not recorded" for a hand-edited row. */
  readonly status: string;
  readonly type?: string;
}

/**
 * The recorded checks, sent once for Edit (Batch 12): `token` changes per
 * request, so the page opens the form for this request and not again on the
 * next push. `structured` is false when the report is not in BugPilot's shape —
 * the form then starts empty, and saving replaces the report.
 */
export interface VerificationEdit {
  readonly token: number;
  readonly checks: readonly VerificationCheckEntry[];
  readonly structured: boolean;
  /** True when the file is listed but could not be read — not merely not canonical. */
  readonly unreadable: boolean;
}

/**
 * Review with AI, as this session saw it (Batch 10). Transient: never written,
 * never restored — a reopened work item offers the button again.
 *
 * `started` means a terminal was opened with the review prompt in it, and no
 * more: nothing comes back from the reviewer, so nothing says it finished,
 * passed or agreed.
 */
export type ReviewHandoff =
  | { readonly state: "starting" }
  | { readonly state: "started"; readonly agent: string }
  | { readonly state: "failed"; readonly error: UserFacingError };

/** The same, in the words Fix result shows. */
export type ReviewHandoffView =
  | { readonly state: "starting" }
  | { readonly state: "started"; readonly summary: string; readonly detail: string }
  | { readonly state: "failed"; readonly error: UserFacingError };

/**
 * Fix result's Validation checklist, as far as it has been asked for.
 *
 * Absent until the developer opens it; then loading, then the CLI's checklist or
 * why it could not be had. Guidance either way — no state here says a step was
 * done, and none is persisted.
 */
export type ValidationView =
  | { readonly state: "loading" }
  | { readonly state: "ready"; readonly checklist: ValidationChecklist }
  | { readonly state: "failed"; readonly message: string };

/**
 * Start New Attempt, as far as the host has got with a press (see
 * `Controller.startNewAttempt`). Absent when nothing is pending and the last
 * press started — which is what lets the page close the form.
 */
export type AttemptView =
  | { readonly state: "starting" }
  | { readonly state: "failed"; readonly message: string };

/**
 * Text a feedback helper produced, sent once: `token` changes per press, so the
 * page adds it to the form for this press and not again on the next push.
 */
export interface AttemptDraft {
  readonly token: number;
  readonly text: string;
}

/**
 * The AI session this panel started for the work item on screen.
 *
 * Kept by the controller across a Rebuild Context of the same work item, which
 * resets the handoff's outcome but not the fact that an agent is working on
 * it; dropped with the work item. Never restored: a reopened work item knows
 * only what its files say.
 */
export interface SessionSummary {
  readonly agent: string;
  /** How many handoffs this panel made for the work item, the first included. */
  readonly attempts: number;
}

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
  /** Fix result only: the Validation checklist, once asked for. */
  readonly validation?: ValidationView;
  /** Fix result only: the review prompt is being prepared, so the button waits. */
  readonly copyingReviewPrompt?: true;
  /**
   * Fix result only: Review with AI, once pressed. Its own state and its own
   * card — never this row's `error`, and never Fix with AI's.
   */
  readonly review?: ReviewHandoffView;
  /** Fix result only: the recorded review result, while `review_report.md` is listed. */
  readonly reviewResult?: ReviewResultView;
  /** Fix result only: a recording in flight, or why the last one did not record. */
  readonly reviewCapture?: ReviewCapture;
  /** Fix result only: the recorded evidence, while `verification_report.md` is listed. */
  readonly verificationResult?: VerificationResultView;
  /** Fix result only: a verification recording in flight, or why the last one did not record. */
  readonly verificationCapture?: VerificationCapture;
  /** Fix result only: the recorded checks for Edit, in the one push that answers it. */
  readonly verificationEdit?: VerificationEdit;
  /** Fix with AI only: a new attempt being prepared, or why the last press did not start one. */
  readonly attempt?: AttemptView;
  /** Fix with AI only: text for the feedback form, in the one push that answers a helper. */
  readonly attemptDraft?: AttemptDraft;
  /** Fix with AI only: which feedback helpers the form may offer, by the artifacts that exist. */
  readonly feedbackHelpers?: readonly FeedbackHelperId[];
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
  /** Fix result's Validation checklist, for the work item on screen. */
  readonly validation?: ValidationView;
  /** True while Copy Review Prompt is waiting for the CLI. */
  readonly copyingReviewPrompt?: boolean;
  /** Review with AI, for the work item on screen; absent until pressed. */
  readonly review?: ReviewHandoff;
  /** `review_report.md`, projected; absent when it was not read. The listing decides presence. */
  readonly reviewReport?: ReviewReportPreview;
  /** A recording in flight, or the last one's failure; absent otherwise. */
  readonly reviewCapture?: ReviewCapture;
  /** Whether Record (or Replace) Review Result may be pressed now: the host's call. */
  readonly canRecordReview?: boolean;
  /** `verification_report.md`, projected; absent when it was not read. The listing decides presence. */
  readonly verificationReport?: VerificationReportPreview;
  /** A verification recording in flight, or the last one's outcome; absent otherwise. */
  readonly verificationCapture?: VerificationCapture;
  /** Whether Record (or Edit) Verification Evidence may be pressed now: the host's call. */
  readonly canRecordVerification?: boolean;
  /** The recorded checks for Edit, only in the push that answers the request. */
  readonly verificationEdit?: VerificationEdit;
  /** The session this panel started for the work item on screen, if any. */
  readonly session?: SessionSummary;
  /** Start New Attempt's state, for the form under Fix with AI. */
  readonly attempt?: AttemptView;
  /** A feedback helper's answer, only in the push that answers it. */
  readonly attemptDraft?: AttemptDraft;
  /** The feedback helpers the form may offer now: the host's call. */
  readonly feedbackHelpers?: readonly FeedbackHelperId[];
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
  const recorded = input.artifacts.includes(REVIEW_REPORT_ARTIFACT);
  const evidence = input.artifacts.includes(VERIFICATION_REPORT_ARTIFACT);
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
    // Reading the report first, then preparing someone else's review of it,
    // then — the one that acts — starting a reviewer. All offered with any
    // report: the prompt and the checklist are built from the work item's
    // files, and a partial report is still one to review.
    actions: fixResultActions(input, recorded, evidence),
    ...(input.validation === undefined ? {} : { validation: input.validation }),
    ...(input.copyingReviewPrompt ? { copyingReviewPrompt: true as const } : {}),
    ...(input.review === undefined ? {} : { review: reviewView(input.review) }),
    ...(recorded ? { reviewResult: reviewResultView(input.reviewReport) } : {}),
    ...(input.reviewCapture === undefined ? {} : { reviewCapture: input.reviewCapture }),
    ...(evidence ? { verificationResult: verificationResultView(input.verificationReport) } : {}),
    ...(input.verificationCapture === undefined ? {} : { verificationCapture: input.verificationCapture }),
    ...(input.verificationEdit === undefined ? {} : { verificationEdit: input.verificationEdit }),
  };
}

/**
 * Fix result's actions, in the order they are read: the report, the review aids,
 * then Review Result's — record one, or open and replace the one recorded — then
 * Verification Evidence's, the same way.
 *
 * Record, Replace and Edit only when the host says a recording may start (no run
 * and no artifact recording in flight); Open whenever the file is listed.
 */
function fixResultActions(input: WorkflowInput, recorded: boolean, evidence: boolean): StepActionId[] {
  const actions: StepActionId[] = ["openFixReport", "copyReviewPrompt"];
  if (canStartReview(input.review)) actions.push("reviewWithAI");
  if (recorded) actions.push("openReviewReport");
  if (input.canRecordReview) actions.push(recorded ? "replaceReviewResult" : "recordReviewResult");
  if (evidence) actions.push("openVerificationReport");
  if (input.canRecordVerification) actions.push(evidence ? "editVerification" : "recordVerification");
  return actions;
}

/** Verification Evidence's lines: counts of recorded statuses, and the checks by name. */
function verificationResultView(report: VerificationReportPreview | undefined): VerificationResultView {
  const base = { artifact: VERIFICATION_REPORT_ARTIFACT } as const;
  const total = report === undefined ? 0 : report.passed + report.failed + report.notRun;
  if (report === undefined || !report.readable || total === 0) {
    return { ...base, counts: "Recorded checks: preview unavailable", checks: [] };
  }
  const counts = [
    ...(report.passed > 0 ? [`${report.passed} passed`] : []),
    ...(report.failed > 0 ? [`${report.failed} failed`] : []),
    ...(report.notRun > 0 ? [`${report.notRun} not run`] : []),
  ];
  return {
    ...base,
    counts: `Recorded checks: ${counts.join(", ")}`,
    overall: overallPhrase(report.passed, report.failed, report.notRun),
    checks: report.preview.map((check) => ({
      name: check.name,
      status: check.status === undefined ? "Status not recorded" : STATUS_LABELS[check.status],
      ...(check.type === undefined ? {} : { type: TYPE_LABELS[check.type] }),
    })),
    ...(report.more > 0 ? { more: `+${report.more} more in ${VERIFICATION_REPORT_ARTIFACT}` } : {}),
  };
}

/** Review Result's lines: the report's own words, or plainly that there is one. */
function reviewResultView(report: ReviewReportPreview | undefined): ReviewResultView {
  const base = { status: REVIEW_RESULT_RECORDED, artifact: REVIEW_REPORT_ARTIFACT } as const;
  if (report === undefined || !report.readable) {
    return { ...base, summary: REVIEW_RESULT_RECORDED, detail: "Preview unavailable" };
  }
  const also = [
    ...(report.validationNotes ? ["validation notes"] : []),
    ...(report.recommendations ? ["recommendations"] : []),
  ];
  const summary = report.summary ?? report.findings ?? REVIEW_RESULT_RECORDED;
  const detail = report.summary !== undefined && report.findings !== undefined ? `Findings: ${report.findings}` : undefined;
  return {
    ...base,
    summary,
    ...(detail === undefined ? {} : { detail }),
    ...(also.length === 0 ? {} : { alsoRecorded: `Also recorded: ${also.join(" · ")}` }),
  };
}

/**
 * Whether Review with AI can be pressed: never pressed, or pressed and failed.
 *
 * Not while one is starting — a second press would be a second reviewer — and
 * not once one started, for the same reason: the same work item, reopened, or
 * the next run offers it again. The controller refuses on the same condition.
 */
export function canStartReview(review: ReviewHandoff | undefined): boolean {
  return review === undefined || review.state === "failed";
}

function reviewView(review: ReviewHandoff): ReviewHandoffView {
  if (review.state === "started") {
    return { state: "started", summary: REVIEW_STARTED_TITLE, detail: `Handed to ${review.agent} in a terminal.` };
  }
  return review;
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
 * A status and a result, not the place to act: the panel's primary action says
 * what to press next (`nextAction.ts`). What this row owns is what happened —
 * and, once an attempt exists, the form for starting a new one.
 *
 * In order of precedence: a handoff being resolved, one that started, one that
 * could not start, one that was skipped, a session this panel started before
 * the context was rebuilt, a report an earlier attempt wrote, a task ready to
 * hand over, and otherwise waiting for a run to produce one.
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
    actions: [] as StepActionId[],
    ...(input.attempt === undefined ? {} : { attempt: input.attempt }),
    ...(input.attemptDraft === undefined ? {} : { attemptDraft: input.attemptDraft }),
    ...(input.feedbackHelpers === undefined || input.feedbackHelpers.length === 0
      ? {}
      : { feedbackHelpers: input.feedbackHelpers }),
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
    const summary = input.attempt?.state === "starting" ? "Starting a new attempt…" : "Starting AI fix…";
    return { ...base, status: "running", summary, ...prepared };
  }
  const fix = input.fix;
  if (fix?.status === "success") {
    // "Started", and nothing further: the agent runs in a terminal this
    // extension does not own. Continuing it is Open AI Session's; a second
    // handoff is Start New Attempt's, and only on purpose.
    return {
      ...base,
      status: "success",
      summary: HANDOFF_STARTED_TITLE,
      ...(fix.detail ? { detail: fix.detail } : {}),
      ...prepared,
    };
  }
  if (input.handoffError) {
    // The card says what failed and what to do, under its own title; the row's
    // line says only the outcome, as the header does. The primary action stays
    // what it was, for another try.
    // The detail line keeps what happened instead — the prompt went to the
    // clipboard — which the card, about what failed, does not say.
    return {
      ...base,
      status: "failed",
      summary: "Did not start",
      ...(fix?.detail ? { detail: fix.detail } : {}),
      error: input.handoffError,
      ...prepared,
    };
  }
  if (fix && fix.status !== "idle") {
    return { ...base, status: fix.status, summary: fix.detail || FINISHED_TEXT[fix.status] };
  }
  if (input.session && !running) {
    // Started by this panel, and the context rebuilt since: the session is
    // still the agent's, so the row still says it was started.
    return {
      ...base,
      status: "success",
      summary: HANDOFF_STARTED_TITLE,
      detail: `Handed to ${input.session.agent} in a terminal.`,
      ...prepared,
    };
  }
  if (taskReady && present.has(FIX_REPORT_ARTIFACT)) {
    // An earlier attempt — another window, a terminal, before a reload — wrote
    // its report. Not "started": nobody here saw it start. Not "fixed" either.
    return {
      ...base,
      status: "ready",
      statusLabel: "fix report available",
      summary: FIX_REPORT_AVAILABLE,
      ...prepared,
    };
  }
  if (taskReady) {
    return { ...base, status: "ready", summary: FINISHED_TEXT.ready, ...prepared };
  }
  if (running) return { ...base, status: "idle", summary: "Waiting for task…" };
  return { ...base, status: "idle", summary: base.description };
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
