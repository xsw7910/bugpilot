import { test } from "node:test";
import assert from "node:assert/strict";

import {
  MAX_CHECKS,
  MAX_CHECK_NAME,
  MAX_CHECK_TEXT,
  VERIFICATION_NOT_RECORDED,
  recordVerificationArgs,
  verificationOutcome,
  verificationPayload,
  verificationProblem,
} from "../src/app/verificationCapture.ts";
import type { VerificationCheckEntry } from "../src/app/verificationReport.ts";

const CHECK: VerificationCheckEntry = {
  name: "Unit tests",
  status: "not_run",
  type: "automated",
  procedure: "npm test -- --grep \"save\" && echo $HOME",
  evidence: "",
  notes: "",
};

test("the caps are the CLI's", () => {
  assert.deepEqual([MAX_CHECKS, MAX_CHECK_NAME, MAX_CHECK_TEXT], [25, 200, 20_000]);
});

test("what the CLI would refuse is said before a process starts", () => {
  assert.equal(verificationProblem([]), "add at least one check.");
  assert.equal(verificationProblem([{ ...CHECK, name: " \t" }]), "check 1 needs a name.");
  assert.equal(verificationProblem([CHECK, { ...CHECK, name: "x".repeat(201) }]), "check 2's name is longer than 200 characters.");
  assert.equal(verificationProblem([{ ...CHECK, notes: "n".repeat(20_001) }]), "check 1 has a field longer than 20000 characters.");
  assert.equal(verificationProblem(Array.from({ length: 26 }, () => CHECK)), "at most 25 checks can be recorded.");
  assert.equal(verificationProblem([CHECK]), undefined);
  assert.equal(verificationProblem(Array.from({ length: 25 }, () => CHECK)), undefined);
});

test("the payload is the CLI's field names and nothing else; a status is never changed", () => {
  assert.deepEqual(verificationPayload([CHECK]), {
    checks: [{ name: "Unit tests", status: "not_run", type: "automated", procedure: CHECK.procedure, evidence: "", notes: "" }],
  });
});

test("--replace only when asked, and the payload only as a path", () => {
  assert.deepEqual(recordVerificationArgs("JR-12345", "/tmp/p.json", false), [
    "record-verification",
    "JR-12345",
    "--from-file",
    "/tmp/p.json",
    "--json",
  ]);
  assert.deepEqual(recordVerificationArgs("JR-12345", "/tmp/p.json", true).at(-1), "--replace");
  assert.equal(recordVerificationArgs("JR-12345", "/tmp/p.json", true).join(" ").includes("npm test"), false);
});

test("an envelope reads as recorded, or why not — about the recording, never a check", () => {
  assert.deepEqual(verificationOutcome({ ok: true, command: "record-verification", warnings: [] }), { recorded: true });
  const exists = verificationOutcome({ ok: false, command: "record-verification", error: { code: "ARTIFACT_EXISTS", message: "x" } });
  assert.equal(exists.recorded, false);
  assert.match(exists.recorded ? "" : exists.reason, /already recorded .* kept\. Use Edit Verification Evidence/);
  assert.deepEqual(
    verificationOutcome({ ok: false, command: "record-verification", error: { code: "INVALID_INPUT", message: "  a\n  b " } }),
    { recorded: false, reason: "a b" },
  );
  assert.deepEqual(
    verificationOutcome({ ok: false, command: "record-verification", error: { code: "INTERNAL_ERROR", message: "" } }),
    { recorded: false, reason: "bugpilot gave no reason." },
  );
  assert.equal(VERIFICATION_NOT_RECORDED, "Verification evidence was not recorded");
});
