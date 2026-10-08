/**
 * Save Review Result: the four sections the developer typed — or
 * pasted and read by Paste Review Output, then checked — on their way to
 * `bugpilot record-review`.
 *
 * The extension never writes `review_report.md` itself. The text goes to the CLI
 * as a JSON file (the Fix Mode transport: a temporary file outside the
 * repository, removed afterwards), because a review does not fit on a command
 * line and should never be shell text. What comes back is either "recorded" or
 * why not — and "recorded" means only that: nothing here says the review
 * finished, passed or was acted on.
 */

import type { Envelope } from "../protocol.ts";

/** What the page sends: the four sections, any of them blank. */
export interface ReviewEntry {
  readonly summary: string;
  readonly findings: string;
  readonly validationNotes: string;
  readonly recommendations: string;
}

/**
 * The recording's own state. Absent when none is in flight, none failed and none
 * just finished.
 *
 * `recorded` is the host saying so — the CLI answered ok for this work item — and
 * the only thing that lets the page close and empty the form. A recording that
 * merely stopped being tracked (a run started, say) is not one that succeeded.
 */
export type ReviewCapture =
  | { readonly state: "recording" }
  | { readonly state: "recorded"; readonly replaced: boolean }
  | { readonly state: "failed"; readonly message: string };

/** How a failure begins: about the saving, never about the review. */
export const REVIEW_NOT_SAVED = "Review result was not saved";

/** Per section, far above a real review; the CLI enforces its own cap too. */
export const MAX_REVIEW_SECTION = 50_000;

/** Whether anything was entered at all — the CLI refuses an empty review. */
export function hasReviewContent(entry: ReviewEntry): boolean {
  return [entry.summary, entry.findings, entry.validationNotes, entry.recommendations].some(
    (text) => text.trim() !== "",
  );
}

/** The JSON `--from-file` carries, in the CLI's field names. */
export function reviewPayload(entry: ReviewEntry): Record<string, string> {
  return {
    summary: entry.summary,
    findings: entry.findings,
    validation_notes: entry.validationNotes,
    recommendations: entry.recommendations,
  };
}

/** `record-review <id> --from-file <file> --json`, with `--replace` only when confirmed. */
export function recordReviewArgs(workItemId: string, payloadPath: string, replace: boolean): readonly string[] {
  return ["record-review", workItemId, "--from-file", payloadPath, "--json", ...(replace ? ["--replace"] : [])];
}

/** The envelope, read: recorded, or why not in one sentence. */
export function recordingOutcome(envelope: Envelope): { readonly recorded: true } | { readonly recorded: false; readonly reason: string } {
  if (envelope.ok) return { recorded: true };
  if (envelope.error.code === "ARTIFACT_EXISTS") {
    return { recorded: false, reason: "a review result is already saved for this work item, and it was kept." };
  }
  const message = envelope.error.message.replace(/\s+/g, " ").trim();
  return { recorded: false, reason: message === "" ? "bugpilot gave no reason." : message };
}
