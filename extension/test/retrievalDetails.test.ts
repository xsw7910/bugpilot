/**
 * Reading the searched terms out of `search_quality.json`.
 *
 * Two rules run through this file. **The artifact decides**: whether a term is
 * broad, what its source is called and where a generated shape came from are
 * all read, never re-derived — a second opinion about BROAD_MATCH_THRESHOLD in
 * TypeScript is the kind of duplication §33.2 spent a phase removing. And
 * **details are supplementary**: a malformed artifact costs the rows and never
 * the result they sit under.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { retrievalTerms } from "../src/app/retrievalDetails.ts";

/** One entry with every field a real artifact writes. */
const ENTRY = {
  classification: "specific",
  derived_from: "",
  effective_weight: 8,
  match_count: 18,
  source: "user",
  status: "retained",
  value: "WidgetController",
  weight: 8,
};

const quality = (...terms: unknown[]) => JSON.stringify({ confidence: "high", terms });

test("a real entry becomes exactly the fields the UI needs", () => {
  assert.deepEqual([...retrievalTerms(quality(ENTRY))], [
    {
      term: "WidgetController",
      source: "User keyword",
      lines: 18,
      broad: false,
      empty: false,
    },
  ]);
});

test("the ranker's own arithmetic stays out of the UI", () => {
  // The question this section answers is "why was this searched", not "what
  // constant did the ranker use". A weight is a number a developer cannot act
  // on, which is exactly the kind that invites them to try.
  const [term] = retrievalTerms(quality(ENTRY));
  assert.ok(term);

  for (const internal of ["weight", "effective_weight", "effectiveWeight", "status", "score"]) {
    assert.equal(internal in term, false, `${internal} reached the UI model`);
  }
  assert.deepEqual(Object.keys(term).sort(), ["broad", "empty", "lines", "source", "term"]);
});

test("the artifact's order is the list's order", () => {
  // Strongest term first, as the weighting left them. That ordering is part of
  // the retrieval story, so nothing here sorts it into alphabetical nonsense.
  const terms = retrievalTerms(
    quality(
      { ...ENTRY, value: "VDS" },
      { ...ENTRY, value: "outputType" },
      { ...ENTRY, value: "validation" },
    ),
  );

  assert.deepEqual(terms.map((term) => term.term), ["VDS", "outputType", "validation"]);
});

test("every source the model can produce has a readable name", () => {
  // `TermSource` in search_terms.py, in full.
  const labels = Object.fromEntries(
    ["issue", "hint", "user", "identifier", "phrase", "expanded", "shape_expansion"].map(
      (source) => [source, retrievalTerms(quality({ ...ENTRY, source }))[0]?.source],
    ),
  );

  assert.deepEqual(labels, {
    issue: "Issue text",
    hint: "Hint",
    user: "User keyword",
    identifier: "Identifier",
    phrase: "Phrase",
    expanded: "Expanded term",
    shape_expansion: "Shape expansion",
  });
});

test("a source this extension has not heard of survives as itself", () => {
  // A newer bugpilot may add one. Degrading to the raw value says more than
  // dropping the row, and it cannot be mistaken for a label somebody chose.
  assert.equal(retrievalTerms(quality({ ...ENTRY, source: "co_occurrence" }))[0]?.source, "co_occurrence");
  // But only if it looks like the identifier it is meant to be: the string
  // reaches the panel, and an artifact is a file something else could write.
  for (const hostile of ["<script>alert(1)</script>", "a".repeat(200), "", 7, null, {}]) {
    assert.equal(
      retrievalTerms(quality({ ...ENTRY, source: hostile }))[0]?.source,
      undefined,
      JSON.stringify(hostile),
    );
  }
});

test("broad is read from the artifact, never worked out from the count", () => {
  // The threshold lives in search.py and belongs there. A copy of it here would
  // disagree with the ranker the day somebody tuned it — and would disagree
  // silently, which is worse.
  const broad = retrievalTerms(quality({ ...ENTRY, classification: "broad", match_count: 821 }))[0];
  assert.equal(broad?.broad, true);
  assert.equal(broad?.lines, 821);

  // A huge count that the artifact did *not* call broad is not broad.
  const huge = retrievalTerms(quality({ ...ENTRY, classification: "specific", match_count: 99_999 }))[0];
  assert.equal(huge?.broad, false);

  // And a tiny one the artifact *did* call broad is broad.
  const tiny = retrievalTerms(quality({ ...ENTRY, classification: "broad", match_count: 3 }))[0];
  assert.equal(tiny?.broad, true);
});

