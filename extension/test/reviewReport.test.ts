/**
 * What Review Result shows of review_report.md: bounded lines in the
 * reviewer's words, and which sections were recorded — never a verdict.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_PREVIEW_CHARS } from "../src/app/fixReport.ts";
import { parseReviewReport } from "../src/app/reviewReport.ts";

const REPORT =
  "# Review Report: JR-12345\n\n" +
  "## Summary\n\n**The change reads correctly.** Two notes.\n\n" +
  "## Findings\n\n### Minor\n\n- The null check duplicates one in the caller.\n- A second finding.\n\n" +
  "## Validation Notes\n\nThe reviewer read the diff only.\n\n" +
  "## Recommendations\n\nNot recorded.\n\n" +
  "## Source\n\nRecorded from an external review.\n";

test("the preview is the first line of Summary and of Findings, and which other sections hold something", () => {
  assert.deepEqual(parseReviewReport(REPORT), {
    readable: true,
    summary: "The change reads correctly. Two notes.",
    findings: "The null check duplicates one in the caller.",
    validationNotes: true,
    recommendations: false,
  });
});

test("a section left empty by the writer counts as not recorded", () => {
  const preview = parseReviewReport(
    "## Summary\n\nNot recorded.\n\n## Findings\n\nOnly findings.\n\n## Validation Notes\n\nNot recorded.\n",
  );
  assert.equal(preview.summary, undefined);
  assert.equal(preview.findings, "Only findings.");
  assert.equal(preview.validationNotes, false);
});

test("missing sections and hand edits are tolerated", () => {
  assert.deepEqual(parseReviewReport("Just some text a person wrote.\n"), {
    readable: true,
    validationNotes: false,
    recommendations: false,
  });
  assert.equal(parseReviewReport("## summary  \nLower-case heading.\n").summary, "Lower-case heading.");
});

test("an unreadable report is still a report, with nothing to preview", () => {
  assert.deepEqual(parseReviewReport(undefined), { readable: false, validationNotes: false, recommendations: false });
});

test("a verdict in the text is passed through as text, and never becomes a field", () => {
  const preview = parseReviewReport("## Summary\n\nAPPROVED — tests pass, safe to merge.\n");
  assert.equal(preview.summary, "APPROVED — tests pass, safe to merge.");
  assert.deepEqual(Object.keys(preview).sort(), ["readable", "recommendations", "summary", "validationNotes"]);
});

test("a long line is bounded, and a huge file is only scanned at its start", () => {
  const long = parseReviewReport(`## Summary\n\n${"word ".repeat(200)}\n`);
  assert.ok(Array.from(long.summary ?? "").length <= MAX_PREVIEW_CHARS);
  assert.ok(long.summary?.endsWith("…"));
  const huge = parseReviewReport(`## Summary\n\nStart.\n\n${"x".repeat(400 * 1024)}\n## Findings\n\nToo far.\n`);
  assert.equal(huge.summary, "Start.");
  assert.equal(huge.findings, undefined);
});
