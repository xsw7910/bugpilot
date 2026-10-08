/**
 * The one reader of `retrieval.json`.
 *
 * Code search's counts, Relevant files and Search details all describe
 * the same search, and BugPilot now writes that search as one artifact. So it
 * is read once, parsed once and shape-checked once, here; the three views are
 * projections of what this returns and never open or parse the file themselves.
 * Git history's structured result is a section of the same file
 * (`git_history`): handed on here untouched, and
 * checked entry by entry by its one reader, `gitHistory.ts`.
 * Two parsers of one file would be two opinions about what a malformed one
 * means.
 *
 * The check is deliberately shallow. This decides whether the file is a
 * version-1 retrieval and which of its two lists are lists; whether each
 * *entry* is usable is the business of the view that shows it, which already
 * drops a bad row rather than drawing it with holes in it.
 *
 * **There is no reader for anything older.** BugPilot is pre-release, and a
 * work item prepared before `retrieval.json` existed is re-prepared, not
 * interpreted: a missing file, a wrong `schema_version`, invalid JSON — all of
 * them are "no retrieval", which each view renders as nothing at all.
 */

/** Written by `bugpilot/core/artifacts.py` as `RETRIEVAL_ARTIFACT`. */
export const RETRIEVAL_ARTIFACT = "retrieval.json";

/** The only version this reads. */
const SCHEMA_VERSION = 1;

/**
 * A retrieval whose lists are known to be lists, and nothing more.
 *
 * Each field is absent rather than empty when the file does not carry it as an
 * array, because "no list" and "an empty list" are different answers: the
 * second is a search that found nothing, which the panel reports as 0.
 */
export interface Retrieval {
  /** `related_files`, in rank order. Entries unchecked. */
  readonly relatedFiles?: readonly unknown[];
  /** `terms`, in search order. Entries unchecked. */
  readonly terms?: readonly unknown[];
  /** `git_history`, when it is an object at all. Checked by `gitHistory.ts`. */
  readonly gitHistory?: Readonly<Record<string, unknown>>;
}

export function parseRetrieval(text: string | undefined): Retrieval | undefined {
  if (text === undefined || text.trim() === "") return undefined;
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    // A half-written file, read while a refinement was still replacing it. The
    // write is atomic on the Python side, so the next refresh reads it whole.
    return undefined;
  }
  if (!isRecord(value) || value["schema_version"] !== SCHEMA_VERSION) return undefined;
  const relatedFiles = value["related_files"];
  const terms = value["terms"];
  const gitHistory = value["git_history"];
  return {
    ...(Array.isArray(relatedFiles) ? { relatedFiles } : {}),
    ...(Array.isArray(terms) ? { terms } : {}),
    ...(isRecord(gitHistory) ? { gitHistory } : {}),
  };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
