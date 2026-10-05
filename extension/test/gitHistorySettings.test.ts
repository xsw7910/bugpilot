/**
 * Git History Settings (Git History Retrieval v2, Batch 2), extension side:
 * the form fields, what they put on the command line, how an old saved form
 * reads them, the page's section and its copy of the model, and what the log
 * may show. The host's staleness rule for them is in `controller.test.ts`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEFAULT_FORM,
  GIT_HISTORY_DEPTHS,
  GIT_MAX_COMMITS_LIMIT,
  buildPrepareArgs,
  gitHistoryDepthOf,
  preparationFingerprint,
  restoreForm,
} from "../src/app/form.ts";
import type { FormState } from "../src/app/form.ts";
import { commandForLog } from "../src/app/logSafety.ts";
import { SETTINGS_SECTION_FIELDS, settingsSummaries } from "../src/app/workflowSettings.ts";
import { panelHtml } from "../src/panel/html.ts";
import { parsePanelMessage } from "../src/panel/messages.ts";

const OPTIONS = { root: "/work/app", platform: "linux" } as const;

/** The Git History Settings fields, by kind. */
const GIT_SWITCH_FIELDS = ["gitUseSharedKeywords", "gitUseSharedFocusFiles", "gitSearchMessages", "gitSearchFileHistory"] as const;

function form(overrides: Partial<FormState> = {}): FormState {
  return { ...DEFAULT_FORM, issueKey: "JR-12345", ...overrides };
}

function argsOf(state: FormState): readonly string[] {
  const result = buildPrepareArgs(state, OPTIONS);
  assert.equal(result.ok, true, `expected a valid form, got ${JSON.stringify(result)}`);
  return result.ok ? result.args : [];
}

const gitFlags = (args: readonly string[]) => args.filter((arg) => arg.startsWith("--git-"));

const HTML = panelHtml({
  nonce: "N0NCE",
  cspSource: "vscode-webview://abc",
  styleUri: "vscode-webview://abc/media/panel.css",
  scriptUri: "vscode-webview://abc/media/panel.js",
  codiconUri: "vscode-webview://abc/media/codicons/codicon.css",
});
const SECTION =
  /<section class="settings-section" id="settings-section-git-history"[\s\S]*?\n {4}<\/section>/.exec(HTML)?.[0] ?? "";
const PAGE_JS = readFileSync(new URL("../media/panel.js", import.meta.url), "utf8");
const CSS = readFileSync(new URL("../media/panel.css", import.meta.url), "utf8");
const MODELS_PY = readFileSync(new URL("../../bugpilot/core/models.py", import.meta.url), "utf8");

// --- defaults are Batch 1 ----------------------------------------------------------

test("the defaults are Batch 1's: every switch on, nothing added, recent, the CLI's count", () => {
  for (const field of GIT_SWITCH_FIELDS) assert.equal(DEFAULT_FORM[field], true, field);
  assert.equal(DEFAULT_FORM.gitKeywords, "");
  assert.equal(DEFAULT_FORM.gitFiles, "");
  assert.equal(DEFAULT_FORM.gitHistoryDepth, "recent");
  assert.equal(DEFAULT_FORM.gitMaxCommits, "");
});

test("a form at the defaults sends no Git flag: the command line is Batch 1's", () => {
  assert.deepEqual(gitFlags(argsOf(form())), []);
  assert.deepEqual(gitFlags(argsOf(form({ keywords: "poststack", focusFiles: "src/a.cpp" }))), []);
});

test("the depths and the count's ceiling are the CLI's", () => {
  const depths = /GIT_HISTORY_DEPTHS: tuple\[str, \.\.\.\] = \(([^)]*)\)/.exec(MODELS_PY)?.[1] ?? "";
  assert.deepEqual([...depths.matchAll(/"([a-z]+)"/g)].map((match) => match[1]), [...GIT_HISTORY_DEPTHS]);
  assert.match(MODELS_PY, new RegExp(`^MAX_RELATED_COMMITS_LIMIT = ${GIT_MAX_COMMITS_LIMIT}$`, "m"));
});

// --- each setting, on the command line ------------------------------------------------

test("each setting becomes its own flag, and only when it differs from the default", () => {
  const args = argsOf(
    form({
      gitUseSharedKeywords: false,
      gitUseSharedFocusFiles: false,
      gitKeywords: "stackmerge, gather order\nstackmerge",
      gitFiles: "src/legacy/\nAngleStack.cpp",
      gitSearchMessages: false,
      gitSearchFileHistory: false,
      gitHistoryDepth: "broader",
      gitMaxCommits: " 7 ",
    }),
  );
  assert.deepEqual(gitFlags(args), [
    "--git-file=src/legacy/",
    "--git-file=AngleStack.cpp",
    "--git-keyword=stackmerge",
    "--git-keyword=gather order",
    "--git-no-shared-keywords",
    "--git-no-shared-focus-files",
    "--git-no-commit-search",
    "--git-no-file-history",
    "--git-history-depth=broader",
    "--git-max-commits=7",
  ]);
});

