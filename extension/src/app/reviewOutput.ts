/**
 * Paste Review Output: a reviewer's reply, read into Review Result's four
 * sections so the form opens filled instead of blank.
 *
 * The canonical review prompt (`review-package`) asks for exactly
 * `## Summary`, `## Findings`, `## Validation Notes` and `## Recommendations`
 * — review_report.md's own sections — and this reads that shape and nothing
 * else. It is section extraction, not a Markdown reader and not a classifier:
 * the text under each heading is kept as written, and nothing here looks for a
 * verdict, a pass, an approval or "verified". A reply in any other shape is
 * refused with the reason, never guessed at.
 *
 * Reading is not saving. The result goes to the page once (`ReviewPrefill`),
 * the developer reads and edits it there, and only Save Review Result records
 * anything — through `record-review`, as for a review typed by hand. BugPilot
 * never reads a terminal for this: a reviewer having started says nothing
 * about a reply existing, so a reply is only ever what the developer pasted.
 */

import { MAX_REVIEW_SECTION } from "./reviewCapture.ts";
import type { ReviewEntry } from "./reviewCapture.ts";

/** Four full sections and room for headings and a lead-in; past this is not one review. */
export const MAX_REVIEW_OUTPUT = 4 * MAX_REVIEW_SECTION + 8 * 1024;

/** The sections, in review_report.md's order, with the heading text each is matched by. */
export const REVIEW_OUTPUT_SECTIONS: readonly (readonly [keyof ReviewEntry, string])[] = [
  ["summary", "Summary"],
  ["findings", "Findings"],
  ["validationNotes", "Validation Notes"],
  ["recommendations", "Recommendations"],
];

/** How a refusal begins: about reading the paste, never about the review. */
export const REVIEW_OUTPUT_NOT_READ = "Review output was not read";

export type ReviewOutputParse =
  | {
      readonly ok: true;
      readonly entry: ReviewEntry;
      /** Text before the first section — a reviewer's lead-in — was left out. */
      readonly leftOut: boolean;
    }
  | { readonly ok: false; readonly message: string };

/**
 * The Review Result draft the host holds, or why a paste could not be read.
 *
 * A draft — from a paste or a captured review — rides on every push until it is
 * saved, discarded (Cancel) or no longer about the work item on screen, so a
 * panel that is recreated fills its form again. A refusal rides on one push.
 * The token lets the page act on each exactly once.
 */
export type ReviewPrefill =
  | {
      readonly token: number;
      readonly entry: ReviewEntry;
      readonly leftOut?: true;
      /**
       * Where the draft came from, for its note: `ai` when BugPilot ran the
       * reviewer and read its reply itself, absent for a paste — whose source
       * BugPilot cannot know.
       */
      readonly source?: "ai";
    }
  | { readonly token: number; readonly error: string };

/** A level-two ATX heading, up to three spaces in, optional closing hashes. */
const HEADING = /^ {0,3}##[ \t]+(.*?)(?:[ \t]+#+)?[ \t]*$/;
/** A fence opener or closer: three or more backticks or tildes. */
const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

const SECTION_OF = new Map(REVIEW_OUTPUT_SECTIONS.map(([key, name]) => [normalizedName(name), key]));
const NAME_OF = new Map(REVIEW_OUTPUT_SECTIONS.map(([key, name]) => [key, name]));

/**
 * Read a pasted review into the four sections, or say why it cannot be.
 *
 * - A section starts at its `## ` heading, matched case-insensitively with runs
 *   of whitespace as one space, and runs to the next of the four. Any order is
 *   read; each heading may appear once.
 * - Inside a code fence nothing is a heading, so a `## Summary` in a snippet
 *   stays in the snippet.
 * - Any other `## ` heading is text of the section it is in, as record-review
 *   keeps it (demoted, so the report's own sections stay the only ones).
 * - Text before the first section is left out, and the result says so.
 * - A section with nothing under it is empty — saved as "Not recorded." — but
 *   all four must be there, and at least one must say something.
 * - Each line loses its trailing whitespace, and a section its leading and
 *   trailing blank lines; nothing else is changed.
 */
