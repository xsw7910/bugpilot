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
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
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
import { deleteWorkItemArtifacts } from "../src/app/sessionReset.ts";
import { repositoryProfileOfForm, runRepositoryProfile } from "../src/app/repositoryProfile.ts";
import { runInstructions } from "../src/app/instructions.ts";
import { projectSettingsOfForm, runProjectSettings } from "../src/app/projectSettings.ts";
import { runVerificationPolicy, samePolicyText } from "../src/app/verificationPolicy.ts";
import { aiBehaviorFingerprint, readsAiBehaviorText, runAiBehaviorPolicy } from "../src/app/aiBehaviorPolicy.ts";
import { readsProtectedRules, runProtectedRules } from "../src/app/protectedRules.ts";
import { readsTaskPreview, runTaskPreview, taskBlocks } from "../src/app/effectiveTask.ts";
import { readsContextPreview, runContextPreview } from "../src/app/effectiveContext.ts";
import { isolateIntegrationSuite } from "./isolation.ts";

/** The repository under development, not whatever happens to be installed. */
const REPO_ROOT = path.resolve(fileURLToPath(new URL("../..", import.meta.url)));

/**
 * First, before any test runs: this process and every child it starts get a
 * disposable home and no Jira or mail variables, and every Python child gets
 * the isolation guard (0.1.6 Batch 0A, plan §11.1; `isolation.ts`).
 */
const ISOLATION = isolateIntegrationSuite(REPO_ROOT);

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
  // The isolation guard first, then the sources.
  PYTHONPATH: ISOLATION.pythonPath,
  PYTHONIOENCODING: "utf-8",
} as const;

