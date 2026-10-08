/**
 * Counting what a run produced, from the retrieval it wrote.
 *
 * Every test here is about the same rule: a number the panel cannot stand
 * behind is not shown. A missing artifact, a half-written one, a shape that
 * changed — each has to end in "no count", because "0 relevant files" about a
 * run that found eight is the one failure a developer never forgives.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  contextCounts,
  isSafeRelativePath,
  relevantFiles,
} from "../src/app/contextSummary.ts";
import { describeSearch } from "../src/app/workflow.ts";
import { parseRetrieval } from "../src/app/retrieval.ts";

/** A version-1 `retrieval.json` with these fields, parsed the way the host parses it. */
const retrieval = (fields: Record<string, unknown>) =>
  parseRetrieval(JSON.stringify({ schema_version: 1, ...fields }));

/** The Relevant Files rows for these `related_files` entries. */
const rowsFor = (entries: unknown) => relevantFiles(retrieval({ related_files: entries }));

const RELATED = [
  { file: "src/Selector.cpp", score: 9 },
  { file: "src/Reader.cpp", score: 4 },
];
const TERMS = [{ value: "outputType" }, { value: "Selector" }, { value: "restore" }];

test("both counts come from the one artifact", () => {
  assert.deepEqual(contextCounts(retrieval({ confidence: "high", related_files: RELATED, terms: TERMS })), {
    relevantFiles: 2,
    searchTerms: 3,
  });
});

test("one unusable list does not cost the other its number", () => {
  assert.deepEqual(contextCounts(retrieval({ related_files: RELATED })), { relevantFiles: 2 });
  assert.deepEqual(contextCounts(retrieval({ terms: TERMS })), { searchTerms: 3 });
  assert.deepEqual(contextCounts(retrieval({})), {});
  assert.deepEqual(contextCounts(undefined), {});
});

test("a file that is not JSON yet produces no number", () => {
  // The normal way this happens: the panel reads the directory while a
  // refinement is replacing the file. The next refresh reads it whole.
  for (const half of ["[{", "", "   ", "not json at all", '{"schema_version": 1, "terms": ['] ) {
    assert.deepEqual(contextCounts(parseRetrieval(half)), {});
  }
});

test("a shape that is not the expected one produces no number", () => {
  // The guard that matters if the artifact format ever moves. A wrong number is
  // worse than none, so each of these omits rather than guesses.
  assert.deepEqual(contextCounts(retrieval({ related_files: {}, terms: null })), {});
  assert.deepEqual(contextCounts(retrieval({ related_files: 42, terms: 7 })), {});
  // A string has a length, which is exactly the trap: "4 relevant files" read
  // off the word "abcd" would look like a real answer.
  assert.deepEqual(contextCounts(retrieval({ related_files: "abcd", terms: "abcd" })), {});
  for (const top of ["null", "42", '"text"', "[]"]) {
    assert.deepEqual(contextCounts(parseRetrieval(top)), {}, top);
  }
});

test("only version 1 is read: no older layout, no newer guess", () => {
  const lists = { related_files: RELATED, terms: TERMS };
  for (const version of [undefined, 0, 2, "1", null]) {
    const text = JSON.stringify(version === undefined ? lists : { schema_version: version, ...lists });
    assert.equal(parseRetrieval(text), undefined, String(version));
    assert.deepEqual(contextCounts(parseRetrieval(text)), {}, String(version));
  }
});

test("an empty result is a real answer, not a missing one", () => {
  // A search that retrieved nothing is a fact worth reporting; it is only the
  // *unreadable* case that stays silent.
  assert.deepEqual(contextCounts(retrieval({ related_files: [], terms: [] })), {
    relevantFiles: 0,
    searchTerms: 0,
  });
});

test("nothing is counted that a developer could not act on", () => {
  // The entries carry more than this — which file is documentation, which term
  // was dropped, what weight each carried. None of it is counted here: it is
  // the retrieval pipeline's own vocabulary, and the panel does not teach it.
  const rich = retrieval({
    related_files: [{ file: "a.md", documentation: true }, { file: "b.cpp" }],
    terms: [
      { value: "x", status: "retained", weight: 8 },
      { value: "y", status: "dropped", weight: 5 },
    ],
  });

  assert.deepEqual(contextCounts(rich), { relevantFiles: 2, searchTerms: 2 });
});

test("Code search's line reads as English, including at one", () => {
  // The counts end up on Code search's row, terms first — what was
  // searched, then what it found.
  assert.equal(describeSearch({ relevantFiles: 8, searchTerms: 53 }), "53 terms · 8 relevant files");
  assert.equal(describeSearch({ relevantFiles: 1, searchTerms: 1 }), "1 term · 1 relevant file");
  assert.equal(describeSearch({ relevantFiles: 3 }), "3 relevant files");
  assert.equal(describeSearch({ searchTerms: 0 }), "0 terms");
  // Nothing readable means no count at all; the row then says only "Completed".
  assert.equal(describeSearch({}), "");
});

// --- which files, not how many ----------------------------------------------

/** A real `related_files` entry, with every field the artifact actually writes. */
const ENTRY = {
  confidence: "medium",
  documentation: false,
  file: "src/Selector.cpp",
  match_count: 3,
  matched_keywords: ["Output", "outputType", "type"],
  noise_flags: [],
  reasons: ["matched keyword in application source path"],
  score: 10,
  snippets: [{ line: 12, text: "OutputType outputType() const;" }],
};

