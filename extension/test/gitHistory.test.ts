/**
 * Git history's structured result (Git History v2, Batch 3), extension side:
 * the one reader of `retrieval.json.git_history`, the row's summary line, the
 * Related commits rows, and the Git history row in the workflow model.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  COMMIT_FILE_SOURCES,
  COMMIT_TERM_SOURCES,
  GIT_HISTORY_STATUSES,
  describeGitHistory,
  gitHistoryOf,
  relatedCommitRows,
  SUPPORTING_FILE_CHANGES,
  supportingFileRows,
} from "../src/app/gitHistory.ts";
import type { GitHistoryResult } from "../src/app/gitHistory.ts";
import { parseRetrieval } from "../src/app/retrieval.ts";
import { buildWorkflow } from "../src/app/workflow.ts";
import type { WorkflowInput, WorkflowStepResult } from "../src/app/workflow.ts";
import { DEFAULT_FORM } from "../src/app/form.ts";
import { CAPABILITIES, CAPABILITY_LABELS } from "../src/app/progress.ts";
import type { ProgressView, RowState } from "../src/app/progress.ts";

const CSS = readFileSync(new URL("../media/panel.css", import.meta.url), "utf8");
const RETRIEVAL_PY = readFileSync(new URL("../../bugpilot/core/retrieval.py", import.meta.url), "utf8");
const GIT_HISTORY_PY = readFileSync(new URL("../../bugpilot/core/git_history.py", import.meta.url), "utf8");

const HASH_A = "a".repeat(40);
const HASH_B = "b".repeat(40);

/** A commit as core writes it. */
function commit(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    hash: HASH_A,
    short_hash: HASH_A.slice(0, 10),
    subject: "Add postblend support to Angle Blend",
    date: "2026-03-01",
    score: 135,
    matched_terms: [
      { value: "JR-12345", source: "issue_id" },
      { value: "postblend", source: "shared_keyword" },
    ],
    files: [{ path: "src/blend/AngleBlend.cpp", source: "shared_focus_file" }],
    reasons: ["exact issue ID match: JR-12345", "matched shared keyword: postblend"],
    ...overrides,
  };
}

/** A `retrieval.json` text with this `git_history` section. */
function file(section: unknown): string {
  return JSON.stringify({ schema_version: 1, confidence: "high", related_files: [], terms: [], git_history: section });
}

function section(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schema_version: 1,
    status: "completed",
    search: { commit_message_search: true, file_history_search: true, history_depth: "recent", max_related_commits: 10 },
    summary: { candidate_count: 24, related_commit_count: 1, incomplete: false, failed_lookup_count: 0 },
    commits: [commit()],
    warnings: [],
    ...overrides,
  };
}

const read = (text: string | undefined): GitHistoryResult | undefined => gitHistoryOf(parseRetrieval(text));

// --- the contract is Python's ---------------------------------------------------------