test("every Git flag the panel builds is one the CLI declares", () => {
  const cli = readFileSync(new URL("../../bugpilot/cli.py", import.meta.url), "utf8");
  const args = argsOf(
    form({
      gitUseSharedKeywords: false,
      gitUseSharedFocusFiles: false,
      gitKeywords: "x1y2",
      gitFiles: "src/a.cpp",
      gitSearchMessages: false,
      gitSearchFileHistory: false,
      gitHistoryDepth: "broader",
      gitMaxCommits: "3",
    }),
  );
  const flags = [...new Set(gitFlags(args).map((arg) => arg.split("=")[0]!))];
  assert.equal(flags.length, 8);
  for (const name of flags) {
    assert.match(cli, new RegExp(`add_argument\\(\\s*"${name}"`), `${name} is not declared in bugpilot/cli.py`);
  }
});

test("Git history's own inputs never reach Code search's flags", () => {
  const args = argsOf(form({ keywords: "poststack", focusFiles: "src/Focus.cpp", gitKeywords: "stackmerge", gitFiles: "src/Legacy.cpp" }));
  const values = (name: string) => args.filter((arg) => arg.startsWith(`${name}=`)).map((arg) => arg.slice(name.length + 1));
  assert.deepEqual(values("--keywords"), ["poststack"]);
  assert.deepEqual(values("--focus-file"), ["src/Focus.cpp"]);
  assert.deepEqual(values("--git-keyword"), ["stackmerge"]);
  assert.deepEqual(values("--git-file"), ["src/Legacy.cpp"]);
  // And turning shared guidance off here leaves Code search's as it was.
  const off = argsOf(form({ keywords: "poststack", focusFiles: "src/Focus.cpp", gitUseSharedKeywords: false, gitUseSharedFocusFiles: false }));
  assert.ok(off.includes("--keywords=poststack"));
  assert.ok(off.includes("--focus-file=src/Focus.cpp"));
});

test("Max related commits must be a whole number from 1 to 25, or empty", () => {
  for (const bad of ["0", "26", "-1", "1.5", "ten", "999999"]) {
    const result = buildPrepareArgs(form({ gitMaxCommits: bad }), OPTIONS);
    assert.equal(result.ok, false, bad);
    if (!result.ok) {
      assert.deepEqual(result.problems.map((problem) => problem.field), ["gitMaxCommits"]);
      assert.match(result.problems[0]!.message, /whole number from 1 to 25/);
    }
  }
  assert.ok(argsOf(form({ gitMaxCommits: "25" })).includes("--git-max-commits=25"));
  assert.ok(argsOf(form({ gitMaxCommits: "1" })).includes("--git-max-commits=1"));
  assert.ok(argsOf(form({ gitMaxCommits: "007" })).includes("--git-max-commits=7"));
});

test("an Additional File follows a Focus File's rule: outside the repository is refused, on its own field", () => {
  const result = buildPrepareArgs(form({ gitFiles: "/elsewhere/x.cpp" }), OPTIONS);
  assert.equal(result.ok, false);
  if (!result.ok) assert.deepEqual(result.problems.map((problem) => problem.field), ["gitFiles"]);
  assert.ok(argsOf(form({ gitFiles: "/work/app/src/x.cpp" })).includes("--git-file=/work/app/src/x.cpp"));
});

test("an unknown depth reads as recent and sends no flag", () => {
  assert.equal(gitHistoryDepthOf("everything"), "recent");
  assert.equal(gitHistoryDepthOf(undefined), "recent");
  assert.equal(gitHistoryDepthOf("broader"), "broader");
  assert.deepEqual(gitFlags(argsOf(form({ gitHistoryDepth: "everything" as never }))), []);
});

// --- persistence ---------------------------------------------------------------------

test("a form saved before the Git History Settings restores with their defaults", () => {
  const legacy = { ...DEFAULT_FORM, issueKey: "JR-12345", keywords: "poststack" } as Partial<FormState>;
  for (const key of [...GIT_SWITCH_FIELDS, "gitKeywords", "gitFiles", "gitHistoryDepth", "gitMaxCommits"] as const) {
    delete legacy[key];
  }

  const restored = restoreForm(legacy as FormState);

  for (const field of GIT_SWITCH_FIELDS) assert.equal(restored[field], true, field);
  assert.equal(restored.gitKeywords, "");
  assert.equal(restored.gitFiles, "");
  assert.equal(restored.gitHistoryDepth, "recent");
  assert.equal(restored.gitMaxCommits, "");
  // The rest of the old form came back untouched, and runs as it did.
  assert.equal(restored.keywords, "poststack");
  assert.deepEqual(gitFlags(argsOf(restored)), []);
});

