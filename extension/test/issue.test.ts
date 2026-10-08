/**
 * Reading the Issue details row's three facts out of `issue.json`.
 *
 * The rule is the one `retrieval.ts` follows: strict and shallow. A file this
 * reader does not fully understand is "not known", and the row then says only
 * "Completed" — better than a row that names the wrong issue.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { ISSUE_ARTIFACT, parseIssue } from "../src/app/issue.ts";

/** A version-1 `issue.json`, with the fields `issue_to_dict` writes around the three read here. */
const ISSUE = {
  schema_version: 1,
  id: "JR-12345",
  source: "jira",
  title: "WidgetController rejects the CSV output type",
  description: "Saving a CSV volume fails with an output type error.",
  comments: [],
  signals: { stack_traces: [], error_messages: [], log_signals: [] },
  details: { issue_type: "Bug", status: "Open", labels: [] },
};

const text = (value: unknown) => JSON.stringify(value);

test("the file name is the one bugpilot writes", () => {
  assert.equal(ISSUE_ARTIFACT, "issue.json");
});

test("a Jira issue yields its id, its source and its title", () => {
  assert.deepEqual(parseIssue(text(ISSUE)), {
    id: "JR-12345",
    source: "jira",
    title: "WidgetController rejects the CSV output type",
  });
});

test("a hand-written bug is read the same way", () => {
  assert.deepEqual(parseIssue(text({ ...ISSUE, id: "BUG-20260925-1", source: "manual", title: "Crash on export" })), {
    id: "BUG-20260925-1",
    source: "manual",
    title: "Crash on export",
  });
});

test("an issue with no title still names itself", () => {
  // A Jira stub, or a description written without a title: the row shows the
  // id and simply has no second line.
  for (const title of [undefined, "", "   ", 42, null]) {
    const issue = title === undefined ? { ...ISSUE, title: undefined } : { ...ISSUE, title };
    assert.equal(parseIssue(text(issue))?.title, "", JSON.stringify(title));
  }
});

test("surrounding whitespace is not part of the id or the title", () => {
  const parsed = parseIssue(text({ ...ISSUE, id: "  JR-12345 ", title: "\n Title \t" }));
  assert.equal(parsed?.id, "JR-12345");
  assert.equal(parsed?.title, "Title");
});

test("a missing, empty or unparseable file is not known", () => {
  for (const input of [undefined, "", "   \n", "{", "not json", "null", "[]", "\"issue\"", "1"]) {
    assert.equal(parseIssue(input), undefined, JSON.stringify(input));
  }
});

test("another schema version is not guessed at", () => {
  for (const version of [0, 2, "1", undefined]) {
    assert.equal(parseIssue(text({ ...ISSUE, schema_version: version })), undefined, String(version));
  }
});

test("an issue without a usable id is not known", () => {
  // The id is what the row's line is built from; without it there is nothing
  // true to say beyond "Completed".
  for (const id of [undefined, "", "   ", 12345, null]) {
    assert.equal(parseIssue(text({ ...ISSUE, id })), undefined, JSON.stringify(id));
  }
});

test("an issue whose source is not a string is not known", () => {
  for (const source of [undefined, 1, null, ["jira"]]) {
    assert.equal(parseIssue(text({ ...ISSUE, source })), undefined, JSON.stringify(source));
  }
});

test("a hostile title is returned as the text it is", () => {
  // Escaping is the page's job (it renders with textContent); this reader must
  // neither strip nor interpret it.
  const hostile = "<img src=x onerror=1> & <b>bold</b>";
  assert.equal(parseIssue(text({ ...ISSUE, title: hostile }))?.title, hostile);
});
