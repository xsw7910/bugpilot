/**
 * The panel's one primary action, and the few that sit behind it.
 *
 * A developer should be able to tell what to do next from one button. Before
 * this, the top of the panel always said Run — also after the context was
 * ready, when Run meant "prepare it all again" — and the way to hand the task
 * to an agent was a second primary button inside the Fix with AI row, below the
 * fold of a collapsed disclosure. Retry sat beside Run and asked the developer
 * to know what `bug --retry` does. So the button now follows the work item:
 *
 *     nothing prepared            → Run
 *     task.md ready, no attempt   → Fix with AI
 *     an attempt started          → Open AI Session
 *     the form changed since      → Rebuild Context
 *     anything in flight          → Running…  (disabled)
 *
 * and everything else is in the ⋯ menu beside it: Start New Attempt once an
 * attempt exists, Rebuild Context once there is a context to rebuild. Fresh and
 * the CLI's Retry stay where recovery belongs — Advanced settings and the
 * command palette — rather than on the path every run takes.
 *
 * Computed by the host on every push, like the workflow rows: the page cannot
 * import this, and a button the page labelled for itself would be a second
 * opinion about the work item. The page posts the action it showed together
 * with the form it holds, and the host acts only if its own answer for that
 * form is the same — so a label a debounce interval behind the form can never
 * launch an agent on a context that went stale in between.
 */

import { firstLine, sectionOf } from "./fixReport.ts";
import { NOT_RECORDED as REVIEW_NOT_RECORDED_TEXT } from "./reviewReport.ts";
import { STATUS_LABELS } from "./verificationReport.ts";
import type { VerificationCheckEntry, VerificationReportPreview } from "./verificationReport.ts";

/** Everything the primary button or its menu can ask the host to do. */
export const NEXT_ACTIONS = ["run", "fixWithAI", "openSession", "rebuildContext", "startNewAttempt"] as const;
export type NextActionId = (typeof NEXT_ACTIONS)[number];

/** Start New Attempt opens a form first, so it is never the primary button. */
export type PrimaryActionId = Exclude<NextActionId, "startNewAttempt">;

export const NEXT_ACTION_LABELS: Readonly<Record<NextActionId, string>> = {
  run: "Run",
  fixWithAI: "Fix with AI",
  openSession: "Open AI Session",
  rebuildContext: "Rebuild Context",
  startNewAttempt: "Start New Attempt",
};

/** What the button says while the host is doing something it must not overlap. */
export const BUSY_LABEL = "Running…";

export interface PrimaryView {
  /** What pressing it asks for. Kept while busy, so the page knows what it is waiting on. */
  readonly action: PrimaryActionId;
  readonly label: string;
  readonly enabled: boolean;
  /** True while a run, a handoff or an artifact write is in flight. */
  readonly busy: boolean;
  /** One line under the button, saying why it says what it says; empty to hide. */
  readonly hint: string;
  /** The ⋯ menu, in order; empty means no menu. */
  readonly more: readonly NextActionId[];
}

export interface NextActionInput {
  /** The CLI answered and a repository is open. */
  readonly ready: boolean;
  /** A run, a handoff, or an artifact write is in flight. */
  readonly busy: boolean;
  /**
   * The work item on screen has a task.md from a Build context that finished —
   * the same condition that lets the Fix with AI row say Ready.
   */
  readonly prepared: boolean;
  /** The form no longer says what the prepared context was built from. */
  readonly stale: boolean;
  /**
   * An AI attempt exists for this work item: this panel started one, or an
   * agent has written fix_report.md. Either way the next thing is to continue
   * it, not to hand the same task over a second time by accident.
   */
  readonly attempted: boolean;
  /** Whether this panel started that attempt, which is the only case it can reopen. */
  readonly sessionKnown: boolean;
  /** Delete previous artifacts first is ticked, which a rebuild honours after asking. */
  readonly fresh: boolean;
  /** The last run finished or failed, so Run's own sentence is no longer news. */
  readonly settled: boolean;
}

export const RUN_HINT = "Run prepares the issue context for AI-assisted fixing.";
export const FIX_HINT = "Context is ready. Fix with AI hands task.md to your AI agent.";
export const SESSION_HINT = "An AI session was started for this work item. Continue the conversation there.";
export const EARLIER_ATTEMPT_HINT =
  "An earlier AI attempt wrote fix_report.md. Open its session, or start a new attempt from ⋯.";
export const STALE_HINT = "The form changed since this context was prepared. Rebuild Context prepares it again.";
export const FRESH_REBUILD_HINT = "Delete previous artifacts first is on, so it asks before deleting anything.";

export function primaryView(input: NextActionInput): PrimaryView {
  const action: PrimaryActionId = !input.prepared
    ? "run"
    : input.stale
      ? "rebuildContext"
      : input.attempted
        ? "openSession"
        : "fixWithAI";
  if (input.busy) {
    return { action, label: BUSY_LABEL, enabled: false, busy: true, hint: "", more: [] };
  }
  const more: NextActionId[] = !input.prepared
    ? []
    : input.stale
      ? // The session is still there to go back to; a new attempt is not, since
        // it would start from the context the form no longer describes.
        input.attempted ? ["openSession"] : []
      : input.attempted
        ? ["startNewAttempt", "rebuildContext"]
        : ["rebuildContext"];
  return {
    action,
    label: NEXT_ACTION_LABELS[action],
    enabled: input.ready,
    busy: false,
    hint: hintFor(action, input),
    more: input.ready ? more : [],
  };
}

