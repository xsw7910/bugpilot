/**
 * The extension's client against the real bugpilot CLI.
 *
 * Everything under `test/` is hermetic: the CLI is a scripted fake, which is
 * what makes those tests fast and honest about the extension's own logic. It
 * also means the seam that matters most in production — actual bytes from a
 * real Python process, parsed by `protocol.ts` and folded into the view models
 * — was never exercised. Two phase 5 defects lived exactly there: the argparse
 * behaviour that ate `--keywords -Wall`, and artifact names taken from the
 * design doc rather than from a run.
 *
 * So this suite spawns the real thing in a temporary git repository. It is not
 * part of `npm test`: it needs Python and takes tens of seconds. Run it with
 * `npm run integration`, and before any release.
 *
 * **It never touches the company Jira.** The one Jira test points
 * `JIRA_BASE_URL` at a closed local port, and environment variables take
 * precedence over `~/.bugpilot/config.toml`, so a developer's real credentials
 * cannot be used even if they are configured.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Runner } from "../src/runner.ts";
import { parseEnvelope } from "../src/protocol.ts";
import type { StreamEvent } from "../src/protocol.ts";
import { ProgressTracker, viewFromStatus } from "../src/app/progress.ts";
import { buildArtifactList, historyFromPayload } from "../src/app/artifacts.ts";
import { buildPrepareArgs, DEFAULT_FORM } from "../src/app/form.ts";
import { diagnose, knownCodes } from "../src/errors.ts";
import { discoverExecutable } from "../src/executable.ts";
import { isPlainPrompt } from "../src/app/agents.ts";
import { reviewPackageArgs, reviewPackageFromEnvelope } from "../src/app/reviewPackage.ts";
import { parseReviewOutput } from "../src/app/reviewOutput.ts";
import { recordReviewArgs, recordingOutcome, reviewPayload } from "../src/app/reviewCapture.ts";
import { parseReviewReport } from "../src/app/reviewReport.ts";
import { recordVerificationArgs, verificationOutcome, verificationPayload } from "../src/app/verificationCapture.ts";
import { parseVerificationReport } from "../src/app/verificationReport.ts";
import type { VerificationCheckEntry } from "../src/app/verificationReport.ts";
import { payloadCommandPort } from "../src/app/fixModeTransport.ts";

/** The repository under development, not whatever happens to be installed. */
const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

/**
 * How to run the sources: `python -m bugpilot`.
 *
 * The Runner takes an executable and appends its own flags, so the module
 * arguments ride in front of the command. `python -m bugpilot.cli` is *not*
 * used: that form silently does nothing (see the phase 6 log).
 */
const PYTHON = process.platform === "win32" ? "python" : "python3";
const MODULE = ["-m", "bugpilot"];

const ENVIRONMENT = {
  PYTHONPATH: REPO_ROOT,
  PYTHONIOENCODING: "utf-8",
} as const;

function runner(): Runner {
  return new Runner(PYTHON);
}

/** A throwaway git repository with something to find in it. */
function repository(): string {
  const root = mkdtempSync(path.join(tmpdir(), "bugpilot-it-"));
  mkdirSync(path.join(root, "src"));
  writeFileSync(
    path.join(root, "src", "record.py"),
    [
      "def save_record(record):",
      '    """Persist a record. Raises KeyError when the id is absent."""',
      '    return record["id"]',
      "",
    ].join("\n"),
    "utf8",
  );
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: root, stdio: "ignore" });
  git("init", "-q");
  git("-c", "user.email=t@t", "-c", "user.name=t", "add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "initial");
  return root;
}

const manualForm = (overrides: Partial<typeof DEFAULT_FORM> = {}) => ({
  ...DEFAULT_FORM,
  source: "manual" as const,
  description: "Saving a record crashes with a KeyError in src/record.py",
  title: "Save crash",
  ...overrides,
});

// --- the handshake ---------------------------------------------------------

