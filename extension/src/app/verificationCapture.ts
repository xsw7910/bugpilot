/**
 * Record Verification Evidence (Batch 12): the checks the developer entered, on
 * their way to `bugpilot record-verification`.
 *
 * The extension never writes `verification_report.md` itself, and never runs a
 * check: every status is the one the developer chose. The checks go to the CLI
 * as a JSON file (the Fix Mode transport: a temporary file outside the
 * repository, removed afterwards), so a command line or a pasted log is never
 * argv and never shell text. What comes back is either "recorded" or why not —
 * a failure is about the recording, never about a check, which only a recorded
 * Failed status speaks for.
 */

import type { Envelope } from "../protocol.ts";
import type { ReviewCapture } from "./reviewCapture.ts";
import type { VerificationCheckEntry } from "./verificationReport.ts";

/** The recording's own state, shaped like Review Result's: recording, recorded, or why not. */
export type VerificationCapture = ReviewCapture;

/** How a failure begins: about the recording, never about the fix. */
export const VERIFICATION_NOT_RECORDED = "Verification evidence was not recorded";

/** The CLI's caps, checked here too so a refusal is said before a process starts. */
export const MAX_CHECKS = 25;
export const MAX_CHECK_NAME = 200;
export const MAX_CHECK_TEXT = 20_000;

/** Why these checks cannot be recorded, in one sentence; undefined when they can be sent. */
export function verificationProblem(checks: readonly VerificationCheckEntry[]): string | undefined {
  if (checks.length === 0) return "add at least one check.";
  if (checks.length > MAX_CHECKS) return `at most ${MAX_CHECKS} checks can be recorded.`;
  const unnamed = checks.findIndex((check) => check.name.trim() === "");
  if (unnamed >= 0) return `check ${unnamed + 1} needs a name.`;
  // Counted as the CLI counts it: runs of whitespace are one space.
  const long = checks.findIndex((check) => check.name.trim().split(/\s+/).join(" ").length > MAX_CHECK_NAME);
  if (long >= 0) return `check ${long + 1}'s name is longer than ${MAX_CHECK_NAME} characters.`;
  const text = checks.findIndex((check) =>
    [check.procedure, check.evidence, check.notes].some((field) => field.length > MAX_CHECK_TEXT),
  );
  if (text >= 0) return `check ${text + 1} has a field longer than ${MAX_CHECK_TEXT} characters.`;
  return undefined;
}

/** The JSON `--from-file` carries: transport only, never stored. */
export function verificationPayload(checks: readonly VerificationCheckEntry[]): { readonly checks: readonly object[] } {
  return {
    checks: checks.map((check) => ({
      name: check.name,
      status: check.status,
      type: check.type,
      procedure: check.procedure,
      evidence: check.evidence,
      notes: check.notes,
    })),
  };
}

/** `record-verification <id> --from-file <file> --json`, with `--replace` only for an Edit. */
export function recordVerificationArgs(workItemId: string, payloadPath: string, replace: boolean): readonly string[] {
  return ["record-verification", workItemId, "--from-file", payloadPath, "--json", ...(replace ? ["--replace"] : [])];
}

/** The envelope, read: recorded, or why not in one sentence. */
export function verificationOutcome(
  envelope: Envelope,
): { readonly recorded: true } | { readonly recorded: false; readonly reason: string } {
  if (envelope.ok) return { recorded: true };
  if (envelope.error.code === "ARTIFACT_EXISTS") {
    return {
      recorded: false,
      reason:
        "verification evidence is already recorded for this work item, and it was kept. " +
        "Use Edit Verification Evidence to change it.",
    };
  }
  const message = envelope.error.message.replace(/\s+/g, " ").trim();
  return { recorded: false, reason: message === "" ? "bugpilot gave no reason." : message };
}
