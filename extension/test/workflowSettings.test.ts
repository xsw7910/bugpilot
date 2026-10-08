/**
 * Workflow Settings' model: which settings live in which section, whether each
 * makes a prepared context stale, and the rows' one-line summaries.
 */

import { test } from "node:test";
import assert from "node:assert/strict";

import { DEFAULT_FORM, preparationFingerprint } from "../src/app/form.ts";
import type { FormState } from "../src/app/form.ts";
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
  sectionRebuildTag,
  settingsSummaries,
  showsRebuildLabel,
  isSettingsField,
} from "../src/app/workflowSettings.ts";
import type { SettingsField } from "../src/app/workflowSettings.ts";

/**
 * What the main page owns: the issue, Fix Mode and Hint with its Use issue
 * details (§37.84), the plan's checkboxes, the Fix with AI box.
 */
const MAIN_PAGE_FIELDS = ["source", "issueKey", "description", "fixModeId", "hint", "useIssueDetails", "plan", "fixWithAI"];

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
  // Every section but the shared inputs, Repository, AI instructions and
  // Branch is one step's, in the workflow's order.
  assert.deepEqual(
    Object.values(SETTINGS_SECTION_OF_STEP),
    WORKFLOW_SETTINGS_SECTIONS.filter(
      (section) => section !== "retrieval-inputs" && section !== "repository" && section !== "ai-instructions" && section !== "branch",
    ),
  );
  // Git history has a gear, and Similar fixes too since §37.113; Fix result
  // has nothing to configure and none.
  assert.equal(SETTINGS_SECTION_OF_STEP.gitHistory, "git-history");
  assert.equal(SETTINGS_SECTION_OF_STEP.similarFixes, "similar-fixes");
  assert.equal(SETTINGS_SECTION_OF_STEP.fixResult, undefined);
  for (const [step, section] of Object.entries(SETTINGS_SECTION_OF_STEP)) {
    assert.equal(SETTINGS_SECTION_TITLES[section], STEP_LABELS[step as keyof typeof STEP_LABELS]);
  }
});

test("the page's sections, in order: the shared inputs just before the retrieval steps that read them (§37.113)", () => {
  assert.deepEqual(
    [...WORKFLOW_SETTINGS_SECTIONS],
    ["issue-details", "retrieval-inputs", "code-search", "git-history", "similar-fixes", "repository", "ai-instructions", "build-context", "fix-with-ai", "branch"],
  );
  // AI instructions (pre-release Batch 2) holds a document edited on its own
  // page, and since Batch 3 the Verification Policy's four switches: all of it
  // task.md's, so wholly "Requires rebuild".
  assert.deepEqual([...SETTINGS_SECTION_FIELDS["ai-instructions"]], ["verifyRelevantTests", "verifyStaticChecks", "verifyFullSuite", "verifyReportNotRun"]);
  assert.deepEqual([...SETTINGS_SECTION_FIELDS.branch], ["branchPolicy", "branchNaming", "branchTemplate"]);
  assert.equal(SETTINGS_SECTION_TITLES["ai-instructions"], "AI instructions");
  assert.equal(SETTINGS_SECTION_TITLES["retrieval-inputs"], "Retrieval inputs");
  // One Keywords and one Focus files, shared, and no row's gear opens them.
  assert.deepEqual([...SETTINGS_SECTION_FIELDS["retrieval-inputs"]], ["keywords", "focusFiles"]);
  assert.equal(Object.values(SETTINGS_SECTION_OF_STEP).includes("retrieval-inputs" as never), false);
  // Code search keeps only its own: no Keywords, no Focus files, no switch for them.
  assert.deepEqual([...SETTINGS_SECTION_FIELDS["code-search"]], ["ignorePaths", "maxFiles", "maxSearchLines"]);
  assert.equal(sectionOfField("keywords"), "retrieval-inputs");
  assert.equal(sectionOfField("focusFiles"), "retrieval-inputs");
  // Git history's structure is unchanged.
  assert.deepEqual([...SETTINGS_SECTION_FIELDS["git-history"]], [
    "gitUseSharedKeywords",
    "gitUseSharedFocusFiles",
    "gitKeywords",
    "gitFiles",
    "gitSearchMessages",
    "gitSearchFileHistory",
    "gitHistoryDepth",
    "gitMaxCommits",
  ]);
  // Similar fixes: exactly its three, and no Focus files switch.
  assert.deepEqual([...SETTINGS_SECTION_FIELDS["similar-fixes"]], ["similarUseSharedKeywords", "similarKeywords", "similarMaxFixes"]);
});

