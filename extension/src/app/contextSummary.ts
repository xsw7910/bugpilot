/**
 * What a prepared package contains, counted from the retrieval the run wrote.
 *
 * The panel needed something to say after a run other than six ticks, and the
 * only honest source for it is what is already on disk: `retrieval.json`, whose
 * `related_files` are the ranked files and whose `terms` are one entry per
 * ripgrep invocation. `retrieval.ts` reads and shape-checks it once; this counts
 * and lists from what that returns, and never opens or parses the file itself.
 *
 * **Every step degrades to "no number".** A missing file, an unreadable one,
 * invalid JSON, a wrong `schema_version`, a list key that is not a list — each
 * of those omits the count. That is the whole design
 * rule here: a panel that says nothing is a panel a developer ignores for a
 * second, and a panel that says "0 relevant files" about a run that found eight
 * is one they stop believing. The second failure is much more expensive, so the
 * shape is checked before anything is counted.
 *
 * Nothing here reads *into* the entries. Which of the files are implementation
 * and which are documentation, which terms were retained and which were
 * dropped, what weight any of them carried — all of that exists in the artifact
 * and none of it is counted, because it is §33's vocabulary and a developer
 * cannot act on it from the panel.
 */

import { isRecord } from "./retrieval.ts";
import type { Retrieval } from "./retrieval.ts";

/**
 * Counts for Code search's summary line. Both optional, independently.
 *
 * One list being unusable says nothing about the other, so a retrieval whose
 * `terms` is malformed still reports its file count.
 */
export interface ContextCounts {
  readonly relevantFiles?: number;
  readonly searchTerms?: number;
}

export function contextCounts(retrieval: Retrieval | undefined): ContextCounts {
  // Already known to be arrays, or absent: `parseRetrieval` checked the shape,
  // so a string's length can never be read here as "4 relevant files".
  const relevantFiles = retrieval?.relatedFiles?.length;
  const searchTerms = retrieval?.terms?.length;
  return {
    ...(relevantFiles === undefined ? {} : { relevantFiles }),
    ...(searchTerms === undefined ? {} : { searchTerms }),
  };
}

// --- which files, not how many ----------------------------------------------

/**
 * One row of the Relevant Files list.
 *
 * Three fields out of the entry's nine. The other six — `score`, `confidence`,
 * `match_count`, `reasons`, `noise_flags`, `snippets` — say how the ranking
 * works, or are evidence for the agent, rather than what it found, and a developer cannot act on any of them
 * from a sidebar. Keeping them out of this type is what keeps them off screen.
 */
export interface RelevantFile {
  /** Exactly what the artifact wrote, repository-relative. */
  readonly path: string;
  /** The basename, which is what a developer recognises in a narrow sidebar. */
  readonly name: string;
  /**
   * Prose rather than implementation, as *Python* decided.
   *
   * Read, never re-derived. `bugpilot/core/code_files.is_documentation` is the
   * only opinion about whether `.md` is a document, and a second one here is
   * the bug §33.2 spent a phase removing.
   */
  readonly documentation: boolean;
  /** The terms that put this file in the list. Already bounded by the ranker. */
  readonly matched: readonly string[];
}

/**
 * How many rows the panel will draw, at most.
 *
 * `MAX_TOTAL_RELATED_FILES` in `search.py` is 10 and the Max files setting can
 * raise it, so the artifact is bounded by a number the developer chose rather
 * than by a constant. Ten matches the default, which means the normal case
 * hides nothing; beyond it the page says how many more there are rather than
 * growing a sidebar list without end. Not pagination — one line of text.
 */
export const MAX_LISTED_FILES = 10;

/**
 * The rows, from the same retrieval the count came from.
 *
 * Every entry is checked and a bad one is dropped rather than shown with a
 * hole in it. An entry needs a `file` that is a non-empty relative path with no
 * `..` in it — the path becomes an open request, so the shape is checked here
 * *and* on the host, which is the side that can actually be lied to.
 */
export function relevantFiles(retrieval: Retrieval | undefined): readonly RelevantFile[] {
  const files: RelevantFile[] = [];
  for (const entry of retrieval?.relatedFiles ?? []) {
    if (!isRecord(entry)) continue;
    const file = entry["file"];
    if (typeof file !== "string" || !isSafeRelativePath(file)) continue;
    files.push({
      path: file,
      name: basename(file),
      // Absent means implementation, which is what the ranker's own default is
      // for an entry written before the field existed.
      documentation: entry["documentation"] === true,
      matched: stringList(entry["matched_keywords"]),
    });
  }
  return files;
}

/**
 * Whether a path from the artifact is one worth handing to the editor.
 *
 * Relative, non-empty, and with no `..` segment. The artifact only ever writes
 * repository-relative paths, so this rejects nothing real — it exists because
 * the value travels through a webview on its way back, and a check that only
 * runs before that trip is not a check.
 */
export function isSafeRelativePath(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") return false;
  // Either separator, whichever platform wrote it.
  const segments = trimmed.split(/[\\/]/);
  if (segments.includes("..")) return false;
  // An absolute path, a drive letter, or a UNC share: all of them would ignore
  // the root they are resolved against.
  if (trimmed.startsWith("/") || trimmed.startsWith("\\")) return false;
  if (/^[A-Za-z]:/.test(trimmed)) return false;
  return true;
}

function basename(value: string): string {
  const segments = value.split(/[\\/]/).filter((segment) => segment !== "");
  return segments[segments.length - 1] ?? value;
}

function stringList(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "");
}
