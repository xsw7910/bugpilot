import { test } from "node:test";
import assert from "node:assert/strict";

import {
  claudeProjectSlug,
  pickLatestSession,
  resumeCommand,
  sessionIdFromFileName,
} from "../src/app/session.ts";

test("the slug rule reproduces a directory Claude Code actually created", () => {
  // The rule was not guessed: it was read off a directory Claude Code created
  // for a checkout on this machine, and the path is generalised here because
  // one developer's layout is nobody else's business. Colon and separator each
  // become a dash; a dash already in the name survives as itself.
  assert.equal(String.raw`c--work-my-app`, claudeProjectSlug(String.raw`c:\work\my-app`));
  assert.equal(claudeProjectSlug("/home/dev/app"), "-home-dev-app");
  assert.equal(claudeProjectSlug(String.raw`C:\Users\a b\repo.v2`), "C--Users-a-b-repo-v2");
});

test("the most recent transcript is the one offered", () => {
  const picked = pickLatestSession([
    { id: "aaa", modifiedMs: 100 },
    { id: "bbb", modifiedMs: 300 },
    { id: "ccc", modifiedMs: 200 },
  ]);
  assert.equal(picked?.id, "bbb");
});

test("a tie is broken deterministically, so the offer does not flicker", () => {
  const first = pickLatestSession([
    { id: "aaa", modifiedMs: 100 },
    { id: "bbb", modifiedMs: 100 },
  ]);
  const second = pickLatestSession([
    { id: "bbb", modifiedMs: 100 },
    { id: "aaa", modifiedMs: 100 },
  ]);
  assert.equal(first?.id, second?.id);
});

test("no sessions is a normal answer, not an error", () => {
  // The slug rule is Claude Code's implementation detail; when it stops
  // matching, this is the state the extension has to degrade into quietly.
  assert.equal(pickLatestSession([]), undefined);
});

test("only transcript files are treated as sessions", () => {
  assert.equal(
    sessionIdFromFileName("0f9c4b1a-1234-4321-9876-abcdefabcdef.jsonl"),
    "0f9c4b1a-1234-4321-9876-abcdefabcdef",
  );
  for (const name of ["notes.md", "summary.json", ".jsonl", "sess.jsonl.bak"]) {
    assert.equal(sessionIdFromFileName(name), undefined, name);
  }
});

test("the resume command falls back to continuing the latest session", () => {
  assert.equal(resumeCommand("abc-123"), "claude --resume abc-123");
  // Better than offering nothing when the directory clearly holds sessions but
  // the id could not be read.
  assert.equal(resumeCommand(undefined), "claude -c");
});
