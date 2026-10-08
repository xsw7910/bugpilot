/**
 * Git history's structured result, as the panel reads it.
 *
 * Git History v2 (Batch 3) records the ranked commits as the `git_history`
 * section of `retrieval.json` — the same record `context.md` is rendered from.
 * This is its one reader: the Git history row's summary line and its Related
 * commits disclosure are projections of what this returns, and nothing else in
 * the extension opens, parses or second-guesses the section. Nothing is ever
 * read out of `context.md`: a work item prepared before the section existed
 * simply has none, and its row says "Completed" as it always did.
 *
 * Since Batch 4 it also reads the section's `supporting_files`: files the
 * strongest related commits changed that Code Search did not return. They are
 * Git history's evidence and stay Git history's — shown under this row, never
 * among Code search's Relevant files.
 *
 * Every string here was written by git into a commit or by a developer into a
 * keyword, so the check is entry by entry and strict where it matters: a
 * commit without a well-formed hash is dropped, a path that could leave the
 * repository is dropped, an unknown source is dropped, and every text is
 * bounded. Nothing here becomes a command or markup — the page renders it with
 * `textContent` — but it is still the untrusted side of the file.
 */

import { isSafeRelativePath } from "./contextSummary.ts";
import { isRecord } from "./retrieval.ts";
import type { Retrieval } from "./retrieval.ts";

/** `GIT_HISTORY_SCHEMA_VERSION` in `bugpilot/core/retrieval.py`; the only version read. */
const SCHEMA_VERSION = 1;

/** `GIT_HISTORY_STATUSES` in `retrieval.py`. */
export const GIT_HISTORY_STATUSES = ["completed", "unavailable", "nothing_to_search"] as const;
export type GitHistoryStatus = (typeof GIT_HISTORY_STATUSES)[number];

/** `COMMIT_TERM_SOURCES` in `retrieval.py`, strongest first. */
export const COMMIT_TERM_SOURCES = ["issue_id", "additional_commit_keyword", "shared_keyword", "extracted_term"] as const;
export type CommitTermSource = (typeof COMMIT_TERM_SOURCES)[number];

/** `COMMIT_FILE_SOURCES` in `retrieval.py`. */
export const COMMIT_FILE_SOURCES = ["shared_focus_file", "additional_file", "code_search_ranked_file"] as const;
export type CommitFileSource = (typeof COMMIT_FILE_SOURCES)[number];

/** `SUPPORTING_FILE_SOURCE` in `retrieval.py`: the only provenance read. */
const SUPPORTING_FILE_SOURCE = "git_history";

/** `SUPPORTING_FILE_CHANGES` in `retrieval.py`. */
export const SUPPORTING_FILE_CHANGES = ["added", "modified", "renamed", "copied"] as const;
export type SupportingFileChange = (typeof SUPPORTING_FILE_CHANGES)[number];

/** Max Related Commits' ceiling: a longer list is not one BugPilot wrote. */
const MAX_COMMITS = 25;
/** Twice `MAX_SUPPORTING_FILES` in `git_history.py`: room, never an unbounded list. */
const MAX_SUPPORTING = 10;
const MAX_TERMS = 30;
const MAX_FILES = 20;
/** The subject cap `MAX_SUBJECT_CHARACTERS` in `git_history.py` writes to. */
const MAX_TEXT = 300;
const HASH_RE = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const SHORT_HASH_RE = /^[0-9a-f]{4,64}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export interface CommitTerm {
  readonly value: string;
  readonly source: CommitTermSource;
  /** Matched too many candidate commits to count fully (`"broad": true`, Batch 5). */
  readonly broad?: true;
}

export interface CommitFile {
  /** Repository-relative, checked. */
  readonly path: string;
  readonly source: CommitFileSource;
}

export interface GitHistoryCommit {
  readonly hash: string;
  readonly shortHash: string;
  readonly subject: string;
  readonly date?: string;
  readonly terms: readonly CommitTerm[];
  readonly files: readonly CommitFile[];
}

/** A file the related commits changed that Code Search did not return. */
export interface SupportingFile {
  /** Repository-relative, checked; a file that existed when the run recorded it. */
  readonly path: string;
  readonly change: SupportingFileChange;
  /** How many of the related commits changed it. */
  readonly commitCount: number;
}

export interface GitHistoryResult {
  readonly status: GitHistoryStatus;
  /** Some git lookups did not finish: the list may be missing commits. */
  readonly incomplete: boolean;
  /** In the record's order — the ranking's. Never re-sorted here. */
  readonly commits: readonly GitHistoryCommit[];
  /** In the record's order, best first; empty for a Batch 3 record. */
  readonly supportingFiles: readonly SupportingFile[];
}