test("a term that found nothing says so", () => {
  const empty = retrievalTerms(quality({ ...ENTRY, classification: "zero", match_count: 0 }))[0];

  assert.equal(empty?.empty, true);
  assert.equal(empty?.broad, false);
  assert.equal(empty?.lines, 0);
});

test("a generated shape carries the phrase it was built from", () => {
  // The whole reason this section is worth having: it explains a term the
  // developer never typed.
  const shape = retrievalTerms(
    quality({
      ...ENTRY,
      value: "outputType",
      source: "shape_expansion",
      derived_from: "output type",
      match_count: 7,
    }),
  )[0];

  assert.equal(shape?.term, "outputType");
  assert.equal(shape?.source, "Shape expansion");
  assert.equal(shape?.derivedFrom, "output type");
});

test("a term that was simply in the text explains itself", () => {
  // `""` is the artifact saying "nothing to add", not a missing field, and it
  // is the common case.
  for (const derived of ["", "   ", undefined, null, 7]) {
    assert.equal(
      retrievalTerms(quality({ ...ENTRY, derived_from: derived }))[0]?.derivedFrom,
      undefined,
      JSON.stringify(derived),
    );
  }
});

test("an unreadable artifact is an empty list, never a crash", () => {
  for (const broken of [undefined, "", "   ", "{half", "not json", "null", "42", '"text"', "[]"]) {
    assert.deepEqual([...retrievalTerms(broken)], [], JSON.stringify(broken));
  }
  // The right shape with the wrong `terms`.
  for (const terms of ["[]", "null", "7", '{"a":1}']) {
    assert.deepEqual([...retrievalTerms(`{"terms": ${terms}}`)], [], terms);
  }
  // And no `terms` at all, which is what an older artifact looks like.
  assert.deepEqual([...retrievalTerms('{"confidence": "high"}')], []);
});

test("a malformed entry is dropped and its neighbours survive", () => {
  const terms = retrievalTerms(
    quality(
      { ...ENTRY, value: "good" },
      null,
      "a string, not an entry",
      { ...ENTRY, value: 42 },
      { ...ENTRY, value: "" },
      { ...ENTRY, value: "   " },
      { classification: "specific" },
      [],
      { ...ENTRY, value: "also-good" },
    ),
  );

  assert.deepEqual(terms.map((term) => term.term), ["good", "also-good"]);
});

test("every optional field is absent rather than invented", () => {
  // A bare entry: a name, and nothing else the artifact chose to record.
  const [term] = retrievalTerms(quality({ value: "bare" }));
  assert.ok(term);

  assert.equal(term.term, "bare");
  assert.equal(term.source, undefined);
  assert.equal(term.lines, undefined);
  assert.equal(term.derivedFrom, undefined);
  // Not classified is not broad and not empty — neither is claimed.
  assert.equal(term.broad, false);
  assert.equal(term.empty, false);
});

test("a match count is accepted only as a whole number of lines", () => {
  const linesOf = (match_count: unknown) =>
    retrievalTerms(quality({ ...ENTRY, match_count }))[0]?.lines;

  assert.equal(linesOf(0), 0);
  assert.equal(linesOf(821), 821);
  for (const wrong of [-1, 1.5, "18", null, undefined, {}, NaN, Infinity]) {
    assert.equal(linesOf(wrong), undefined, JSON.stringify(wrong));
  }
});

test("a hostile artifact reaches the page as data, not as markup", () => {
  // Terms come out of a Jira description by way of a JSON file, which is the
  // path a script tag would take. The parser keeps them as strings; the page
  // writes them with textContent.
  const hostile = '<script>alert(1)</script>';
  const [term] = retrievalTerms(
    quality({ ...ENTRY, value: hostile, derived_from: hostile }),
  );

  assert.equal(term?.term, hostile);
  assert.equal(term?.derivedFrom, hostile);
});
