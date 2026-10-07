/**
 * Similar Fixes Settings and the shared Retrieval inputs (§37.113), extension
 * side: what each setting puts on the command line — and what it must not —
 * how an old saved form reads them, the page's message, the log, and the
 * constants the CLI checks against. The host's staleness rule for them is in
 * `controller.test.ts`; the page's behaviour in `page.test.ts`.
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  DEFAULT_FORM,
  SIMILAR_MAX_FIXES_DEFAULT,
  SIMILAR_MAX_FIXES_LIMIT,
  buildPrepareArgs,
  preparationFingerprint,
  restoreForm,
} from "../src/app/form.ts";
import type { FormState } from "../src/app/form.ts";
import { commandForLog } from "../src/app/logSafety.ts";
import { parsePanelMessage } from "../src/panel/messages.ts";

const OPTIONS = { root: "/work/app", platform: "linux" } as const;
const MODELS_PY = readFileSync(new URL("../../bugpilot/core/models.py", import.meta.url), "utf8");
const CLI_PY = readFileSync(new URL("../../bugpilot/cli.py", import.meta.url), "utf8");

function form(overrides: Partial<FormState> = {}): FormState {
  return { ...DEFAULT_FORM, issueKey: "JR-12345", ...overrides };
}

function argsOf(state: FormState): readonly string[] {
  const result = buildPrepareArgs(state, OPTIONS);
  assert.equal(result.ok, true, `expected a valid form, got ${JSON.stringify(result)}`);
  return result.ok ? result.args : [];
}

const similarFlags = (args: readonly string[]) =>
  args.filter((arg) => arg.startsWith("--similar-fixes-") || arg.startsWith("--max-similar-fixes"));
const values = (args: readonly string[], name: string) =>
  args.filter((arg) => arg.startsWith(`${name}=`)).map((arg) => arg.slice(name.length + 1));

// --- defaults --------------------------------------------------------------------------

test("the defaults are the step's behaviour before the settings: shared Keywords on, nothing added, five", () => {
  assert.equal(DEFAULT_FORM.similarUseSharedKeywords, true);
  assert.equal(DEFAULT_FORM.similarKeywords, "");
  assert.equal(DEFAULT_FORM.similarMaxFixes, "");
  assert.equal(SIMILAR_MAX_FIXES_DEFAULT, 5);
  assert.equal(SIMILAR_MAX_FIXES_LIMIT, 20);
});

test("the count's default and ceiling are the CLI's", () => {
  assert.match(MODELS_PY, new RegExp(`^DEFAULT_MAX_SIMILAR_FIXES = ${SIMILAR_MAX_FIXES_DEFAULT}$`, "m"));
  assert.match(MODELS_PY, new RegExp(`^MAX_SIMILAR_FIXES_LIMIT = ${SIMILAR_MAX_FIXES_LIMIT}$`, "m"));
});

test("a form at the defaults sends no Similar fixes flag: the command line it always sent", () => {
  assert.deepEqual(similarFlags(argsOf(form())), []);
  assert.deepEqual(similarFlags(argsOf(form({ keywords: "poststack", focusFiles: "src/a.cpp" }))), []);
});

// --- the shared Retrieval inputs ------------------------------------------------------------

test("the shared Keywords go out once, as --keywords, whichever steps use them", () => {
  for (const [gitShared, similarShared] of [[true, true], [false, true], [true, false], [false, false]] as const) {
    const args = argsOf(form({ keywords: "poststack, OpenVDS", gitUseSharedKeywords: gitShared, similarUseSharedKeywords: similarShared }));
    // Code search always: one canonical list, never a copy per step.
    assert.deepEqual(values(args, "--keywords"), ["poststack", "OpenVDS"]);
    // Each step's opt-out is its own flag, and only that.
    assert.equal(args.includes("--git-no-shared-keywords"), !gitShared);
    assert.equal(args.includes("--similar-fixes-no-shared-keywords"), !similarShared);
    // Never re-sent as another step's own keywords.
    assert.deepEqual(values(args, "--git-keyword"), []);
    assert.deepEqual(values(args, "--similar-fixes-keyword"), []);
  }
});

test("the shared Focus files go to Code search and Git history; Similar fixes has no way to read them", () => {
  const args = argsOf(form({ focusFiles: "src/Focus.cpp\nsrc/core/" }));
  assert.deepEqual(values(args, "--focus-file"), ["src/Focus.cpp", "src/core/"]);
  // No Similar fixes flag names a file, and none is sent for them.
  assert.deepEqual(similarFlags(args), []);
  const declared = [...CLI_PY.matchAll(/add_argument\(\s*"(--(?:similar-fixes|max-similar-fixes)[a-z-]*)"/g)].map((match) => match[1]);
  assert.deepEqual(declared.sort(), ["--max-similar-fixes", "--similar-fixes-keyword", "--similar-fixes-no-shared-keywords"]);
  // Git history's own switch still decides for Git history.
  assert.ok(argsOf(form({ focusFiles: "src/Focus.cpp", gitUseSharedFocusFiles: false })).includes("--git-no-shared-focus-files"));
});

// --- each setting, on the command line ------------------------------------------------------

test("each Similar fixes setting becomes its own flag, and only when it differs from the default", () => {
  const args = argsOf(
    form({
      similarUseSharedKeywords: false,
      similarKeywords: " legacyexporter, export crash\nlegacyexporter,, \n",
      similarMaxFixes: " 07 ",
    }),
  );
  // Trimmed, blanks dropped, duplicates removed, in the order typed.
  assert.deepEqual(similarFlags(args), [
    "--similar-fixes-keyword=legacyexporter",
    "--similar-fixes-keyword=export crash",
    "--similar-fixes-no-shared-keywords",
    "--max-similar-fixes=7",
  ]);
});

test("every Similar fixes flag the panel builds is one the CLI declares", () => {
  const args = argsOf(form({ similarUseSharedKeywords: false, similarKeywords: "x1y2", similarMaxFixes: "3" }));
  const flags = [...new Set(similarFlags(args).map((arg) => arg.split("=")[0]!))];
  assert.equal(flags.length, 3);
  for (const name of flags) {
    assert.match(CLI_PY, new RegExp(`add_argument\\(\\s*"${name}"`), `${name} is not declared in bugpilot/cli.py`);
  }
});

test("Additional keywords are Similar fixes' alone: never Code search's, never Git history's, never the shared list", () => {
  const args = argsOf(form({ keywords: "poststack", gitKeywords: "stackmerge", similarKeywords: "legacyexporter" }));
  assert.deepEqual(values(args, "--keywords"), ["poststack"]);
  assert.deepEqual(values(args, "--git-keyword"), ["stackmerge"]);
  assert.deepEqual(values(args, "--similar-fixes-keyword"), ["legacyexporter"]);
  // And Git history's never reach Similar fixes.
  assert.equal(values(args, "--similar-fixes-keyword").includes("stackmerge"), false);
});

test("Max similar fixes must be a whole number from 1 to 20, or empty", () => {
  for (const bad of ["0", "21", "-1", "1.5", "five", "999999"]) {
    const result = buildPrepareArgs(form({ similarMaxFixes: bad }), OPTIONS);
    assert.equal(result.ok, false, bad);
    if (!result.ok) {
      assert.deepEqual(result.problems.map((problem) => problem.field), ["similarMaxFixes"]);
      assert.equal(result.problems[0]!.message, "Enter a whole number from 1 to 20, or leave it empty.");
    }
  }
  assert.ok(argsOf(form({ similarMaxFixes: "1" })).includes("--max-similar-fixes=1"));
  assert.ok(argsOf(form({ similarMaxFixes: "20" })).includes("--max-similar-fixes=20"));
  // Empty is the default, five, and says nothing.
  assert.deepEqual(similarFlags(argsOf(form({ similarMaxFixes: "  " }))), []);
});

test("an unticked Similar fixes is skipped, and its settings still travel with the form", () => {
  const args = argsOf(
    form({ similarKeywords: "legacyexporter", similarMaxFixes: "3", plan: { ...DEFAULT_FORM.plan, similarFixes: false } }),
  );
  assert.ok(args.includes("--skip-similar-fixes"));
  // The CLI skips the step whatever they say; nothing was cleared to get there.
  assert.ok(args.includes("--similar-fixes-keyword=legacyexporter"));
  assert.ok(args.includes("--max-similar-fixes=3"));
});

// --- staleness ----------------------------------------------------------------------------------

test("every Similar fixes setting, and each shared input, changes what a context was prepared from", () => {
  const base = form();
  for (const change of [
    { similarUseSharedKeywords: false },
    { similarKeywords: "legacyexporter" },
    { similarMaxFixes: "2" },
    { keywords: "poststack" },
    { focusFiles: "src/a.cpp" },
  ]) {
    assert.notEqual(preparationFingerprint({ ...base, ...change }), preparationFingerprint(base), JSON.stringify(change));
  }
  // Whitespace a run would ignore does not.
  assert.equal(preparationFingerprint(form({ similarKeywords: " a,\n a " })), preparationFingerprint(form({ similarKeywords: "a" })));
  assert.equal(preparationFingerprint(form({ similarMaxFixes: " 3 " })), preparationFingerprint(form({ similarMaxFixes: "3" })));
});

// --- persistence -----------------------------------------------------------------------------

test("a form saved before the Similar Fixes Settings restores with their defaults", () => {
  const legacy: Record<string, unknown> = { ...form(), keywords: "poststack" };
  for (const key of ["similarUseSharedKeywords", "similarKeywords", "similarMaxFixes"]) delete legacy[key];

  const restored = restoreForm(legacy as unknown as FormState);

  assert.equal(restored.similarUseSharedKeywords, true);
  assert.equal(restored.similarKeywords, "");
  assert.equal(restored.similarMaxFixes, "");
  assert.equal(restored.keywords, "poststack");
  assert.deepEqual(similarFlags(argsOf(restored)), []);
});

test("saved Similar Fixes Settings survive a restart; a stored value of the wrong type reads as the default", () => {
  const saved = form({ similarUseSharedKeywords: false, similarKeywords: "legacyexporter, ångström", similarMaxFixes: "2" });
  const restored = restoreForm(JSON.parse(JSON.stringify(saved)) as FormState);
  assert.deepEqual(restored, saved);

  const tampered = restoreForm({ ...form(), similarUseSharedKeywords: "no", similarKeywords: 42, similarMaxFixes: {} } as unknown as FormState);
  // Only an explicit false turns the shared Keywords off.
  assert.equal(tampered.similarUseSharedKeywords, true);
  assert.equal(tampered.similarKeywords, "");
  assert.equal(tampered.similarMaxFixes, "");
});

// --- the page's message ----------------------------------------------------------------------

test("a page message carries the Similar Fixes Settings, shape-checked and capped", () => {
  const message = parsePanelMessage({
    type: "applySettings",
    form: { ...form(), similarUseSharedKeywords: false, similarKeywords: "legacyexporter", similarMaxFixes: "2" },
  });
  if (message?.type !== "applySettings") return assert.fail("dropped");
  assert.equal(message.form.similarUseSharedKeywords, false);
  assert.equal(message.form.similarKeywords, "legacyexporter");
  assert.equal(message.form.similarMaxFixes, "2");

  const old = parsePanelMessage({ type: "run", form: { source: "jira", issueKey: "JR-12345" } });
  if (old?.type !== "run") return assert.fail("dropped");
  assert.equal(old.form.similarUseSharedKeywords, true);
  assert.equal(old.form.similarKeywords, "");
  assert.equal(old.form.similarMaxFixes, "");

  const hostile = parsePanelMessage({
    type: "run",
    form: { source: "jira", issueKey: "JR-12345", similarKeywords: "x".repeat(100_000), similarMaxFixes: "9".repeat(1_000), similarUseSharedKeywords: "off" },
  });
  if (hostile?.type !== "run") return assert.fail("dropped");
  assert.equal(hostile.form.similarKeywords.length, 8_000);
  assert.equal(hostile.form.similarMaxFixes.length, 16);
  assert.equal(hostile.form.similarUseSharedKeywords, true);
});

// --- the log ---------------------------------------------------------------------------------

test("the log keeps the count and the switch, and redacts the keywords", () => {
  const line = commandForLog(
    argsOf(form({ keywords: "SECRET_SHARED_8812", similarKeywords: "SECRET_SIMILAR_5521", similarMaxFixes: "2", similarUseSharedKeywords: false })),
  );
  assert.match(line, / --similar-fixes-keyword=<redacted> /);
  assert.match(line, / --similar-fixes-no-shared-keywords /);
  assert.match(line, / --max-similar-fixes=2 /);
  assert.equal(line.includes("SECRET_SIMILAR_5521"), false);
  assert.equal(line.includes("SECRET_SHARED_8812"), false);
});
