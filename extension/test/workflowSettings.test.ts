/**
 * Workflow Settings' model: which settings live in which section, whether each
 * makes a prepared context stale, and the rows' one-line summaries.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_FORM, preparationFingerprint } from "../src/app/form.ts";
import type { FormState } from "../src/app/form.ts";
import type { FixModeCatalog } from "../src/app/fixModes.ts";
import { STEP_LABELS, WORKFLOW_STEP_IDS } from "../src/app/workflow.ts";
import {
  REQUIRES_REBUILD_LABEL,
  SETTINGS_SECTION_FIELDS,
  SETTINGS_SECTION_OF_STEP,
  SETTINGS_SECTION_TITLES,
  SETTING_REQUIRES_REBUILD,
  WORKFLOW_SETTINGS_SECTIONS,
  sectionOfField,
  sectionRebuildNote,
  settingsSummaries,
  showsRebuildLabel,
} from "../src/app/workflowSettings.ts";
import type { SettingsField } from "../src/app/workflowSettings.ts";

/** What the main page owns: the issue, the plan's checkboxes, the Fix with AI box. */
const MAIN_PAGE_FIELDS = ["source", "issueKey", "description", "plan", "fixWithAI"];

test("every settings field has exactly one home, and the form's own fields have none", () => {
  const placed = WORKFLOW_SETTINGS_SECTIONS.flatMap((section) => [...SETTINGS_SECTION_FIELDS[section]]);
  assert.equal(new Set(placed).size, placed.length, "a setting is in two sections");
  const expected = Object.keys(DEFAULT_FORM).filter((key) => !MAIN_PAGE_FIELDS.includes(key));
  assert.deepEqual([...placed].sort(), expected.sort());
  for (const field of placed) assert.ok(SETTINGS_SECTION_FIELDS[sectionOfField(field)].includes(field));
});

test("the gears map rows to sections one to one, and a section is titled by its step", () => {
  const steps = Object.keys(SETTINGS_SECTION_OF_STEP);
  for (const step of steps) assert.ok((WORKFLOW_STEP_IDS as readonly string[]).includes(step), step);
  assert.deepEqual(Object.values(SETTINGS_SECTION_OF_STEP), [...WORKFLOW_SETTINGS_SECTIONS]);
  // No gear where there is nothing to configure.
  assert.equal(SETTINGS_SECTION_OF_STEP.gitHistory, undefined);
  assert.equal(SETTINGS_SECTION_OF_STEP.similarFixes, undefined);
  for (const [step, section] of Object.entries(SETTINGS_SECTION_OF_STEP)) {
    assert.equal(SETTINGS_SECTION_TITLES[section], STEP_LABELS[step as keyof typeof STEP_LABELS]);
  }
});

/** A changed value for each settings field. */
const CHANGED: Readonly<Record<SettingsField, Partial<FormState>>> = {
  title: { title: "Crash on save" },
  attachments: { attachments: ["/logs/crash.txt"] },
  keywords: { keywords: "VolumeDescriptor" },
  focusFiles: { focusFiles: "src/a.ts" },
  ignorePaths: { ignorePaths: "build/" },
  maxFiles: { maxFiles: "5" },
  maxSearchLines: { maxSearchLines: "100" },
  fresh: { fresh: true },
  agent: { agent: "claude" },
  agentCommand: { agentCommand: "my-agent {prompt}" },
  fixModeId: { fixModeId: "conservative" },
  hint: { hint: "look at the controller" },
  useIssueDetails: { useIssueDetails: false },
};

test("the page's 'requires rebuild' words are the host's staleness rule, field by field", () => {
  // The labels are derived from SETTING_REQUIRES_REBUILD; the host decides
  // staleness from the fingerprint. This is what keeps the two the same rule.
  const jira = { ...DEFAULT_FORM, issueKey: "JR-1" };
  const manual: FormState = { ...DEFAULT_FORM, source: "manual", description: "It crashes." };
  for (const field of Object.keys(CHANGED) as SettingsField[]) {
    // Title only reaches a run for a hand-written bug, as on the command line.
    const base = field === "title" ? manual : jira;
    const moved = preparationFingerprint({ ...base, ...CHANGED[field] }) !== preparationFingerprint(base);
    assert.equal(moved, SETTING_REQUIRES_REBUILD[field], `${field}: the label and the fingerprint disagree`);
  }
});

test("a section says once whether its changes need a rebuild; a mixed one marks each setting that does", () => {
  assert.equal(sectionRebuildNote("issue-details"), "Changes here require rebuilding context.");
  assert.equal(sectionRebuildNote("code-search"), "Changes here require rebuilding context.");
  assert.equal(sectionRebuildNote("build-context"), "Changes here apply to the next run and do not require rebuilding context.");
  assert.equal(sectionRebuildNote("fix-with-ai"), `Settings marked “${REQUIRES_REBUILD_LABEL}” change the prepared context; the others do not.`);
  const labelled = (Object.keys(CHANGED) as SettingsField[]).filter(showsRebuildLabel);
  assert.deepEqual(labelled.sort(), ["fixModeId", "hint"]);
});

const CATALOG: FixModeCatalog = {
  kind: "ready",
  defaultModeId: "standard",
  modes: [
    { id: "standard", name: "Standard Fix", description: "", version: 1, source: "builtin", executionKind: "fix" },
    { id: "conservative", name: "Conservative Fix", description: "", version: 1, source: "builtin", executionKind: "fix" },
  ],
};

test("defaults summarize to nothing but Fix with AI's agent and mode", () => {
  assert.deepEqual(settingsSummaries({ ...DEFAULT_FORM, fixModeId: "standard" }, CATALOG), {
    fixWithAI: "Auto-detected agent · Standard Fix",
  });
  // No catalog, no mode name: nothing is guessed.
  assert.deepEqual(settingsSummaries({ ...DEFAULT_FORM, fixModeId: "standard" }, { kind: "loading" }), {
    fixWithAI: "Auto-detected agent",
  });
});

test("summaries are counts and names, singular or plural, and only for what is set", () => {
  const summaries = settingsSummaries(
    {
      ...DEFAULT_FORM,
      keywords: "a, b, a\nc",
      focusFiles: "src/x.ts",
      ignorePaths: "build/\nout/",
      maxFiles: "10",
      maxSearchLines: "1",
      attachments: ["/l/one.log", "/l/two.log"],
      fresh: true,
      agent: "claude",
      fixModeId: "conservative",
      hint: "check the reader",
    },
    CATALOG,
  );
  assert.deepEqual(summaries, {
    issueDetails: "2 attachments",
    codeSearch: "3 keywords · 1 focus path · 2 ignored paths · max 10 files · max 1 search line",
    buildContext: "Deletes previous artifacts first",
    fixWithAI: "Claude Code · Conservative Fix · hint added",
  });
  // A limit the run would reject is not reported as one.
  assert.equal(settingsSummaries({ ...DEFAULT_FORM, maxFiles: "abc", maxSearchLines: "0" }, CATALOG).codeSearch, undefined);
});

test("a custom agent is summarized by kind, never by its command", () => {
  const summary = settingsSummaries({ ...DEFAULT_FORM, agent: "custom", agentCommand: "C:/tools/agent.exe --key s3cret {prompt}" }, CATALOG);
  assert.equal(summary.fixWithAI, "Custom agent command");
  assert.doesNotMatch(JSON.stringify(summary), /tools|s3cret|agent\.exe/);
});