test("saved Git History Settings survive a restart, Additional keywords and files included", () => {
  const saved = form({
    gitUseSharedKeywords: false,
    gitKeywords: "stackmerge, ångström",
    gitFiles: "src/legacy/\nAngleStack.cpp",
    gitSearchFileHistory: false,
    gitHistoryDepth: "broader",
    gitMaxCommits: "5",
  });
  // A workspaceState round trip is JSON.
  const restored = restoreForm(JSON.parse(JSON.stringify(saved)) as FormState);
  assert.deepEqual(restored, saved);
  assert.equal(preparationFingerprint(restored), preparationFingerprint(saved));
});

test("a stored value of the wrong type reads as the default", () => {
  const tampered = { ...form(), gitHistoryDepth: 3, gitKeywords: 42, gitFiles: null, gitMaxCommits: {}, gitSearchMessages: "no" };
  const restored = restoreForm(tampered as unknown as FormState);
  assert.equal(restored.gitHistoryDepth, "recent");
  assert.equal(restored.gitKeywords, "");
  assert.equal(restored.gitFiles, "");
  assert.equal(restored.gitMaxCommits, "");
  // Only an explicit false turns a route off.
  assert.equal(restored.gitSearchMessages, true);
});

// --- the page's message ------------------------------------------------------------------

test("a page message carries the Git History Settings, shape-checked", () => {
  const message = parsePanelMessage({
    type: "applySettings",
    form: {
      ...form(),
      gitUseSharedKeywords: false,
      gitSearchFileHistory: false,
      gitKeywords: "stackmerge",
      gitFiles: "src/legacy/",
      gitHistoryDepth: "broader",
      gitMaxCommits: "7",
    },
  });
  assert.equal(message?.type, "applySettings");
  if (message?.type !== "applySettings") return;
  assert.equal(message.form.gitUseSharedKeywords, false);
  assert.equal(message.form.gitUseSharedFocusFiles, true);
  assert.equal(message.form.gitSearchFileHistory, false);
  assert.equal(message.form.gitKeywords, "stackmerge");
  assert.equal(message.form.gitFiles, "src/legacy/");
  assert.equal(message.form.gitHistoryDepth, "broader");
  assert.equal(message.form.gitMaxCommits, "7");
});

test("a page too old to send them gets the defaults, and a hostile one is capped", () => {
  const old = parsePanelMessage({ type: "run", form: { source: "jira", issueKey: "JR-12345" } });
  assert.equal(old?.type, "run");
  if (old?.type !== "run") return;
  for (const field of GIT_SWITCH_FIELDS) assert.equal(old.form[field], true, field);
  assert.equal(old.form.gitHistoryDepth, "recent");

  const hostile = parsePanelMessage({
    type: "run",
    form: { source: "jira", issueKey: "JR-12345", gitKeywords: "x".repeat(100_000), gitMaxCommits: "9".repeat(1_000), gitHistoryDepth: "all" },
  });
  if (hostile?.type !== "run") return assert.fail("dropped");
  assert.equal(hostile.form.gitKeywords.length, 8_000);
  assert.equal(hostile.form.gitMaxCommits.length, 16);
  assert.equal(hostile.form.gitHistoryDepth, "recent");
});

// --- the log --------------------------------------------------------------------------------

test("the log keeps the depth and the count, and redacts what was typed", () => {
  const line = commandForLog(
    argsOf(form({ gitKeywords: "SECRET_COMMIT_WORD", gitFiles: "src/secret_legacy.cpp", gitHistoryDepth: "broader", gitMaxCommits: "7", gitSearchMessages: false })),
  );
  assert.match(line, / --git-file=<redacted> /);
  assert.match(line, / --git-keyword=<redacted> /);
  assert.match(line, / --git-no-commit-search /);
  assert.match(line, / --git-history-depth=broader /);
  assert.match(line, / --git-max-commits=7 /);
  assert.equal(line.includes("SECRET_COMMIT_WORD"), false);
  assert.equal(line.includes("secret_legacy"), false);
});

// --- the row summary --------------------------------------------------------------------------