test("doctor --json really does answer with one envelope", async () => {
  const result = await runner().run([...MODULE, "doctor", "--json"], {
    cwd: repository(),
    env: ENVIRONMENT,
    timeoutMs: 120_000,
  });

  // parseEnvelope, not JSON.parse: the point is that the client's own rules
  // (exactly one object, the expected schema_version, a usable shape) hold
  // against real output.
  const envelope = parseEnvelope(result.stdout, result.stderr);
  assert.equal(envelope.ok, true);
  assert.equal(envelope.command, "doctor");
  const report = envelope["report"] as Record<string, unknown>;
  assert.equal(typeof report["python_ok"], "boolean");
  assert.equal(typeof report["rg_available"], "boolean");
});

// --- a full streaming run --------------------------------------------------

test("a hand-written bug runs end to end, and the models describe it correctly", async () => {
  const root = repository();
  const built = buildPrepareArgs(manualForm({ keywords: "save, record" }), { root });
  assert.equal(built.ok, true);
  if (!built.ok) return;

  // runStreaming appends `--json-lines` itself, so it is dropped here. Asserted
  // rather than assumed: if the flag were renamed, the filter would quietly
  // become a no-op, argparse would accept the duplicate, and this test would
  // still pass while testing something else.
  assert.ok(built.args.includes("--json-lines"), "buildPrepareArgs no longer streams");

  const events: StreamEvent[] = [];
  const tracker = new ProgressTracker(DEFAULT_FORM.plan);
  const outcome = await runner().runStreaming(
    [...MODULE, ...built.args.filter((arg) => arg !== "--json-lines")],
    { cwd: root, env: ENVIRONMENT, timeoutMs: 300_000 },
    (event) => {
      events.push(event);
      tracker.apply(event);
    },
  );

  assert.equal(outcome.foreignVersion, undefined, "the CLI speaks the contract this client reads");
  assert.equal(outcome.terminated, true, "a finished run must end with a terminal event");

  const view = tracker.view();
  assert.equal(view.state, "done");
  for (const row of view.rows) {
    assert.notEqual(row.state, "pending", `${row.label} never reported anything`);
    assert.notEqual(row.state, "running", `${row.label} was left open`);
  }
  assert.ok(view.workItemId?.startsWith("local_"), view.workItemId);
  assert.equal(view.source, "manual");

  // The artifact model against a real directory listing. The design doc's file
  // names were wrong here; the run is the source of truth.
  const workItemId = view.workItemId!;
  const listing = readdirSync(path.join(root, ".ai", workItemId));
  const artifacts = buildArtifactList({ names: listing });
  assert.equal(artifacts.kind, "ready");
  if (artifacts.kind !== "ready") return;
  // One flat list (§37.88): task.md is there to hand over, and the report the
  // agent has not written yet is listed as not written.
  const task = artifacts.entries.find((entry) => entry.name === "task.md");
  assert.equal(task?.written, true, "no task.md, so the panel would offer nothing to hand over");
  const report = artifacts.entries.find((entry) => entry.name === "fix_report.md");
  assert.equal(report?.written, false);

  // And the restore path: the run state the run left behind must rebuild the
  // same checklist, because that is all a reopened window has.
  const status = JSON.parse(
    readFileSync(path.join(root, ".ai", workItemId, "run.json"), "utf8"),
  );
  assert.equal((status as { status?: string }).status, "prepared");
  const restored = viewFromStatus(status);
  assert.equal(restored.state, "done");
  assert.deepEqual(
    restored.rows.map((row) => row.state),
    view.rows.map((row) => row.state),
    "the restored checklist disagrees with the one the stream produced",
  );
});

// --- the argparse trap this contract depends on ----------------------------

test("a keyword starting with a dash survives the = form", async () => {
  const root = repository();
  const built = buildPrepareArgs(manualForm({ keywords: "-Wall" }), { root });
  assert.equal(built.ok, true);
  if (!built.ok) return;

  const tracker = new ProgressTracker(DEFAULT_FORM.plan);
  const outcome = await runner().runStreaming(
    [...MODULE, ...built.args.filter((arg) => arg !== "--json-lines")],
    { cwd: root, env: ENVIRONMENT, timeoutMs: 300_000 },
    (event) => tracker.apply(event),
  );

  assert.equal(outcome.terminated, true);
  assert.equal(tracker.view().state, "done");
});

