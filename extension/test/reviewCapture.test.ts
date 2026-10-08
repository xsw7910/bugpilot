/**
 * Save Review Result's plumbing: what is sent to record-review, how
 * its answer is read, and the payload file the review travels in.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { access, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";

import {
  REVIEW_NOT_SAVED,
  hasReviewContent,
  recordReviewArgs,
  recordingOutcome,
  reviewPayload,
} from "../src/app/reviewCapture.ts";
import { payloadCommandPort } from "../src/app/fixModeTransport.ts";
import type { Envelope } from "../src/protocol.ts";

const ENTRY = { summary: "Reads correctly.", findings: "", validationNotes: "", recommendations: "" };

test("the arguments name the work item and the file, and --replace only when asked", () => {
  assert.deepEqual([...recordReviewArgs("JR-12345", "/tmp/r.json", false)], [
    "record-review", "JR-12345", "--from-file", "/tmp/r.json", "--json",
  ]);
  assert.deepEqual(recordReviewArgs("JR-12345", "/tmp/r.json", true).at(-1), "--replace");
});

test("the payload uses the CLI's field names and carries the text as typed", () => {
  const typed = { summary: " a ", findings: "## Critical\n- x", validationNotes: "v", recommendations: "" };
  assert.deepEqual(reviewPayload(typed), {
    summary: " a ",
    findings: "## Critical\n- x",
    validation_notes: "v",
    recommendations: "",
  });
});

test("an entry is worth recording only when some section says something", () => {
  assert.equal(hasReviewContent(ENTRY), true);
  assert.equal(hasReviewContent({ summary: " ", findings: "\n", validationNotes: "\t", recommendations: "" }), false);
});

test("the answer is recorded, or why not — about the recording, never the review", () => {
  assert.deepEqual(recordingOutcome({ ok: true, command: "record-review", warnings: [] }), { recorded: true });
  const exists = recordingOutcome({ ok: false, command: "record-review", error: { code: "ARTIFACT_EXISTS", message: "x" } });
  assert.deepEqual(exists, { recorded: false, reason: "a review result is already saved for this work item, and it was kept." });
  const other = recordingOutcome({ ok: false, command: "record-review", error: { code: "INVALID_INPUT", message: " two\n lines " } });
  assert.deepEqual(other, { recorded: false, reason: "two lines" });
  assert.match(REVIEW_NOT_SAVED, /not saved/);
  assert.equal(/review (failed|did not pass)/i.test(REVIEW_NOT_SAVED), false);
});

test("the review travels in a temporary file that is gone afterwards, never in argv", async () => {
  const hostile = 'quotes " backticks ` pipes | newlines\nand $vars %here%';
  let seen: readonly string[] = [];
  let written: unknown;
  let file = "";
  const port = payloadCommandPort(
    () => "/repo",
    async (args, cwd) => {
      assert.equal(cwd, "/repo");
      seen = args;
      file = args[3]!;
      written = JSON.parse(readFileSync(file, "utf8"));
      return { ok: true, command: "record-review", warnings: [] };
    },
    { command: "record-review", prefix: "bugpilot-review", noRepository: "no repository" },
  );

  await port({ args: (path) => recordReviewArgs("JR-12345", path, false), payload: reviewPayload({ ...ENTRY, findings: hostile }) });

  assert.equal((written as { findings: string }).findings, hostile);
  assert.ok(!seen.some((arg) => arg.includes("backticks")), "review text reached argv");
  assert.ok(file.includes("bugpilot-review-"));
  await assert.rejects(access(file), "the payload file was left behind");
  assert.deepEqual((await readdir(tmpdir())).filter((name) => name === file), []);
});

test("without a repository, record-review is not run at all", async () => {
  let ran = false;
  const port = payloadCommandPort(
    () => undefined,
    async () => {
      ran = true;
      return { ok: true, command: "record-review", warnings: [] } as Envelope;
    },
    { command: "record-review", prefix: "bugpilot-review", noRepository: "No repository is open." },
  );
  const envelope = await port({ args: () => ["record-review"], payload: ENTRY });
  assert.equal(ran, false);
  assert.equal(envelope.ok, false);
  assert.equal(envelope.ok === false && envelope.command, "record-review");
});
