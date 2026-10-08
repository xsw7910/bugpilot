/**
 * The Fix result row's review aids, from `bugpilot review-package --json`.
 *
 * Both are built by the CLI — the final-review prompt and the validation
 * checklist that `summarize-results` also renders — and this file only reads
 * them back. Nothing here writes a prompt or a checklist to disk, runs a review
 * or decides whether a fix is right: the prompt goes to the clipboard, or to the
 * selected agent through Review with AI (Batch 10) — past the prompt gate every
 * terminal handoff shares, `isPlainPrompt` in `agents.ts` — and the checklist
 * is guidance the developer reads.
 *
 * The JSON mode is the read-only one (plan §37.58): no step mark in `run.json`,
 * no directory created, nothing posted. That is what makes it safe as a panel
 * button — including while a re-run of the same work item is writing
 * `run.json`, which the report's row stays visible through.
 */

import type { Envelope } from "../protocol.ts";

/**
 * The one command both aids come from. `includeChanges`: also the current git
 * status and diff, which BugPilot collects itself for a captured review that
 * cannot run commands (pre-release Batch 2, C) — asked for only by Review with
 * AI, since the copy and the checklist do not need a diff.
 */
export function reviewPackageArgs(workItemId: string, options: { readonly includeChanges?: boolean } = {}): readonly string[] {
  return ["review-package", workItemId, "--json", ...(options.includeChanges ? ["--include-changes"] : [])];
}

/** At most this many Review Notes lines on the row; the rest are in the report. */
export const MAX_RISKS = 8;

/** One checklist line on a sidebar row. */
const MAX_LINE_CHARS = 240;

/** The prompt is a template of a few hundred characters; anything past this is not it. */
const MAX_PROMPT_CHARS = 64 * 1024;

/**
 * The CLI bounds the changes block (60,000 characters of diff, 200 status
 * lines, said when cut); anything past this is not that block.
 */
export const MAX_CHANGES_CHARS = 128 * 1024;

/** What the panel shows under "Validation checklist". Guidance, never a result. */
export interface ValidationChecklist {
  /** What to try by hand: the CLI's five steps. */
  readonly steps: readonly string[];
  /** The top related files from `retrieval.json`. */
  readonly files: readonly string[];
  /** The report's Review Notes lines, bounded to `MAX_RISKS`. */
  readonly risks: readonly string[];
  /** How many Review Notes lines were left for the report itself. */
  readonly moreRisks?: number;
}

export interface ReviewPackage {
  readonly prompt: string;
  readonly validation: ValidationChecklist;
  /**
   * The current changes as BugPilot collected them, a Markdown block for a
   * captured review's stdin — present only when asked for and well-formed.
   */
  readonly changes?: string;
}

/**
 * The prompt and the checklist, or undefined when the envelope is not a
 * well-formed success. A malformed field is not guessed at: without a prompt
 * there is nothing to copy, and a checklist missing its steps is not one.
 */
export function reviewPackageFromEnvelope(envelope: Envelope): ReviewPackage | undefined {
  if (!envelope.ok) return undefined;
  const prompt = envelope["prompt"];
  const validation = envelope["validation"];
  if (typeof prompt !== "string" || prompt.trim() === "" || prompt.length > MAX_PROMPT_CHARS) return undefined;
  if (typeof validation !== "object" || validation === null) return undefined;
  const record = validation as Record<string, unknown>;
  const steps = lines(record["steps"]);
  if (steps === undefined || steps.length === 0) return undefined;
  const files = lines(record["regression_files"]) ?? [];
  const allRisks = (lines(record["review_risks"]) ?? []).map(withoutListMarker).filter((line) => line !== "");
  const risks = allRisks.slice(0, MAX_RISKS);
  const changes = envelope["changes"];
  return {
    prompt,
    ...(typeof changes === "string" && changes.trim() !== "" && changes.length <= MAX_CHANGES_CHARS ? { changes } : {}),
    validation: {
      steps,
      files,
      risks,
      ...(allRisks.length > risks.length ? { moreRisks: allRisks.length - risks.length } : {}),
    },
  };
}

/** A list of non-empty strings, each cut to one row's worth; undefined when not a list. */
function lines(value: unknown): readonly string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .filter((item): item is string => typeof item === "string")
    .map((item) => bounded(item.replace(/\s+/g, " ").trim()))
    .filter((item) => item !== "");
}

/** The report writes its notes as a Markdown list; the panel draws its own bullets. */
function withoutListMarker(line: string): string {
  return line.replace(/^([-*+]|\d+[.)])\s+/, "").trim();
}

function bounded(text: string): string {
  const points = Array.from(text);
  return points.length <= MAX_LINE_CHARS ? text : `${points.slice(0, MAX_LINE_CHARS - 1).join("").trimEnd()}…`;
}