test("the same keyword as a separate token still breaks the CLI", async () => {
  // Not a wish, a fact: argparse reads `-Wall` as an option, exits 2, and emits
  // no events at all — not even a terminal one. This test documents why every
  // value-carrying flag uses `--flag=value`, and will fail if argparse ever
  // changes so the workaround can be revisited.
  const root = repository();
  const outcome = await runner().runStreaming(
    [...MODULE, "bug", "--description=crash", "--keywords", "-Wall", "--resume", "--prepare-only"],
    { cwd: root, env: ENVIRONMENT, timeoutMs: 120_000 },
    () => {},
  );

  assert.equal(outcome.events.length, 0);
  assert.equal(outcome.terminated, false);
  assert.match(outcome.result.stderr, /unrecognized arguments|expected one argument/);
});

// --- failure paths ---------------------------------------------------------

test("a missing work item fails with a code this client knows", async () => {
  const result = await runner().run([...MODULE, "status", "JR-99999", "--json"], {
    cwd: repository(),
    env: ENVIRONMENT,
    timeoutMs: 120_000,
  });

  const envelope = parseEnvelope(result.stdout, result.stderr);
  assert.equal(envelope.ok, false);
  if (envelope.ok) return;
  assert.ok(
    knownCodes().includes(envelope.error.code),
    `${envelope.error.code} is not in the extension's code table`,
  );
  // Three channels on failure, as §5.1 promises: the envelope, a stderr line,
  // and a non-zero exit.
  assert.notEqual(result.code, 0);
  assert.match(result.stderr, /ERROR/);

  const diagnosis = diagnose(envelope.error.code, envelope.error.message);
  assert.equal(diagnosis.unknownCode, false);
  assert.ok(diagnosis.summary.length > 0);
});

test("an unreachable Jira ends the stream with a terminal failure event", async () => {
  // Pointed at a closed local port. Environment variables win over
  // ~/.bugpilot/config.toml, so this cannot reach the real Jira even on a
  // machine where credentials are configured.
  const tracker = new ProgressTracker(DEFAULT_FORM.plan);
  const outcome = await runner().runStreaming(
    [...MODULE, "bug", "JR-12345", "--resume", "--prepare-only"],
    {
      cwd: repository(),
      env: {
        ...ENVIRONMENT,
        JIRA_BASE_URL: "http://127.0.0.1:9",
        JIRA_EMAIL: "nobody@example.invalid",
        JIRA_TOKEN: "not-a-real-token",
      },
      timeoutMs: 180_000,
    },
    (event) => tracker.apply(event),
  );

  // The stream is terminated even though the run failed: a consumer waiting for
  // a terminal event must not be left waiting.
  assert.equal(outcome.terminated, true);
  const view = tracker.view();
  assert.equal(view.state, "failed");
  assert.ok(view.failure, "a failed run must carry a failure");
  assert.ok(
    knownCodes().includes(view.failure!.code),
    `${view.failure!.code} is not in the extension's code table`,
  );
  // The row that was in flight is the one blamed, and it is the Jira one.
  assert.equal(view.failure!.capability, "issue_details");
});

// --- the history list ------------------------------------------------------

test("list --json feeds the history view", async () => {
  const root = repository();
  const built = buildPrepareArgs(manualForm(), { root });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  await runner().runStreaming(
    [...MODULE, ...built.args.filter((arg) => arg !== "--json-lines")],
    { cwd: root, env: ENVIRONMENT, timeoutMs: 300_000 },
    () => {},
  );

  const result = await runner().run([...MODULE, "list", "--json"], {
    cwd: root,
    env: ENVIRONMENT,
    timeoutMs: 120_000,
  });
  const envelope = parseEnvelope(result.stdout, result.stderr);
  const history = historyFromPayload(envelope);

  assert.equal(history.kind, "ready");
  if (history.kind !== "ready") return;
  assert.equal(history.items.length, 1);
  assert.ok(history.items[0]!.workItemId.startsWith("local_"));
  assert.equal(history.items[0]!.prepared, true);
  // A local id says nothing on its own, so the title is what makes the row
  // readable (§3.4).
  assert.equal(history.items[0]!.title, "Save crash");
});

