import { test } from "node:test";
import assert from "node:assert/strict";

import {
  EventStreamReader,
  ProtocolError,
  SCHEMA_VERSION,
  parseEnvelope,
} from "../src/protocol.ts";

const ok = (extra: Record<string, unknown> = {}) =>
  JSON.stringify({ schema_version: 1, ok: true, command: "bug", warnings: [], ...extra });

// --- envelope --------------------------------------------------------------

test("parses a success envelope and its extra fields", () => {
  const envelope = parseEnvelope(ok({ work_item_id: "JR-12345", source: "jira" }));
  assert.equal(envelope.ok, true);
  assert.equal(envelope["work_item_id"], "JR-12345");
  assert.deepEqual(envelope.warnings, []);
});

test("tolerates the trailing newline a CLI always writes", () => {
  assert.equal(parseEnvelope(`${ok()}\n`).ok, true);
});

test("parses a failure envelope", () => {
  const envelope = parseEnvelope(
    JSON.stringify({
      schema_version: 1,
      ok: false,
      command: "bug",
      error: { code: "JIRA_AUTH_FAILED", message: "rejected" },
    }),
  );
  assert.equal(envelope.ok, false);
  if (!envelope.ok) assert.equal(envelope.error.code, "JIRA_AUTH_FAILED");
});

test("empty stdout is a protocol error, not an empty result", () => {
  assert.throws(() => parseEnvelope("   "), ProtocolError);
});

test("a stray print alongside the object is reported, not ignored", () => {
  // Exactly the failure the CLI's one-object-on-stdout test guards against.
  assert.throws(() => parseEnvelope(`Preparing...\n${ok()}`), ProtocolError);
});

test("a newer contract version is refused rather than guessed at", () => {
  const future = JSON.stringify({ schema_version: SCHEMA_VERSION + 1, ok: true, command: "bug" });
  assert.throws(
    () => parseEnvelope(future),
    (error: unknown) =>
      error instanceof ProtocolError && /Update the extension/.test(error.message),
  );
});

test("a missing schema_version is refused", () => {
  assert.throws(() => parseEnvelope(JSON.stringify({ ok: true, command: "bug" })), ProtocolError);
});

test("a failure with no error.code is refused", () => {
  // error.code is the only field a consumer may branch on, so its absence is
  // unusable rather than merely incomplete.
  const bad = JSON.stringify({ schema_version: 1, ok: false, command: "bug", error: { message: "x" } });
  assert.throws(() => parseEnvelope(bad), ProtocolError);
});

test("a payload with no ok field is refused", () => {
  assert.throws(() => parseEnvelope(JSON.stringify({ schema_version: 1, command: "bug" })), ProtocolError);
});

test("a protocol error carries the raw streams for a bug report", () => {
  try {
    parseEnvelope("not json", "boom");
    assert.fail("should have thrown");
  } catch (error) {
    assert.ok(error instanceof ProtocolError);
    assert.equal(error.stdout, "not json");
    assert.equal(error.stderr, "boom");
  }
});

// --- event stream ----------------------------------------------------------

const line = (event: Record<string, unknown>) => `${JSON.stringify({ schema_version: 1, ...event })}\n`;

test("reads whole lines as they arrive", () => {
  const reader = new EventStreamReader();
  const events = reader.push(
    line({ type: "started", work_item_id: "JR-1", source: "jira" }) +
      line({ type: "step_started", step: "doctor" }),
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ["started", "step_started"],
  );
});

test("reassembles a line split across chunks", () => {
  // A spawned process chunks stdout arbitrarily; parsing chunks independently
  // would drop events at random and look like a flaky CLI.
  const reader = new EventStreamReader();
  const whole = line({ type: "step_started", step: "code_search" });
  const cut = Math.floor(whole.length / 2);

  assert.deepEqual(reader.push(whole.slice(0, cut)), []);
  const events = reader.push(whole.slice(cut));
  assert.equal(events.length, 1);
  assert.equal(events[0]?.type, "step_started");
});

test("reports the stream as terminated only after a completed event", () => {
  const reader = new EventStreamReader();
  reader.push(line({ type: "started", work_item_id: "JR-1", source: "jira" }));
  assert.equal(reader.end().terminated, false);

  const closed = new EventStreamReader();
  closed.push(line({ type: "completed", ok: true }));
  assert.equal(closed.end().terminated, true);
});

test("a killed process leaves the stream unterminated", () => {
  // The CLI emits `completed` on every path, so a missing one means the process
  // died mid-run — better than leaving a progress view stuck on a step.
  const reader = new EventStreamReader();
  reader.push(line({ type: "step_started", step: "code_search" }));
  const { terminated } = reader.end();
  assert.equal(terminated, false);
});

test("flushes a final line that had no trailing newline", () => {
  const reader = new EventStreamReader();
  reader.push(JSON.stringify({ schema_version: 1, type: "completed", ok: true }));
  const { events, terminated } = reader.end();
  assert.equal(events.length, 1);
  assert.equal(terminated, true);
});

test("one malformed line does not abort a progressing run", () => {
  const reader = new EventStreamReader();
  const events = reader.push(
    line({ type: "started", work_item_id: "JR-1", source: "jira" }) +
      "{ not json\n" +
      line({ type: "step_started", step: "doctor" }),
  );
  assert.deepEqual(
    events.map((event) => event.type),
    ["started", "step_started"],
  );
});

test("events from an unknown contract version are dropped", () => {
  const reader = new EventStreamReader();
  const events = reader.push(`${JSON.stringify({ schema_version: 99, type: "completed", ok: true })}\n`);
  assert.deepEqual(events, []);
  assert.equal(reader.end().terminated, false);
});

test("blank lines are ignored", () => {
  const reader = new EventStreamReader();
  assert.deepEqual(reader.push("\n\n   \n"), []);
});

test("a failure stream carries the error code through", () => {
  const reader = new EventStreamReader();
  const events = reader.push(
    line({ type: "completed", ok: false, error: { code: "INVALID_INPUT", message: "no input" } }),
  );
  const completed = events[0];
  assert.equal(completed?.type, "completed");
  if (completed?.type === "completed") {
    assert.equal(completed.ok, false);
    assert.equal(completed.error?.code, "INVALID_INPUT");
  }
});


test("end() names the contract version it could not read", () => {
  // Without this the caller cannot tell a version bump from a mid-run crash:
  // both look like "no events, never terminated".
  const reader = new EventStreamReader();
  reader.push(`${JSON.stringify({ schema_version: 99, type: "started" })}
`);
  const { events, terminated, foreignVersion } = reader.end();

  assert.deepEqual(events, []);
  assert.equal(terminated, false);
  assert.equal(foreignVersion, 99);
});

test("a stream this client can read reports no foreign version", () => {
  const reader = new EventStreamReader();
  reader.push(`${JSON.stringify({ schema_version: 1, type: "completed", ok: true })}
`);
  assert.equal(reader.end().foreignVersion, undefined);
});
