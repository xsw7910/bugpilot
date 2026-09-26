/**
 * Reading `bugpilot review-package --json`: the review prompt and the
 * validation checklist the Fix result row offers (Batch 9).
 *
 * The CLI builds both; this reader only takes them back, bounded. A malformed
 * envelope is "not available", never a guess: without a prompt there is nothing
 * to copy, and a checklist without its steps is not one.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_RISKS, reviewPackageArgs, reviewPackageFromEnvelope } from "../src/app/reviewPackage.ts";
import type { Envelope } from "../src/protocol.ts";

const PROMPT = "# Final Review Request\n\nReview the BugPilot result for work item JR-12345.\n";

const STEPS = [
  "Reproduce the original issue if possible.",
  "Confirm the failure no longer occurs.",
  "Confirm the fix does not change unrelated behavior.",
  "Run the focused tests named in fix_report.md's Tests section, if any.",
  "Check regression areas mentioned in context.md and retrieval.json.",
];

const envelope = (validation: unknown, prompt: unknown = PROMPT): Envelope => ({
  ok: true,
  command: "review-package",
  warnings: [],
  work_item_id: "JR-12345",
  prompt,
  validation,
});

test("the command is the read-only JSON query, for exactly this work item", () => {
  assert.deepEqual([...reviewPackageArgs("JR-12345")], ["review-package", "JR-12345", "--json"]);
});

test("a well-formed envelope gives the prompt as written and the checklist as lists", () => {
  const parsed = reviewPackageFromEnvelope(
    envelope({
      steps: STEPS,
      regression_files: ["src/widgets/WidgetController.cpp", "src/widgets/WidgetController.h"],
      review_risks: ["- Check the other enum comparisons.", "The legacy VDS path is untested."],
    }),
  );
  assert.deepEqual(parsed, {
    prompt: PROMPT,
    validation: {
      steps: STEPS,
      files: ["src/widgets/WidgetController.cpp", "src/widgets/WidgetController.h"],
      // The report's own list markers go; the panel draws its bullets.
      risks: ["Check the other enum comparisons.", "The legacy VDS path is untested."],
    },
  });
});

test("the prompt is kept byte for byte: it is what the reviewer will read", () => {
  const prompt = "# Final Review Request\n\n  indented line\n\ttab\n\nVerdict:\nPASS / NEEDS CHANGES\n";
  assert.equal(reviewPackageFromEnvelope(envelope({ steps: STEPS }, prompt))?.prompt, prompt);
});

test("a failure, a missing prompt or a checklist without steps is not available", () => {
  const failure: Envelope = {
    ok: false,
    command: "review-package",
    error: { code: "WORK_ITEM_NOT_FOUND", message: "Work item not found" },
  };
  assert.equal(reviewPackageFromEnvelope(failure), undefined);
  const { prompt: _dropped, ...withoutPrompt } = envelope({ steps: STEPS }) as Record<string, unknown>;
  assert.equal(reviewPackageFromEnvelope(withoutPrompt as Envelope), undefined, "no prompt at all");
  for (const prompt of ["", "   ", 42, "x".repeat(70_000)]) {
    assert.equal(reviewPackageFromEnvelope(envelope({ steps: STEPS }, prompt)), undefined, JSON.stringify(prompt).slice(0, 20));
  }
  for (const validation of [undefined, null, "steps", { steps: [] }, { steps: "x" }, { regression_files: ["a"] }]) {
    assert.equal(reviewPackageFromEnvelope(envelope(validation)), undefined, JSON.stringify(validation));
  }
});

test("missing optional lists are empty, not an error", () => {
  const parsed = reviewPackageFromEnvelope(envelope({ steps: STEPS }));
  assert.deepEqual(parsed?.validation, { steps: STEPS, files: [], risks: [] });
});

test("Review Notes past the row's share are counted, not dropped silently", () => {
  const risks = Array.from({ length: MAX_RISKS + 3 }, (_, index) => `- Risk ${index + 1}`);
  const parsed = reviewPackageFromEnvelope(envelope({ steps: STEPS, review_risks: risks }));
  assert.equal(parsed?.validation.risks.length, MAX_RISKS);
  assert.equal(parsed?.validation.risks[0], "Risk 1");
  assert.equal(parsed?.validation.moreRisks, 3);
});

test("every line is bounded, whitespace collapsed, and non-text dropped", () => {
  const long = "Check ".concat("the exporter path ".repeat(40));
  const parsed = reviewPackageFromEnvelope(
    envelope({ steps: [...STEPS, 7, null, "  multiple   spaces\there  "], review_risks: [long, "", "   "] }),
  );
  const steps = parsed?.validation.steps ?? [];
  assert.equal(steps.length, 6);
  assert.equal(steps.at(-1), "multiple spaces here");
  const risk = parsed?.validation.risks[0] ?? "";
  assert.ok(Array.from(risk).length <= 240);
  assert.ok(risk.endsWith("…"));
  assert.equal(parsed?.validation.risks.length, 1, "blank risks were kept");
});

test("HTML-looking text is returned as text", () => {
  const hostile = "<img src=x onerror=alert(1)> <script>alert(1)</script>";
  const parsed = reviewPackageFromEnvelope(envelope({ steps: [hostile], review_risks: [hostile] }));
  assert.equal(parsed?.validation.steps[0], hostile);
  assert.equal(parsed?.validation.risks[0], hostile);
});
