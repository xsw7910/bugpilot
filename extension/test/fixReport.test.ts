/**
 * The two lines the Fix result row shows of `fix_report.md`.
 *
 * Two rules run through this file. **The agent's words pass through**: nothing
 * here decides whether a report means fixed, failed or passed. And **the file
 * is read the way `bugpilot/core/fix_report.py` reads it**, so the panel and the
 * CLI cannot disagree about which section a line belongs to.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { MAX_PREVIEW_CHARS, parseFixReport, sectionOf } from "../src/app/fixReport.ts";

/** A report in the shape `task.md` asks for. */
const CANONICAL = `# Fix Report: JR-12345

## Summary

Fixed the output-type validation in WidgetController.

The check compared the wrong enum.

## Analysis

### Root cause

WidgetController::validate() compared against VDS_LEGACY.

## Changes

- src/widgets/WidgetController.cpp: compare against the current enum.

## Tests

24 passed, 0 failed (ctest -R widget).

## Review Notes

None beyond the change itself.
`;

test("a canonical report yields its first Summary line and its first Tests line", () => {
  assert.deepEqual(parseFixReport(CANONICAL), {
    readable: true,
    summary: "Fixed the output-type validation in WidgetController.",
    tests: "24 passed, 0 failed (ctest -R widget).",
  });
});

test("whatever the agent said is what the row says, however it reads", () => {
  // Not a classifier: an investigation, a no-op and a failing attempt are all
  // the same kind of result — a report — and their words pass through intact.
  for (const [summary, tests] of [
    ["Investigation complete; no source changes applied.", "Not run: investigation-only mode."],
    ["Attempted fix; validation still fails.", "pytest: 2 failed, 18 passed."],
    ["No code change was required.", "Not run: no code changed."],
    ["Developer manual fix. TODO: one line on what was done and the outcome.", "TODO: the commands run and their outcomes."],
  ]) {
    const preview = parseFixReport(`# Fix Report: JR-12345\n\n## Summary\n\n${summary}\n\n## Tests\n\n${tests}\n`);
    assert.deepEqual(preview, { readable: true, summary, tests });
  }
});

test("headings match with case and surrounding whitespace forgiven, as the CLI does", () => {
  // Surrounding, not internal: `section_of` compares the stripped, lowercased
  // line with "## summary", and so does this.
  assert.equal(parseFixReport("##   Summary\nNot matched.\n").summary, undefined);
  const text = "# x\n\n  ## SUMMARY   \nFixed it.\n\n## tests \t\n3 passed.\n";
  const preview = parseFixReport(text);
  assert.equal(preview.summary, "Fixed it.");
  assert.equal(preview.tests, "3 passed.");
});

test("a missing, empty or unfinished section is simply absent", () => {
  // A report being written is a report with fewer sections, not a broken one.
  assert.deepEqual(parseFixReport("# Fix Report: JR-12345\n"), { readable: true });
  assert.deepEqual(parseFixReport("# Fix Report: JR-12345\n\n## Summary\n\n## Analysis\nx\n"), { readable: true });
  assert.deepEqual(parseFixReport("## Summary\nFixed it.\n"), { readable: true, summary: "Fixed it." });
  assert.deepEqual(parseFixReport("## Summary\nFixed it.\n\n## Analysis\nBecause.\n"), {
    readable: true,
    summary: "Fixed it.",
  });
  assert.deepEqual(parseFixReport(""), { readable: true });
});

test("sections are found wherever they are, and subheadings stay inside them", () => {
  const text = "## Tests\n### Unit\n5 passed.\n\n## Summary\n### What\nFixed it.\n";
  assert.deepEqual(parseFixReport(text), { readable: true, summary: "Fixed it.", tests: "5 passed." });
  // `###` is content, never a section of its own.
  assert.equal(parseFixReport("### Summary\nNot a section.\n").summary, undefined);
});

test("the first heading wins, like the CLI's reader", () => {
  const text = "## Summary\nFirst.\n\n## Summary\nSecond.\n";
  assert.equal(parseFixReport(text).summary, "First.");
});

test("Markdown's scaffolding is set aside, and the words are left alone", () => {
  const text = [
    "## Summary",
    "",
    "<!-- the agent's own note -->",
    "---",
    "<details>",
    "> - **Fixed** the `outputType` check.",
    "## Tests",
    "1. `ctest -R widget`: 24 passed",
  ].join("\n");
  const preview = parseFixReport(text);
  // The comment, the rule and the bare tag are skipped; the quote, list and
  // bold markers go; backticks and every word stay.
  assert.equal(preview.summary, "Fixed the `outputType` check.");
  assert.equal(preview.tests, "`ctest -R widget`: 24 passed");
});