/** The section of an already-parsed retrieval, or `undefined` when there is none to trust. */
export function gitHistoryOf(retrieval: Retrieval | undefined): GitHistoryResult | undefined {
  const section = retrieval?.gitHistory;
  if (!section || section["schema_version"] !== SCHEMA_VERSION) return undefined;
  const status = section["status"];
  if (!(GIT_HISTORY_STATUSES as readonly unknown[]).includes(status)) return undefined;
  const summary = isRecord(section["summary"]) ? section["summary"] : {};
  const commits: GitHistoryCommit[] = [];
  for (const entry of Array.isArray(section["commits"]) ? section["commits"] : []) {
    if (commits.length >= MAX_COMMITS) break;
    const commit = commitOf(entry);
    if (commit) commits.push(commit);
  }
  const supportingFiles: SupportingFile[] = [];
  for (const entry of Array.isArray(section["supporting_files"]) ? section["supporting_files"] : []) {
    if (supportingFiles.length >= MAX_SUPPORTING) break;
    const file = supportingFileOf(entry);
    if (file) supportingFiles.push(file);
  }
  return { status: status as GitHistoryStatus, incomplete: summary["incomplete"] === true, commits, supportingFiles };
}

/** One supporting file, or nothing: another provenance, an unknown change or an unsafe path is dropped. */
function supportingFileOf(entry: unknown): SupportingFile | undefined {
  if (!isRecord(entry) || entry["source"] !== SUPPORTING_FILE_SOURCE) return undefined;
  const change = entry["change"];
  if (!(SUPPORTING_FILE_CHANGES as readonly unknown[]).includes(change)) return undefined;
  const path = entry["path"];
  if (typeof path !== "string" || /[\u0000-\u001f\u007f]/.test(path) || !isSafeRelativePath(path)) return undefined;
  const hashes = Array.isArray(entry["commit_hashes"]) ? entry["commit_hashes"].filter((hash) => typeof hash === "string" && HASH_RE.test(hash)) : [];
  if (hashes.length === 0) return undefined;
  return { path: path.slice(0, 1_024), change: change as SupportingFileChange, commitCount: Math.min(hashes.length, MAX_COMMITS) };
}

function commitOf(entry: unknown): GitHistoryCommit | undefined {
  if (!isRecord(entry)) return undefined;
  const hash = entry["hash"];
  if (typeof hash !== "string" || !HASH_RE.test(hash)) return undefined;
  const short = entry["short_hash"];
  const shortHash = typeof short === "string" && SHORT_HASH_RE.test(short) && hash.startsWith(short) ? short : hash.slice(0, 10);
  const date = entry["date"];
  const terms: CommitTerm[] = [];
  for (const term of Array.isArray(entry["matched_terms"]) ? entry["matched_terms"] : []) {
    if (terms.length >= MAX_TERMS) break;
    if (!isRecord(term) || !(COMMIT_TERM_SOURCES as readonly unknown[]).includes(term["source"])) continue;
    const value = text(term["value"]);
    if (value !== "") terms.push({ value, source: term["source"] as CommitTermSource, ...(term["broad"] === true ? { broad: true as const } : {}) });
  }
  const files: CommitFile[] = [];
  for (const file of Array.isArray(entry["files"]) ? entry["files"] : []) {
    if (files.length >= MAX_FILES) break;
    if (!isRecord(file) || !(COMMIT_FILE_SOURCES as readonly unknown[]).includes(file["source"])) continue;
    const path = file["path"];
    // A path a developer could be sent to: relative, inside the repository, one line.
    if (typeof path !== "string" || /[\u0000-\u001f\u007f]/.test(path) || !isSafeRelativePath(path)) continue;
    files.push({ path: path.slice(0, 1_024), source: file["source"] as CommitFileSource });
  }
  return {
    hash,
    shortHash,
    subject: text(entry["subject"]),
    ...(typeof date === "string" && DATE_RE.test(date) ? { date } : {}),
    terms,
    files,
  };
}

/** Repository text, made safe to lay out: one line, bounded. Never interpreted. */
function text(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, MAX_TEXT);
}

/**
 * The Git history row's summary line, from the record alone.
 *
 * "6 related commits found", "1 related commit found", "No related commits
 * found" — the phrase `related_commits_phrase` in `git_history.py` puts in the
 * context — and "· Some lookups incomplete" when the record says it is
 * partial. A record that searched nothing says why in two words.
 */