/** A changed value for each settings field. */
const CHANGED: Readonly<Record<SettingsField, Partial<FormState>>> = {
  title: { title: "Crash on save" },
  attachments: { attachments: ["/logs/crash.txt"] },
  attachmentDescriptions: { attachmentDescriptions: { "/logs/crash.txt": "Console output after Save." } },
  keywords: { keywords: "VolumeDescriptor" },
  focusFiles: { focusFiles: "src/a.ts" },
  ignorePaths: { ignorePaths: "build/" },
  maxFiles: { maxFiles: "5" },
  maxSearchLines: { maxSearchLines: "100" },
  fresh: { fresh: true },
  agent: { agent: "claude-cli" },
  agentCommand: { agentCommand: "my-agent {prompt}" },
  gitUseSharedKeywords: { gitUseSharedKeywords: false },
  gitUseSharedFocusFiles: { gitUseSharedFocusFiles: false },
  gitKeywords: { gitKeywords: "blendmerge" },
  gitFiles: { gitFiles: "src/legacy/" },
  gitSearchMessages: { gitSearchMessages: false },
  gitSearchFileHistory: { gitSearchFileHistory: false },
  gitHistoryDepth: { gitHistoryDepth: "broader" },
  gitMaxCommits: { gitMaxCommits: "5" },
  similarUseSharedKeywords: { similarUseSharedKeywords: false },
  similarKeywords: { similarKeywords: "legacyexporter" },
  similarMaxFixes: { similarMaxFixes: "2" },
  branchPolicy: { branchPolicy: "per-issue" },
  // The Repository Profile and every Custom detail are written into task.md.
  repositoryProfile: { repositoryProfile: "generic" },
  repositoryLanguages: { repositoryLanguages: "Rust" },
  repositoryFrameworks: { repositoryFrameworks: "Tokio" },
  repositoryApplicationType: { repositoryApplicationType: "Command-line tool" },
  repositoryBuildSystem: { repositoryBuildSystem: "Cargo" },
  repositoryTestFramework: { repositoryTestFramework: "cargo test" },
  repositoryNotes: { repositoryNotes: "No unsafe code." },
  // The project settings (Batch 3): the Verification Policy is a section of
  // task.md, and a template names the branch — used only while Custom is chosen.
  verifyRelevantTests: { verifyRelevantTests: false },
  verifyStaticChecks: { verifyStaticChecks: false },
  verifyFullSuite: { verifyFullSuite: true },
  verifyReportNotRun: { verifyReportNotRun: false },
  branchNaming: { branchNaming: "custom", branchTemplate: "fix/{issue}" },
  branchTemplate: { branchNaming: "custom", branchTemplate: "bugfix/{issue}-{slug}" },
};

test("the page's 'requires rebuild' words are the host's staleness rule, field by field", () => {
  // The labels are derived from SETTING_REQUIRES_REBUILD; the host decides
  // staleness from the fingerprint. This is what keeps the two the same rule.
  const jira = { ...DEFAULT_FORM, issueKey: "JR-1" };
  const manual: FormState = { ...DEFAULT_FORM, source: "manual", description: "It crashes." };
  for (const field of Object.keys(CHANGED) as SettingsField[]) {
    // Title only reaches a run for a hand-written bug, as on the command line;
    // a description only describes a file that is attached, the same in both.
    const base =
      field === "title" ? manual : field === "attachmentDescriptions" ? { ...jira, attachments: ["/logs/crash.txt"] } : jira;
    const moved = preparationFingerprint({ ...base, ...CHANGED[field] }) !== preparationFingerprint(base);
    assert.equal(moved, SETTING_REQUIRES_REBUILD[field], `${field}: the label and the fingerprint disagree`);
  }
});

test("a section says once whether its changes need a rebuild; no section is mixed any more", () => {
  assert.equal(sectionRebuildNote("issue-details"), "Changes here require rebuilding context.");
  assert.equal(sectionRebuildNote("retrieval-inputs"), "Changes here require rebuilding context.");
  assert.equal(sectionRebuildNote("code-search"), "Changes here require rebuilding context.");
  assert.equal(sectionRebuildNote("git-history"), "Changes here require rebuilding context.");
  assert.equal(sectionRebuildNote("similar-fixes"), "Changes here require rebuilding context.");
  assert.equal(sectionRebuildNote("build-context"), "Changes here apply to the next run and do not require rebuilding context.");
  // The agent and its command: which agent, never what it is given.
  assert.equal(sectionRebuildNote("fix-with-ai"), "Changes here apply to the next run and do not require rebuilding context.");
  const labelled = (Object.keys(CHANGED) as SettingsField[]).filter(showsRebuildLabel);
  assert.deepEqual(labelled, [], `a setting carries its own ${REQUIRES_REBUILD_LABEL} label`);
});

