/**
 * Paste Review Output's parser: the canonical four sections, read
 * deterministically, or a refusal that says why — never a verdict.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_REVIEW_OUTPUT, REVIEW_OUTPUT_NOT_READ, parseReviewOutput } from "../src/app/reviewOutput.ts";
import type { ReviewOutputParse } from "../src/app/reviewOutput.ts";
import { MAX_REVIEW_SECTION } from "../src/app/reviewCapture.ts";

const CANONICAL = [
  "## Summary",
  "Main fix addresses the issue.",
  "",
  "## Findings",
  "Missing null handling in WidgetController.",
  "",
  "## Validation Notes",
  "Reviewed the diff. No tests were run.",
  "",
  "## Recommendations",
  "Add a regression test.",
  "",
].join("\n");

function read(text: string): Extract<ReviewOutputParse, { ok: true }> {
  const parsed = parseReviewOutput(text);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.message);
  return parsed as Extract<ReviewOutputParse, { ok: true }>;
}

function refusal(text: string): string {
  const parsed = parseReviewOutput(text);
  assert.equal(parsed.ok, false, "the paste was read");
  const message = (parsed as Extract<ReviewOutputParse, { ok: false }>).message;
  assert.ok(message.startsWith(`${REVIEW_OUTPUT_NOT_READ}: `), message);
  return message;
}

test("all four sections are read, each in its own words", () => {
  const parsed = read(CANONICAL);
  assert.deepEqual(parsed.entry, {
    summary: "Main fix addresses the issue.",
    findings: "Missing null handling in WidgetController.",
    validationNotes: "Reviewed the diff. No tests were run.",
    recommendations: "Add a regression test.",
  });
  assert.equal(parsed.leftOut, false);
});

test("headings match case-insensitively, with spacing and closing hashes forgiven", () => {
  const parsed = read(
    "##   SUMMARY  ##\nA.\n## findings\nB.\n  ## Validation   notes\nC.\n##\tRecommendations\nD.\n",
  );
  assert.deepEqual(parsed.entry, { summary: "A.", findings: "B.", validationNotes: "C.", recommendations: "D." });
});

test("the sections may come in any order, each read under its own heading", () => {
  const parsed = read("## Findings\nB.\n## Summary\nA.\n## Recommendations\nD.\n## Validation Notes\nC.\n");
  assert.deepEqual(parsed.entry, { summary: "A.", findings: "B.", validationNotes: "C.", recommendations: "D." });
});

test("an empty section is read as empty, and saving then records it as not recorded", () => {
  const parsed = read("## Summary\nA.\n## Findings\n\n## Validation Notes\n   \n## Recommendations\nD.\n");
  assert.equal(parsed.entry.findings, "");
  assert.equal(parsed.entry.validationNotes, "");
});

test("four empty sections are refused: there is nothing to prefill", () => {
  assert.match(refusal("## Summary\n## Findings\n## Validation Notes\n## Recommendations\n"), /all four sections are empty/);
});

test("a duplicated heading is refused, naming it", () => {
  const message = refusal(`${CANONICAL}\n## Findings\nA second list.\n`);
  assert.match(message, /"## Findings" appears more than once/);
});

test("a heading inside a code fence is code, not a section", () => {
  const text = [
    "## Summary",
    "Reads correctly.",
    "## Findings",
    "```markdown",
    "## Summary",
    "## Recommendations",
    "```",
    "~~~~",
    "## Validation Notes",
    "~~~",
    "still fenced",
    "~~~~",
    "## Validation Notes",
    "Read the diff.",
    "## Recommendations",
    "None.",
  ].join("\n");
  const parsed = read(text);
  assert.equal(
    parsed.entry.findings,
    "```markdown\n## Summary\n## Recommendations\n```\n~~~~\n## Validation Notes\n~~~\nstill fenced\n~~~~",
  );
  assert.equal(parsed.entry.validationNotes, "Read the diff.");
  assert.equal(parsed.entry.summary, "Reads correctly.");
});

test("an unclosed fence swallows the headings after it, and the refusal says why", () => {
  const message = refusal("## Summary\nA.\n```\n## Findings\n## Validation Notes\n## Recommendations\n");
  assert.match(message, /missing: ## Findings, ## Validation Notes, ## Recommendations/);
  assert.match(message, /A code fence is not closed/);
});

test("oversized input is refused before it is read", () => {
  const huge = `## Summary\n${"x".repeat(MAX_REVIEW_OUTPUT)}\n## Findings\n\n## Validation Notes\n\n## Recommendations\n`;
  assert.match(refusal(huge), /longer than/);
});

test("one section past record-review's cap is refused, naming it", () => {
  const long = `## Summary\nA.\n## Findings\n${"x".repeat(MAX_REVIEW_SECTION + 1)}\n## Validation Notes\n\n## Recommendations\n`;
  assert.ok(long.length <= MAX_REVIEW_OUTPUT);
  assert.match(refusal(long), /## Findings is longer than 50,000 characters/);
});

test("a missing section is refused, naming what is missing and what is needed", () => {
  const message = refusal("## Summary\nA.\n## Findings\nB.\n## Recommendations\nD.\n");
  assert.match(message, /this section is missing: ## Validation Notes\./);
  assert.match(message, /needs all four: ## Summary, ## Findings, ## Validation Notes, ## Recommendations/);
});

test("output in another shape is refused, never guessed at", () => {
  for (const text of [
    "Verdict: PASS\nBlocking issues: none\n",
    "# Summary\nA.\n# Findings\nB.\n# Validation Notes\nC.\n# Recommendations\nD.\n",
    "### Summary\nA.\n### Findings\nB.\n### Validation Notes\nC.\n### Recommendations\nD.\n",
    "**Summary**\nA.\n**Findings**\nB.\n**Validation Notes**\nC.\n**Recommendations**\nD.\n",
    "Summary:\nA.\nFindings:\nB.\nValidation Notes:\nC.\nRecommendations:\nD.\n",
  ]) {
    assert.match(refusal(text), /missing/, text);
  }
});

test("an empty paste is refused", () => {
  assert.match(refusal("  \n\t\n"), /nothing was pasted/);
});

test("an unrelated heading stays as text of the section it is in", () => {
  const parsed = read(CANONICAL.replace("## Findings\n", "## Findings\n## Critical\nA crash.\n### Minor\nA typo.\n"));
  assert.equal(parsed.entry.findings, "## Critical\nA crash.\n### Minor\nA typo.\nMissing null handling in WidgetController.");
});

test("a lead-in before the first section is left out, and the result says so", () => {
  const parsed = read(`Here is my review of JR-1.\n\n## Notes\nignored\n\n${CANONICAL}`);
  assert.equal(parsed.leftOut, true);
  assert.equal(parsed.entry.summary, "Main fix addresses the issue.");
  assert.equal(read(`\n\n   \n${CANONICAL}`).leftOut, false, "blank lines are not a lead-in");
});

test("whitespace is normalized: line endings, trailing spaces and outer blank lines", () => {
  const parsed = read(
    "## Summary\r\n\r\n  Indented stays.   \r\n\tTab stays.\t\r\n\r\n\r\n## Findings\rB.\r## Validation Notes\nC.  \n\n\nC2.\n## Recommendations\nD.",
  );
  assert.equal(parsed.entry.summary, "  Indented stays.\n\tTab stays.");
  assert.equal(parsed.entry.findings, "B.");
  assert.equal(parsed.entry.validationNotes, "C.\n\n\nC2.");
  assert.equal(parsed.entry.recommendations, "D.");
});

test("nothing is inferred: verdict words pass through as text, and no status is returned", () => {
  const parsed = read(
    "## Summary\nPASS. Approved, safe to merge.\n## Findings\nNone.\n## Validation Notes\nVerified: all tests passed.\n## Recommendations\nLGTM.\n",
  );
  assert.deepEqual(Object.keys(parsed).sort(), ["entry", "leftOut", "ok"]);
  assert.deepEqual(Object.keys(parsed.entry).sort(), ["findings", "recommendations", "summary", "validationNotes"]);
  assert.equal(parsed.entry.summary, "PASS. Approved, safe to merge.");
  assert.equal(parsed.entry.validationNotes, "Verified: all tests passed.");
});