export function describeGitHistory(result: GitHistoryResult): string {
  if (result.status === "unavailable") return "Git history unavailable";
  if (result.status === "nothing_to_search") return "Nothing to search";
  const count = result.commits.length;
  const parts = [count === 0 ? "No related commits found" : `${count} related commit${count === 1 ? "" : "s"} found`];
  const supporting = result.supportingFiles.length;
  if (supporting > 0) parts.push(`${supporting} supporting file${supporting === 1 ? "" : "s"}`);
  if (result.incomplete) parts.push("Some lookups incomplete");
  return parts.join(" · ");
}

/** One row of the Supporting files disclosure: the file, and how history found it. */
export interface SupportingFileRow {
  readonly path: string;
  readonly name: string;
  /** "Changed in 2 related commits", with how when it was not a plain edit. */
  readonly detail: string;
}

export function supportingFileRows(result: GitHistoryResult): readonly SupportingFileRow[] {
  return result.supportingFiles.map((file) => {
    const commits = `Changed in ${file.commitCount} related commit${file.commitCount === 1 ? "" : "s"}`;
    return {
      path: file.path,
      name: basename(file.path),
      detail: file.change === "modified" ? commits : `${commits} · ${file.change}`,
    };
  });
}

/** One row of the Related commits disclosure: only what a developer reads. */
export interface RelatedCommitRow {
  readonly shortHash: string;
  readonly subject: string;
  /** "Matched: postblend, angle blend" — absent when no message evidence. */
  readonly matched?: string;
  /** "Changed: AngleBlend.cpp, Bucket.cpp + 1 more" — the known candidate files only. */
  readonly changed?: string;
  /** Every changed candidate path, one per line, for the tooltip. */
  readonly changedPaths?: string;
  /** "Why: issue ID · shared keyword · focus file" — from the evidence sources. */
  readonly why?: string;
}

/**
 * Each source in words, for the Why line.
 *
 * The record's own reasons are full sentences for the agent's context ("modified
 * Code Search file: #1 `src/a.cpp`"); a row has room for the kinds of evidence,
 * and the kinds are what the sources already are — so nothing here parses a
 * reason. The score is not shown: it orders the list, and a number a developer
 * cannot act on is a number that invites them to try.
 */
const WHY_LABELS: Readonly<Record<CommitTermSource | CommitFileSource, string>> = {
  issue_id: "issue ID",
  additional_commit_keyword: "commit keyword",
  shared_keyword: "shared keyword",
  extracted_term: "issue term",
  shared_focus_file: "focus file",
  additional_file: "additional file",
  code_search_ranked_file: "Code search file",
};
/**
 * A broad match's word, last: it adds little to the score, and calling it a
 * shared keyword would claim the evidence the ranking discounted.
 */
const BROAD_LABEL = "broad term";

/** How many file names a row names before it counts the rest. */
const NAMED_FILES = 2;
/** How many matched terms a row names before it counts the rest. */
const NAMED_TERMS = 5;

export function relatedCommitRows(result: GitHistoryResult): readonly RelatedCommitRow[] {
  return result.commits.map((commit) => {
    const terms = commit.terms.map((term) => term.value);
    const named = commit.files.slice(0, NAMED_FILES).map((file) => basename(file.path));
    const rest = commit.files.length - named.length;
    const sources = [...COMMIT_TERM_SOURCES, ...COMMIT_FILE_SOURCES].filter(
      (source) =>
        commit.terms.some((term) => term.source === source && term.broad !== true) ||
        commit.files.some((file) => file.source === source),
    );
    const why = [...sources.map((source) => WHY_LABELS[source]), ...(commit.terms.some((term) => term.broad === true) ? [BROAD_LABEL] : [])];
    return {
      shortHash: commit.shortHash,
      subject: commit.subject === "" ? "(no subject)" : commit.subject,
      ...(terms.length === 0
        ? {}
        : {
            matched: `Matched: ${terms.slice(0, NAMED_TERMS).join(", ")}${
              terms.length > NAMED_TERMS ? ` + ${terms.length - NAMED_TERMS} more` : ""
            }`,
          }),
      ...(commit.files.length === 0
        ? {}
        : {
            changed: `Changed: ${named.join(", ")}${rest > 0 ? ` + ${rest} more` : ""}`,
            changedPaths: commit.files.map((file) => file.path).join("\n"),
          }),
      ...(why.length === 0 ? {} : { why: `Why: ${why.join(" · ")}` }),
    };
  });
}

function basename(value: string): string {
  const segments = value.split(/[\\/]/).filter((segment) => segment !== "");
  return segments[segments.length - 1] ?? value;
}