test("a section's tag says in a few words what its sentence says, from the same table", () => {
  // The tag beside each heading (Advanced Settings simplification) and the
  // sentence that is its tooltip can never disagree: both read
  // SETTING_REQUIRES_REBUILD, and the fingerprint test above holds that table to
  // what actually makes a context stale.
  for (const section of WORKFLOW_SETTINGS_SECTIONS) {
    const rebuilds = SETTINGS_SECTION_FIELDS[section].every((field) => SETTING_REQUIRES_REBUILD[field]);
    assert.equal(sectionRebuildTag(section), rebuilds ? "Requires rebuild" : "Next run only", section);
    assert.equal(sectionRebuildNote(section) === "Changes here require rebuilding context.", rebuilds, section);
    // Short enough to sit beside a heading in a 200px sidebar.
    assert.ok(sectionRebuildTag(section).length <= 16, sectionRebuildTag(section));
  }
});

test("Fix Mode and Hint left the settings page, and still make a prepared context stale exactly as before", () => {
  for (const field of ["fixModeId", "hint", "useIssueDetails"]) {
    assert.equal(isSettingsField(field), false, `${field} is still a settings field`);
    assert.equal(WORKFLOW_SETTINGS_SECTIONS.some((section) => (SETTINGS_SECTION_FIELDS[section] as readonly string[]).includes(field)), false);
  }
  assert.deepEqual([...SETTINGS_SECTION_FIELDS["fix-with-ai"]], ["agent", "agentCommand"]);
  // The rule is the fingerprint's, unchanged: a mode or a hint changes what is
  // prepared; what the hint improver may read does not.
  const base = { ...DEFAULT_FORM, issueKey: "JR-1" };
  assert.notEqual(preparationFingerprint({ ...base, fixModeId: "conservative" }), preparationFingerprint(base));
  assert.notEqual(preparationFingerprint({ ...base, hint: "look at the controller" }), preparationFingerprint(base));
  assert.equal(preparationFingerprint({ ...base, useIssueDetails: false }), preparationFingerprint(base));
});

test("defaults summarize to nothing — not the mode or the hint, which are on the main page, nor Auto-detect (§37.108)", () => {
  assert.deepEqual(settingsSummaries({ ...DEFAULT_FORM, fixModeId: "standard" }), {});
  assert.deepEqual(settingsSummaries({ ...DEFAULT_FORM, fixModeId: "conservative", hint: "check the reader" }), {});
  // An agent the developer chose is not the default, and is named.
  assert.deepEqual(settingsSummaries({ ...DEFAULT_FORM, agent: "claude-cli" }), { fixWithAI: "Claude CLI" });
  assert.deepEqual(settingsSummaries({ ...DEFAULT_FORM, agent: "custom", agentCommand: "my-agent {prompt}" }), {
    fixWithAI: "Custom agent command",
  });
  assert.equal(JSON.stringify(settingsSummaries(DEFAULT_FORM)).includes("Auto-detected"), false);
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
      agent: "claude-cli",
      fixModeId: "conservative",
      hint: "check the reader",
    },
  );
  assert.deepEqual(summaries, {
    issueDetails: "2 attachments",
    codeSearch: "3 keywords · 1 focus path · 2 ignored paths · max 10 files · max 1 search line",
    buildContext: "Deletes previous artifacts first",
    fixWithAI: "Claude CLI",
  });
  // A limit the run would reject is not reported as one.
  assert.equal(settingsSummaries({ ...DEFAULT_FORM, maxFiles: "abc", maxSearchLines: "0" }).codeSearch, undefined);
});

test("Similar fixes' summary: its own keywords counted, the switch when off, the count when set", () => {
  assert.equal(settingsSummaries(DEFAULT_FORM).similarFixes, undefined);
  assert.equal(
    settingsSummaries({ ...DEFAULT_FORM, similarKeywords: "LegacyExporter, export crash, LegacyExporter", similarUseSharedKeywords: false, similarMaxFixes: "2" })
      .similarFixes,
    "2 additional keywords · shared keywords off · max 2 similar fixes",
  );
  assert.equal(settingsSummaries({ ...DEFAULT_FORM, similarMaxFixes: "1" }).similarFixes, "max 1 similar fix");
  // A count the run would reject is not reported as one.
  assert.equal(settingsSummaries({ ...DEFAULT_FORM, similarMaxFixes: "abc" }).similarFixes, undefined);
  // The shared Keywords are counted where they are always used, Code search,
  // and never a second time on Similar fixes' row; its words are never shown.
  const shared = settingsSummaries({ ...DEFAULT_FORM, keywords: "OpenCSV", similarKeywords: "s3cretTerm" });
  assert.equal(shared.codeSearch, "1 keyword");
  assert.equal(shared.similarFixes, "1 additional keyword");
  assert.doesNotMatch(JSON.stringify(shared), /OpenCSV|s3cretTerm/);
});

test("a custom agent is summarized by kind, never by its command", () => {
  const summary = settingsSummaries({ ...DEFAULT_FORM, agent: "custom", agentCommand: "C:/tools/agent.exe --key s3cret {prompt}" });
  assert.equal(summary.fixWithAI, "Custom agent command");
  assert.doesNotMatch(JSON.stringify(summary), /tools|s3cret|agent\.exe/);
});
