/**
 * Telling an out-of-date bugpilot CLI from every other failure (pre-release
 * Batch 1, D). Exit code 2 alone is any argparse usage error; only argparse's
 * own words for "never heard of that" make a CLI out of date.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  CLI_NOT_FOUND_CODE,
  CLI_OUTDATED_CODE,
  isMissingCli,
  outdatedCliDetail,
  rejectedByOutdatedCli,
} from "../src/app/cliCompatibility.ts";
import { runError } from "../src/app/failures.ts";
import { ProgressTracker } from "../src/app/progress.ts";
import { DEFAULT_FORM } from "../src/app/form.ts";
import { installInstructions, outdatedCliActions } from "../src/app/environment.ts";

const USAGE = "usage: bugpilot bug [-h] [--json-lines] [issue_key]\n";

test("exit 2 with argparse's unrecognized arguments is an out-of-date CLI, by flag name", () => {
  const rejected = rejectedByOutdatedCli({
    code: 2,
    stderr: `${USAGE}bugpilot: error: unrecognized arguments: --replace-attachments --branch-policy=current\n`,
  });
  assert.deepEqual(rejected, ["--replace-attachments", "--branch-policy"]);
});

test("a rejected flag's value never comes back, only its name", () => {
  const rejected = rejectedByOutdatedCli({
    code: 2,
    stderr: `${USAGE}bugpilot: error: unrecognized arguments: --repository-profile=custom --future=C:\\Users\\me\\secret.txt\n`,
  });
  assert.deepEqual(rejected, ["--repository-profile", "--future"]);
  assert.equal(JSON.stringify(rejected).includes("secret"), false);
});

test("an unknown subcommand is an out-of-date CLI too", () => {
  const rejected = rejectedByOutdatedCli({
    code: 2,
    stderr:
      "usage: bugpilot [-h] {setup,doctor,bug} ...\n" +
      "bugpilot: error: argument command: invalid choice: 'repository-profile' (choose from 'setup', 'doctor', 'bug')\n",
  });
  assert.deepEqual(rejected, ["repository-profile"]);
});

test("other usage errors with exit 2 are not taken for an out-of-date CLI", () => {
  for (const line of [
    "bugpilot bug: error: argument --max-files: invalid int value: 'x'",
    "bugpilot bug: error: argument --branch-policy: invalid choice: 'later' (choose from 'current', 'per-issue', 'ask')",
    "bugpilot bug: error: argument --fresh: not allowed with argument --resume",
    "bugpilot: error: the following arguments are required: command",
  ]) {
    assert.equal(rejectedByOutdatedCli({ code: 2, stderr: `${USAGE}${line}\n` }), undefined, line);
  }
});

test("the words alone, with any other exit code, are not taken for an out-of-date CLI", () => {
  for (const code of [0, 1, 3, null]) {
    assert.equal(
      rejectedByOutdatedCli({ code, stderr: "bugpilot: error: unrecognized arguments: --x\n" }),
      undefined,
      String(code),
    );
  }
  // A traceback that happens to quote the phrase mid-line is not argparse's sentence.
  assert.equal(
    rejectedByOutdatedCli({ code: 2, stderr: 'ValueError: "error: unrecognized arguments" was in the description\n' }),
    undefined,
  );
});

test("the detail names what was rejected, or says the arguments were", () => {
  assert.equal(outdatedCliDetail(["--branch-policy"]), "The installed bugpilot does not accept: --branch-policy.");
  assert.equal(outdatedCliDetail([]), "The installed bugpilot rejected this extension's arguments.");
});

test("a missing executable is ENOENT, and nothing else is", () => {
  assert.equal(isMissingCli(Object.assign(new Error("spawn bugpilot ENOENT"), { code: "ENOENT" })), true);
  assert.equal(isMissingCli(Object.assign(new Error("denied"), { code: "EACCES" })), false);
  assert.equal(isMissingCli(new Error("spawn bugpilot ENOENT")), false, "the message is not the evidence");
  assert.equal(isMissingCli(undefined), false);
});

function failed(kind: "outdated" | "missing", detail?: string) {
  const tracker = new ProgressTracker(DEFAULT_FORM.plan, () => 0);
  tracker.cliUnusable(kind, detail);
  return tracker.view();
}

test("an out-of-date CLI is a card that says update it, never retry it", () => {
  const view = failed("outdated", outdatedCliDetail(["--branch-policy"]));
  assert.equal(view.state, "failed");
  assert.equal(view.failure?.code, CLI_OUTDATED_CODE);
  assert.equal(view.failure?.retryable, false);
  const card = runError(view.failure)!;
  assert.equal(card.kind, "cli");
  assert.equal(card.title, "BugPilot CLI is out of date");
  assert.match(card.message, /^BugPilot CLI is out of date\. This version of the extension requires a newer BugPilot CLI\./);
  assert.equal(card.detail, "The installed bugpilot does not accept: --branch-policy.");
  assert.deepEqual(card.action, { title: "Update Instructions", command: "bugpilot.showInstallInstructions" });
});

test("a missing CLI is a different card: install it, not update it", () => {
  const view = failed("missing");
  assert.equal(view.failure?.code, CLI_NOT_FOUND_CODE);
  assert.equal(view.failure?.retryable, false);
  const card = runError(view.failure)!;
  assert.equal(card.title, "BugPilot CLI was not found");
  assert.match(card.message, /^BugPilot CLI was not found\./);
  assert.deepEqual(card.action, { title: "Install Instructions", command: "bugpilot.showInstallInstructions" });
  assert.equal(card.detail, undefined);
});

test("the environment card offers update, choose and check again, and the instructions say how to update", () => {
  assert.deepEqual(outdatedCliActions().map((action) => action.title), ["Update Instructions", "Choose Executable", "Retry"]);
  const text = installInstructions().join("\n");
  assert.match(text, /pipx upgrade bugpilot/);
  assert.match(text, /bugpilot --version/);
});
