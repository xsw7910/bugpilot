import { test } from "node:test";
import assert from "node:assert/strict";

import {
  ARTIFACT_IGNORE_RULES,
  addGitignoreRules,
  gitignoreAppendix,
  lineEndingOf,
  rulesFor,
  unignoredArtifactDirectories,
} from "../src/app/gitignore.ts";
import type { GitignoreDocument, GitignoreEntry, GitignoreIo } from "../src/app/gitignore.ts";

const BOTH = [ARTIFACT_IGNORE_RULES[".ai"], ARTIFACT_IGNORE_RULES[".ai_memory"]];
const FILE = "/work/app/.gitignore";

// --- what is missing: git's answer, from doctor -----------------------------

test("the directories to fix are the ones doctor says git does not ignore", () => {
  assert.deepEqual(unignoredArtifactDirectories({ ai_artifacts_ignored_paths: { ".ai": false, ".ai_memory": false } }), [".ai", ".ai_memory"]);
  assert.deepEqual(unignoredArtifactDirectories({ ai_artifacts_ignored_paths: { ".ai": false, ".ai_memory": true } }), [".ai"]);
  assert.deepEqual(unignoredArtifactDirectories({ ai_artifacts_ignored_paths: { ".ai": true, ".ai_memory": false } }), [".ai_memory"]);
  assert.deepEqual(unignoredArtifactDirectories({ ai_artifacts_ignored_paths: { ".ai": true, ".ai_memory": true } }), []);
});

test("no per-directory answer, no guess: an older CLI, no git, or a malformed field", () => {
  // Reading the file's text instead would be a second opinion about what git
  // ignores — the thing the warning must not have.
  for (const report of [
    { ai_artifacts_ignored: false },
    { ai_artifacts_ignored_paths: null },
    { ai_artifacts_ignored_paths: [".ai"] },
    { ai_artifacts_ignored_paths: { ".ai": false } },
    { ai_artifacts_ignored_paths: { ".ai": "no", ".ai_memory": false } },
  ]) {
    assert.equal(unignoredArtifactDirectories(report), undefined, JSON.stringify(report));
  }
});

test("the rules come out in one order, .ai/ first, whatever order they are asked for", () => {
  assert.deepEqual(rulesFor([".ai_memory", ".ai"]), BOTH);
  assert.deepEqual(rulesFor([".ai_memory"]), [".ai_memory/"]);
  assert.deepEqual(rulesFor([]), []);
});

// --- what gets appended -----------------------------------------------------

test("no .gitignore: exactly the two rules, LF, nothing else", () => {
  assert.equal(gitignoreAppendix(undefined, BOTH), ".ai/\n.ai_memory/\n");
});

test("an empty .gitignore: the rules from its first line", () => {
  assert.equal(gitignoreAppendix("", BOTH), ".ai/\n.ai_memory/\n");
});

test("an LF file keeps LF, and the rules go after its last line", () => {
  assert.equal(gitignoreAppendix("node_modules/\ndist/\n", BOTH), ".ai/\n.ai_memory/\n");
});

test("a CRLF file gets CRLF lines", () => {
  assert.equal(lineEndingOf("node_modules/\r\ndist/\r\n"), "\r\n");
  assert.equal(gitignoreAppendix("node_modules/\r\ndist/\r\n", BOTH), ".ai/\r\n.ai_memory/\r\n");
});

test("no final newline: one is added first, so the rule is a line of its own", () => {
  assert.equal(gitignoreAppendix("node_modules/", BOTH), "\n.ai/\n.ai_memory/\n");
  assert.equal(gitignoreAppendix("node_modules/\r\ndist/", BOTH), "\r\n.ai/\r\n.ai_memory/\r\n");
});

test("comments and trailing blank lines stay where they are: the rules go after them, with no comment of ours", () => {
  const existing = "# build output\ndist/\n\n\n";
  const appendix = gitignoreAppendix(existing, BOTH);
  assert.equal(appendix, ".ai/\n.ai_memory/\n");
  assert.equal(appendix.includes("#"), false);
});

test("only the rule asked for is written", () => {
  assert.equal(gitignoreAppendix("dist/\n", [".ai/"]), ".ai/\n");
  assert.equal(gitignoreAppendix("dist/\n", [".ai_memory/"]), ".ai_memory/\n");
});

test("a rule already a line of the file is not written twice — the fix is idempotent", () => {
  assert.equal(gitignoreAppendix(".ai/\n", BOTH), ".ai_memory/\n");
  assert.equal(gitignoreAppendix(".ai/  \r\n.ai_memory/\r\n", BOTH), "", "trailing whitespace, which git ignores too");
  const once = "dist/\n" + gitignoreAppendix("dist/\n", BOTH);
  assert.equal(gitignoreAppendix(once, BOTH), "");
  // And duplicate entries the developer already has are theirs: left alone.
  assert.equal(gitignoreAppendix(".ai/\n.ai/\n", [".ai/"]), "");
});

// --- the write --------------------------------------------------------------

interface FakeFs {
  entry: GitignoreEntry;
  bytes?: Uint8Array;
  writes: Uint8Array[];
  document?: GitignoreDocument;
  writeThrows?: Error;
}

function io(fs: FakeFs): GitignoreIo {
  return {
    document: () => fs.document,
    stat: async () => fs.entry,
    read: async () => fs.bytes ?? new Uint8Array(),
    write: async (_file, bytes) => {
      if (fs.writeThrows) throw fs.writeThrows;
      fs.writes.push(bytes);
      fs.bytes = bytes;
      fs.entry = "file";
    },
  };
}

const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);

