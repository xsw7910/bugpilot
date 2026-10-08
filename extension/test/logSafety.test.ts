/**
 * What the BugPilot output channel may say (§37.95): flags, ids and outcomes,
 * never the text somebody typed or Jira returned.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { REDACTED, commandForLog, redactKnown, rejectedValueForLog, sensitiveValues, stderrForLog } from "../src/app/logSafety.ts";
import { ProtocolError, parseEnvelope } from "../src/protocol.ts";
import { DEFAULT_FORM, buildPrepareArgs } from "../src/app/form.ts";

const SECRET_DESCRIPTION = "SECRET_BUG_DESCRIPTION_48291";
const SECRET_JIRA = "SECRET_JIRA_TEXT_73125";
const SECRET_INSTRUCTION = "SECRET_CUSTOM_INSTRUCTION_99421";

test("a run's command line keeps its flags and loses every value somebody typed", () => {
  const args = [
    "bug",
    `--description=Crash on save ${SECRET_DESCRIPTION}`,
    `--title=${SECRET_JIRA}`,
    `--hint=${SECRET_INSTRUCTION}`,
    "--keywords=VolumeDescriptor",
    "--focus-file=src/private/secret_area.py",
    "--ignore-path=vendor",
    "--attach=C:\\path\\to\\Desktop\\crash.log",
    "--max-files=10",
    "--max-search-lines=300",
    "--fix-mode=investigate",
    "--skip-git-history",
    "--resume",
    "--prepare-only",
    "--json-lines",
  ];
  assert.equal(
    commandForLog(args),
    "bugpilot bug --description=<redacted> --title=<redacted> --hint=<redacted> --keywords=<redacted> " +
      "--focus-file=<redacted> --ignore-path=<redacted> --attach=<redacted> --max-files=10 --max-search-lines=300 " +
      "--fix-mode=investigate --skip-git-history --resume --prepare-only --json-lines",
  );
});

test("a work item id and BugPilot's own values stay: a Jira run and a retry read as before", () => {
  assert.equal(commandForLog(["bug", "JR-12345", "--fix-mode=standard", "--resume"]), "bugpilot bug JR-12345 --fix-mode=standard --resume");
  assert.equal(commandForLog(["bug", "JR-1", "--retry", "--prepare-only", "--json"]), "bugpilot bug JR-1 --retry --prepare-only --json");
  assert.equal(commandForLog(["clean", "local_20260930230052"]), "bugpilot clean local_20260930230052");
  assert.equal(commandForLog(["agent-check"]), "bugpilot agent-check");
  // The extension's own scratch file: its path, never its contents.
  assert.equal(commandForLog(["bug", "--description-file=C:\\storage\\bug-description.md"]), "bugpilot bug --description-file=C:\\storage\\bug-description.md");
});

test("the branch policy is a choice BugPilot normalised, so it stays — and is not scrubbed from stderr", () => {
  for (const policy of ["current", "per-issue", "ask"]) {
    assert.equal(commandForLog(["bug", "JR-1", `--branch-policy=${policy}`]), `bugpilot bug JR-1 --branch-policy=${policy}`);
  }
  // Redacted, "ask" and "current" were cut out of every word that held them.
  const values = sensitiveValues(["bug", "JR-1", "--branch-policy=ask", "--branch-policy=current"]);
  assert.deepEqual(values, []);
  assert.equal(stderrForLog("could not read task.md in the current folder", values), "could not read task.md in the current folder");
});

test("an unknown flag's value, and a positional that is not an id, are redacted by default", () => {
  // An allowlist: a flag added tomorrow leaks nothing until someone decides it may.
  assert.equal(commandForLog(["bug", `--future-flag=${SECRET_JIRA}`]), `bugpilot bug --future-flag=${REDACTED}`);
  // `clean` with whatever was typed into the palette's box.
  assert.equal(commandForLog(["clean", `${SECRET_DESCRIPTION} please`]), `bugpilot clean ${REDACTED}`);
});

test("the args the form really builds are logged without its text", () => {
  const built = buildPrepareArgs(
    {
      ...DEFAULT_FORM,
      source: "manual",
      description: `Crash on save ${SECRET_DESCRIPTION}`,
      title: SECRET_JIRA,
      hint: SECRET_INSTRUCTION,
      keywords: `${SECRET_INSTRUCTION}_kw, save`,
      focusFiles: "src/secret_area.py",
    },
    { root: "/repo" },
  );
  assert.ok(built.ok);
  if (!built.ok) return;
  const line = commandForLog(built.args);
  for (const secret of [SECRET_DESCRIPTION, SECRET_JIRA, SECRET_INSTRUCTION, "secret_area"]) assert.equal(line.includes(secret), false, secret);
  assert.match(line, /^bugpilot bug --description=<redacted> --title=<redacted> --hint=<redacted> --keywords=<redacted> --keywords=<redacted> --focus-file=<redacted> /);
});

test("what a process echoes back is scrubbed of those values, and stays readable", () => {
  const args = ["bug", `--description=${SECRET_DESCRIPTION} on save`, `--hint=${SECRET_INSTRUCTION}`, "--keywords=ab"];
  const values = sensitiveValues(args);
  const echoed = `usage: bugpilot bug [-h] ...\nbugpilot bug: error: unrecognized arguments: --hint=${SECRET_INSTRUCTION}\nwhile reading "${SECRET_DESCRIPTION} on save"`;
  const scrubbed = redactKnown(echoed, values);
  assert.equal(scrubbed.includes(SECRET_INSTRUCTION), false);
  assert.equal(scrubbed.includes(SECRET_DESCRIPTION), false);
  assert.match(scrubbed, /unrecognized arguments: --hint=<redacted>/);
  // Longest first: the whole description goes, not a fragment of it.
  assert.match(scrubbed, /while reading "<redacted>"/);
  // A two-character value is not worth wrecking every word that contains it.
  assert.match(redactKnown("abort about", values), /^abort about$/);
});

test("stderr reaches the log as its scrubbed tail", () => {
  const stderr = Array.from({ length: 60 }, (_, index) => `line ${index}`).join("\n") + `\nValueError: ${SECRET_DESCRIPTION}`;
  const logged = stderrForLog(stderr, [SECRET_DESCRIPTION]);
  assert.match(logged, /^\(21 earlier lines omitted\)\n/);
  assert.match(logged, /ValueError: <redacted>$/);
  assert.equal(logged.split("\n").length, 41);
});

test("a value that failed validation is logged by its length only", () => {
  assert.equal(rejectedValueForLog(`${SECRET_DESCRIPTION} x`), "(30 characters)");
  assert.equal(rejectedValueForLog(42), "(number)");
});

test("stdout that is not JSON is reported without quoting it", () => {
  // Node's own parse message quotes a fragment of the input — here an issue's text.
  assert.throws(
    () => parseEnvelope(`{"title": "${SECRET_JIRA}" oops`),
    (error: unknown) => {
      assert.ok(error instanceof ProtocolError);
      assert.equal(error.message.includes(SECRET_JIRA), false, error.message);
      assert.match(error.message, /^bugpilot stdout was not a single JSON object \(SyntaxError, \d+ characters\)\.$/);
      // The output itself is still on the error for code that needs it.
      assert.ok(error.stdout.includes(SECRET_JIRA));
      return true;
    },
  );
});