function hintFor(action: PrimaryActionId, input: NextActionInput): string {
  switch (action) {
    case "run":
      return input.settled ? "" : RUN_HINT;
    case "fixWithAI":
      return FIX_HINT;
    case "openSession":
      return input.sessionKnown ? SESSION_HINT : EARLIER_ATTEMPT_HINT;
    case "rebuildContext":
      return input.fresh ? `${STALE_HINT} ${FRESH_REBUILD_HINT}` : STALE_HINT;
  }
}

/** Every action the view offers right now: the button, then its menu. */
export function offeredActions(view: PrimaryView): readonly NextActionId[] {
  return view.enabled ? [view.action, ...view.more] : [];
}

// --- Start New Attempt's feedback ---------------------------------------------

/**
 * The longest feedback a new attempt carries.
 *
 * Far more than a correction needs, and far less than a pasted log: the retry
 * prompt quotes the first 3,000 characters and the agent is told to read the
 * whole file, so past this the text is a document rather than feedback.
 */
export const MAX_ATTEMPT_FEEDBACK = 20_000;

/** The file a new attempt's feedback is written to, which `bug --retry` reads. */
export const USER_FEEDBACK_ARTIFACT = "user_feedback.md";

/** The package `bug --retry` builds, which a new attempt with feedback hands over. */
export const RETRY_PROMPT_ARTIFACT = "agent_retry_prompt.md";

/**
 * `user_feedback.md`, as the developer's own words and nothing else.
 *
 * The CLI's template carries placeholders and a "Do Not Do" list; the retry
 * prompt restates those rules itself, so what is written here is the heading
 * the template starts with and the text that was typed — never a placeholder
 * an agent might read as an instruction.
 */
export function userFeedbackMarkdown(workItemId: string, feedback: string): string {
  return `# User Feedback: ${workItemId}\n\n## Required Next Attempt\n\n${feedback.trim()}\n`;
}

/** The one sentence a new attempt with feedback is launched with, as the CLI's `retry_handoff_prompt`. */
export function retryHandoffText(workItemId: string): string {
  return `Read .ai/${workItemId}/${RETRY_PROMPT_ARTIFACT} and continue the workflow.`;
}

/** The two helpers the feedback form can offer, each only while its source exists. */
export const FEEDBACK_HELPERS = ["useReviewFindings", "useVerificationEvidence"] as const;
export type FeedbackHelperId = (typeof FEEDBACK_HELPERS)[number];

/**
 * Whether recorded evidence has anything a new attempt should hear about: a
 * check recorded as Failed or Not Run. All passed is not feedback.
 */
export function hasUnsettledChecks(report: VerificationReportPreview | undefined): boolean {
  return report !== undefined && report.readable && report.failed + report.notRun > 0;
}

/**
 * What a recorded review said that a new attempt can act on — its Findings and
 * Recommendations, verbatim — or undefined when neither was recorded.
 *
 * Quoted, never summarized or classified: "the review said" is the whole
 * claim, and nothing here reads a verdict out of it.
 */
export function feedbackFromReview(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const parts: string[] = [];
  for (const [heading, label] of [
    ["## Findings", "Findings"],
    ["## Recommendations", "Recommendations"],
  ] as const) {
    const body = sectionOf(text, heading).trim();
    if (body === "" || body === REVIEW_NOT_RECORDED_TEXT || firstLine(body) === undefined) continue;
    parts.push(`${label}:\n${body}`);
  }
  if (parts.length === 0) return undefined;
  return `From review_report.md (a recorded review):\n\n${parts.join("\n\n")}`;
}

/**
 * The recorded checks that did not pass, as the developer recorded them — or
 * undefined when every recorded check passed or none could be read.
 *
 * Each line is the check's name and the status somebody recorded for it, then
 * what they wrote. Nothing is said about checks that passed, and nothing says
 * verified: this is a list of what to look at again.
 */
export function feedbackFromVerification(report: VerificationReportPreview | undefined): string | undefined {
  if (!hasUnsettledChecks(report) || report === undefined) return undefined;
  const lines: string[] = [];
  if (report.checks !== undefined) {
    for (const check of report.checks) {
      if (check.status === "passed") continue;
      lines.push(checkLine(check));
    }
  } else {
    // Not in BugPilot's shape, so only the previewed names and statuses are known
    // — the first few of them — and the counts, which were read from every line.
    for (const check of report.preview) {
      if (check.status !== "failed" && check.status !== "not_run") continue;
      lines.push(`- ${check.name} — recorded as ${STATUS_LABELS[check.status]}`);
    }
    if (lines.length === 0 || report.more > 0) {
      lines.push(
        `- ${report.failed} recorded as Failed and ${report.notRun} as Not Run in all; see verification_report.md for each.`,
      );
    }
  }
  return `From verification_report.md (checks recorded as Failed or Not Run):\n\n${lines.join("\n")}`;
}

function checkLine(check: VerificationCheckEntry): string {
  const details = [
    ["Procedure", check.procedure],
    ["Evidence", check.evidence],
    ["Notes", check.notes],
  ]
    .filter(([, value]) => value !== undefined && value.trim() !== "")
    .map(([label, value]) => `  ${label}: ${value!.trim().replace(/\s*\n\s*/g, " ")}`);
  return [`- ${check.name} — recorded as ${STATUS_LABELS[check.status]}`, ...details].join("\n");
}
