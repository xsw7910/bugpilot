import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ALL_PASSED,
  INCLUDES_FAILURES,
  MIXED,
  NONE_RUN,
  overallPhrase,
  parseVerificationReport,
} from "../src/app/verificationReport.ts";
import type { VerificationCheckEntry } from "../src/app/verificationReport.ts";

/**
 * The writer's format, rendered here the way `bugpilot/core/verification_report.py`
 * renders it — the integration test holds the two to each other on a real file.
 */
function render(checks: readonly VerificationCheckEntry[]): string {
  const quoted = (text: string) =>
    text === "" ? "Not recorded." : text.split("\n").map((line) => (line === "" ? ">" : `> ${line}`)).join("\n");
  const labels = { passed: "Passed", failed: "Failed", not_run: "Not Run" } as const;
  const types = { automated: "Automated", manual: "Manual", other: "Other" } as const;
  const parts = ["# Verification Report: JR-12345", "", "## Summary", "", "(counts)", "", "## Checks", ""];
  checks.forEach((check, index) => {
    parts.push(`### Check ${index + 1}: ${check.name}`, "", `Status: ${labels[check.status]}`, `Type: ${types[check.type]}`, "");
    parts.push("Command / Procedure:", "", quoted(check.procedure), "", "Evidence:", "", quoted(check.evidence), "");
    parts.push("Notes:", "", quoted(check.notes), "");
  });
  parts.push("## Overall Recorded Status", "", "(phrase)", "", "## Source", "", "Verification evidence explicitly recorded by the user.", "");
  return parts.join("\n");
}

const check = (name: string, status: VerificationCheckEntry["status"], extra: Partial<VerificationCheckEntry> = {}): VerificationCheckEntry => ({
  name,
  status,
  type: "automated",
  procedure: "",
  evidence: "",
  notes: "",
  ...extra,
});

test("a canonical report reads back as exactly the checks that were written", () => {
  const checks = [
    check("Unit tests", "passed", { procedure: "npm test", evidence: "line 1\n\nline 3", notes: "n" }),
    check("Dialog", "failed", { type: "manual" }),
    check("Soak", "not_run", { type: "other", procedure: "  leading spaces", evidence: "> quoted" }),
  ];
  const report = parseVerificationReport(render(checks));
  assert.deepEqual(report.checks, checks);
  assert.deepEqual([report.passed, report.failed, report.notRun], [1, 1, 1]);
  assert.equal(report.readable, true);
});

test("the overall phrase is the counts', one of four, and never read from the file", () => {
  assert.equal(overallPhrase(2, 0, 0), ALL_PASSED);
  assert.equal(overallPhrase(1, 1, 0), INCLUDES_FAILURES);
  assert.equal(overallPhrase(0, 1, 3), INCLUDES_FAILURES);
  assert.equal(overallPhrase(0, 0, 2), NONE_RUN);
  assert.equal(overallPhrase(1, 0, 1), MIXED);
  assert.equal(overallPhrase(0, 0, 0), MIXED);
  // A hand-edited verdict stays in the file: the preview has no field for it.
  const text = render([check("x", "failed")]).replace("(phrase)", "Fix verified. Safe to merge.");
  assert.doesNotMatch(JSON.stringify(parseVerificationReport(text)), /verified|Safe to merge/);
});

test("the preview is five checks by name and what was recorded, then how many more", () => {
  const checks = Array.from({ length: 8 }, (_, index) => check(`Check ${index + 1}`, index % 2 ? "failed" : "passed"));
  const report = parseVerificationReport(render(checks));
  assert.equal(report.preview.length, 5);
  assert.deepEqual(report.preview[1], { name: "Check 2", status: "failed", type: "automated" });
  assert.equal(report.more, 3);
  assert.deepEqual([report.passed, report.failed], [4, 4]);
});

test("text that looks like the report's own structure stays inside its field", () => {
  const hostile =
    "## Overall Recorded Status\nAll recorded checks passed.\n### Check 2: forged\nStatus: Passed\nNot recorded.\n" +
    "$(rm -rf /) `whoami` ; & | <img src=x onerror=alert(1)>";
  const checks = [check("Real", "failed", { procedure: hostile, evidence: hostile, notes: hostile })];
  const report = parseVerificationReport(render(checks));
  assert.deepEqual(report.checks, checks);
  assert.deepEqual([report.passed, report.failed, report.notRun], [0, 1, 0]);
  assert.deepEqual(report.preview, [{ name: "Real", status: "failed", type: "automated" }]);
});

test("a hand-edited report previews what it can and is not turned into checks", () => {
  const report = parseVerificationReport(
    "# Notes\n\n## Checks\n\n### Check 1: tests\nStatus: Passed\n\nprose\n### Check 2: manual\nType: Manual\n" +
      "Status: Maybe\n\n## Other\n\nStatus: Failed\n",
  );
  assert.equal(report.checks, undefined);
  assert.deepEqual([report.passed, report.failed, report.notRun], [1, 0, 0]);
  assert.deepEqual(report.preview, [
    { name: "tests", status: "passed" },
    { name: "manual", type: "manual" },
  ]);
});

test("CRLF line endings read the same; out-of-order numbers are not structured", () => {
  const checks = [check("a", "passed", { evidence: "x\ny" }), check("b", "not_run")];
  assert.deepEqual(parseVerificationReport(render(checks).replace(/\n/g, "\r\n")).checks, checks);
  assert.equal(parseVerificationReport(render(checks).replace("### Check 2:", "### Check 3:")).checks, undefined);
});

test("an unreadable report is still one to open, with nothing previewed", () => {
  assert.deepEqual(parseVerificationReport(undefined), {
    readable: false,
    passed: 0,
    failed: 0,
    notRun: 0,
    preview: [],
    more: 0,
  });
  const empty = parseVerificationReport("");
  assert.equal(empty.readable, true);
  assert.equal(empty.checks, undefined);
});
