/**
 * What a prepared package contains, counted from the files the run wrote.
 *
 * The panel needed something to say after a run other than six ticks, and the
 * only honest source for it is what is already on disk. `related_files.json` is
 * a JSON array of ranked files; `search_quality.json` is an object whose
 * `terms` array is one entry per ripgrep invocation. Both are read by
 * `bugpilot/core/context.py` on the way to `bug_context.md`, so this reads the
 * same contract BugPilot already relies on internally rather than a new one.
 *
 * **Every step degrades to "no number".** A missing file, an unreadable one,
 * invalid JSON, a top-level object where an array was expected, a `terms` key
 * that is not a list — each of those omits the count. That is the whole design
 * rule here: a panel that says nothing is a panel a developer ignores for a
 * second, and a panel that says "0 relevant files" about a run that found eight
 * is one they stop believing. The second failure is much more expensive, so the
 * shape is checked before anything is counted.
 *
 * Nothing here reads *into* the entries. Which of the files are implementation
 * and which are documentation, which terms were retained and which were
 * dropped, what weight any of them carried — all of that exists in these files
 * and none of it is counted, because it is §33's vocabulary and a developer
 * cannot act on it from the panel.
 */

/**
 * Counts for the result section. Both optional, independently.
 *
 * One file being unreadable says nothing about the other, so a run whose
 * `search_quality.json` is missing still reports its file count.
 */
export interface ContextCounts {
  readonly relevantFiles?: number;
  readonly searchTerms?: number;
}

/** The two artifacts this reads, so a caller does not spell them twice. */
export const RELATED_FILES_ARTIFACT = "related_files.json";
export const SEARCH_QUALITY_ARTIFACT = "search_quality.json";

export function contextCounts(
  relatedFilesJson: string | undefined,
  searchQualityJson: string | undefined,
): ContextCounts {
  const relevantFiles = countOfArray(parse(relatedFilesJson));
  const quality = parse(searchQualityJson);
  const searchTerms = countOfArray(
    isRecord(quality) ? (quality["terms"] as unknown) : undefined,
  );
  return {
    ...(relevantFiles === undefined ? {} : { relevantFiles }),
    ...(searchTerms === undefined ? {} : { searchTerms }),
  };
}

/**
 * The counts as one line, or nothing.
 *
 * Built here rather than in the page for the reason everything else is: the page
 * renders and the host computes. Singular and plural are spelled out because
 * "1 relevant files" is the kind of detail that makes a panel look unfinished.
 */
export function describeCounts(counts: ContextCounts): string {
  const parts: string[] = [];
  if (counts.relevantFiles !== undefined) {
    parts.push(plural(counts.relevantFiles, "relevant file"));
  }
  if (counts.searchTerms !== undefined) {
    parts.push(plural(counts.searchTerms, "search term"));
  }
  return parts.join(" · ");
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

function parse(text: string | undefined): unknown {
  if (text === undefined || text.trim() === "") return undefined;
  try {
    return JSON.parse(text);
  } catch {
    // A half-written file, read while the run was still flushing it. Not worth
    // a message: the next refresh will read it whole.
    return undefined;
  }
}

/**
 * How many entries, when the value really is a list of them.
 *
 * `Array.isArray` rather than a truthiness check, because `{}` has no length
 * and `"abcd"` has four — and "4 relevant files" read off a string would be the
 * exact failure this module exists to avoid.
 */
function countOfArray(value: unknown): number | undefined {
  return Array.isArray(value) ? value.length : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// --- which files, not how many ----------------------------------------------

/**
 * One row of the Relevant Files list.
 *
 * Three fields out of the artifact's eight. The other five — `score`,
 * `confidence`, `match_count`, `reasons`, `noise_flags` — say how the ranking
 * works rather than what it found, and a developer cannot act on any of them
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
 * The rows, from the same artifact the count came from.
 *
 * Parsed separately rather than threaded through `contextCounts`: the file is
 * read once and this is a second `JSON.parse` of a string already in memory,
 * which buys two functions that each do one thing over one that does both.
 *
 * Every entry is checked and a bad one is dropped rather than shown with a
 * hole in it. An entry needs a `file` that is a non-empty relative path with no
 * `..` in it — the path becomes an open request, so the shape is checked here
 * *and* on the host, which is the side that can actually be lied to.
 */
export function relevantFiles(relatedFilesJson: string | undefined): readonly RelevantFile[] {
  const parsed = parse(relatedFilesJson);
  if (!Array.isArray(parsed)) return [];
  const files: RelevantFile[] = [];
  for (const entry of parsed) {
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
