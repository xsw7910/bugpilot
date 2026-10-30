/**
 * The CLI's answer to "may a work item's folder be given to an agent?" (0.1.7, S-2): `doctor --json`'s
 * `storage.privacy`. Only `private` is a yes; everything else is a no, in the CLI's words when it gave them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { workFolderPrivacyOf } from "../src/app/dataFolder.ts";

test("only storage.privacy = private is a yes", () => {
  assert.deepEqual(workFolderPrivacyOf({ storage: { privacy: "private", privacy_problem: null } }), { private: true });
});

test("not-private and unverifiable are a no, with the CLI's sentence", () => {
  for (const privacy of ["not-private", "unverifiable"]) {
    const problem = `BugPilot cannot use BUGPILOT_HOME (${privacy}).`;
    assert.deepEqual(workFolderPrivacyOf({ storage: { privacy, privacy_problem: `  ${problem}  ` } }), { private: false, problem });
  }
});

test("a report without the answer is a no: an older CLI, a refused storage, no report at all", () => {
  for (const report of [undefined, {}, { storage: null }, { storage: [] }, { storage: { state: "refused" } }, { storage: { privacy: "PRIVATE" } }]) {
    const answer = workFolderPrivacyOf(report as Record<string, unknown> | undefined);
    assert.equal(answer.private, false, JSON.stringify(report));
    assert.match(answer.private ? "" : answer.problem, /did not say whether BugPilot's data folder is private/);
  }
});
