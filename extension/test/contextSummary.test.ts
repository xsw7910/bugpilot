/**
 * Counting what a run produced, from the files it wrote.
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
  describeCounts,
  isSafeRelativePath,
  relevantFiles,
} from "../src/app/contextSummary.ts";

const RELATED = JSON.stringify([
  { file: "src/Selector.cpp", score: 9 },
  { file: "src/Reader.cpp", score: 4 },
]);

const QUALITY = JSON.stringify({
  confidence: "high",
  terms: [{ value: "outputType" }, { value: "Selector" }, { value: "restore" }],
});

test("the two artifacts are counted as what they are", () => {
  assert.deepEqual(contextCounts(RELATED, QUALITY), { relevantFiles: 2, searchTerms: 3 });
});

test("one unreadable artifact does not cost the other its number", () => {
  assert.deepEqual(contextCounts(RELATED, undefined), { relevantFiles: 2 });
  assert.deepEqual(contextCounts(undefined, QUALITY), { searchTerms: 3 });
  assert.deepEqual(contextCounts(undefined, undefined), {});
});

test("a file that is not JSON yet produces no number", () => {
  // The normal way this happens: the panel reads the directory while the run is
  // still flushing. The next refresh reads it whole.
  for (const half of ["[{", "", "   ", "not json at all"]) {
    assert.deepEqual(contextCounts(half, half), {});
  }
});

test("a shape that is not the expected one produces no number", () => {
  // The guard that matters if the artifact format ever moves. A wrong number is
  // worse than none, so each of these omits rather than guesses.
  assert.deepEqual(contextCounts('{"files": []}', "{}"), {});
  assert.deepEqual(contextCounts("null", '{"terms": null}'), {});
  assert.deepEqual(contextCounts("42", '{"terms": 7}'), {});
  // A string has a length, which is exactly the trap: "4 relevant files" read
  // off the word "true" would look like a real answer.
  assert.deepEqual(contextCounts('"abcd"', '{"terms": "abcd"}'), {});
});

test("an empty result is a real answer, not a missing one", () => {
  // A search that retrieved nothing is a fact worth reporting; it is only the
  // *unreadable* case that stays silent.
  assert.deepEqual(contextCounts("[]", '{"terms": []}'), {
    relevantFiles: 0,
    searchTerms: 0,
  });
});

test("nothing is counted that a developer could not act on", () => {
  // The entries carry more than this — which file is documentation, which term
  // was dropped, what weight each carried. None of it is counted here: it is
  // the retrieval pipeline's own vocabulary, and the panel does not teach it.
  const rich = JSON.stringify([{ file: "a.md", documentation: true }, { file: "b.cpp" }]);
  const terms = JSON.stringify({
    terms: [
      { value: "x", status: "retained", weight: 8 },
      { value: "y", status: "dropped", weight: 5 },
    ],
  });

  assert.deepEqual(contextCounts(rich, terms), { relevantFiles: 2, searchTerms: 2 });
});

test("the line reads as English, including at one", () => {
  assert.equal(
    describeCounts({ relevantFiles: 8, searchTerms: 53 }),
    "8 relevant files · 53 search terms",
  );
  assert.equal(describeCounts({ relevantFiles: 1, searchTerms: 1 }), "1 relevant file · 1 search term");
  assert.equal(describeCounts({ relevantFiles: 3 }), "3 relevant files");
  assert.equal(describeCounts({ searchTerms: 0 }), "0 search terms");
  // Nothing readable means no line at all, which the page renders as no element.
  assert.equal(describeCounts({}), "");
});

// --- which files, not how many ----------------------------------------------

/** A real entry, with every field the artifact actually writes. */
const ENTRY = {
  confidence: "medium",
  documentation: false,
  file: "src/Selector.cpp",
  match_count: 3,
  matched_keywords: ["Output", "outputType", "type"],
  noise_flags: [],
  reasons: ["matched keyword in application source path"],
  score: 10,
};

test("a real artifact entry becomes exactly four fields", () => {
  const files = relevantFiles(JSON.stringify([ENTRY]));

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
  const [file] = relevantFiles(JSON.stringify([ENTRY]));
  assert.ok(file);

  for (const leaked of ["score", "confidence", "match_count", "reasons", "noise_flags"]) {
    assert.equal(leaked in file, false, `${leaked} reached the UI model`);
  }
  assert.deepEqual(Object.keys(file).sort(), ["documentation", "matched", "name", "path"]);
});

test("the artifact's order is the list's order", () => {
  // Ranking happens in Python. A sort here would mean the list and the context
  // disagree about which file matters most.
  const files = relevantFiles(
    JSON.stringify([
      { file: "src/zebra.cpp" },
      { file: "src/alpha.cpp" },
      { file: "src/middle.cpp" },
    ]),
  );

  assert.deepEqual(files.map((file) => file.name), ["zebra.cpp", "alpha.cpp", "middle.cpp"]);
});

test("an unreadable artifact is an empty list, never a crash", () => {
  for (const broken of [undefined, "", "   ", "[{", "not json", "null", "42", '"text"', "{}"]) {
    assert.deepEqual([...relevantFiles(broken)], [], JSON.stringify(broken));
  }
});

test("a malformed entry is dropped and the good ones survive", () => {
  const files = relevantFiles(
    JSON.stringify([
      { file: "src/good.cpp" },
      null,
      "src/a-string-not-an-object.cpp",
      { file: 42 },
      { file: "" },
      { file: "   " },
      { nofile: "src/other.cpp" },
      [],
      { file: "src/also-good.h" },
    ]),
  );

  assert.deepEqual(files.map((file) => file.path), ["src/good.cpp", "src/also-good.h"]);
});

test("optional metadata is absent rather than invented", () => {
  const [file] = relevantFiles(JSON.stringify([{ file: "src/bare.cpp" }]));
  assert.ok(file);

  // No `documentation` means implementation, which is the ranker's own default.
  assert.equal(file.documentation, false);
  assert.deepEqual([...file.matched], []);
});

test("matched terms are accepted only as a list of non-empty strings", () => {
  const of = (matched: unknown) =>
    relevantFiles(JSON.stringify([{ file: "a.cpp", matched_keywords: matched }]))[0]?.matched ?? [];

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
  const files = relevantFiles(
    JSON.stringify([
      { file: "docs/design.md", documentation: true },
      { file: "CMakeLists.txt", documentation: false },
      { file: "notes.md", documentation: false },
    ]),
  );

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
    assert.deepEqual([...relevantFiles(JSON.stringify([{ file: path }]))], [], path);
  }
  // And the ordinary forms both platforms produce.
  for (const path of ["src/a.cpp", "src\\a.cpp", "a.cpp", "deep/nested/dir/a.hpp"]) {
    assert.equal(isSafeRelativePath(path), true, path);
  }
});

test("the basename is taken from either separator", () => {
  const names = relevantFiles(
    JSON.stringify([{ file: "platform/sample/Volume.cpp" }, { file: "platform\\sample\\Volume.h" }]),
  ).map((file) => file.name);

  assert.deepEqual(names, ["Volume.cpp", "Volume.h"]);
});

test("a broken file list never costs Context Ready its counts", () => {
  // Relevant Files is supplementary. The count comes from the same artifact,
  // and an entry this cannot use is still an entry the run found.
  const related = JSON.stringify([{ file: "src/good.cpp" }, { nofile: true }]);

  assert.deepEqual(contextCounts(related, undefined), { relevantFiles: 2 });
  assert.equal(relevantFiles(related).length, 1);
});