test("identifiers that look like emphasis keep every character", () => {
  // Only `**bold**` around a whole span is formatting.
  for (const line of [
    "Fixed the import cycle in __init__.py and a ** b overflow.",
    "Pass **kwargs through to the widget factory.",
    "Guarded __declspec(dllexport) and __FILE__ usage.",
  ]) {
    assert.equal(parseFixReport(`## Summary\n${line}\n`).summary, line);
  }
  assert.equal(parseFixReport("## Summary\n**Fixed** the check (**partly**).\n").summary, "Fixed the check (partly).");
});

test("a multi-line comment is skipped as a whole", () => {
  const text = "## Summary\n<!--\nTODO: fill this in\n-->\nFixed it.\n";
  assert.equal(parseFixReport(text).summary, "Fixed it.");
});

test("prose outside a code fence wins; a fence alone gives its first line, as written", () => {
  // task.md asks for the commands run and their outcomes, which agents often
  // write as a command block and then a sentence.
  const commandThenResult = "## Tests\n```bash\n$ pytest -q tests/test_widget.py\n```\n18 passed, 2 failed.\n";
  assert.equal(parseFixReport(commandThenResult).tests, "18 passed, 2 failed.");
  const onlyFenced = "## Tests\n```\n$ pytest -q\n# 18 passed\n```\n";
  // Literal: inside a fence nothing is Markdown, so `$` and `#` stay.
  assert.equal(parseFixReport(onlyFenced).tests, "$ pytest -q");
});

test("a table's header and separator are skipped, and its first row reads as cells", () => {
  const text = "## Tests\n| Command | Result |\n|---|:---:|\n| pytest tests | 2 failed, 18 passed |\n";
  assert.equal(parseFixReport(text).tests, "pytest tests · 2 failed, 18 passed");
});

test("every line break the CLI's reader knows is a line break here too", () => {
  // Python's splitlines() splits on a lone CR, form feeds, the Unicode line and
  // paragraph separators and more; section_of reads them all as new lines.
  for (const breakChar of ["\r", "\u2028", "\u2029", "\f", "\v", "\x85"]) {
    const text = ["# T", "## Summary", "Fixed it.", "## Tests", "3 passed."].join(breakChar);
    assert.deepEqual(parseFixReport(text), { readable: true, summary: "Fixed it.", tests: "3 passed." }, JSON.stringify(breakChar));
  }
});

test("a cut never leaves half an emoji", () => {
  const long = `${"x".repeat(MAX_PREVIEW_CHARS - 2)}😀😀😀`;
  const summary = parseFixReport(`## Summary\n${long}\n`).summary ?? "";
  assert.ok(summary.endsWith("…"));
  assert.equal(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/.test(summary), false, "a lone high surrogate was left behind");
  assert.ok(Array.from(summary).length <= MAX_PREVIEW_CHARS);
});

test("Windows line endings read the same", () => {
  const preview = parseFixReport(CANONICAL.replaceAll("\n", "\r\n"));
  assert.equal(preview.summary, "Fixed the output-type validation in WidgetController.");
  assert.equal(preview.tests, "24 passed, 0 failed (ctest -R widget).");
});

test("HTML-looking text is returned as the text it is", () => {
  // Escaping is the page's job (textContent); this reader neither strips nor
  // interprets it.
  const hostile = '<img src=x onerror=alert(1)> <script>alert("x")</script>';
  const preview = parseFixReport(`## Summary\n${hostile}\n## Tests\n${hostile}\n`);
  assert.equal(preview.summary, hostile);
  assert.equal(preview.tests, hostile);
});

test("a line longer than the row can hold is cut, and says so", () => {
  const long = "Fixed ".concat("the validation ".repeat(40));
  const summary = parseFixReport(`## Summary\n${long}\n`).summary ?? "";
  assert.ok(summary.length <= MAX_PREVIEW_CHARS, `${summary.length} characters`);
  assert.ok(summary.endsWith("…"));
  assert.ok(summary.startsWith("Fixed the validation"));
});

test("a pathological file costs only its start", () => {
  // A report megabytes long still yields two short lines; a Summary buried
  // past the scanned window is simply not previewed.
  const padding = "x".repeat(300 * 1024);
  assert.deepEqual(parseFixReport(`## Summary\nFixed it.\n${padding}\n## Tests\nLate.\n`), {
    readable: true,
    summary: "Fixed it.",
  });
  assert.deepEqual(parseFixReport(`${padding}\n## Summary\nToo late.\n`), { readable: true });
});

test("a report that could not be read is still a report, with nothing to preview", () => {
  assert.deepEqual(parseFixReport(undefined), { readable: false });
});

test("sectionOf is the CLI's section_of, case for case", () => {
  // The same expectations tests/test_fix_report_artifact.py holds the Python
  // reader to.
  const text = "# T\n\n## Summary\nline one\n### sub\nline two\n\n## Tests\nok\n";
  assert.equal(sectionOf(text, "## Summary"), "line one\n### sub\nline two");
  assert.equal(sectionOf(text, "## Tests"), "ok");
  assert.equal(sectionOf(text, "## Review Notes"), "");
  assert.equal(sectionOf("## summary \nx\n", "## Summary"), "x");
});