test("the statuses, sources and schema version are the ones core writes", () => {
  const tuple = (name: string) =>
    [...(new RegExp(`^${name} = \\(([^)]*)\\)`, "m").exec(RETRIEVAL_PY)?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((m) => m[1]);
  assert.deepEqual(tuple("GIT_HISTORY_STATUSES"), [...GIT_HISTORY_STATUSES]);
  assert.deepEqual(tuple("COMMIT_TERM_SOURCES"), [...COMMIT_TERM_SOURCES]);
  assert.deepEqual(tuple("COMMIT_FILE_SOURCES"), [...COMMIT_FILE_SOURCES]);
  assert.match(RETRIEVAL_PY, /^GIT_HISTORY_SCHEMA_VERSION = 1$/m);
  // The subject cap the reader bounds to.
  assert.match(GIT_HISTORY_PY, /^MAX_SUBJECT_CHARACTERS = 300$/m);
});

// --- the reader --------------------------------------------------------------------------

test("a valid section reads as typed commits, in the record's order", () => {
  const result = read(file(section({ commits: [commit(), commit({ hash: HASH_B, short_hash: HASH_B.slice(0, 10), subject: "Second" })] })));
  assert.ok(result);
  assert.equal(result.status, "completed");
  assert.equal(result.incomplete, false);
  assert.deepEqual(result.commits.map((c) => c.subject), ["Add postblend support to Angle Blend", "Second"]);
  const first = result.commits[0]!;
  assert.equal(first.hash, HASH_A);
  assert.equal(first.shortHash, "aaaaaaaaaa");
  assert.equal(first.date, "2026-03-01");
  assert.deepEqual(first.terms, [
    { value: "JR-12345", source: "issue_id" },
    { value: "postblend", source: "shared_keyword" },
  ]);
  assert.deepEqual(first.files, [{ path: "src/blend/AngleBlend.cpp", source: "shared_focus_file" }]);
  // Nothing the row does not show is carried: no score, no reasons.
  assert.deepEqual(Object.keys(first).sort(), ["date", "files", "hash", "shortHash", "subject", "terms"]);
});

test("no file, no section, malformed JSON or another version: nothing to trust", () => {
  assert.equal(read(undefined), undefined);
  assert.equal(read("{ half written"), undefined);
  assert.equal(read(JSON.stringify({ schema_version: 1, related_files: [], terms: [] })), undefined, "a legacy retrieval");
  for (const bad of [null, "text", [], { ...section(), schema_version: 2 }, { ...section(), status: "sparkling" }, { ...section(), schema_version: "1" }]) {
    assert.equal(read(file(bad)), undefined, JSON.stringify(bad));
  }
});

test("a malformed commit is dropped, the rest are kept", () => {
  const result = read(
    file(
      section({
        commits: ["text", null, commit({ hash: "not-a-hash" }), commit({ hash: HASH_A.toUpperCase() }), {}, commit({ hash: HASH_B })],
      }),
    ),
  );
  assert.deepEqual(result?.commits.map((c) => c.hash), [HASH_B]);
});

test("a path that could leave the repository is dropped, and so is an unknown source", () => {
  const result = read(
    file(
      section({
        commits: [
          commit({
            files: [
              { path: "../outside.cpp", source: "shared_focus_file" },
              { path: "/etc/passwd", source: "additional_file" },
              { path: "C:\\Windows\\win.ini", source: "additional_file" },
              { path: "\\\\server\\share\\x.cpp", source: "additional_file" },
              { path: "src/\nInjected.cpp", source: "additional_file" },
              { path: "src/ok.cpp", source: "made_up" },
              { path: 42, source: "additional_file" },
              { path: "src/kept.cpp", source: "code_search_ranked_file" },
            ],
            matched_terms: [{ value: "x", source: "made_up" }, { value: "", source: "shared_keyword" }, { value: "kept", source: "extracted_term" }],
          }),
        ],
      }),
    ),
  );
  assert.deepEqual(result?.commits[0]!.files, [{ path: "src/kept.cpp", source: "code_search_ranked_file" }]);
  assert.deepEqual(result?.commits[0]!.terms, [{ value: "kept", source: "extracted_term" }]);
});

test("text is repository text: kept verbatim, made one line, bounded", () => {
  const hostile = `<script>alert("x")</script> & 'q' < > — 日本語 ü`;
  const result = read(file(section({ commits: [commit({ subject: `${hostile}\nsecond line`, matched_terms: [{ value: hostile, source: "shared_keyword" }] })] })));
  assert.equal(result?.commits[0]!.subject, `${hostile} second line`);
  assert.equal(result?.commits[0]!.terms[0]!.value, hostile);
  const long = read(file(section({ commits: [commit({ subject: "x".repeat(5_000) })] })));
  assert.equal(long?.commits[0]!.subject.length, 300);
});

test("a short hash that is not the hash's own prefix is rebuilt from the hash", () => {
  const result = read(file(section({ commits: [commit({ short_hash: "deadbeef00" }), commit({ hash: HASH_B, short_hash: 7 })] })));
  assert.deepEqual(result?.commits.map((c) => c.shortHash), ["aaaaaaaaaa", "bbbbbbbbbb"]);
});

test("a list longer than any BugPilot writes is bounded", () => {
  const many = Array.from({ length: 40 }, (_, index) => commit({ hash: index.toString(16).padStart(40, "0") }));
  assert.equal(read(file(section({ commits: many })))?.commits.length, 25);
});

// --- the summary line --------------------------------------------------------------------------

test("the summary counts commits, singular and plural, and says when it is partial", () => {
  const one = read(file(section()))!;
  assert.equal(describeGitHistory(one), "1 related commit found");
  const six = read(file(section({ commits: Array.from({ length: 6 }, (_, i) => commit({ hash: String(i).repeat(40) })) })))!;
  assert.equal(describeGitHistory(six), "6 related commits found");
  assert.equal(describeGitHistory(read(file(section({ commits: [] })))!), "No related commits found");
  const partial = read(file(section({ summary: { incomplete: true, failed_lookup_count: 2 }, commits: Array.from({ length: 6 }, (_, i) => commit({ hash: String(i).repeat(40) })) })))!;
  assert.equal(describeGitHistory(partial), "6 related commits found · Some lookups incomplete");
  assert.equal(describeGitHistory(read(file(section({ status: "unavailable", commits: [] })))!), "Git history unavailable");
  assert.equal(describeGitHistory(read(file(section({ status: "nothing_to_search", commits: [] })))!), "Nothing to search");
});

test("the count phrase is the one the context uses", () => {
  // `related_commits_phrase` in git_history.py: the same three forms.
  assert.match(GIT_HISTORY_PY, /return "No related commits found"/);
  assert.match(GIT_HISTORY_PY, /return f"\{count\} related commit\{'s' if count != 1 else ''\} found"/);
});

// --- the rows --------------------------------------------------------------------------------

test("a row is the short hash, the subject, and three short lines", () => {
  const [row] = relatedCommitRows(read(file(section()))!);
  assert.deepEqual(row, {
    shortHash: "aaaaaaaaaa",
    subject: "Add postblend support to Angle Blend",
    matched: "Matched: JR-12345, postblend",
    changed: "Changed: AngleBlend.cpp",
    changedPaths: "src/blend/AngleBlend.cpp",
    why: "Why: issue ID · shared keyword · focus file",
  });
  // No score, no reasons, no date: what a developer reads, not how it ranked.
  assert.equal(JSON.stringify(row).includes("135"), false);
});

test("many files are counted after two names; every path is in the tooltip", () => {
  const files = ["a/one.cpp", "b/two.cpp", "c/three.cpp", "d/four.cpp"].map((path, index) => ({
    path,
    source: COMMIT_FILE_SOURCES[index % 3],
  }));
  const [row] = relatedCommitRows(read(file(section({ commits: [commit({ files, matched_terms: [] })] })))!);
  assert.equal(row!.changed, "Changed: one.cpp, two.cpp + 2 more");
  assert.equal(row!.changedPaths, "a/one.cpp\nb/two.cpp\nc/three.cpp\nd/four.cpp");
  assert.equal(row!.matched, undefined, "an empty Matched line");
  assert.equal(row!.why, "Why: focus file · additional file · Code search file");
});

test("every evidence kind has its word, in strength order", () => {
  const terms = COMMIT_TERM_SOURCES.map((source, index) => ({ value: `t${index}`, source }));
  const files = COMMIT_FILE_SOURCES.map((source, index) => ({ path: `f${index}.cpp`, source }));
  const [row] = relatedCommitRows(read(file(section({ commits: [commit({ matched_terms: [...terms].reverse(), files })] })))!);
  assert.equal(row!.why, "Why: issue ID · commit keyword · shared keyword · issue term · focus file · additional file · Code search file");
  assert.equal(row!.matched, "Matched: t3, t2, t1, t0", "Matched keeps the record's own order");
});

test("a broad match is called a broad term, last, never a shared keyword", () => {
  // Batch 5: the ranking gives a broad Keyword 2 points; "shared keyword" here
  // would claim the evidence the context's reason says was discounted.
  const broad = commit({
    matched_terms: [{ value: "template", source: "shared_keyword", broad: true }],
    files: [{ path: "src/ui/Dialog.cpp", source: "code_search_ranked_file" }],
  });
  const [row] = relatedCommitRows(read(file(section({ commits: [broad] })))!);
  assert.equal(row!.why, "Why: Code search file · broad term");
  assert.equal(row!.matched, "Matched: template", "the word itself is still what matched");

  const both = commit({
    matched_terms: [
      { value: "postblend", source: "shared_keyword" },
      { value: "template", source: "shared_keyword", broad: true },
    ],
    files: [],
  });
  const [mixed] = relatedCommitRows(read(file(section({ commits: [both] })))!);
  assert.equal(mixed!.why, "Why: shared keyword · broad term");
  // Anything but `true` is not a mark: a record without the key reads as before.
  const odd = commit({ matched_terms: [{ value: "template", source: "shared_keyword", broad: "yes" }], files: [] });
  assert.equal(relatedCommitRows(read(file(section({ commits: [odd] })))!)[0]!.why, "Why: shared keyword");
});

test("a bulk commit with no files and a message match shows no Changed line", () => {
  const [row] = relatedCommitRows(read(file(section({ commits: [commit({ files: [] })] })))!);
  assert.equal(row!.changed, undefined);
  assert.equal(row!.why, "Why: issue ID · shared keyword");
});

// --- the Git history row --------------------------------------------------------------------------

const progress = (states: Partial<Record<string, RowState>>): ProgressView => ({
  state: "done",
  rows: CAPABILITIES.map((capability) => ({ capability, label: CAPABILITY_LABELS[capability], state: states[capability] ?? "done" })),
  artifacts: [],
});

const input = (overrides: Partial<WorkflowInput> = {}): WorkflowInput => ({
  source: "jira",
  plan: DEFAULT_FORM.plan,
  fixWithAI: false,
  progress: progress({}),
  artifacts: ["retrieval.json", "context.md", "task.md"],
  ...overrides,
});

const gitRow = (steps: readonly WorkflowStepResult[]) => steps.find((step) => step.id === "gitHistory")!;

test("a finished Git history with its record says what it found, and lists it", () => {
  const steps = buildWorkflow(input({ gitHistory: read(file(section()))! }));
  const row = gitRow(steps);
  assert.equal(row.statusText, "Completed");
  assert.equal(row.summary, "1 related commit found");
  assert.equal(row.gitHistory?.commits.length, 1);
  assert.equal(row.gitHistory?.commits[0]!.subject, "Add postblend support to Angle Blend");
});

test("without a record the row says Completed and nothing else", () => {
  const row = gitRow(buildWorkflow(input()));
  assert.equal(row.statusText, "Completed");
  assert.equal(row.summary, "", "a count was invented");
  assert.equal(row.gitHistory, undefined);
});

test("no commits: a summary, and no disclosure", () => {
  const row = gitRow(buildWorkflow(input({ gitHistory: read(file(section({ commits: [] })))! })));
  assert.equal(row.summary, "No related commits found");
  assert.equal(row.gitHistory, undefined);
});

test("running, skipped and failed rows never show a record, even one that was read", () => {
  const record = read(file(section()))!;
  const states: Record<string, string> = { running: "Collecting git history…", skipped: "", failed: "" };
  for (const [state, summary] of Object.entries(states)) {
    const row = gitRow(buildWorkflow(input({ gitHistory: record, progress: progress({ git_history: state as RowState }) })));
    assert.equal(row.gitHistory, undefined, state);
    assert.equal(row.summary, summary, state);
  }
});

test("the other rows are the same with or without a Git history record", () => {
  const strip = (steps: readonly WorkflowStepResult[]) => steps.filter((step) => step.id !== "gitHistory");
  assert.deepEqual(strip(buildWorkflow(input({ gitHistory: read(file(section()))! }))), strip(buildWorkflow(input())));
});

// --- the narrow panel ------------------------------------------------------------------------------

test("Related commits survives a 200px panel: text wraps, the hash ends a line cleanly", () => {
  // Measured in the real window: inline, the hash and the subject's first word
  // were one run, and the word split in two.
  assert.match(CSS, /\.commit-hash \{[^}]*display: inline-block;[^}]*white-space: nowrap;/s);
  for (const selector of ["commit-title", "commit-meta"]) {
    assert.match(CSS, new RegExp(`\\.${selector} \\{[^}]*overflow-wrap: anywhere;`, "s"), selector);
  }
});

// --- Batch 4: supporting files ------------------------------------------------------------------

/** A supporting file as core writes it. */
function supporting(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    path: "src/blend/BlendInputModel.cpp",
    source: "git_history",
    score: 22,
    change: "modified",
    commit_hashes: [HASH_A, HASH_B],
    reasons: ["changed in 2 related commits", "changed with focus file `src/blend/AngleBlend.cpp`"],
    ...overrides,
  };
}

