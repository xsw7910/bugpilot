/**
 * The Effective AI Task as the panel holds it (0.1.4): the CLI's command line
 * for a work item or the template, the snapshot read from its envelope —
 * refused when a section does not fit the text — and blocks that, joined, are
 * the CLI's text byte for byte, each labelled protected or editable.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import {
  SECTION_KIND_LABELS,
  TASK_PREVIEW_CAPABILITY,
  readsTaskPreview,
  runTaskPreview,
  taskBlocks,
  taskPreviewArgs,
  taskPreviewFromEnvelope,
  taskPreviewRequestKey,
  taskPreviewView,
} from "../src/app/effectiveTask.ts";

const TEXT = [
  "# BugPilot Task: JR-12345",
  "",
  "## BugPilot Safety Rules",
  "",
  "- Never force push.",
  "",
  "## Project / Team Instructions",
  "",
  "Keep exports stable — <unchanged>.",
  "",
  "## AI Fix Mode",
  "",
  "Standard Fix.",
  "",
].join("\n");

const payload = (overrides: Record<string, unknown> = {}) => ({
  schema_version: 1,
  ok: true,
  command: "task-preview",
  preview_kind: "active-work-item",
  label: "Effective AI task for JR-12345",
  work_item: "JR-12345",
  text: TEXT,
  sections: [
    { heading: "BugPilot Safety Rules", class: "protected", protected: true, line: 3, lines: 4, placeholder: false },
    { heading: "Project / Team Instructions", class: "project-instructions", protected: false, line: 7, lines: 4, placeholder: false },
    { heading: "AI Fix Mode", class: "fix-mode", protected: false, line: 11, lines: 4, placeholder: false },
  ],
  placeholders: [],
  sources: {
    protected_rules: { rules_version: 1 },
    repository_profile: { mode: "auto" },
    project_instructions: { configured: true, characters: 30, problem: null, sha256: "x" },
    verification: { source: "verification-file", problem: null, lint: 0 },
    ai_behavior: { source: "ai-behavior-file", problem: null, lint: 0, has_project_additions: true },
    user_instructions: { configured: false, characters: 0, problem: null, sha256: "" },
    fix_mode: { id: "standard", name: "Standard Fix", source: "builtin", execution_kind: "fix", origin: "persisted" },
    branch_policy: { policy: "current", branch: "feature/JR-12345-crash" },
    jira_comment: false,
    hint: false,
    attachments: 0,
  },
  prepared: { task_exists: true, context_exists: true, task_current: false, changed_sections: ["Project / Team Instructions"], problem: null },
  warnings: ["User instructions (~/.bugpilot/instructions.md) were not included: it is not UTF-8 text."],
  ...overrides,
});

test("a work item's command line, or the template's with bug's own flags", () => {
  assert.equal(TASK_PREVIEW_CAPABILITY, "task-preview");
  assert.equal(readsTaskPreview({ capabilities: ["task-preview"] }), true);
  assert.equal(readsTaskPreview({ capabilities: ["protected-rules"] }), false);
  assert.deepEqual(taskPreviewArgs({ kind: "work-item", workItemId: "JR-12345" }), ["task-preview", "JR-12345", "--json"]);
  assert.deepEqual(taskPreviewArgs({ kind: "template", jiraComment: false }), ["task-preview", "--json"]);
  assert.deepEqual(
    taskPreviewArgs({ kind: "template", fixModeId: "investigate-first", branchPolicy: "per-issue", jiraComment: true }),
    ["task-preview", "--fix-mode", "investigate-first", "--branch-policy", "per-issue", "--jira-comment", "--json"],
  );
  assert.notEqual(taskPreviewRequestKey({ kind: "template", jiraComment: false }), taskPreviewRequestKey({ kind: "template", fixModeId: "conservative", jiraComment: false }));
  assert.equal(taskPreviewRequestKey({ kind: "work-item", workItemId: "JR-1" }), "work-item:JR-1");
});

test("the blocks, joined, are the CLI's text exactly — title included — each labelled by the CLI's class", () => {
  const snapshot = taskPreviewFromEnvelope(payload())!;
  const blocks = taskBlocks(snapshot);
  assert.equal(blocks.map((block) => block.text).join(""), TEXT);
  assert.deepEqual(
    blocks.map((block) => [block.heading ?? "(title)", block.label, block.protected]),
    [
      ["(title)", "Task title", true],
      ["BugPilot Safety Rules", "Protected · BugPilot", true],
      ["Project / Team Instructions", "Editable · Project instructions", false],
      ["AI Fix Mode", "Selected · Fix Mode", false],
    ],
  );
  assert.match(blocks[2]!.where, /Guidance & Verification › Project instructions/);
  // The text is the CLI's, angle brackets and dashes included: nothing is escaped or rewritten here.
  assert.ok(blocks[2]!.text.includes("Keep exports stable — <unchanged>."));
  for (const kind of ["protected", "project-instructions", "verification-policy", "ai-behavior", "user-instructions", "fix-mode", "developer-hint", "generated-evidence"]) {
    assert.ok(SECTION_KIND_LABELS[kind], kind);
  }
});

test("the view: label, the prepared task's state, where each layer came from, warnings and counts", () => {
  const view = taskPreviewView(taskPreviewFromEnvelope(payload())!);
  assert.equal(view.label, "Effective AI task for JR-12345");
  assert.equal(view.template, false);
  assert.equal(view.prepared, "Prepared task.md: differs in Project / Team Instructions.");
  assert.deepEqual(view.facts, [
    { label: "Fix Mode", value: "Standard Fix" },
    { label: "Branch policy", value: "current" },
    { label: "Jira status comment", value: "Off" },
    { label: "Verification Policy", value: "Repository verification.md" },
    { label: "AI Behavior", value: "BugPilot default + repository additions" },
    { label: "Project instructions", value: "Configured" },
    { label: "User instructions", value: "None" },
    { label: "Repository profile", value: "auto" },
    { label: "Protected rules", value: "version 1" },
  ]);
  assert.equal(view.warnings.length, 1);
  assert.deepEqual([view.protectedCount, view.editableCount], [1, 2]);
  const template = taskPreviewView(
    taskPreviewFromEnvelope(payload({ preview_kind: "template", label: "Template preview — no work item selected", work_item: null, prepared: null, placeholders: ["<work-item-id>"] }))!,
  );
  assert.deepEqual([template.template, template.prepared, template.placeholderNote], [true, "", "Placeholders in angle brackets stand for what only a work item has."]);
  for (const [prepared, line] of [
    [{ task_exists: false }, "Prepared task.md: not written yet."],
    [{ task_exists: true, task_current: true, changed_sections: [] }, "Prepared task.md: the same as this preview."],
    [{ task_exists: true, problem: "behind a link" }, "Prepared task.md: not compared — behind a link"],
    // Not the same text, though no section differs (its title, or the order): never "differs in ."
    [{ task_exists: true, task_current: false, changed_sections: [] }, "Prepared task.md: differs from this preview outside its sections."],
  ] as const) {
    assert.equal(taskPreviewView(taskPreviewFromEnvelope(payload({ prepared }))!).prepared, line);
  }
});

test("anything off in the envelope is refused, never guessed", () => {
  assert.equal(taskPreviewFromEnvelope(payload({ ok: false })), undefined);
  assert.equal(taskPreviewFromEnvelope(payload({ preview_kind: "draft" })), undefined);
  assert.equal(taskPreviewFromEnvelope(payload({ text: "" })), undefined);
  // A section that runs past the end of the text, or starts at line 0.
  assert.equal(taskPreviewFromEnvelope(payload({ sections: [{ heading: "X", class: "protected", line: 13, lines: 9 }] })), undefined);
  assert.equal(taskPreviewFromEnvelope(payload({ sections: [{ heading: "X", class: "protected", line: 0, lines: 1 }] })), undefined);
  assert.equal(taskPreviewFromEnvelope(payload({ text: "x".repeat(400_001) })), undefined);
});

test("an old CLI is out of date, a failure says why, and a good answer is loaded", async () => {
  const outdated = await runTaskPreview(async () => ({ code: 2, stdout: "", stderr: "usage: bugpilot ...\nbugpilot: error: unrecognized arguments: --json" }), {
    kind: "template",
    jiraComment: false,
  });
  assert.deepEqual(outdated, { kind: "outdated" });
  const failed = await runTaskPreview(
    async () => ({
      code: 1,
      stdout: JSON.stringify({ schema_version: 1, ok: false, command: "task-preview", error: { code: "WORK_ITEM_NOT_FOUND", message: "There is no prepared work item JR-1 here." } }),
      stderr: "",
    }),
    { kind: "work-item", workItemId: "JR-1" },
  );
  assert.deepEqual(failed, { kind: "failed", message: "There is no prepared work item JR-1 here." });
  const loaded = await runTaskPreview(async () => ({ code: 0, stdout: JSON.stringify(payload()), stderr: "" }), { kind: "work-item", workItemId: "JR-12345" });
  assert.equal(loaded.kind, "loaded");
  const thrown = await runTaskPreview(async () => {
    throw new Error("spawn failed");
  }, { kind: "template", jiraComment: false });
  assert.deepEqual(thrown, { kind: "failed", message: "spawn failed" });
});
