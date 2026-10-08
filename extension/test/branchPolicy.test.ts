/**
 * The branch policy (§37.127), extension side: the form field, what it puts on
 * the command line, how an old saved form and an untrusted page message read
 * it, the settings page's Branch section and its copy of the model, and the
 * Fix with AI row's summary. What the policy tells the agent is the CLI's, in
 * `tests/test_branch_policy.py`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  BRANCH_POLICIES,
  DEFAULT_FORM,
  branchPolicyOf,
  buildPrepareArgs,
  preparationFingerprint,
  restoreForm,
} from "../src/app/form.ts";
import type { FormState } from "../src/app/form.ts";
import { FORM_FIELD_SCOPE, resetSessionForm } from "../src/app/sessionReset.ts";
import {
  SETTINGS_SECTION_FIELDS,
  SETTINGS_SECTION_OF_STEP,
  SETTINGS_SECTION_TITLES,
  SETTING_REQUIRES_REBUILD,
  WORKFLOW_SETTINGS_SECTIONS,
  sectionRebuildTag,
  settingsSummaries,
} from "../src/app/workflowSettings.ts";
import { panelHtml } from "../src/panel/html.ts";
import { parsePanelMessage } from "../src/panel/messages.ts";

const OPTIONS = { root: "/work/app", platform: "linux" } as const;
const PAGE_JS = readFileSync(new URL("../media/panel.js", import.meta.url), "utf8");
const POLICY_PY = readFileSync(new URL("../../bugpilot/core/branch_policy.py", import.meta.url), "utf8");
const HTML = panelHtml({ nonce: "n", cspSource: "c", styleUri: "s", scriptUri: "j", codiconUri: "i" });

function form(overrides: Partial<FormState> = {}): FormState {
  return { ...DEFAULT_FORM, issueKey: "JR-12345", ...overrides };
}

function argsOf(state: FormState): readonly string[] {
  const result = buildPrepareArgs(state, OPTIONS);
  assert.equal(result.ok, true, JSON.stringify(result));
  return result.ok ? result.args : [];
}

test("three policies, the CLI's own, and the current branch is the default", () => {
  assert.deepEqual([...BRANCH_POLICIES], ["current", "per-issue", "ask"]);
  assert.equal(DEFAULT_FORM.branchPolicy, "current");
  // The same three, in the same order, as the CLI's module says.
  const python = /BRANCH_POLICIES: tuple\[str, \.\.\.\] = \(([^)]*)\)/.exec(POLICY_PY)?.[1] ?? "";
  const names: Record<string, string> = { BRANCH_POLICY_CURRENT: "current", BRANCH_POLICY_PER_ISSUE: "per-issue", BRANCH_POLICY_ASK: "ask" };
  assert.deepEqual(python.split(",").map((name) => names[name.trim()]), [...BRANCH_POLICIES]);
  assert.match(POLICY_PY, /DEFAULT_BRANCH_POLICY = BRANCH_POLICY_CURRENT/);
  // And the page's copy.
  assert.match(PAGE_JS, /const BRANCH_POLICIES = \["current", "per-issue", "ask"\];/);
});

test("every run names its policy — the default too — since a resume would otherwise keep the last one", () => {
  const flagOf = (args: readonly string[]) => args.filter((arg) => arg.startsWith("--branch-policy"));
  assert.deepEqual(flagOf(argsOf(form())), ["--branch-policy=current"]);
  assert.deepEqual(flagOf(argsOf(form({ branchPolicy: "per-issue" }))), ["--branch-policy=per-issue"]);
  assert.deepEqual(flagOf(argsOf(form({ branchPolicy: "ask" }))), ["--branch-policy=ask"]);
  // A hand-written bug carries it as well.
  assert.deepEqual(flagOf(argsOf(form({ source: "manual", issueKey: "", description: "It crashes.", branchPolicy: "ask" }))), [
    "--branch-policy=ask",
  ]);
  // Anything else is the default, never passed through.
  assert.deepEqual(flagOf(argsOf(form({ branchPolicy: "sideways" as never }))), ["--branch-policy=current"]);
});

test("an older saved form, or a page message, that says nothing or nonsense reads as the default", () => {
  const { branchPolicy: _dropped, ...older } = form();
  assert.equal(restoreForm(older as FormState).branchPolicy, "current");
  assert.equal(restoreForm(form({ branchPolicy: "ask" })).branchPolicy, "ask");
  assert.equal(branchPolicyOf("per-issue"), "per-issue");
  assert.equal(branchPolicyOf("PER-ISSUE"), "current");
  assert.equal(branchPolicyOf(undefined), "current");
  const parsed = (branchPolicy: unknown) => {
    const message = parsePanelMessage({ type: "formChanged", form: { ...form(), branchPolicy } });
    assert.ok(message && message.type === "formChanged");
    return message.form.branchPolicy;
  };
  assert.equal(parsed("ask"), "ask");
  assert.equal(parsed("git checkout main"), "current");
  assert.equal(parsed(42), "current");
});

test("changing it makes a prepared context stale: task.md says it", () => {
  assert.equal(SETTING_REQUIRES_REBUILD.branchPolicy, true);
  assert.notEqual(preparationFingerprint(form({ branchPolicy: "per-issue" })), preparationFingerprint(form()));
  assert.notEqual(preparationFingerprint(form({ branchPolicy: "ask" })), preparationFingerprint(form({ branchPolicy: "per-issue" })));
});

test("the Branch section: last, its own, no row's gear, and wholly 'Requires rebuild'", () => {
  assert.equal(WORKFLOW_SETTINGS_SECTIONS.at(-1), "branch");
  assert.equal(SETTINGS_SECTION_TITLES.branch, "Branch");
  // Branch naming is the same section: both name what task.md says about branches.
  assert.deepEqual([...SETTINGS_SECTION_FIELDS.branch], ["branchPolicy", "branchNaming", "branchTemplate"]);
  // Not mixed into Fix with AI, whose agent settings need no rebuild.
  assert.deepEqual([...SETTINGS_SECTION_FIELDS["fix-with-ai"]], ["agent", "agentCommand"]);
  assert.equal(sectionRebuildTag("branch"), "Requires rebuild");
  assert.equal(sectionRebuildTag("fix-with-ai"), "Next run only");
  assert.equal(Object.values(SETTINGS_SECTION_OF_STEP).includes("branch" as never), false);
  // The page's copy of the section.
  assert.match(PAGE_JS, /branch: \{ fields: \["branchPolicy", "branchNaming", "branchTemplate"\], focus: \["branchPolicy"\] \},/);
});

test("the page offers the three by name, the default first and recommended, what each means on hover", () => {
  const section = /<section class="settings-section" id="settings-section-branch"[\s\S]*?<\/section>/.exec(HTML)?.[0] ?? "";
  assert.notEqual(section, "", "no Branch section");
  assert.match(section, /<h3 class="settings-section-title" id="settings-title-branch"[^>]*>Branch<\/h3>/);
  // The field says what it is, under a heading that says where: not "Branch" twice.
  assert.match(section, /<label for="branchPolicy"[^>]*>[\s\S]*?Branch policy<\/label>/);
  const policy = /<select id="branchPolicy"[\s\S]*?<\/select>/.exec(section)?.[0] ?? "";
  const options = [...policy.matchAll(/<option value="([^"]+)" title="([^"]+)">([^<]+)<\/option>/g)].map((match) => [
    match[1],
    match[3],
    match[2],
  ]);
  // Each option's meaning is its own tooltip.
  assert.deepEqual(options, [
    ["current", "Use current branch (Recommended)", "Work on the checked-out branch and do not create or switch branches."],
    ["per-issue", "One branch per issue", "Create or reuse one branch for the issue."],
    ["ask", "Ask before editing", "Ask whether to stay on the current branch or create/switch before editing."],
  ]);
  // What the field is for, and what each option means, as the select's tooltip
  // and description — never a line on screen.
  const help =
    "Choose which branch the AI agent edits and commits on. Main and master are always protected. " +
    "Use current branch: Work on the checked-out branch and do not create or switch branches. " +
    "One branch per issue: Create or reuse one branch for the issue. " +
    "Ask before editing: Ask whether to stay on the current branch or create/switch before editing.";
  assert.ok(section.includes(`<select id="branchPolicy" name="branchPolicy" title="${help}" aria-describedby="branchPolicy-hint">`));
  assert.ok(section.includes(`<p class="visually-hidden" id="branchPolicy-hint">${help}</p>`));
  // Read, written and disabled with the other settings.
  assert.match(PAGE_JS, /settings\.branchPolicy = branchPolicyOf\(byId\("branchPolicy"\)\.value\);/);
  assert.match(PAGE_JS, /settings\.branchPolicy = branchPolicyOf\(form\.branchPolicy\);/);
  assert.match(PAGE_JS, /byId\("branchPolicy"\)\.value = branchPolicyOf\(settings\.branchPolicy\);/);
  assert.match(PAGE_JS, /byId\("branchPolicy"\)\.disabled = !enabled;/);
});

test("the Branch section fits a narrow sidebar: full-width fields one under another, nothing that sets a width", () => {
  const section = /<section class="settings-section" id="settings-section-branch"[\s\S]*?<\/section>/.exec(HTML)?.[0] ?? "";
  // Fields one under another, each select under its label — no row that would need side-by-side
  // room: the policy, Branch naming, and the Template field Custom template shows (hidden until then).
  assert.equal((section.match(/<div class="field"/g) ?? []).length, 3);
  assert.equal((section.match(/<select /g) ?? []).length, 2);
  assert.match(section, /<div class="field" id="field-branchTemplate" hidden>/);
  assert.doesNotMatch(section, /style="/);
  // Every select is as wide as its column, never wider…
  const css = readFileSync(new URL("../media/panel.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  assert.match(css, /textarea,\s*select \{\s*width: 100%;\s*box-sizing: border-box;/);
  // …and no rule gives this one a width of its own.
  assert.doesNotMatch(css, /#branchPolicy|field-branchPolicy|#branchNaming|field-branchNaming|#branchTemplate|field-branchTemplate|settings-section-branch/);
  // A choice longer than a narrow box ends in an ellipsis, not under the arrow.
  assert.match(css, /#workflow-settings-view select \{\s*overflow: hidden;\s*text-overflow: ellipsis;\s*white-space: nowrap;\s*\}/);
});

test("the Fix with AI row says the policy only when it is not the default", () => {
  assert.equal(settingsSummaries(form()).fixWithAI, undefined);
  assert.equal(settingsSummaries(form({ branchPolicy: "per-issue" })).fixWithAI, "one branch per issue");
  assert.equal(settingsSummaries(form({ branchPolicy: "ask" })).fixWithAI, "asks which branch");
  assert.equal(settingsSummaries(form({ agent: "claude-cli", branchPolicy: "per-issue" })).fixWithAI, "Claude CLI · one branch per issue");
});

test("Reset Session keeps it: it is how the developer works, not this issue", () => {
  assert.equal(FORM_FIELD_SCOPE.branchPolicy, "preference");
  assert.equal(resetSessionForm(form({ branchPolicy: "ask" }), "standard").branchPolicy, "ask");
});
