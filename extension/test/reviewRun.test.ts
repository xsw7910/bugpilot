/**
 * Review with AI, captured (§37.80): which agents are run one-shot, how their
 * output is read, which fix a review attempt is for, and where that is kept.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { AgentService, CLAUDE_CAPTURED_REVIEW, CLI_AGENTS, capturedReviewOf } from "../src/app/agents.ts";
import {
  CAPTURE_FAILED,
  MAX_REMEMBERED_FIXES,
  NO_USABLE_RESULT,
  TIMED_OUT,
  capturedReviewOutcome,
  fixReportIdentity,
  reviewedFixStore,
} from "../src/app/reviewRun.ts";
import type { CapturedRun } from "../src/app/reviewRun.ts";
import { parseReviewOutput } from "../src/app/reviewOutput.ts";

const REPLY =
  "## Summary\nHandles the null input.\n\n## Findings\nNothing to report.\n\n## Validation Notes\nRan git diff. No tests were run.\n\n## Recommendations\nAdd a regression test.\n";
const json = (result: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type: "result", subtype: "success", is_error: false, result, ...extra });
const run = (stdout: string, extra: Partial<CapturedRun> = {}): CapturedRun => ({ code: 0, stdout, stderr: "", aborted: false, ...extra });
const read = (captured: CapturedRun) => capturedReviewOutcome(captured, CLAUDE_CAPTURED_REVIEW);

// --- which agents are captured -------------------------------------------------

const PROMPT = "# Final Review Request\n\nReview the BugPilot result for work item JR-12345.\n";

const reviewer = async (choice: "auto" | "claude-cli" | "custom", onPath: readonly string[], capture: boolean, prompt = PROMPT, customCommand = "") => {
  const agents = new AgentService({ probes: { canRun: async (command) => onPath.includes(command) } });
  const resolution = await agents.resolve({ choice, customCommand, prompt });
  return { resolution, captured: capturedReviewOf(resolution, capture) };
};

test("Claude CLI is the one agent with a captured review; auto and claude-cli reach it", async () => {
  assert.deepEqual(CLI_AGENTS.filter((agent) => agent.capturedReview !== undefined).map((agent) => agent.id), ["claude-cli"]);
  for (const choice of ["auto", "claude-cli"] as const) {
    const { captured } = await reviewer(choice, ["claude"], true);
    assert.equal(captured?.command, "claude", choice);
    assert.equal(captured?.invocation, CLAUDE_CAPTURED_REVIEW);
  }
});

test("a custom command is never captured: it keeps the terminal handoff", async () => {
  const { resolution, captured } = await reviewer("custom", ["codex"], true, PROMPT, "codex {prompt}");
  assert.equal(resolution.kind, "ready");
  assert.equal(captured, undefined);
});

test("without a capture port, or without the agent, there is no captured plan", async () => {
  assert.equal((await reviewer("auto", ["claude"], false)).captured, undefined);
  const missing = await reviewer("claude-cli", [], true);
  assert.equal(missing.resolution.kind, "unavailable");
  assert.equal(missing.captured, undefined);
  const refused = await reviewer("claude-cli", ["claude"], true, "$(rm -rf .)");
  assert.equal(refused.resolution.kind, "refused", "the prompt gate applies to a captured review too");
});

test("the captured invocation is one-shot, read-only and isolated from the developer's settings", () => {
  const args = [...CLAUDE_CAPTURED_REVIEW.args];
  const after = (flag: string) => args[args.indexOf(flag) + 1];
  assert.equal(args[0], "-p");
  assert.equal(after("--output-format"), "json");
  assert.equal(after("--permission-mode"), "dontAsk");
  assert.equal(after("--setting-sources"), "");
  assert.ok(args.includes("--strict-mcp-config"));
  assert.ok(args.includes("--no-session-persistence"));
  // The tools that exist at all, and the ones allowed: reading only. No shell:
  // `Bash(git diff *)` admitted `git diff
  // --output=<file>`, which writes any file, and an external diff driver or a
  // textconv filter, which run programs. BugPilot collects the diff instead.
  const tools = args.slice(args.indexOf("--tools") + 1, args.indexOf("--allowedTools"));
  assert.deepEqual(tools, ["Read", "Grep", "Glob"]);
  assert.deepEqual(args.slice(args.indexOf("--allowedTools") + 1), ["Read", "Grep", "Glob"]);
  assert.equal(args.some((arg) => /Bash|PowerShell|\bgit\b|^--output(=|$)|--ext-diff|textconv/i.test(arg)), false, args.join(" "));
  for (const writer of ["Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch", "Task", "Agent", "--dangerously-skip-permissions", "bypassPermissions", "acceptEdits", "--add-dir"]) {
    assert.equal(args.includes(writer), false, writer);
  }
  // The prompt is not an argument: it goes on stdin.
  assert.equal(args.some((arg) => /Review/.test(arg)), false);
});

// --- reading what came back ----------------------------------------------------

test("a finished run whose result parses is a draft, read by the same parser as a paste", () => {
  const outcome = read(run(json(`I'll check the diff first.\n\n${REPLY}`)));
  assert.equal(outcome.ok, true);
  const pasted = parseReviewOutput(`I'll check the diff first.\n\n${REPLY}`);
  assert.ok(outcome.ok && pasted.ok);
  assert.deepEqual(outcome.entry, pasted.entry);
  assert.equal(outcome.leftOut, pasted.leftOut);
  assert.equal(outcome.leftOut, true, "leading chatter is left out, and said");
});

test("exit code 0 alone is not a captured review", () => {
  for (const [stdout, detail] of [
    ["", /printed nothing/],
    ["   \n", /printed nothing/],
    ["## Summary\nA.", /not the result/],
    [JSON.stringify({ type: "assistant", message: "x" }), /not the result/],
    [JSON.stringify([1, 2]), /not the result/],
    [json(42), /not the result/],
  ] as const) {
    const outcome = read(run(stdout));
    assert.equal(outcome.ok, false, stdout);
    assert.ok(!outcome.ok && outcome.title === CAPTURE_FAILED, stdout);
    assert.match(!outcome.ok ? outcome.detail : "", detail);
  }
});

test("a reply that does not parse is refused with the parser's reason, and kept for the paste box", () => {
  const cases = [
    "Looks good overall, nothing to add.",
    "## Summary\nA.\n## Findings\nB.\n",
    // The real transcript's shape: Recommendations repeated at the end.
    `${REPLY}\n## Recommendations\nAdd a regression test.\n`,
    // Two complete blocks — ambiguous, never one picked at random.
    `${REPLY}\n${REPLY}`,
  ];
  for (const text of cases) {
    const outcome = read(run(json(text)));
    assert.ok(!outcome.ok, text);
    assert.equal(!outcome.ok && outcome.title, CAPTURE_FAILED);
    assert.match(!outcome.ok ? outcome.detail : "", /^Review output was not read: /);
    assert.equal(!outcome.ok && outcome.reply, text);
  }
});

test("tool output inside the reply stays inside its section; it never makes one", () => {
  const reply = REPLY.replace(
    "Ran git diff. No tests were run.",
    "Ran git diff:\n```\n## Summary\n-old\n+new\n```\nNo tests were run.",
  );
  const outcome = read(run(json(reply)));
  assert.ok(outcome.ok);
  assert.equal(outcome.entry.summary, "Handles the null input.");
  assert.match(outcome.entry.validationNotes, /```\n## Summary\n-old/);
});

test("a run that did not finish with a result is a process failure, whatever it printed", () => {
  const cases: CapturedRun[] = [
    run("", { code: 1, stderr: "Error: not logged in\nmore" }),
    run(json(REPLY), { code: 2 }),
    run(json("Prompt is too long", { is_error: true })),
    run(json("", { subtype: "error_max_turns" })),
  ];
  for (const captured of cases) {
    const outcome = read(captured);
    assert.ok(!outcome.ok);
    assert.equal(!outcome.ok && outcome.title, NO_USABLE_RESULT, JSON.stringify(captured));
    assert.equal(!outcome.ok && outcome.reply, undefined);
  }
  // The host's timeout is said as that — not as a failure of the review.
  const timedOut = read(run("", { code: null, aborted: true }));
  assert.equal(!timedOut.ok && timedOut.title, TIMED_OUT);
  assert.match(!timedOut.ok ? timedOut.detail : "", /stopped after 15 minutes/);
  const said = read(run("", { code: 1, stderr: "Error: not logged in\nmore" }));
  assert.match(!said.ok ? said.detail : "", /exited with code 1: Error: not logged in$/);
});

test("nothing is inferred: a reply saying PASS is the reviewer's words, and the outcome has no status", () => {
  const outcome = read(run(json(REPLY.replace("Handles the null input.", "PASS — approved, safe to merge."))));
  assert.ok(outcome.ok);
  assert.deepEqual(Object.keys(outcome).sort(), ["entry", "leftOut", "ok"]);
  assert.equal(outcome.entry.summary, "PASS — approved, safe to merge.");
  for (const title of [CAPTURE_FAILED, NO_USABLE_RESULT, TIMED_OUT]) assert.equal(/fail(ed)?\b|reject|pass/i.test(title), false, title);
});

test("an oversized output is refused before it is parsed", () => {
  const outcome = read(run(json("x".repeat(2_000_000))));
  assert.ok(!outcome.ok && outcome.title === CAPTURE_FAILED);
});

// --- which fix, and where that is kept ------------------------------------------

test("a fix is its report's content: the same text is the same fix, any change a new one", () => {
  const report = "# Fix Report\n\n## Summary\nFixed it.\n";
  assert.equal(fixReportIdentity(report), fixReportIdentity(report));
  assert.equal(fixReportIdentity(report), fixReportIdentity(report.replace(/\n/g, "\r\n")), "line endings are not a new fix");
  assert.notEqual(fixReportIdentity(report), fixReportIdentity(report.replace("Fixed it.", "Fixed it again.")));
  assert.notEqual(fixReportIdentity(report), fixReportIdentity(`${report} `));
  assert.equal(fixReportIdentity(undefined), "unreadable");
  assert.match(fixReportIdentity(report), /^[0-9a-f]{64}$/);
});

test("the store keeps one fix per work item, bounded, and trusts nothing it did not write", () => {
  let saved: unknown = { "JR-1": "a", "JR-2": 7, bogus: null };
  const store = reviewedFixStore(() => saved, (value) => (saved = value));
  assert.equal(store.get("JR-1"), "a");
  assert.equal(store.get("JR-2"), undefined, "a value that is not a string");
  assert.equal(store.get("constructor"), undefined);
  store.set("JR-2", "b");
  store.set("JR-1", undefined);
  assert.deepEqual(saved, { "JR-2": "b" });
  for (let index = 0; index < MAX_REMEMBERED_FIXES + 5; index += 1) store.set(`JR-${100 + index}`, "x");
  assert.equal(Object.keys(saved as object).length, MAX_REMEMBERED_FIXES);
  assert.equal(store.get("JR-2"), undefined, "the oldest was not forgotten first");
  saved = "garbage";
  assert.equal(store.get("JR-100"), undefined);
});
