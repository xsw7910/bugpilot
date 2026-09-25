/**
 * Which terms BugPilot searched, and how each behaved.
 *
 * §33 built a weighted term model, probed every term against the repository and
 * wrote the result to what is now `retrieval.json.terms`. Nothing had shown it, so
 * "11 search terms" is where a developer's understanding stops — including for
 * the terms BugPilot generated and they never typed.
 *
 * This is transparency and not configuration. Nothing here recomputes anything:
 * no extraction, no ripgrep, no re-derivation of a shape relationship that the
 * artifact already records. The file is authoritative and this reads it.
 *
 * A sibling of `contextSummary.ts` rather than part of it, because the two
 * answer different questions from different files — that one is "how many, and
 * which files", this one is "which terms, and what did each find". Sharing a
 * module would mean one parser with two unrelated shapes in it.
 */

import { isRecord } from "./retrieval.ts";
import type { Retrieval } from "./retrieval.ts";

/**
 * One row of Code search's Search details list.
 *
 * Five fields out of the term's eight. `weight` and `effective_weight` are
 * left behind deliberately: the question this section answers is *why was this
 * searched*, not what constant the ranker used, and a number a developer cannot
 * act on is a number that invites them to try. `status` is left behind because
 * it restates `match_count === 0`, which `classification` already carries.
 */
export interface RetrievalTerm {
  /** The string ripgrep was given. */
  readonly term: string;
  /** Where it came from, already mapped to something readable. */
  readonly source?: string;
  /**
   * Matching **lines** across the repository, not files and not the evidence
   * kept downstream.
   *
   * `TermSearchResult` in `search.py` draws that distinction explicitly and
   * `_collect` increments this once per parsed ripgrep line. Labelling it
   * "matches" would be a quiet lie about a number a developer might act on.
   */
  readonly lines?: number;
  /** True when the artifact classified it as broad. Never inferred here. */
  readonly broad: boolean;
  /** True when the artifact classified it as having found nothing. */
  readonly empty: boolean;
  /** The phrase a generated shape was built from, when it was generated. */
  readonly derivedFrom?: string;
}

/**
 * `TermSource` in `search_terms.py`, in words.
 *
 * One place, so a label is never spelled twice. A value this table does not
 * know is not a crash and not a guess — it is shown as itself, sanitized,
 * because a new source in a newer bugpilot should degrade to "something I have
 * not seen" rather than to nothing at all.
 */
const SOURCE_LABELS: Readonly<Record<string, string>> = {
  user: "User keyword",
  hint: "Hint",
  issue: "Issue text",
  identifier: "Identifier",
  phrase: "Phrase",
  expanded: "Expanded term",
  shape_expansion: "Shape expansion",
};

/** What a source value may look like before it is shown at all. */
const SAFE_SOURCE = /^[a-z][a-z0-9_-]{0,31}$/i;

/**
 * The rows, in the artifact's own order.
 *
 * That order is the retrieval story — strongest term first, as the weighting
 * left them — so nothing here sorts or regroups. Every entry is checked and a
 * bad one is dropped rather than shown with holes in it; an artifact that
 * cannot be read at all is an empty list, and the section that renders it is
 * hidden rather than shown empty.
 */
export function retrievalTerms(retrieval: Retrieval | undefined): readonly RetrievalTerm[] {
  const terms: RetrievalTerm[] = [];
  for (const entry of retrieval?.terms ?? []) {
    if (!isRecord(entry)) continue;
    const value = entry["value"];
    // The one field a row cannot do without: there is nothing to show about a
    // term whose name is missing.
    if (typeof value !== "string" || value.trim() === "") continue;

    const classification = entry["classification"];
    const source = label(entry["source"]);
    const lines = count(entry["match_count"]);
    const derivedFrom = phrase(entry["derived_from"]);

    terms.push({
      term: value,
      ...(source === undefined ? {} : { source }),
      ...(lines === undefined ? {} : { lines }),
      // Read, never computed. Deriving it from `match_count` here would put a
      // second opinion about BROAD_MATCH_THRESHOLD in the extension, which is
      // the kind of duplication §33.2 spent a phase removing.
      broad: classification === "broad",
      empty: classification === "zero",
      ...(derivedFrom === undefined ? {} : { derivedFrom }),
    });
  }
  return terms;
}

/**
 * A source value as a developer should read it.
 *
 * An unknown value survives as itself rather than being dropped or renamed,
 * but only if it looks like the identifier it is supposed to be — the string
 * reaches the panel, and an artifact is a file on disk that something else
 * could have written.
 */
function label(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const known = SOURCE_LABELS[value];
  if (known) return known;
  return SAFE_SOURCE.test(value) ? value : undefined;
}

function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

function phrase(value: unknown): string | undefined {
  // `""` is the artifact's way of saying "this term was simply in the text",
  // which is the common case and not a missing field.
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text === "" ? undefined : text;
}