export function parseReviewOutput(text: string): ReviewOutputParse {
  if (text.length > MAX_REVIEW_OUTPUT) {
    return refused(
      `it is longer than ${MAX_REVIEW_OUTPUT.toLocaleString("en-US")} characters. Paste only the reviewer's four sections.`,
    );
  }
  if (text.trim() === "") return refused("nothing was pasted.");

  const collected = new Map<keyof ReviewEntry, string[]>();
  let current: string[] | undefined;
  let leftOut = false;
  let fence: { readonly marker: string; readonly length: number } | undefined;

  for (const raw of text.split(/\r\n|\r|\n/)) {
    const line = raw.trimEnd();
    const fenced = FENCE.exec(line);
    if (fence === undefined && fenced) {
      const marker = fenced[1]!;
      // A backtick fence's info string cannot hold a backtick; one that does is text.
      if (!(marker.startsWith("`") && (fenced[2] ?? "").includes("`"))) {
        fence = { marker: marker[0]!, length: marker.length };
      }
    } else if (fence !== undefined && fenced) {
      const marker = fenced[1]!;
      if (marker[0] === fence.marker && marker.length >= fence.length && (fenced[2] ?? "").trim() === "") {
        fence = undefined;
      }
    } else if (fence === undefined) {
      const heading = HEADING.exec(line);
      const key = heading ? SECTION_OF.get(normalizedName(heading[1] ?? "")) : undefined;
      if (key !== undefined) {
        if (collected.has(key)) {
          return refused(`"## ${NAME_OF.get(key)}" appears more than once. Keep one and parse again.`);
        }
        current = [];
        collected.set(key, current);
        continue;
      }
    }
    if (current === undefined) {
      if (line !== "") leftOut = true;
      continue;
    }
    current.push(line);
  }

  const missing = REVIEW_OUTPUT_SECTIONS.filter(([key]) => !collected.has(key)).map(([, name]) => `## ${name}`);
  if (missing.length > 0) {
    const unclosed = fence === undefined ? "" : " A code fence is not closed, so everything after it was read as code.";
    return refused(
      `${missing.length === 1 ? "this section is" : "these sections are"} missing: ${missing.join(", ")}. ` +
        `The output needs all four: ${REVIEW_OUTPUT_SECTIONS.map(([, name]) => `## ${name}`).join(", ")}.${unclosed}`,
    );
  }

  const section = (key: keyof ReviewEntry): string => trimBlankLines(collected.get(key) ?? []);
  const entry: ReviewEntry = {
    summary: section("summary"),
    findings: section("findings"),
    validationNotes: section("validationNotes"),
    recommendations: section("recommendations"),
  };
  for (const [key, name] of REVIEW_OUTPUT_SECTIONS) {
    if (entry[key].length > MAX_REVIEW_SECTION) {
      return refused(`## ${name} is longer than ${MAX_REVIEW_SECTION.toLocaleString("en-US")} characters.`);
    }
  }
  if (REVIEW_OUTPUT_SECTIONS.every(([key]) => entry[key] === "")) {
    return refused("all four sections are empty.");
  }
  return { ok: true, entry, leftOut };
}

function refused(reason: string): ReviewOutputParse {
  return { ok: false, message: `${REVIEW_OUTPUT_NOT_READ}: ${reason}` };
}

function normalizedName(name: string): string {
  return name.trim().replace(/\s+/g, " ").toLowerCase();
}

function trimBlankLines(lines: readonly string[]): string {
  let start = 0;
  let end = lines.length;
  while (start < end && lines[start] === "") start += 1;
  while (end > start && lines[end - 1] === "") end -= 1;
  return lines.slice(start, end).join("\n");
}