test("a real artifact entry becomes exactly four fields", () => {
  const files = rowsFor([ENTRY]);

  assert.deepEqual([...files], [
    {
      path: "src/Selector.cpp",
      name: "Selector.cpp",
      documentation: false,
      matched: ["Output", "outputType", "type"],
    },
  ]);
});

test("nothing about how the ranking works survives the parse", () => {
  // The guard that keeps §13 true: score, confidence, match count, reasons and
  // noise flags cannot reach the page if they never leave this function.
  const [file] = rowsFor([ENTRY]);
  assert.ok(file);

  for (const leaked of ["score", "confidence", "match_count", "reasons", "noise_flags", "snippets"]) {
    assert.equal(leaked in file, false, `${leaked} reached the UI model`);
  }
  assert.deepEqual(Object.keys(file).sort(), ["documentation", "matched", "name", "path"]);
});

test("the artifact's order is the list's order", () => {
  // Ranking happens in Python. A sort here would mean the list and the context
  // disagree about which file matters most.
  const files = rowsFor([
      { file: "src/zebra.cpp" },
      { file: "src/alpha.cpp" },
      { file: "src/middle.cpp" },
    ]);

  assert.deepEqual(files.map((file) => file.name), ["zebra.cpp", "alpha.cpp", "middle.cpp"]);
});

test("an unreadable artifact is an empty list, never a crash", () => {
  for (const broken of [undefined, "", "   ", "[{", "not json", "null", "42", '"text"', "{}"]) {
    assert.deepEqual([...relevantFiles(parseRetrieval(broken))], [], JSON.stringify(broken));
  }
  for (const list of [null, 42, "src/a.cpp", {}]) {
    assert.deepEqual([...rowsFor(list)], [], JSON.stringify(list));
  }
  // The shape the old related_files.json had — a bare array — is not read.
  assert.deepEqual([...relevantFiles(parseRetrieval(JSON.stringify([{ file: "src/a.cpp" }])))], []);
});

test("a malformed entry is dropped and the good ones survive", () => {
  const files = rowsFor([
      { file: "src/good.cpp" },
      null,
      "src/a-string-not-an-object.cpp",
      { file: 42 },
      { file: "" },
      { file: "   " },
      { nofile: "src/other.cpp" },
      [],
      { file: "src/also-good.h" },
    ]);

  assert.deepEqual(files.map((file) => file.path), ["src/good.cpp", "src/also-good.h"]);
});

test("optional metadata is absent rather than invented", () => {
  const [file] = rowsFor([{ file: "src/bare.cpp" }]);
  assert.ok(file);

  // No `documentation` means implementation, which is the ranker's own default.
  assert.equal(file.documentation, false);
  assert.deepEqual([...file.matched], []);
});

test("matched terms are accepted only as a list of non-empty strings", () => {
  const of = (matched: unknown) =>
    rowsFor([{ file: "a.cpp", matched_keywords: matched }])[0]?.matched ?? [];

  assert.deepEqual([...of(["a", "b"])], ["a", "b"]);
  assert.deepEqual([...of(["a", "", "  ", 7, null, "b"])], ["a", "b"]);
  for (const wrong of [undefined, null, "a,b", 7, {}]) {
    assert.deepEqual([...of(wrong)], [], JSON.stringify(wrong));
  }
});

test("a documentation flag is read, never re-derived", () => {
  // The extension has no suffix rules any more — §33.2 spent a phase removing
  // the second opinion about whether `.md` is a document. A `.md` the artifact
  // calls implementation is implementation here.
  const files = rowsFor([
      { file: "docs/design.md", documentation: true },
      { file: "CMakeLists.txt", documentation: false },
      { file: "notes.md", documentation: false },
    ]);

  assert.deepEqual(files.map((file) => file.documentation), [true, false, false]);
});

test("a path that could escape the repository never becomes a row", () => {
  // The artifact writes repository-relative paths, so this rejects nothing
  // real. It exists because the value travels through a webview and comes back.
  const rejected = [
    "../../outside.txt",
    "src/../../outside.txt",
    "..",
    "/etc/passwd",
    "C:/Windows/System32/drivers/etc/hosts",
    "c:\\Windows\\win.ini",
    "\\\\server\\share\\file.txt",
    "\\absolute\\on\\this\\drive",
  ];

  for (const path of rejected) {
    assert.equal(isSafeRelativePath(path), false, path);
    assert.deepEqual([...rowsFor([{ file: path }])], [], path);
  }
  // And the ordinary forms both platforms produce.
  for (const path of ["src/a.cpp", "src\\a.cpp", "a.cpp", "deep/nested/dir/a.hpp"]) {
    assert.equal(isSafeRelativePath(path), true, path);
  }
});

test("the basename is taken from either separator", () => {
  const names = rowsFor([{ file: "src/widgets/WidgetController.cpp" }, { file: "src\\widgets\\WidgetController.h" }]).map((file) => file.name);

  assert.deepEqual(names, ["WidgetController.cpp", "WidgetController.h"]);
});

test("a broken file list never costs Code search its counts", () => {
  // Relevant Files is supplementary. The count comes from the same artifact,
  // and an entry this cannot use is still an entry the run found.
  const parsed = retrieval({ related_files: [{ file: "src/good.cpp" }, { nofile: true }] });

  assert.deepEqual(contextCounts(parsed), { relevantFiles: 2 });
  assert.equal(relevantFiles(parsed).length, 1);
});
