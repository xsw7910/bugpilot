/**
 * A captured one-shot review, read: the draft it gives the Review Result form,
 * or why it gives none.
 *
 * Review with AI runs a supported agent once, non-interactively, with the
 * canonical review prompt on stdin, and waits for it to exit (`agents.ts`,
 * `CapturedReviewInvocation`). This file decides what came back. It reads the
 * process's own stdout — never a terminal, never a screen — and puts the answer
 * through exactly the parser Paste Review Output uses (`reviewOutput.ts`), so a
 * reply reads the same whichever way it arrived.
 *
 * Success needs all three: the process finished (not cancelled or timed out,
 * exit code 0), its output was the agent's result and not an error, and the
 * parser read the four sections. Exit code 0 alone is not success, and a
 * started process is not a finished review. Nothing here saves anything, and
 * nothing here reads a verdict: the draft is the reviewer's four sections, for
 * the developer to check and save.
 */

import { createHash } from "node:crypto";

import { MAX_REVIEW_OUTPUT, parseReviewOutput } from "./reviewOutput.ts";
import type { ReviewEntry } from "./reviewCapture.ts";
import type { CapturedReviewInvocation } from "./agents.ts";

/** What the host's process port hands back: the Runner's result. */
export interface CapturedRun {
  readonly code: number | null;
  readonly stdout: string;
  readonly stderr: string;
  readonly aborted: boolean;
}

/** Room for the JSON wrapper around the largest reply the parser accepts, escaped. */
const MAX_STDOUT_CHARS = 4 * MAX_REVIEW_OUTPUT;

/** One line of the process's own words, for a failure's detail. */
const MAX_DETAIL_CHARS = 240;

/** The process ended, but what it printed is not a review in the four sections. */
export const CAPTURE_FAILED = "Review result could not be captured automatically.";
/** The process did not finish with a result at all. */
export const NO_USABLE_RESULT = "AI review did not produce a usable structured result.";
/** The host's timeout ended it: said as that, never as the review failing. */
export const TIMED_OUT = "AI review did not finish within the allowed time.";

/** How long a captured review may run before the host ends it. The one timeout. */
export const CAPTURED_REVIEW_TIMEOUT_MS = 15 * 60_000;

export type CapturedReviewOutcome =
  | { readonly ok: true; readonly entry: ReviewEntry; readonly leftOut: boolean }
  | {
      readonly ok: false;
      /** `CAPTURE_FAILED` or `NO_USABLE_RESULT`: about the capture, never the fix. */
      readonly title: string;
      readonly detail: string;
      /**
       * The reviewer's reply as text, when there was one: the page puts it in
       * Paste Review Output so the developer can fix a heading and Parse. Held
       * only in the panel's state, never written.
       */
      readonly reply?: string;
    };

export function capturedReviewOutcome(run: CapturedRun, invocation: CapturedReviewInvocation): CapturedReviewOutcome {
  // Aborted here means the timeout: a Cancel Review is the controller's to
  // handle before it asks this, and is not a failure at all.
  if (run.aborted) return failed(TIMED_OUT, `The reviewer was stopped after ${CAPTURED_REVIEW_TIMEOUT_MS / 60_000} minutes.`);
  const reply = invocation.output === "claude-json" ? claudeResult(run.stdout) : undefined;
  if (run.code !== 0) {
    const said = reply?.kind === "error" ? reply.message : firstLine(run.stderr) || firstLine(run.stdout);
    return failed(NO_USABLE_RESULT, said === "" ? `The reviewer exited with code ${run.code}.` : `The reviewer exited with code ${run.code}: ${said}`);
  }
  if (reply === undefined || reply.kind === "none") {
    return failed(CAPTURE_FAILED, run.stdout.trim() === "" ? "The reviewer printed nothing." : "The reviewer's output was not the result it was asked for.");
  }
  if (reply.kind === "error") return failed(NO_USABLE_RESULT, reply.message);
  const parsed = parseReviewOutput(reply.text);
  if (!parsed.ok) {
    return {
      ...failed(CAPTURE_FAILED, parsed.message),
      ...(reply.text.trim() === "" ? {} : { reply: reply.text.slice(0, MAX_REVIEW_OUTPUT) }),
    };
  }
  return { ok: true, entry: parsed.entry, leftOut: parsed.leftOut };
}

/**
 * Claude Code's `--output-format json`: one object, `type: "result"`. Its
 * `result` is the final answer; `is_error` or a non-success `subtype` is the
 * CLI saying the run did not complete. Anything else is not that object.
 */
function claudeResult(
  stdout: string,
): { readonly kind: "text"; readonly text: string } | { readonly kind: "error"; readonly message: string } | { readonly kind: "none" } {
  const text = stdout.trim();
  if (text === "" || text.length > MAX_STDOUT_CHARS) return { kind: "none" };
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { kind: "none" };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return { kind: "none" };
  const record = value as Record<string, unknown>;
  if (record["type"] !== "result") return { kind: "none" };
  if (record["is_error"] === true || (typeof record["subtype"] === "string" && record["subtype"] !== "success")) {
    const said = typeof record["result"] === "string" ? firstLine(record["result"]) : "";
    const subtype = typeof record["subtype"] === "string" ? record["subtype"] : "error";
    return { kind: "error", message: said === "" ? `The reviewer reported ${subtype}.` : `The reviewer reported: ${said}` };
  }
  return typeof record["result"] === "string" ? { kind: "text", text: record["result"] } : { kind: "none" };
}

/**
 * Which fix a review attempt is for: `fix_report.md` by content.
 *
 * Review with AI is offered once per fix, and the report is the one record of a
 * fix BugPilot has — a new attempt writes a new one; Rebuild Context, a
 * settings change or Start New Attempt on their own do not touch it. So the
 * identity is its text, line endings unified, hashed: the same report written
 * again is the same fix; any change in it is a new one. A report listed but
 * unreadable has an identity of its own, so it too is offered once.
 */
export function fixReportIdentity(text: string | undefined): string {
  if (text === undefined) return "unreadable";
  return createHash("sha256").update(text.replace(/\r\n?/g, "\n"), "utf8").digest("hex");
}

/** Work items remembered; the oldest is forgotten first, so the store stays small. */
export const MAX_REMEMBERED_FIXES = 200;

/**
 * The persisted "which fix had a review attempt", by work item, over any
 * key-value store — VS Code's workspace state in the host. A value that is not
 * a map of strings is read as empty, never trusted; a work item set again moves
 * to the newest place.
 */
export function reviewedFixStore(
  load: () => unknown,
  save: (value: Readonly<Record<string, string>>) => void,
): { get: (workItemId: string) => string | undefined; set: (workItemId: string, fix: string | undefined) => void } {
  const current = (): Record<string, string> => {
    const value = load();
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
    );
  };
  return {
    get: (workItemId) => (Object.hasOwn(current(), workItemId) ? current()[workItemId] : undefined),
    set: (workItemId, fix) => {
      const entries = Object.entries(current()).filter(([key]) => key !== workItemId);
      if (fix !== undefined) entries.push([workItemId, fix]);
      save(Object.fromEntries(entries.slice(-MAX_REMEMBERED_FIXES)));
    },
  };
}

function failed(title: string, detail: string): CapturedReviewOutcome {
  return { ok: false, title, detail };
}

function firstLine(text: string): string {
  const line = text.trim().split(/\r\n|\r|\n/)[0]?.replace(/\s+/g, " ").trim() ?? "";
  const points = Array.from(line);
  return points.length <= MAX_DETAIL_CHARS ? line : `${points.slice(0, MAX_DETAIL_CHARS - 1).join("")}…`;
}