/** Every CLI child goes through the isolation's spawn, which refuses an unisolated one before it starts. */
function runner(): Runner {
  return new Runner(PYTHON, ISOLATION.spawn);
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
  // machine where credentials are configured. https://, because an http:// site
  // is refused before any connection — a different
  // failure from the unreachable one this test is about.
  const tracker = new ProgressTracker(DEFAULT_FORM.plan);
  const outcome = await runner().runStreaming(
    [...MODULE, "bug", "JR-12345", "--resume", "--prepare-only"],
    {
      cwd: repository(),
      env: {
        ...ENVIRONMENT,
        JIRA_BASE_URL: "https://127.0.0.1:9",
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
  // The selector lives in Advanced settings. The form's `fixModeId`
  // is the whole contract between the panel and a run, so this drives it end
  // to end: the panel's form, `buildPrepareArgs`, the real CLI, the artifacts.
  const root = repository();
  // A project custom mode, created the way Duplicate & Customize creates one.
  execFileSync(PYTHON, [...MODULE, "fix-mode", "duplicate", "conservative", "team-safe", "--scope", "project"], {
    cwd: root,
    env: ISOLATION.checkedEnv({ ...process.env, ...ENVIRONMENT }, PYTHON, MODULE),
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
  // What Copy Review Prompt and the Validation checklist run: the real
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
  // What Review with AI may put on a command line: the real prompt passes the guard.
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
  // Save Review Result end to end: the payload file, the real CLI,
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
  // Verification Evidence end to end: the payload file, the real CLI's
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
  //
  // Started through the isolation's spawn like every other CLI child (0.1.6
  // plan §14.1.A). An installed bugpilot is a console script, not `python`, so
  // the spawn judges it by its environment: the isolated home, no Jira or mail
  // variables, the guard's loader inherited on PYTHONPATH.
  const started: string[] = [];
  const spawn: typeof ISOLATION.spawn = (command, args, options) => {
    started.push(path.basename(command));
    return ISOLATION.spawn(command, args, options);
  };
  const verdict = await discoverExecutable({ cwd: repository(), timeoutMs: 120_000, spawn });
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
  assert.ok(started.length > 0, "the PATH bugpilot must start through the isolation's spawn");
});

// --- Reset Session's Delete generated files (§37.103) ---------------------------

test("Reset Session's Delete runs the real clean on .ai/<id>/ only, and never deletes through a link", async () => {
  const root = repository();
  const outside = mkdtempSync(path.join(tmpdir(), "bugpilot-it-outside-"));
  writeFileSync(path.join(outside, "precious.txt"), "do not delete\n", "utf8");
  for (const id of ["JR-1", "JR-2"]) {
    mkdirSync(path.join(root, ".ai", id), { recursive: true });
    writeFileSync(path.join(root, ".ai", id, "task.md"), `${id}\n`, "utf8");
  }
  writeFileSync(path.join(root, ".ai", "notes.txt"), "mine\n", "utf8");
  mkdirSync(path.join(root, ".ai_memory", "bugs"), { recursive: true });
  writeFileSync(path.join(root, ".ai_memory", "bugs", "JR-1.md"), "memory\n", "utf8");
  // A link inside the folder being deleted, to something outside it: removed
  // as a link, its target left alone.
  symlinkSync(outside, path.join(root, ".ai", "JR-1", "linked"), process.platform === "win32" ? "junction" : "dir");
  const clean = (id: string) => () => runner().run([...MODULE, "clean", id], { cwd: root, env: ENVIRONMENT, timeoutMs: 120_000 });

  assert.deepEqual(await deleteWorkItemArtifacts({ root, workItemId: "JR-1", clean: clean("JR-1") }), { kind: "deleted" });
  assert.equal(existsSync(path.join(root, ".ai", "JR-1")), false);
  assert.equal(readFileSync(path.join(outside, "precious.txt"), "utf8"), "do not delete\n");
  assert.equal(readFileSync(path.join(root, ".ai", "JR-2", "task.md"), "utf8"), "JR-2\n");
  assert.equal(readFileSync(path.join(root, ".ai", "notes.txt"), "utf8"), "mine\n");
  assert.equal(readFileSync(path.join(root, ".ai_memory", "bugs", "JR-1.md"), "utf8"), "memory\n");
  assert.ok(existsSync(path.join(root, "src", "record.py")));

  // The work item folder itself a link: refused before the CLI is asked.
  rmSync(path.join(root, ".ai", "JR-2"), { recursive: true });
  symlinkSync(outside, path.join(root, ".ai", "JR-2"), process.platform === "win32" ? "junction" : "dir");
  let asked = false;
  const refused = await deleteWorkItemArtifacts({
    root,
    workItemId: "JR-2",
    clean: async () => {
      asked = true;
      return clean("JR-2")();
    },
  });
  assert.deepEqual(refused, { kind: "refused", reason: "link" });
  assert.equal(asked, false);
  assert.equal(readFileSync(path.join(outside, "precious.txt"), "utf8"), "do not delete\n");

  // Nothing there: missing, and the CLI is not asked.
  assert.deepEqual(await deleteWorkItemArtifacts({ root, workItemId: "JR-3", clean: clean("JR-3") }), { kind: "missing" });
});

// --- the Repository Profile through the real CLI -------------------------------

test("the Repository Profile port reads, saves and reads back through the real CLI, and a run writes it into task.md", async () => {
  const root = repository();
  writeFileSync(
    path.join(root, "CMakeLists.txt"),
    "cmake_minimum_required(VERSION 3.21)\nproject(Viewer LANGUAGES CXX)\nfind_package(Qt6 REQUIRED COMPONENTS Widgets)\n",
    "utf8",
  );
  const run = (args: readonly string[]) => runner().run([...MODULE, ...args], { cwd: root, env: ENVIRONMENT, timeoutMs: 120_000 });

  const shown = await runRepositoryProfile(run);
  assert.equal(shown.kind, "loaded");
  if (shown.kind !== "loaded") return;
  assert.equal(shown.snapshot.profile.mode, "auto");
  assert.equal(shown.snapshot.saved, false);
  assert.match(shown.snapshot.detected, /C\+\+ · Qt · Desktop application · CMake/);

  const custom = repositoryProfileOfForm({ ...DEFAULT_FORM, repositoryProfile: "custom", repositoryLanguages: "Rust", repositoryNotes: "No unsafe code." });
  const saved = await runRepositoryProfile(run, custom);
  assert.equal(saved.kind, "loaded");
  if (saved.kind !== "loaded") return;
  assert.equal(saved.snapshot.saved, true);
  assert.equal(saved.snapshot.profile.custom.languages, "Rust");
  const file = JSON.parse(readFileSync(path.join(root, ".bugpilot", "repository_profile.json"), "utf8")) as { mode: string };
  assert.equal(file.mode, "custom");

  // A Run sends no profile flag, and the task still describes the repository from the file.
  const built = buildPrepareArgs(manualForm({ repositoryProfile: "custom", repositoryLanguages: "Rust" }), { root });
  assert.ok(built.ok);
  if (!built.ok) return;
  const outcome = await runner().runStreaming(
    [...MODULE, ...built.args.filter((arg) => arg !== "--json-lines")],
    { cwd: root, env: ENVIRONMENT, timeoutMs: 300_000 },
    () => {},
  );
  assert.equal(outcome.terminated, true, outcome.result.stderr);
  const ai = path.join(root, ".ai");
  const [workItem] = readdirSync(ai);
  const task = readFileSync(path.join(ai, workItem!, "task.md"), "utf8");
  assert.match(task, /Repository profile: Custom\./);
  assert.match(task, /- Languages: Rust/);
  assert.match(task, /- Codebase notes: No unsafe code\./);
  assert.equal(/Qt|C\+\+/.test(task), false, "the detected facts leaked into a Custom profile");
});

// --- User and Project instructions through the real CLI -------------------------

test("the instructions port reads, saves by stdin, clears and reads back through the real CLI, and a run carries them", async () => {
  const root = repository();
  // The user's own file in a folder of the test's, never the real ~/.bugpilot.
  const home = mkdtempSync(path.join(tmpdir(), "bugpilot-it-home-"));
  const env = { ...ENVIRONMENT, BUGPILOT_CONFIG_DIR: home };
  const run = (args: readonly string[], input?: string) =>
    runner().run([...MODULE, ...args], { cwd: root, env, timeoutMs: 120_000, ...(input === undefined ? {} : { input }) });

  const shown = await runInstructions(run);
  assert.equal(shown.kind, "loaded", JSON.stringify(shown));
  if (shown.kind !== "loaded") return;
  assert.equal(shown.snapshot.user.configured, false);
  assert.equal(shown.snapshot.project.configured, false);
  assert.equal(existsSync(path.join(root, ".bugpilot")), false, "reading created a folder");

  const qt = "Preserve Qt object ownership conventions.\nAvoid blocking the UI thread.";
  const project = await runInstructions(run, { scope: "project", text: `${qt}\n` });
  assert.equal(project.kind, "loaded", JSON.stringify(project));
  if (project.kind !== "loaded") return;
  assert.equal(project.snapshot.project.text, qt);
  assert.equal(project.snapshot.project.sha256.length, 64);
  assert.ok(existsSync(path.join(root, ".bugpilot", "instructions.md")));

  const user = await runInstructions(run, { scope: "user", text: "Prefer small focused changes — ✓ ünïcode." });
  assert.equal(user.kind, "loaded");
  assert.equal(readFileSync(path.join(home, "instructions.md"), "utf8").trim(), "Prefer small focused changes — ✓ ünïcode.");

  // A Run carries both, after the Repository Context and below the safety rules.
  const built = buildPrepareArgs(manualForm(), { root });
  assert.ok(built.ok);
  if (!built.ok) return;
  const outcome = await runner().runStreaming(
    [...MODULE, ...built.args.filter((arg) => arg !== "--json-lines")],
    { cwd: root, env, timeoutMs: 300_000 },
    () => {},
  );
  assert.equal(outcome.terminated, true, outcome.result.stderr);
  const ai = path.join(root, ".ai");
  const [workItem] = readdirSync(ai);
  // Line endings unified: artifacts are written in the platform's own.
  const task = readFileSync(path.join(ai, workItem!, "task.md"), "utf8").replace(/\r\n/g, "\n");
  const order = ["## BugPilot Safety Rules", "## Repository Context", "## Project / Team Instructions", "## User Instructions", "## Branch Instructions"].map((heading) => task.indexOf(heading));
  assert.ok(order.every((index) => index >= 0), JSON.stringify(order));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.ok(task.includes(qt));
  assert.ok(task.includes("Prefer small focused changes — ✓ ünïcode."));
  assert.equal(task.includes(home), false, "an absolute path reached the task");

  // Empty text removes the file.
  const cleared = await runInstructions(run, { scope: "project", text: "" });
  assert.equal(cleared.kind, "loaded");
  if (cleared.kind !== "loaded") return;
  assert.equal(cleared.snapshot.project.configured, false);
  assert.equal(existsSync(path.join(root, ".bugpilot", "instructions.md")), false);
});

// --- project settings through the real CLI ----------------------------------------

test("the project settings port reads, saves and reads back through the real CLI, and a run writes the policy and branch", async () => {
  const root = repository();
  const run = (args: readonly string[]) => runner().run([...MODULE, ...args], { cwd: root, env: ENVIRONMENT, timeoutMs: 120_000 });

  const shown = await runProjectSettings(run);
  assert.equal(shown.kind, "loaded", JSON.stringify(shown));
  if (shown.kind !== "loaded") return;
  assert.equal(shown.snapshot.saved, false);
  assert.deepEqual(shown.snapshot.settings, projectSettingsOfForm(DEFAULT_FORM));

  const form = { ...DEFAULT_FORM, verifyFullSuite: true, branchNaming: "custom" as const, branchTemplate: "bugfix/{issue}-{slug}" };
  const saved = await runProjectSettings(run, projectSettingsOfForm(form));
  assert.equal(saved.kind, "loaded", JSON.stringify(saved));
  if (saved.kind !== "loaded") return;
  assert.equal(saved.snapshot.saved, true);
  assert.equal(saved.snapshot.settings.branch_naming.template, "bugfix/{issue}-{slug}");

  // An unsafe template is refused by the CLI, in its own words, and the file is kept.
  const refused = await runProjectSettings(run, { ...projectSettingsOfForm(form), branch_naming: { template: "../{issue}" } });
  assert.equal(refused.kind, "failed");
  if (refused.kind === "failed") assert.match(refused.message, /cannot contain '\.\.'/);

  // A Run sends no flag for them, and the task carries both.
  const built = buildPrepareArgs(manualForm(), { root });
  assert.ok(built.ok);
  if (!built.ok) return;
  assert.equal(built.args.some((arg) => /verif|template/i.test(arg)), false);
  const outcome = await runner().runStreaming(
    [...MODULE, ...built.args.filter((arg) => arg !== "--json-lines")],
    { cwd: root, env: ENVIRONMENT, timeoutMs: 300_000 },
    () => {},
  );
  assert.equal(outcome.terminated, true, outcome.result.stderr);
  const ai = path.join(root, ".ai");
  const [workItem] = readdirSync(ai);
  const task = readFileSync(path.join(ai, workItem!, "task.md"), "utf8").replace(/\r\n/g, "\n");
  assert.match(task, /## Verification Policy\n\nSource: repository configuration \(project settings\)\./);
  assert.match(task, /- Run the repository's full test suite before reporting, if it can run in this environment\./);
  assert.match(task, /`bugfix\/bug-[0-9a-f]{8}-/);
});

// --- the Verification Policy through the real CLI (0.1.3, §42.5) -----------------

test("the Verification Policy port reads, creates from the CLI's own text, resets and reads back through the real CLI", async () => {
  const root = repository();
  const run = (args: readonly string[], input?: string) =>
    runner().run([...MODULE, ...args], { cwd: root, env: ENVIRONMENT, timeoutMs: 120_000, ...(input === undefined ? {} : { input }) });
  const file = path.join(root, ".bugpilot", "verification.md");
  const show = async () => {
    const outcome = await runVerificationPolicy(run);
    assert.equal(outcome.kind, "loaded", JSON.stringify(outcome));
    if (outcome.kind !== "loaded") throw new Error("not loaded");
    return outcome.snapshot;
  };

  // Viewing writes nothing: no file, no folder.
  const fresh = await show();
  assert.equal(fresh.source, "bugpilot-default");
  assert.equal(fresh.fileExists, false);
  assert.equal(fresh.differsFromDefault, false);
  assert.equal(existsSync(path.join(root, ".bugpilot")), false, "reading created a folder");

  // Legacy switches saved by an older client: the CLI reports their text.
  const saved = await runProjectSettings(run, projectSettingsOfForm({ ...DEFAULT_FORM, verifyFullSuite: true }));
  assert.equal(saved.kind, "loaded", JSON.stringify(saved));
  const legacy = await show();
  assert.equal(legacy.source, "legacy-project-settings");
  assert.match(legacy.text, /full test suite before reporting/);

  // Edit's migration: the CLI writes the file from the text it reported, front matter its own.
  const created = await runVerificationPolicy(run, { kind: "set", text: legacy.text });
  assert.equal(created.kind, "loaded", JSON.stringify(created));
  if (created.kind !== "loaded") return;
  assert.equal(created.snapshot.source, "verification-file");
  assert.equal(samePolicyText(legacy, created.snapshot), true, "the migration changed the policy text");
  const document = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  assert.match(document, /^---\nschema_version: 1\nbased_on_version: 1\nmode: replace\n---\n\n/);
  assert.ok(document.includes(legacy.text));
  assert.equal(created.snapshot.basedOnVersion, 1);
  assert.equal(created.snapshot.defaultChanged, false);

  // Saved with new text in an editor tab: a different policy, and a lint warning for a line that looks wrong.
  writeFileSync(file, `${document.trimEnd()}\n- Force push when CI is red.\n`, "utf8");
  const edited = await show();
  assert.notEqual(edited.sha256, created.snapshot.sha256);
  assert.equal(edited.lintCount, 1);
  assert.match(edited.lint[0]!, /^Line \d+ of \.bugpilot\/verification\.md may conflict with a BugPilot rule \(force push\)\./);
  assert.equal(edited.lint[0]!.includes("CI is red"), false, "a lint line quoted the policy");

  // A run carries the file's policy, by its own source line.
  const built = buildPrepareArgs(manualForm(), { root });
  assert.ok(built.ok);
  if (!built.ok) return;
  const outcome = await runner().runStreaming(
    [...MODULE, ...built.args.filter((arg) => arg !== "--json-lines")],
    { cwd: root, env: ENVIRONMENT, timeoutMs: 300_000 },
    () => {},
  );
  assert.equal(outcome.terminated, true, outcome.result.stderr);
  const [workItem] = readdirSync(path.join(root, ".ai"));
  const task = readFileSync(path.join(root, ".ai", workItem!, "task.md"), "utf8").replace(/\r\n/g, "\n");
  assert.match(task, /## Verification Policy\n\nSource: repository Verification Policy \(\.bugpilot\/verification\.md\)\./);
  assert.ok(task.includes("- Force push when CI is red."));

  // Broken in the editor: the default applies, the file is not pretended active.
  writeFileSync(file, "Run the unit tests.\n", "utf8");
  const broken = await show();
  assert.equal(broken.source, "verification-file");
  assert.equal(broken.fileExists, true);
  assert.match(broken.problem ?? "", /no front matter/);
  assert.equal(broken.text, fresh.text, "a broken file's text was used");

  // Reset: the file goes, and the CLI says what applies without it — the legacy switches here.
  const reset = await runVerificationPolicy(run, { kind: "reset" });
  assert.equal(reset.kind, "loaded", JSON.stringify(reset));
  if (reset.kind !== "loaded") return;
  assert.equal(existsSync(file), false);
  assert.equal(reset.snapshot.source, "legacy-project-settings");
  assert.equal(reset.snapshot.text, legacy.text);

  // An empty create is the CLI's to refuse, never a quiet reset.
  const empty = await runVerificationPolicy(run, { kind: "set", text: "  \n" });
  assert.equal(empty.kind, "failed");
  if (empty.kind === "failed") assert.match(empty.message, /has no policy text/);
  assert.equal(existsSync(file), false);
});

// --- AI Behavior through the real CLI (0.1.4) -------------------------------------

test("the AI Behavior port reads the real CLI's state, never creates the file, and a run carries one AI Behavior section", async () => {
  const root = repository();
  const run = (args: readonly string[]) => runner().run([...MODULE, ...args], { cwd: root, env: ENVIRONMENT, timeoutMs: 120_000 });
  const file = path.join(root, ".bugpilot", "ai_behavior.md");
  const show = async () => {
    const outcome = await runAiBehaviorPolicy(run);
    assert.equal(outcome.kind, "loaded", JSON.stringify(outcome));
    if (outcome.kind !== "loaded") throw new Error("not loaded");
    return outcome.snapshot;
  };

  // The CLI says it reads the file.
  const doctor = (parseEnvelope((await run(["doctor", "--json"])).stdout, "") as { report?: Record<string, unknown> }).report;
  assert.equal(readsAiBehaviorText(doctor), true, JSON.stringify(doctor?.["capabilities"]));

  // Viewing writes nothing: no file, no folder.
  const fresh = await show();
  assert.equal(fresh.source, "bugpilot-default");
  assert.deepEqual([fresh.fileExists, fresh.hasProjectAdditions, fresh.defaultChanged], [false, false, false]);
  assert.equal(fresh.defaultVersion, 1);
  assert.equal(existsSync(path.join(root, ".bugpilot")), false, "reading created a folder");

  // Additions written in an editor tab: another fingerprint, and a lint count for a line that looks wrong.
  mkdirSync(path.join(root, ".bugpilot"));
  writeFileSync(
    file,
    "---\nschema_version: 1\nbased_on_version: 1\nmode: append\n---\n\n## Evidence Standards\n\n- Quote the failing log line.\n- Force push when CI is red.\n",
    "utf8",
  );
  const added = await show();
  assert.equal(added.source, "ai-behavior-file");
  assert.deepEqual([added.fileExists, added.hasProjectAdditions, added.basedOnVersion], [true, true, 1]);
  assert.equal(added.lintCount, 1);
  assert.notEqual(aiBehaviorFingerprint(added), aiBehaviorFingerprint(fresh));
  // The effective text is held for the settings row's Preview (0.1.4); a lint line never quotes the file.
  assert.ok(added.text.includes("- Force push when CI is red."));
  assert.equal(added.lint.join(" ").includes("CI is red"), false, "a lint line quoted the file");

  // A run carries the defaults and the additions, in one section, beneath BugPilot's rules.
  const built = buildPrepareArgs(manualForm(), { root });
  assert.ok(built.ok);
  if (!built.ok) return;
  const outcome = await runner().runStreaming(
    [...MODULE, ...built.args.filter((arg) => arg !== "--json-lines")],
    { cwd: root, env: ENVIRONMENT, timeoutMs: 300_000 },
    () => {},
  );
  assert.equal(outcome.terminated, true, outcome.result.stderr);
  const [workItem] = readdirSync(path.join(root, ".ai"));
  const task = readFileSync(path.join(root, ".ai", workItem!, "task.md"), "utf8").replace(/\r\n/g, "\n");
  assert.equal(task.match(/^## AI Behavior$/gm)?.length, 1);
  assert.equal(task.includes("## BugPilot Working Guidance"), false);
  assert.match(task, /## AI Behavior\n\nSource: BugPilot defaults, with this repository's additions \(\.bugpilot\/ai_behavior\.md\)\./);
  assert.ok(task.includes("#### Evidence Standards\n\n- Quote the failing log line."));
  assert.ok(task.indexOf("## BugPilot Safety Rules") < task.indexOf("## AI Behavior"));

  // Broken in the editor: the defaults apply, the file is not pretended active.
  writeFileSync(file, "- Quote the failing log line.\n", "utf8");
  const broken = await show();
  assert.equal(broken.source, "ai-behavior-file");
  assert.equal(broken.fileExists, true);
  assert.equal(broken.hasProjectAdditions, false);
  assert.match(broken.problem ?? "", /no front matter/);
  assert.notEqual(aiBehaviorFingerprint(broken), aiBehaviorFingerprint(added));

  // Removed: back to the defaults, by the same fingerprint as before the file.
  rmSync(file);
  assert.equal(aiBehaviorFingerprint(await show()), aiBehaviorFingerprint(fresh));
});


// --- 0.1.4: the read-only views and AI Behavior's template, through the real CLI -----------------

test("the read-only views read the real CLI: protected rules, the task template and a work item's task, the context and its status", async () => {
  const root = repository();
  const run = (args: readonly string[]) => runner().run([...MODULE, ...args], { cwd: root, env: ENVIRONMENT, timeoutMs: 120_000 });
  const doctor = (parseEnvelope((await run(["doctor", "--json"])).stdout, "") as { report?: Record<string, unknown> }).report;
  assert.equal(readsProtectedRules(doctor) && readsTaskPreview(doctor) && readsContextPreview(doctor), true, JSON.stringify(doctor?.["capabilities"]));

  // Protected Rules: the CLI's list, grouped, read-only.
  const rules = await runProtectedRules(run);
  assert.equal(rules.kind, "loaded", JSON.stringify(rules));
  if (rules.kind !== "loaded") return;
  assert.deepEqual(rules.snapshot.groups.map((group) => group.title), ["Safety", "Evidence Integrity", "Git / Editing", "Delivery", "Jira", "Secrets / Artifacts"]);
  assert.ok(rules.snapshot.groups.flatMap((group) => group.rules).length >= 20);

  // No work item yet: the template, and no generated context — and nothing written for either.
  const template = await runTaskPreview(run, { kind: "template", fixModeId: "investigate-first", branchPolicy: "per-issue", jiraComment: false });
  assert.equal(template.kind, "loaded", JSON.stringify(template));
  if (template.kind !== "loaded") return;
  assert.equal(template.snapshot.label, "Template preview — no work item selected");
  assert.equal(taskBlocks(template.snapshot).map((block) => block.text).join(""), template.snapshot.text);
  assert.ok(template.snapshot.text.includes("## Investigation Handoff"));
  const none = await runContextPreview(run, undefined);
  assert.equal(none.kind === "loaded" && none.snapshot.state, "unavailable");
  assert.equal(existsSync(path.join(root, ".ai")), false, "a preview created .ai/");

  // Prepared: the work item's task is its task.md byte for byte, and its context is the stored file.
  const built = buildPrepareArgs(manualForm(), { root });
  assert.ok(built.ok);
  if (!built.ok) return;
  const outcome = await runner().runStreaming(
    [...MODULE, ...built.args.filter((arg) => arg !== "--json-lines")],
    { cwd: root, env: ENVIRONMENT, timeoutMs: 300_000 },
    () => {},
  );
  assert.equal(outcome.terminated, true, outcome.result.stderr);
  const [workItem] = readdirSync(path.join(root, ".ai"));
  const taskFile = readFileSync(path.join(root, ".ai", workItem!, "task.md"), "utf8").replace(/\r\n/g, "\n");
  const contextFile = readFileSync(path.join(root, ".ai", workItem!, "context.md"), "utf8").replace(/\r\n/g, "\n");
  const preview = await runTaskPreview(run, { kind: "work-item", workItemId: workItem! });
  assert.equal(preview.kind, "loaded", JSON.stringify(preview));
  if (preview.kind !== "loaded") return;
  assert.equal(preview.snapshot.text, taskFile);
  assert.equal(taskBlocks(preview.snapshot).map((block) => block.text).join(""), taskFile);
  assert.equal(preview.snapshot.prepared?.taskCurrent, true);
  const context = await runContextPreview(run, workItem!);
  assert.equal(context.kind, "loaded", JSON.stringify(context));
  if (context.kind !== "loaded") return;
  assert.equal(context.snapshot.state, "current");
  assert.equal(context.snapshot.text, contextFile);
  assert.ok(context.snapshot.quality && context.snapshot.retrieval);

  // A policy edited since: the CLI says the context needs a rebuild, and why — still showing it.
  mkdirSync(path.join(root, ".bugpilot"), { recursive: true });
  writeFileSync(path.join(root, ".bugpilot", "instructions.md"), "Name the module owner.\n", "utf8");
  const stale = await runContextPreview(run, workItem!);
  assert.equal(stale.kind === "loaded" && stale.snapshot.state, "stale");
  if (stale.kind !== "loaded") return;
  assert.deepEqual(stale.snapshot.reasons.map((reason) => reason.code), ["project_instructions_changed"]);
  assert.equal(stale.snapshot.text, contextFile);
});

test("AI Behavior's Edit path through the real CLI: the template adds nothing, so creating it changes no task", async () => {
  const root = repository();
  const run = (args: readonly string[], input?: string) =>
    runner().run([...MODULE, ...args], { cwd: root, env: ENVIRONMENT, timeoutMs: 120_000, ...(input === undefined ? {} : { input }) });
  const before = await runAiBehaviorPolicy(run);
  assert.equal(before.kind, "loaded", JSON.stringify(before));
  if (before.kind !== "loaded") return;
  assert.ok(before.snapshot.template, "the CLI gave no template");
  const created = await runAiBehaviorPolicy(run, { kind: "set", text: before.snapshot.template! });
  assert.equal(created.kind, "loaded", JSON.stringify(created));
  if (created.kind !== "loaded") return;
  assert.equal(created.snapshot.fileExists, true);
  assert.equal(created.snapshot.hasProjectAdditions, false);
  assert.equal(aiBehaviorFingerprint(created.snapshot), aiBehaviorFingerprint(before.snapshot), "creating the empty file was a change");
  const reset = await runAiBehaviorPolicy(run, { kind: "reset" });
  assert.equal(reset.kind === "loaded" && reset.snapshot.fileExists, false);
});

// --- the isolation itself ----------------------------------------------------

test("no Python child of this suite reached for the developer's real BugPilot data", () => {
  // Runs last (node:test runs a file's top-level tests in order). The guard
  // refuses before any read or write; this makes a refusal that a CLI
  // swallowed visible as a failure, not a quiet pass.
  assert.deepEqual(ISOLATION.violations(), []);
});