test("Git history's summary is counts and switches, never what was typed", () => {
  assert.equal(settingsSummaries(form()).gitHistory, undefined, "a row with default settings said something");
  const summary = settingsSummaries(
    form({
      gitKeywords: "SECRET_A, SECRET_B",
      gitFiles: "src/secret.cpp",
      gitUseSharedKeywords: false,
      gitSearchMessages: false,
      gitHistoryDepth: "broader",
      gitMaxCommits: "5",
    }),
  ).gitHistory;
  assert.equal(summary, "2 commit keywords · 1 additional file · shared keywords off · commit search off · broader history · max 5 commits");
  assert.equal(
    settingsSummaries(form({ gitSearchMessages: false, gitSearchFileHistory: false, gitUseSharedFocusFiles: false })).gitHistory,
    "shared focus files off · both searches off",
  );
});

// --- the page ----------------------------------------------------------------------------------

test("the section holds its eight controls in the model's order, with labels", () => {
  assert.notEqual(SECTION, "", "no Git history section");
  const controls = [...SECTION.matchAll(/<(?:input|textarea|select) [^>]*?\bid="([A-Za-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(controls, [...SETTINGS_SECTION_FIELDS["git-history"]]);
  for (const id of controls) assert.match(SECTION, new RegExp(`<label[^>]*for="${id}"`), `${id} has no label`);
  // Sentence case like every label on the page (Advanced Settings simplification).
  for (const label of [
    "Use shared keywords",
    "Use shared focus files",
    "Additional commit keywords",
    "Additional files",
    "Search commit messages",
    "Search related file history",
    "History depth",
    "Max related commits",
  ]) {
    assert.ok(SECTION.includes(label), label);
  }
});

test("the markup's defaults are the model's: switches ticked, recent first, 10 as the placeholder", () => {
  for (const id of GIT_SWITCH_FIELDS) assert.match(SECTION, new RegExp(`<input type="checkbox" id="${id}"[^>]* checked>`), id);
  const options = [...SECTION.matchAll(/<option value="([a-z]+)">/g)].map((match) => match[1]);
  assert.deepEqual(options, [...GIT_HISTORY_DEPTHS]);
  assert.match(SECTION, /id="gitMaxCommits" name="gitMaxCommits" placeholder="10"/);
  // A numeric text box like Max files: no spinner stealing width at 200px.
  assert.match(SECTION, /<input type="text" inputmode="numeric" id="gitMaxCommits"/);
});

test("the page's copies of the switches and depths are the model's", () => {
  const switches = /const GIT_SWITCHES = \[([^\]]*)\]/.exec(PAGE_JS)?.[1] ?? "";
  assert.deepEqual([...switches.matchAll(/"([A-Za-z]+)"/g)].map((match) => match[1]), [...GIT_SWITCH_FIELDS]);
  const depths = /const GIT_HISTORY_DEPTHS = \[([^\]]*)\]/.exec(PAGE_JS)?.[1] ?? "";
  assert.deepEqual([...depths.matchAll(/"([a-z]+)"/g)].map((match) => match[1]), [...GIT_HISTORY_DEPTHS]);
  // Read, written and disabled with the rest of the settings.
  for (const pattern of [
    /for \(const field of GIT_SWITCHES\) settings\[field\] = byId\(field\)\.checked;/,
    /for \(const field of GIT_SWITCHES\) byId\(field\)\.checked = settings\[field\] !== false;/,
    /for \(const field of GIT_SWITCHES\) byId\(field\)\.disabled = !enabled;/,
    /byId\("gitHistoryDepth"\)\.disabled = !enabled;/,
  ]) {
    assert.match(PAGE_JS, pattern);
  }
});

test("a narrow panel: the section is built only from layouts that wrap", () => {
  // The two side-by-side controls sit in `.limits`, which wraps below ~190px a
  // column; the switches are `.field-check` rows, whose labels may shrink.
  assert.match(SECTION, /<div class="limits">[\s\S]*id="field-gitHistoryDepth"[\s\S]*id="field-gitMaxCommits"/);
  for (const id of GIT_SWITCH_FIELDS) assert.match(SECTION, new RegExp(`<div class="field field-check" id="field-${id}">`));
  assert.match(CSS, /\.limits \{[^}]*flex-wrap: wrap;/s);
  assert.match(CSS, /\.field-check \.setting-header > label \{[^}]*flex: 1 1 auto;[^}]*min-width: 0;/s);
  // "Additional commit keywords" is the one label too long for a 200px
  // sidebar (191px against 182px, measured in the real window): it may wrap.
  assert.match(CSS, /#field-gitKeywords \.setting-header > label \{[^}]*flex: 0 1 auto;[^}]*min-width: 0;/s);
  // Nothing in the section fixes a width.
  assert.equal(/style="|width:/.test(SECTION), false);
});
