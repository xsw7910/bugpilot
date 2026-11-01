/**
 * The CLI's answer to "may this work item's folder be given to an agent?" (0.1.7, S-2, F-1):
 * `doctor --json --work-item <id>`'s `storage.work_item_privacy`. Only `private`, about that very folder, is a
 * yes; everything else is a no, in the CLI's words when it gave them.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";

import {
  WORK_ITEM_PRIVACY_UNSUPPORTED,
  askWorkFolderPrivacy,
  workFolderPrivacyOf,
  workItemDirectory,
  workItemPrivacyArgs,
} from "../src/app/dataFolder.ts";
import { ProtocolError } from "../src/protocol.ts";

const REPOSITORY_DIR = path.resolve("/data/repositories/app-0123456789abcdef");
const GRANT = { workItemId: "JR-12345", workFolder: workItemDirectory(REPOSITORY_DIR, "JR-12345")! };

/** A `doctor --json --work-item` report: the repository-level answer, then the work item's. */
function report(storage: Record<string, unknown>): Record<string, unknown> {
  return {
    storage: {
      repository_dir: REPOSITORY_DIR,
      privacy: "private",
      privacy_problem: null,
      work_item_id: "JR-12345",
      work_item_privacy: "private",
      work_item_privacy_problem: null,
      ...storage,
    },
  };
}

test("only work_item_privacy = private, about the folder the agent would be given, is a yes", () => {
  assert.deepEqual(workFolderPrivacyOf(report({}), GRANT), { private: true });
});

test("not-private and unverifiable are a no, with the CLI's sentence", () => {
  for (const privacy of ["not-private", "unverifiable"]) {
    const problem = `BugPilot will not give an agent this work item's folder (${privacy}).`;
    assert.deepEqual(
      workFolderPrivacyOf(report({ work_item_privacy: privacy, work_item_privacy_problem: `  ${problem}  ` }), GRANT),
      { private: false, problem },
    );
  }
});

test("the repository-level answer never decides a grant: it stops at work/ (F-1)", () => {
  // The measured F-1 case: every parent private, the work item's own folder open to others.
  const answer = workFolderPrivacyOf(report({ work_item_privacy: "not-private", work_item_privacy_problem: "JR-12345 is not private." }), GRANT);
  assert.deepEqual(answer, { private: false, problem: "JR-12345 is not private." });
  // A CLI that answers only for the repository (a build before `--work-item`) is not a yes either.
  const older = workFolderPrivacyOf({ storage: { repository_dir: REPOSITORY_DIR, privacy: "private", privacy_problem: null } }, GRANT);
  assert.equal(older.private, false);
  assert.match(older.private ? "" : older.problem, /did not say whether this work item's folder is private/);
});

test("a yes about another work item or another folder is a no", () => {
  for (const changed of [
    { work_item_id: "JR-23456" },
    { work_item_id: undefined },
    { repository_dir: path.resolve("/elsewhere/repositories/app-0123456789abcdef") },
    { repository_dir: "relative/repositories/app" },
    { repository_dir: undefined },
  ]) {
    const answer = workFolderPrivacyOf(report(changed), GRANT);
    assert.equal(answer.private, false, JSON.stringify(changed));
    assert.match(answer.private ? "" : answer.problem, /answered for a different folder/);
  }
  const elsewhere = { workItemId: "JR-12345", workFolder: path.resolve("/elsewhere/work/JR-12345") };
  assert.equal(workFolderPrivacyOf(report({}), elsewhere).private, false, "the folder about to be given is not the one checked");
});

test("a report without the answer is a no: an older CLI, a refused storage, no report at all", () => {
  for (const value of [undefined, {}, { storage: null }, { storage: [] }, { storage: { state: "refused" } }, report({ work_item_privacy: "PRIVATE" })]) {
    const answer = workFolderPrivacyOf(value as Record<string, unknown> | undefined, GRANT);
    assert.equal(answer.private, false, JSON.stringify(value));
    assert.match(answer.private ? "" : answer.problem, /did not say whether this work item's folder is private/);
  }
});

test("the question is asked only for a work item id, never for a path or an option", () => {
  assert.deepEqual(workItemPrivacyArgs("JR-12345"), ["doctor", "--work-item", "JR-12345"]);
  for (const id of ["", "../JR-12345", "JR-12345/..", "--json", "a b", "C:\\work"]) {
    assert.equal(workItemPrivacyArgs(id), undefined, id);
  }
});

// --- the port: asked of the CLI, and a CLI that does not know the option (0.1.7 before --work-item) ------

/** What a 0.1.7 bugpilot built before `--work-item` prints, and the runner's throw for it (no envelope on stdout). */
const ARGPARSE_REFUSAL =
  "usage: bugpilot [-h] [--version]\r\n                {setup,doctor,agent-check} ...\r\nbugpilot: error: unrecognized arguments: --work-item JR-12345\r\n";
const unsupported = () => new ProtocolError("bugpilot produced no output on stdout.", "", ARGPARSE_REFUSAL);

test("the port asks doctor --work-item for that work item, once, and reads the answer", async () => {
  const asked: (readonly string[])[] = [];
  const answer = await askWorkFolderPrivacy(async (args) => {
    asked.push(args);
    return { ok: true, command: "doctor", warnings: [], report: report({}) };
  }, GRANT);
  assert.deepEqual(answer, { private: true });
  assert.deepEqual(asked, [["doctor", "--work-item", "JR-12345"]]);
});

test("a bugpilot without --work-item: no folder, a sentence that says to update it, and no fall back to storage.privacy", async () => {
  const asked: (readonly string[])[] = [];
  const answer = await askWorkFolderPrivacy(async (args) => {
    asked.push(args);
    throw unsupported();
  }, GRANT);
  assert.deepEqual(answer, { private: false, problem: WORK_ITEM_PRIVACY_UNSUPPORTED });
  assert.match(WORK_ITEM_PRIVACY_UNSUPPORTED, /Update bugpilot/);
  assert.deepEqual(asked, [["doctor", "--work-item", "JR-12345"]], "asked again, without the option");
});

test("any other failure is not taken for an old bugpilot: it is thrown, for the controller to word as a no", async () => {
  for (const error of [
    new ProtocolError("bugpilot produced no output on stdout.", "", "bugpilot: error: unrecognized arguments: --json\r\n"),
    new ProtocolError("The bugpilot run was cancelled.", "", ""),
    new Error("spawn ENOENT"),
  ]) {
    await assert.rejects(askWorkFolderPrivacy(async () => { throw error; }, GRANT), (thrown) => thrown === error);
  }
});

test("a failure envelope is a no, and an id that is not one is never asked about", async () => {
  const failed = await askWorkFolderPrivacy(async () => ({ ok: false, command: "doctor", error: { code: "INTERNAL_ERROR", message: "x" } }), GRANT);
  assert.equal(failed.private, false);
  let asked = 0;
  const refused = await askWorkFolderPrivacy(async () => { asked += 1; return { ok: true }; }, { workItemId: "../JR-12345", workFolder: GRANT.workFolder });
  assert.equal(refused.private, false);
  assert.equal(asked, 0);
});