// --- the Fix Mode a form carries, all the way to the artifacts --------------

/**
 * The audit record's keys, as `fix_mode_state.fix_mode_metadata` writes them.
 *
 * All of them, not only the id: `issue.json` records which definition ran —
 * its version, where it came from and what it was based on — and a record cut
 * down to an id would stop answering that.
 */
const FIX_MODE_RECORD_KEYS = [
  "based_on",
  "based_on_version",
  "execution_kind",
  "id",
  "name",
  "source",
  "version",
];

test("the Fix Mode a form carries reaches issue.json and task.md, for a built-in and a custom mode", async () => {
  // Batch 7 moved the selector into Advanced settings. The form's `fixModeId`
  // is the whole contract between the panel and a run, so this drives it end
  // to end: the panel's form, `buildPrepareArgs`, the real CLI, the artifacts.
  const root = repository();
  // A project custom mode, created the way Duplicate & Customize creates one.
  execFileSync(PYTHON, [...MODULE, "fix-mode", "duplicate", "conservative", "team-safe", "--scope", "project"], {
    cwd: root,
    env: { ...process.env, ...ENVIRONMENT },
    stdio: "ignore",
  });

  const expected = [
    { fixModeId: "standard", source: "builtin", kind: "fix", basedOn: null },
    { fixModeId: "investigate-first", source: "builtin", kind: "investigate", basedOn: null },
    { fixModeId: "team-safe", source: "project", kind: "fix", basedOn: "conservative" },
  ];
  for (const mode of expected) {
    const built = buildPrepareArgs(manualForm({ fixModeId: mode.fixModeId }), { root });
    assert.equal(built.ok, true, mode.fixModeId);
    if (!built.ok) return;
    assert.ok(built.args.includes(`--fix-mode=${mode.fixModeId}`), mode.fixModeId);

    const tracker = new ProgressTracker(DEFAULT_FORM.plan);
    const outcome = await runner().runStreaming(
      [...MODULE, ...built.args.filter((arg) => arg !== "--json-lines")],
      { cwd: root, env: ENVIRONMENT, timeoutMs: 300_000 },
      (event) => tracker.apply(event),
    );
    assert.equal(outcome.terminated, true, mode.fixModeId);
    assert.equal(tracker.view().state, "done", mode.fixModeId);
    const directory = path.join(root, ".ai", tracker.view().workItemId!);

    // issue.json: the whole audit record, unchanged in shape.
    const issue = JSON.parse(readFileSync(path.join(directory, "issue.json"), "utf8")) as {
      guidance: { fix_mode: Record<string, unknown> };
    };
    const record = issue.guidance.fix_mode;
    assert.deepEqual(Object.keys(record).sort(), FIX_MODE_RECORD_KEYS, mode.fixModeId);
    assert.equal(record["id"], mode.fixModeId);
    assert.equal(record["source"], mode.source, mode.fixModeId);
    assert.equal(record["execution_kind"], mode.kind, mode.fixModeId);
    assert.equal(record["based_on"], mode.basedOn, mode.fixModeId);

    // run.json carries the same record — it is what the panel's Strategy line reads.
    const run = JSON.parse(readFileSync(path.join(directory, "run.json"), "utf8")) as {
      fix_mode: Record<string, unknown>;
    };
    assert.deepEqual(run.fix_mode, record, mode.fixModeId);

    // task.md names the mode the agent is to follow. Line endings are the
    // platform's (Python writes text mode), so they are normalised first.
    const task = readFileSync(path.join(directory, "task.md"), "utf8").replaceAll("\r\n", "\n");
    const section = /## AI Fix Mode\n([\s\S]*?)\n## /.exec(task)?.[1] ?? "";
    assert.match(section, new RegExp(`- Mode ID: \`${mode.fixModeId}\``), mode.fixModeId);
    assert.match(section, new RegExp(`- Source: ${mode.source}`), mode.fixModeId);
    assert.match(section, new RegExp(`- Execution: ${mode.kind}`), mode.fixModeId);
  }
});

