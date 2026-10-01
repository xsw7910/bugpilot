/**
 * What BugPilot says it is configured with.
 *
 * Two rules run through this file. **Nothing is claimed that was not
 * established**: a stored credential is "Credentials configured" and never
 * "Connected", and an agent nobody has tried to resolve is "Not checked yet".
 * And **nothing sensitive reaches the model** — the token, the custom command
 * line and the bug's own text all stay where they are.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { diagnostics } from "../src/app/diagnostics.ts";
import type { DiagnosticsInput } from "../src/app/diagnostics.ts";

const input = (overrides: Partial<DiagnosticsInput> = {}): DiagnosticsInput => ({
  root: "/work/sample-repo",
  executable: "/home/dev/.local/bin/bugpilot",
  cliVersion: "0.1.0",
  extensionVersion: "0.1.0",
  jiraConfigured: true,
  agent: "auto",
  source: "jira",
  ...overrides,
});

const rowsOf = (overrides: Partial<DiagnosticsInput> = {}) =>
  Object.fromEntries(diagnostics(input(overrides)).rows.map((row) => [row.label, row]));

test("a configured environment reads as one", () => {
  assert.deepEqual([...diagnostics(input({ workItemId: "JR-12345" })).rows], [
    { label: "Repository", value: "sample-repo", detail: "/work/sample-repo" },
    { label: "Jira", value: "Credentials configured" },
    { label: "AI agent", value: "Auto-detect", detail: "Not checked yet" },
    { label: "Work item", value: "JR-12345", detail: "From a Jira issue" },
    { label: "Extension", value: "0.1.0" },
    { label: "BugPilot CLI", value: "0.1.0", detail: "/home/dev/.local/bin/bugpilot" },
  ]);
});

test("the repository is named, with its path underneath", () => {
  // The name is what a developer calls it; the path is what tells two checkouts
  // of the same thing apart, which is the case this exists for.
  assert.deepEqual(rowsOf().Repository, {
    label: "Repository",
    value: "sample-repo",
    detail: "/work/sample-repo",
  });
  // Either separator, whichever platform wrote it.
  assert.equal(rowsOf({ root: "C:\\work\\sample-repo" }).Repository?.value, "sample-repo");
});

test("no repository is a state, not a blank", () => {
  const row = rowsOf({ root: undefined }).Repository;
  assert.equal(row?.value, "No repository open");
  assert.equal(row?.detail, undefined);
});

test("Jira says what is known and not what is hoped", () => {
  // A stored credential. Nobody has asked Jira anything.
  assert.equal(rowsOf({ jiraConfigured: true }).Jira?.value, "Credentials configured");
  assert.equal(rowsOf({ jiraConfigured: false }).Jira?.value, "Credentials not configured");

  for (const claim of ["Connected", "Healthy", "Online", "Verified", "Working"]) {
    const text = diagnostics(input()).rows.map((row) => `${row.value} ${row.detail ?? ""}`).join(" ");
    assert.equal(text.includes(claim), false, `Diagnostics claims "${claim}"`);
  }
});

test("the agent shows the selection, and what it resolved to only once it has", () => {
  // Resolution costs a process per candidate. Opening a disclosure must not
  // spend that, so until a handoff runs there is nothing to report.
  assert.deepEqual(rowsOf({ agent: "auto" })["AI agent"], {
    label: "AI agent",
    value: "Auto-detect",
    detail: "Not checked yet",
  });

  assert.equal(
    rowsOf({ resolvedAgent: { kind: "resolved", label: "Claude Code" } })["AI agent"]?.detail,
    "Resolved: Claude Code",
  );
  assert.equal(
    rowsOf({ resolvedAgent: { kind: "unavailable" } })["AI agent"]?.detail,
    "Resolved: none available",
  );
});

test("every agent choice has a name, and an unknown one survives as itself", () => {
  assert.equal(rowsOf({ agent: "auto" })["AI agent"]?.value, "Auto-detect");
  assert.equal(rowsOf({ agent: "claude-cli" })["AI agent"]?.value, "Claude CLI");
  assert.equal(rowsOf({ agent: "codex-extension" })["AI agent"]?.value, "Codex Extension");
  assert.equal(rowsOf({ agent: "custom" })["AI agent"]?.value, "Custom command");
  assert.equal(rowsOf({ agent: "something-new" })["AI agent"]?.value, "something-new");
});

test("a custom agent never brings its command line with it", () => {
  // It can carry a local path, an argument, or a token. "Custom command" is the
  // whole of what Diagnostics has any business saying.
  const row = rowsOf({ agent: "custom" })["AI agent"];

  assert.equal(row?.value, "Custom command");
  assert.equal(row?.detail, "Not checked yet");
});

test("a work item appears only once a run has established one", () => {
  assert.equal(rowsOf()["Work item"], undefined);
  assert.deepEqual(rowsOf({ workItemId: "JR-12345" })["Work item"], {
    label: "Work item",
    value: "JR-12345",
    detail: "From a Jira issue",
  });
});

test("a hand-written bug is named by its id, never by its text", () => {
  // The CLI mints the id; the description is the bug report and has no place
  // in a configuration summary.
  const row = rowsOf({ workItemId: "local_20260101120000", source: "manual" })["Work item"];

  assert.equal(row?.value, "local_20260101120000");
  assert.equal(row?.detail, "From a bug description");
});

test("the two versions are told apart", () => {
  // They are different numbers on a machine with a pipx copy and a checkout,
  // which is the failure this row exists to make visible.
  const rows = rowsOf({ extensionVersion: "0.2.0", cliVersion: "0.1.0" });

  assert.equal(rows.Extension?.value, "0.2.0");
  assert.equal(rows["BugPilot CLI"]?.value, "0.1.0");
  assert.equal(rows["BugPilot CLI"]?.detail, "/home/dev/.local/bin/bugpilot");
});

test("a version nobody could read is left out rather than guessed", () => {
  const rows = rowsOf({ extensionVersion: undefined, cliVersion: undefined, executable: undefined });

  assert.equal(rows.Extension, undefined);
  assert.equal(rows["BugPilot CLI"], undefined);
});

test("a CLI whose version did not answer still says which one it is", () => {
  const row = rowsOf({ cliVersion: undefined })["BugPilot CLI"];

  assert.equal(row?.value, "Version not known");
  assert.equal(row?.detail, "/home/dev/.local/bin/bugpilot");
});

test("nothing secret can reach a row", () => {
  // The token lives in SecretStorage and travels to the CLI in an environment
  // variable; the custom command and the bug's own text are not identity. None
  // of them is an input to this function, which is the strongest form of "never
  // displayed" available.
  const fields = Object.keys(input({ workItemId: "JR-12345", resolvedAgent: { kind: "unavailable" } })).sort();

  assert.deepEqual(fields, [
    "agent",
    "cliVersion",
    "executable",
    "extensionVersion",
    "jiraConfigured",
    "resolvedAgent",
    "root",
    "source",
    "workItemId",
  ]);
  for (const leaked of ["token", "credential", "secret", "command", "description", "email", "prompt"]) {
    assert.equal(
      fields.some((field) => field.toLowerCase().includes(leaked)),
      false,
      `Diagnostics takes "${leaked}" as input`,
    );
  }
});

test("a row never carries an empty detail", () => {
  // `detail: undefined` is not a detail, and a row with a hole where one should
  // be reads as a value that failed to load.
  for (const row of diagnostics(input({ root: undefined, cliVersion: undefined })).rows) {
    assert.equal("detail" in row && row.detail === undefined, false, row.label);
  }
});

test("a hostile value stays a value", () => {
  // A repository path and a work item id both come from outside this panel.
  // The repository one carries no slash on purpose: a path *is* split on those,
  // so a value containing one is a different test and not this one.
  const hostile = "<img src=x onerror=alert(1)>";
  const rows = rowsOf({ root: `/work/${hostile}`, workItemId: "<script>alert(1)</script>" });

  assert.equal(rows.Repository?.value, hostile);
  assert.equal(rows.Repository?.detail, `/work/${hostile}`);
  assert.equal(rows["Work item"]?.value, "<script>alert(1)</script>");
});