test("a missing .gitignore is created with only the two rules", async () => {
  const fs: FakeFs = { entry: "missing", writes: [] };
  const outcome = await addGitignoreRules(io(fs), FILE, BOTH);
  assert.deepEqual(outcome, { kind: "written", created: true, added: BOTH });
  assert.equal(text(fs.bytes), ".ai/\n.ai_memory/\n");
});

test("an existing file's bytes are kept exactly — a BOM, CRLF, comments, unrelated rules — with the rules after them", async () => {
  const before = "﻿# ours\r\nnode_modules/\r\n\r\n!keep.log\r\n*.log";
  const fs: FakeFs = { entry: "file", bytes: new TextEncoder().encode(before), writes: [] };
  const outcome = await addGitignoreRules(io(fs), FILE, [".ai_memory/"]);
  assert.deepEqual(outcome, { kind: "written", created: false, added: [".ai_memory/"] });
  const after = fs.bytes!;
  const original = new TextEncoder().encode(before);
  assert.deepEqual(after.slice(0, original.length), original, "a byte of the existing file changed");
  assert.equal(text(after.slice(original.length)), "\r\n.ai_memory/\r\n");
});

test("pressing it again writes nothing", async () => {
  const fs: FakeFs = { entry: "missing", writes: [] };
  await addGitignoreRules(io(fs), FILE, BOTH);
  const again = await addGitignoreRules(io(fs), FILE, BOTH);
  assert.deepEqual(again, { kind: "unchanged", unsaved: false });
  assert.equal(fs.writes.length, 1);
});

test("a write that fails is a failure with a reason — never the file's contents", async () => {
  const secret = "internal-host.example/secret";
  const fs: FakeFs = {
    entry: "file",
    bytes: new TextEncoder().encode(`${secret}\n`),
    writes: [],
    writeThrows: new Error("EACCES: permission denied"),
  };
  const outcome = await addGitignoreRules(io(fs), FILE, BOTH);
  assert.equal(outcome.kind, "failed");
  assert.match(outcome.kind === "failed" ? outcome.detail : "", /permission denied/);
  assert.equal(JSON.stringify(outcome).includes(secret), false);
});

test("a .gitignore that is a symbolic link, or not a file, is not written through", async () => {
  for (const entry of ["symlink", "other"] as const) {
    const fs: FakeFs = { entry, writes: [] };
    const outcome = await addGitignoreRules(io(fs), FILE, BOTH);
    assert.equal(outcome.kind, "failed", entry);
    assert.equal(fs.writes.length, 0, entry);
  }
});

// --- an open document -------------------------------------------------------

function openDocument(initial: string, options: { dirty: boolean; eol?: "\n" | "\r\n"; accept?: boolean; saves?: boolean }) {
  const state = { text: initial, dirty: options.dirty, saved: 0 };
  const document: GitignoreDocument = {
    get text() {
      return state.text;
    },
    eol: options.eol ?? "\n",
    get dirty() {
      return state.dirty;
    },
    append: async (more) => {
      if (options.accept === false) return false;
      state.text += more;
      state.dirty = true;
      return true;
    },
    save: async () => {
      if (options.saves === false) return false;
      state.saved += 1;
      state.dirty = false;
      return true;
    },
  };
  return { document, state };
}

test("an open .gitignore with unsaved edits: the rules go into its buffer, the edits stay, nothing is saved or written", async () => {
  // The developer typed "coverage/" and has not saved; disk has only dist/.
  const { document, state } = openDocument("dist/\ncoverage/", { dirty: true });
  const fs: FakeFs = { entry: "file", bytes: new TextEncoder().encode("dist/\n"), writes: [], document };
  const outcome = await addGitignoreRules(io(fs), FILE, BOTH);
  assert.deepEqual(outcome, { kind: "unsaved", added: BOTH });
  assert.equal(state.text, "dist/\ncoverage/\n.ai/\n.ai_memory/\n", "the typed line was lost or moved");
  assert.equal(state.saved, 0, "the developer's unsaved edits were saved for them");
  assert.equal(fs.writes.length, 0, "the disk was written behind a dirty editor");
});

test("a dirty buffer that already has the rules is left alone, and says it is unsaved", async () => {
  const { document, state } = openDocument(".ai/\n.ai_memory/\n", { dirty: true });
  const fs: FakeFs = { entry: "file", writes: [], document };
  assert.deepEqual(await addGitignoreRules(io(fs), FILE, BOTH), { kind: "unchanged", unsaved: true });
  assert.equal(state.text, ".ai/\n.ai_memory/\n");
});

test("an open .gitignore with no unsaved edits: through the editor, then saved — in the document's line ending", async () => {
  const { document, state } = openDocument("dist/\r\n", { dirty: false, eol: "\r\n" });
  const fs: FakeFs = { entry: "file", writes: [], document };
  const outcome = await addGitignoreRules(io(fs), FILE, [".ai/"]);
  assert.deepEqual(outcome, { kind: "written", created: false, added: [".ai/"] });
  assert.equal(state.text, "dist/\r\n.ai/\r\n");
  assert.equal(state.saved, 1);
  assert.equal(fs.writes.length, 0, "written around the open editor");
});

test("an editor that refuses the edit, or the save, is a failure", async () => {
  const refused = openDocument("dist/\n", { dirty: false, accept: false });
  assert.equal((await addGitignoreRules(io({ entry: "file", writes: [], document: refused.document }), FILE, BOTH)).kind, "failed");
  const unsaved = openDocument("dist/\n", { dirty: false, saves: false });
  assert.equal((await addGitignoreRules(io({ entry: "file", writes: [], document: unsaved.document }), FILE, BOTH)).kind, "failed");
});
