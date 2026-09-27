/**
 * What Fix result shows of `review_report.md` (Batch 11): a line or two, and
 * which sections were recorded.
 *
 * The report is what somebody recorded after a review — `bugpilot record-review`
 * writes it, the developer may edit it — and its presence says a review result
 * was recorded, nothing more. So this is deliberately not a verdict parser:
 * "Approved", "LGTM", "tests pass" and "do not merge" all pass through as text,
 * and nothing here reads a status out of them.
 *
 * Sections are read with the fix report's rules (`sectionOf`, `firstLine`), the
 * same ones `bugpilot/core/review_report.py` uses, and `Not recorded.` — what the
 * writer puts in a section left empty — counts as absent.
 */

import { firstLine, sectionOf } from "./fixReport.ts";

/** Only the start of a pathological file is parsed; the preview needs two lines. */
const MAX_SCANNED_CHARS = 256 * 1024;

/** The writer's text for a section left empty. */
export const NOT_RECORDED = "Not recorded.";

export interface ReviewReportPreview {
  /** Whether the file could be read. Listed but unreadable is still a report to open. */
  readonly readable: boolean;
  /** The first meaningful line of `## Summary`, bounded. */
  readonly summary?: string;
  /** The first meaningful line of `## Findings`, bounded. */
  readonly findings?: string;
  /** Whether `## Validation Notes` holds anything recorded. */
  readonly validationNotes: boolean;
  /** Whether `## Recommendations` holds anything recorded. */
  readonly recommendations: boolean;
}

export function parseReviewReport(text: string | undefined): ReviewReportPreview {
  if (text === undefined) return { readable: false, validationNotes: false, recommendations: false };
  const scanned = text.length > MAX_SCANNED_CHARS ? text.slice(0, MAX_SCANNED_CHARS) : text;
  const summary = firstLine(recorded(sectionOf(scanned, "## Summary")));
  const findings = firstLine(recorded(sectionOf(scanned, "## Findings")));
  return {
    readable: true,
    ...(summary === undefined ? {} : { summary }),
    ...(findings === undefined ? {} : { findings }),
    validationNotes: firstLine(recorded(sectionOf(scanned, "## Validation Notes"))) !== undefined,
    recommendations: firstLine(recorded(sectionOf(scanned, "## Recommendations"))) !== undefined,
  };
}

function recorded(section: string): string {
  return section.trim() === NOT_RECORDED ? "" : section;
}
