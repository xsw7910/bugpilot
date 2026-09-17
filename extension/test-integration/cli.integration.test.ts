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
  const handoff = artifacts.sections.find((section) => section.group === "handoff");
  assert.ok(handoff, "no handoff section, so the panel would offer nothing to hand over");
  assert.equal(handoff.entries[0]?.name, "agent_task.md");
  // Every result file is still missing, which is exactly what the tree shows
  // before an agent has run.
  const results = artifacts.sections.find((section) => section.group === "results");
  assert.ok(results?.entries.every((entry) => entry.missing));

  // And the restore path: the status file the run left behind must rebuild the
  // same checklist, because that is all a reopened window has.
  const status = JSON.parse(
    readFileSync(path.join(root, ".ai", workItemId, "workflow_status.json"), "utf8"),
  );
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