test("the supporting-file provenance and changes are the ones core writes", () => {
  assert.match(RETRIEVAL_PY, /^SUPPORTING_FILE_SOURCE = "git_history"$/m);
  const changes = [...(/^SUPPORTING_FILE_CHANGES = \(([^)]*)\)/m.exec(RETRIEVAL_PY)?.[1] ?? "").matchAll(/"([a-z]+)"/g)].map((m) => m[1]);
  assert.deepEqual(changes, [...SUPPORTING_FILE_CHANGES]);
});

test("a Batch 3 section has no supporting files, and its row is as it was", () => {
  const result = read(file(section()))!;
  assert.deepEqual(result.supportingFiles, []);
  assert.equal(describeGitHistory(result), "1 related commit found");
  assert.equal(gitRow(buildWorkflow(input({ gitHistory: result }))).gitHistory?.supportingFiles, undefined);
});

test("supporting files are read in the record's order and counted on the summary line", () => {
  const result = read(file(section({ supporting_files: [supporting(), supporting({ path: "src/Bucket.cpp", change: "added", commit_hashes: [HASH_A] })] })))!;
  assert.deepEqual(result.supportingFiles, [
    { path: "src/blend/BlendInputModel.cpp", change: "modified", commitCount: 2 },
    { path: "src/Bucket.cpp", change: "added", commitCount: 1 },
  ]);
  assert.equal(describeGitHistory(result), "1 related commit found · 2 supporting files");
  const partial = read(file(section({ summary: { incomplete: true }, supporting_files: [supporting()] })))!;
  assert.equal(describeGitHistory(partial), "1 related commit found · 1 supporting file · Some lookups incomplete");
});