// --- Fix result's review aids ---------------------------------------------

test("review-package --json gives the review aids and leaves the work item untouched", async () => {
  // What Copy Review Prompt and the Validation checklist run (Batch 9): the real
  // CLI, the extension's own reader, and a directory that must not change.
  const root = repository();
  const built = buildPrepareArgs(manualForm(), { root });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const tracker = new ProgressTracker(DEFAULT_FORM.plan);
  await runner().runStreaming(
    [...MODULE, ...built.args.filter((arg) => arg !== "--json-lines")],
    { cwd: root, env: ENVIRONMENT, timeoutMs: 300_000 },
    (event) => tracker.apply(event),
  );
  const workItemId = tracker.view().workItemId!;
  const directory = path.join(root, ".ai", workItemId);
  writeFileSync(
    path.join(directory, "fix_report.md"),
    `# Fix Report: ${workItemId}\n\n## Summary\n\nFixed the KeyError.\n\n## Tests\n\nNot run.\n\n## Review Notes\n\n- The id is still required by callers.\n`,
    "utf8",
  );
  const snapshot = () => Object.fromEntries(readdirSync(directory).map((name) => [name, readFileSync(path.join(directory, name), "utf8")]));
  const before = snapshot();

  const result = await runner().run([...MODULE, ...reviewPackageArgs(workItemId)], {
    cwd: root,
    env: ENVIRONMENT,
    timeoutMs: 120_000,
  });
  const review = reviewPackageFromEnvelope(parseEnvelope(result.stdout, result.stderr));

  assert.ok(review, "the extension could not read review-package --json");
  assert.match(review.prompt, /^# Final Review Request\n/);
  assert.match(review.prompt, new RegExp(`\\.ai/${workItemId}/fix_report\\.md`));
  // What Review with AI (Batch 10) may put on a command line: the real prompt passes the guard.
  assert.equal(isPlainPrompt(review.prompt), true, "Review with AI would refuse the canonical prompt");
  // It asks for the four sections Paste Review Output reads, and for no verdict.
  const reply = review.prompt.slice(review.prompt.indexOf("## Summary"));
  assert.equal(parseReviewOutput(reply).ok, true, "a reply shaped as the prompt asks would not parse");
  assert.equal(/Verdict|PASS|NEEDS CHANGES/.test(review.prompt), false, "the prompt asks for a verdict");
  assert.equal(review.validation.steps.length, 5);
  assert.deepEqual([...review.validation.risks], ["The id is still required by callers."]);
  assert.ok(review.validation.files.some((file) => file.endsWith("record.py")), review.validation.files.join(", "));
  // Read-only: not a byte changed, no file added, run.json included.
  assert.deepEqual(snapshot(), before);

  // And the human command still prints exactly the same prompt.
  const human = await runner().run([...MODULE, "review-package", workItemId], { cwd: root, env: ENVIRONMENT, timeoutMs: 120_000 });
  assert.equal(human.stdout.replaceAll("\r\n", "\n"), review.prompt.replaceAll("\r\n", "\n"));
});

test("record-review through the extension's own port writes review_report.md, and nothing else", async () => {
  // Save Review Result (Batch 11) end to end: the payload file, the real CLI,
  // the extension's readers — and a work item in which only the one file appears.
  const root = repository();
  const built = buildPrepareArgs(manualForm(), { root });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const tracker = new ProgressTracker(DEFAULT_FORM.plan);
  await runner().runStreaming(
    [...MODULE, ...built.args.filter((arg) => arg !== "--json-lines")],
    { cwd: root, env: ENVIRONMENT, timeoutMs: 300_000 },
    (event) => tracker.apply(event),
  );
  const workItemId = tracker.view().workItemId!;
  const directory = path.join(root, ".ai", workItemId);
  writeFileSync(path.join(directory, "fix_report.md"), `# Fix Report: ${workItemId}\n\n## Summary\n\nFixed the KeyError.\n`, "utf8");
  const snapshot = () => Object.fromEntries(readdirSync(directory).map((name) => [name, readFileSync(path.join(directory, name), "utf8")]));
  const before = snapshot();

  const port = payloadCommandPort(
    () => root,
    (args, cwd) => runner().runJson([...MODULE, ...args], { cwd, env: ENVIRONMENT, timeoutMs: 120_000 }),
    { command: "record-review", prefix: "bugpilot-review", noRepository: "no repository" },
  );
  // Text a shell would act on, which must arrive as text.
  const hostile = 'Quotes " backticks ` pipes | %VAR% $(x)\n## Critical\n- the id check';
  const first = await port({
    args: (file) => recordReviewArgs(workItemId, file, false),
    payload: reviewPayload({ summary: "Reads correctly.", findings: hostile, validationNotes: "", recommendations: "Keep it." }),
  });
  assert.deepEqual(recordingOutcome(first), { recorded: true });

  const after = snapshot();
  assert.deepEqual(Object.keys(after).sort(), [...Object.keys(before), "review_report.md"].sort());
  for (const name of Object.keys(before)) assert.equal(after[name], before[name], `${name} changed`);
  const text = after["review_report.md"]!;
  assert.match(text, /^# Review Report: /);
  assert.ok(text.includes("backticks ` pipes | %VAR% $(x)"), "the review was not kept as text");
  assert.ok(text.includes("### Critical"), "a heading in the text broke out of Findings");
  assert.deepEqual(parseReviewReport(text), {
    readable: true,
    summary: "Reads correctly.",
    findings: 'Quotes " backticks ` pipes | %VAR% $(x)',
    validationNotes: false,
    recommendations: true,
  });

  // Recorded once: a second recording keeps it, with a code this client knows,
  // until it is asked to replace it.
  const again = await port({
    args: (file) => recordReviewArgs(workItemId, file, false),
    payload: reviewPayload({ summary: "Second.", findings: "", validationNotes: "", recommendations: "" }),
  });
  assert.equal(again.ok, false);
  assert.equal(!again.ok && again.error.code, "ARTIFACT_EXISTS");
  assert.ok(knownCodes().includes("ARTIFACT_EXISTS"));
  assert.equal(readFileSync(path.join(directory, "review_report.md"), "utf8"), text);
  const replaced = await port({
    args: (file) => recordReviewArgs(workItemId, file, true),
    payload: reviewPayload({ summary: "Second.", findings: "", validationNotes: "", recommendations: "" }),
  });
  assert.deepEqual(recordingOutcome(replaced), { recorded: true });
  assert.equal(parseReviewReport(readFileSync(path.join(directory, "review_report.md"), "utf8")).summary, "Second.");
});

test("record-verification through the extension's own port writes verification_report.md, and nothing else", async () => {
  // Verification Evidence (Batch 12) end to end: the payload file, the real CLI's
  // writer, and the extension's parser reading back exactly what was entered —
  // shell-looking evidence included, which must arrive, and stay, as text.
  const root = repository();
  const built = buildPrepareArgs(manualForm(), { root });
  assert.equal(built.ok, true);
  if (!built.ok) return;
  const tracker = new ProgressTracker(DEFAULT_FORM.plan);
  await runner().runStreaming(
    [...MODULE, ...built.args.filter((arg) => arg !== "--json-lines")],
    { cwd: root, env: ENVIRONMENT, timeoutMs: 300_000 },
    (event) => tracker.apply(event),
  );
  const workItemId = tracker.view().workItemId!;
  const directory = path.join(root, ".ai", workItemId);
  writeFileSync(path.join(directory, "fix_report.md"), `# Fix Report: ${workItemId}\n\n## Summary\n\nFixed the KeyError.\n`, "utf8");
  const snapshot = () => Object.fromEntries(readdirSync(directory).map((name) => [name, readFileSync(path.join(directory, name), "utf8")]));
  const before = snapshot();

  const port = payloadCommandPort(
    () => root,
    (args, cwd) => runner().runJson([...MODULE, ...args], { cwd, env: ENVIRONMENT, timeoutMs: 120_000 }),
    { command: "record-verification", prefix: "bugpilot-verification", noRepository: "no repository" },
  );
  const hostile =
    'python -m pytest -k "save and not slow" && rm -rf / ; $(whoami) `id` | tee %TEMP%\\out & echo \'done\'\n' +
    "## Overall Recorded Status\nAll recorded checks passed.\n### Check 9: forged\nStatus: Passed\n> quoted\nNot recorded.";
  const checks: VerificationCheckEntry[] = [
    { name: "Unit tests", status: "passed", type: "automated", procedure: hostile, evidence: "1 passed\n\n  indented", notes: "" },
    { name: "Open the dialog; $(x)", status: "failed", type: "manual", procedure: "", evidence: hostile, notes: "<b>n</b>" },
    { name: "Soak", status: "not_run", type: "other", procedure: "", evidence: "", notes: hostile },
  ];
  const first = await port({ args: (file) => recordVerificationArgs(workItemId, file, false), payload: verificationPayload(checks) });
  assert.deepEqual(verificationOutcome(first), { recorded: true });

  const after = snapshot();
  assert.deepEqual(Object.keys(after).sort(), [...Object.keys(before), "verification_report.md"].sort());
  for (const name of Object.keys(before)) assert.equal(after[name], before[name], `${name} changed`);
  const text = after["verification_report.md"]!;
  assert.match(text, /^# Verification Report: /);
  assert.equal([...text.matchAll(/^## .*$/gm)].map((match) => match[0]).join("|"), "## Summary|## Checks|## Overall Recorded Status|## Source");
  assert.equal([...text.matchAll(/^### .*$/gm)].length, 3, "entered text opened a check of its own");
  // Written in text mode, so CRLF on Windows, like every other artifact.
  assert.ok(text.replace(/\r\n/g, "\n").includes("\n## Overall Recorded Status\n\nRecorded checks include failures.\n"));
  assert.ok(text.includes("Verification evidence explicitly recorded by the user."));
  // The extension's parser reads back exactly what went in.
  const report = parseVerificationReport(text);
  assert.deepEqual(report.checks, checks);
  assert.deepEqual([report.passed, report.failed, report.notRun], [1, 1, 1]);
  // Nothing ran: the evidence never became a process, and no other file appeared.
  assert.equal(readdirSync(root).includes("out"), false);

  // Recorded once: a second recording keeps it until asked to replace it.
  const again = await port({ args: (file) => recordVerificationArgs(workItemId, file, false), payload: verificationPayload([checks[2]!]) });
  assert.equal(!again.ok && again.error.code, "ARTIFACT_EXISTS");
  assert.equal(readFileSync(path.join(directory, "verification_report.md"), "utf8"), text);
  const replaced = await port({ args: (file) => recordVerificationArgs(workItemId, file, true), payload: verificationPayload([checks[2]!]) });
  assert.deepEqual(verificationOutcome(replaced), { recorded: true });
  assert.deepEqual(parseVerificationReport(readFileSync(path.join(directory, "verification_report.md"), "utf8")).checks, [checks[2]]);

  // What the CLI refuses comes back as a code this client knows.
  const refused = await port({
    args: (file) => recordVerificationArgs(workItemId, file, true),
    payload: { checks: [{ name: "x", status: "skipped", type: "automated" }] },
  });
  assert.equal(!refused.ok && refused.error.code, "INVALID_INPUT");
  assert.ok(knownCodes().includes("INVALID_INPUT"));
});

// --- the install matrix ----------------------------------------------------

test("whatever bugpilot is on PATH is classified, not misread", async () => {
  // This machine has an older pipx copy on PATH that does not understand
  // --json, which is the case the `incompatible` verdict exists for. The
  // assertion is deliberately about the *classification*, not about which
  // install happens to be first: what must never happen is calling a real
  // install "not found", which sends the developer to install a second one.
  const verdict = await discoverExecutable({ cwd: repository(), timeoutMs: 120_000 });
  console.log(`      PATH bugpilot -> ${verdict.kind}`);
  if (verdict.kind === "not-found") {
    assert.match(
      verdict.detail,
      /not on PATH/,
      "a bugpilot that exists must not be reported as absent",
    );
    return;
  }
  assert.ok(
    ["ready", "incompatible", "unhealthy", "unresponsive"].includes(verdict.kind),
    verdict.kind,
  );
});
