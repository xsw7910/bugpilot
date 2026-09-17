import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { diagnose, knownCodes } from "../src/errors.ts";

test("a known code yields a summary and an action", () => {
  const diagnosis = diagnose("JIRA_NOT_CONFIGURED", "Jira environment variables are missing.");
  assert.match(diagnosis.summary, /not configured/);
  assert.match(diagnosis.action ?? "", /bugpilot setup/);
  assert.equal(diagnosis.unknownCode, false);
});

test("the CLI message is not consulted for a known code", () => {
  // Branch on the code, never parse the message: a reworded message must not
  // change what the extension shows or does.
  const first = diagnose("JIRA_AUTH_FAILED", "rejected");
  const second = diagnose("JIRA_AUTH_FAILED", "completely different wording");
  assert.deepEqual(first, second);
});

test("an unknown code falls back to the CLI message rather than discarding it", () => {
  // Codes are append-only on the CLI side, so this table will be behind a newer
  // bugpilot. Being less helpful is fine; throwing away the only explanation is not.
  const diagnosis = diagnose("JIRA_TEAPOT", "Jira is a teapot.");
  assert.equal(diagnosis.summary, "Jira is a teapot.");
  assert.equal(diagnosis.unknownCode, true);
  assert.match(diagnosis.action ?? "", /updating it may help/);
});

test("an unknown code with no message still says something useful", () => {
  assert.match(diagnose("JIRA_TEAPOT").summary, /JIRA_TEAPOT/);
});

test("only transient failures are marked retryable", () => {
  for (const code of ["JIRA_RATE_LIMITED", "JIRA_TIMEOUT", "JIRA_NETWORK_ERROR"]) {
    assert.equal(diagnose(code).retryable, true, code);
  }
  for (const code of ["JIRA_ISSUE_NOT_FOUND", "INVALID_INPUT", "NO_JIRA_TARGET"]) {
    assert.equal(diagnose(code).retryable, false, code);
  }
});

test("every code the CLI defines has an entry here", () => {
  // A cross-language guard: adding a code to bugpilot/core/errors.py without
  // telling the extension turns this red instead of shipping a fallback message
  // to users. Reads the Python source rather than importing it, so the test
  // needs no interpreter.
  const source = readFileSync(
    fileURLToPath(new URL("../../bugpilot/core/errors.py", import.meta.url)),
    "utf8",
  );
  const declared = new Set<string>();
  for (const match of source.matchAll(/^([A-Z][A-Z0-9_]*) = "([A-Z][A-Z0-9_]*)"$/gm)) {
    if (match[1] === match[2]) declared.add(match[1]!);
  }

  assert.ok(declared.size >= 15, `expected to find the code constants, found ${declared.size}`);
  const missing = [...declared].filter((code) => diagnose(code).unknownCode).sort();
  assert.deepEqual(missing, [], `codes with no extension entry: ${missing.join(", ")}`);
});

test("the table declares no code the CLI does not have", () => {
  // The other direction: a stale entry means the extension carries advice for a
  // code that can never arrive.
  const source = readFileSync(
    fileURLToPath(new URL("../../bugpilot/core/errors.py", import.meta.url)),
    "utf8",
  );
  const stale = knownCodes().filter((code) => !source.includes(`"${code}"`));
  assert.deepEqual(stale, []);
});