test("another provenance, an unknown change, an unsafe path or no commit: dropped", () => {
  const result = read(
    file(
      section({
        supporting_files: [
          supporting({ source: "code_search" }),
          supporting({ change: "exploded" }),
          supporting({ path: "../outside.cpp" }),
          supporting({ path: "/etc/passwd" }),
          supporting({ path: "C:\\Windows\\x.cpp" }),
          supporting({ path: "src/\nInjected.cpp" }),
          supporting({ commit_hashes: ["not-a-hash"] }),
          supporting({ commit_hashes: [] }),
          "text",
          supporting({ path: "src/kept.cpp" }),
        ],
      }),
    ),
  );
  assert.deepEqual(result?.supportingFiles.map((f) => f.path), ["src/kept.cpp"]);
});

test("the supporting list is bounded", () => {
  const many = Array.from({ length: 30 }, (_, index) => supporting({ path: `src/f${index}.cpp` }));
  assert.equal(read(file(section({ supporting_files: many })))?.supportingFiles.length, 10);
});

test("a supporting row is the file's name, its path, and how history found it", () => {
  const long = `${"deep/".repeat(40)}Leaf.cpp`;
  const result = read(file(section({ supporting_files: [supporting(), supporting({ path: long, change: "renamed", commit_hashes: [HASH_B] })] })))!;
  assert.deepEqual(supportingFileRows(result), [
    { path: "src/blend/BlendInputModel.cpp", name: "BlendInputModel.cpp", detail: "Changed in 2 related commits" },
    { path: long, name: "Leaf.cpp", detail: "Changed in 1 related commit · renamed" },
  ]);
});

test("supporting files sit under Git history; Code search's Relevant files are untouched", () => {
  const record = read(file(section({ supporting_files: [supporting()] })))!;
  const search = { relevantFiles: 1, searchTerms: 1, content: { files: [{ path: "src/a.cpp", name: "a.cpp", documentation: false, matched: [] }], terms: [] } };
  const steps = buildWorkflow(input({ gitHistory: record, search }));
  assert.deepEqual(gitRow(steps).gitHistory?.supportingFiles?.map((f) => f.path), ["src/blend/BlendInputModel.cpp"]);
  const code = steps.find((step) => step.id === "codeSearch")!;
  assert.deepEqual(code.search?.files.map((f) => f.path), ["src/a.cpp"]);
});
