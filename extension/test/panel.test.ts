import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MAX_ATTACHMENTS,
  PANEL_ACTIONS,
  PANEL_MESSAGE_TYPES,
  WORKFLOW_CHECKBOX_IDS,
  parsePanelMessage,
} from "../src/panel/messages.ts";
import type { PanelMessage } from "../src/panel/messages.ts";
import { SETTINGS_FIELD_IDS, TEXT_FIELD_IDS, panelHtml } from "../src/panel/html.ts";
import { DEFAULT_FORM, JIRA_ISSUE_KEY_RE } from "../src/app/form.ts";
import { WORKFLOW_STEP_IDS } from "../src/app/workflow.ts";
import {
  SETTINGS_ACTION_LABELS,
  SETTINGS_SECTION_FIELDS,
  SETTINGS_SECTION_OF_STEP,
  SETTINGS_SECTION_TITLES,
  WORKFLOW_SETTINGS_SECTIONS,
  sectionRebuildNote,
} from "../src/app/workflowSettings.ts";

const HTML = panelHtml({
  nonce: "N0NCE",
  cspSource: "vscode-webview://abc",
  styleUri: "vscode-webview://abc/media/panel.css",
  scriptUri: "vscode-webview://abc/media/panel.js",
  codiconUri: "vscode-webview://abc/media/codicons/codicon.css",
});

const CODICON_CSS = readFileSync(
  new URL("../media/codicons/codicon.css", import.meta.url),
  "utf8",
);

const CSS_SOURCE =
  readFileSync(new URL("../media/panel.css", import.meta.url), "utf8") +
  // The vendored subset ships inside the page too, so it lives under the same
  // no-colour, no-remote rules as the panel's own stylesheet.
  CODICON_CSS;
const PAGE_JS_SOURCE = readFileSync(new URL("../media/panel.js", import.meta.url), "utf8");

/**
 * A file with its comments removed.
 *
 * Both files document the rules they follow, so a plain grep for a forbidden
 * token finds the sentence saying the token is forbidden. Only whole comment
 * lines and block comments go, which cannot damage a string literal the way a
 * general `//` strip would.
 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((line) => !/^\s*\/\//.test(line))
    .join("\n");
}

const CSS = stripComments(CSS_SOURCE);
const PAGE_JS = stripComments(PAGE_JS_SOURCE);

/**
 * The `FormState` keys that are text a developer types.
 *
 * Everything else is a select, a checkbox, a list built by a file dialog, or
 * the plan — none of which is a text control the document has to carry.
 */
const MODEL_TEXT_FIELDS = Object.keys(DEFAULT_FORM).filter(
  (key) =>
    ![
      "source",
      "plan",
      "fresh",
      "fixWithAI",
      "agent",
      "attachments",
      "fixModeId",
      "useIssueDetails",
    ].includes(key),
);

/** The two model fields the single Issue control stands in for. */
const ISSUE_FIELD_CARRIES = ["issueKey", "description"];

/** Hex, rgb(), hsl() — the literals a theme cannot override. */
const COLOUR_LITERAL = /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/;

const fullForm = {
  source: "manual",
  issueKey: "JR-1",
  title: "t",
  description: "d",
  hint: "h",
  keywords: "k",
  focusFiles: "f",
  ignorePaths: "i",
  maxFiles: "10",
  maxSearchLines: "300",
  plan: { codeSearch: true, gitHistory: false, similarFixes: true, buildContext: true },
  fixWithAI: true,
  agent: "claude-cli",
  agentCommand: "",
  fresh: true,
};

// --- the message boundary --------------------------------------------------

test("a well-formed run message is accepted whole", () => {
  const message = parsePanelMessage({ type: "run", form: fullForm });
  assert.equal(message?.type, "run");
  if (message?.type !== "run") return;
  assert.equal(message.form.source, "manual");
  assert.equal(message.form.plan.gitHistory, false);
  assert.equal(message.form.fresh, true);
});

test("anything unrecognized is dropped rather than half-trusted", () => {
  for (const raw of [undefined, null, 7, "run", [], {}, { type: "eval" }, { type: 1 }]) {
    assert.equal(parsePanelMessage(raw), undefined);
  }
});

test("a form with no valid source is refused", () => {
  // Rather than defaulting: the source decides which fields are even read, and
  // guessing it would run the wrong kind of investigation.
  assert.equal(parsePanelMessage({ type: "run", form: { ...fullForm, source: "other" } }), undefined);
  assert.equal(parsePanelMessage({ type: "run", form: {} }), undefined);
});

test("missing text fields become empty strings, not undefined", () => {
  // The argv builder trims and measures these; an undefined reaching it would
  // throw somewhere far away from the cause.
  const message = parsePanelMessage({ type: "run", form: { source: "jira" } });
  assert.equal(message?.type, "run");
  if (message?.type !== "run") return;
  // The model's text fields, not the document's controls — `issue` is one box
  // standing for two of these and never arrives under its own name.
  for (const field of MODEL_TEXT_FIELDS) {
    assert.equal(typeof message.form[field as keyof typeof message.form], "string");
  }
});

test("an absurdly large paste is clamped, not dropped", () => {
  // Dropping the message would look like the panel had frozen; the cap is far
  // above any real bug report.
  const message = parsePanelMessage({
    type: "run",
    form: { ...fullForm, description: "x".repeat(500_000) },
  });
  assert.equal(message?.type, "run");
  if (message?.type !== "run") return;
  assert.equal(message.form.description.length, 200_000);
});

test("the page cannot turn off issue details", () => {
  const message = parsePanelMessage({
    type: "run",
    form: { ...fullForm, plan: { ...fullForm.plan, issueDetails: false } },
  });
  assert.equal(message?.type === "run" && message.form.plan.issueDetails, true);
});

test("an artifact name that tries to leave the work item directory is refused", () => {
  // Names are plain files inside `.ai/<work_item>/`; a separator or `..` here
  // is a traversal attempt, and the host would otherwise open it.
  for (const name of ["../../etc/passwd", "sub/dir.md", "..\\..\\secrets", ".."]) {
    assert.equal(parsePanelMessage({ type: "openArtifact", name }), undefined, name);
  }
  assert.deepEqual(parsePanelMessage({ type: "openArtifact", name: "task.md" }), {
    type: "openArtifact",
    name: "task.md",
  });
});

test("only the declared semantic actions are accepted", () => {
  for (const id of PANEL_ACTIONS) {
    assert.deepEqual(parsePanelMessage({ type: "action", id }), { type: "action", id });
  }
  assert.equal(parsePanelMessage({ type: "action", id: "runArbitraryThing" }), undefined);
});

test("every message the page sends is one the host understands", () => {
  // The page and the parser are in different languages of a sort — one is
  // untyped browser JS. This walks the actual postMessage calls in the page.
  const sent = [...PAGE_JS.matchAll(/postMessage\(\{\s*type:\s*"([a-zA-Z]+)"/g)].map(
    (match) => match[1]!,
  );
  assert.ok(sent.length >= 6, `expected several message kinds, found ${sent.length}`);
  // Against the host's own list, not a copy of it kept here: a copy is how
  // "ready", "stop" and "retry" were listed as understood while the parser
  // dropped all three (§37.70).
  const understood = new Set<string>(PANEL_MESSAGE_TYPES);
  for (const type of sent) {
    assert.ok(understood.has(type), `the page sends "${type}", which the host drops`);
  }
  // And every action the page names is one the host has.
  const actions = [...PAGE_JS.matchAll(/type:\s*"action",\s*id:\s*"([a-zA-Z]+)"/g)].map((match) => match[1]!);
  for (const id of actions) {
    assert.ok((PANEL_ACTIONS as readonly string[]).includes(id), `the page asks for action "${id}", which the host drops`);
  }
});

/**
 * One well-formed message per type the host declares.
 *
 * Keyed by the union, so a type added to `PanelMessage` without a sample here
 * is a compile error, and the test below is what a type the parser cannot
 * parse fails. The shapes are the page's own: bare types carry nothing else.
 */
const WELL_FORMED: Readonly<Record<PanelMessage["type"], Record<string, unknown>>> = {
  ready: { type: "ready" },
  run: { type: "run", form: DEFAULT_FORM },
  stop: { type: "stop" },
  retry: { type: "retry" },
  nextAction: { type: "nextAction", action: "fixWithAI", form: DEFAULT_FORM },
  startAttempt: { type: "startAttempt", feedback: "Focus on WidgetController.cpp.", form: DEFAULT_FORM },
  formChanged: { type: "formChanged", form: DEFAULT_FORM },
  applySettings: { type: "applySettings", form: DEFAULT_FORM },
  pickAttachments: { type: "pickAttachments", attachments: ["C:/logs/crash.txt"] },
  addAttachments: { type: "addAttachments", form: DEFAULT_FORM },
  action: { type: "action", id: "fixWithAI" },
  command: { type: "command", id: "bugpilot.openSettings" },
  openArtifact: { type: "openArtifact", name: "task.md" },
  openRelevantFile: { type: "openRelevantFile", path: "src/widgets/WidgetController.cpp" },
  improveHint: { type: "improveHint", form: DEFAULT_FORM },
  useImprovedHint: { type: "useImprovedHint" },
  dismissImprovedHint: { type: "dismissImprovedHint" },
  manageFixModes: { type: "manageFixModes" },
  closeFixModes: { type: "closeFixModes" },
  detectAgents: { type: "detectAgents" },
  fixModeAction: { type: "fixModeAction", action: "view", id: "standard", scope: "builtin" },
  parseReviewOutput: { type: "parseReviewOutput", text: "## Summary\nReads correctly.\n" },
  discardReviewDraft: { type: "discardReviewDraft" },
  verificationDraft: {
    type: "verificationDraft",
    checks: [{ name: "Unit tests", status: "not_run", type: "automated", procedure: "", evidence: "", notes: "" }],
  },
  flushVerification: { type: "flushVerification" },
  overwriteVerification: { type: "overwriteVerification" },
  discardVerificationDraft: { type: "discardVerificationDraft" },
  saveFixMode: {
    type: "saveFixMode",
    draft: {
      intent: "create",
      id: "careful-fix",
      scope: "user",
      executionKind: "fix",
      version: 1,
      name: "Careful Fix",
      description: "Smaller steps.",
      objective: "Fix the bug.",
      investigation: "Read first.",
      implementation: "Change little.",
      verification: "Run the tests.",
      constraints: "No refactors.",
      completion: "Write fix_report.md.",
    },
  },
  recordReview: {
    type: "recordReview",
    review: { summary: "Reads correctly.", findings: "", validationNotes: "", recommendations: "" },
  },
  recordVerification: {
    type: "recordVerification",
    replace: false,
    checks: [{ name: "Unit tests", status: "passed", type: "automated", procedure: "npm test", evidence: "", notes: "" }],
  },
};

test("the host's list of message types is the PanelMessage union, read from its source", () => {
  // The Record keeps them equal at compile time; `npm test` strips types, so
  // the same is checked here against messages.ts itself.
  const source = readFileSync(new URL("../src/panel/messages.ts", import.meta.url), "utf8");
  const union = /export type PanelMessage =([\s\S]*?);\r?\n\r?\n/.exec(source)?.[1] ?? "";
  const declared = [...union.matchAll(/readonly type: "([a-zA-Z]+)"/g)].map((match) => match[1]!);
  assert.ok(declared.length >= 10, `read ${declared.length} types from the union`);
  assert.deepEqual([...new Set(declared)].sort(), [...PANEL_MESSAGE_TYPES].sort());
});

test("every message type the host declares parses from its well-formed shape, as that type", () => {
  // The contract `ready`, `stop` and `retry` broke: each fell through into
  // `improveHint`, which needs a form, and came back undefined.
  assert.deepEqual(Object.keys(WELL_FORMED).sort(), [...PANEL_MESSAGE_TYPES].sort());
  for (const type of PANEL_MESSAGE_TYPES) {
    const parsed = parsePanelMessage(WELL_FORMED[type]);
    assert.ok(parsed, `a well-formed "${type}" message was dropped`);
    assert.equal(parsed.type, type);
  }
  // The bare three come back as exactly themselves: no form is required of
  // them, and none is invented.
  for (const type of ["ready", "stop", "retry"] as const) {
    assert.deepEqual(parsePanelMessage({ type }), { type });
    assert.deepEqual(parsePanelMessage({ type, form: DEFAULT_FORM }), { type }, `"${type}" with a form turned into something else`);
  }
});

// --- the document ----------------------------------------------------------

test("the content security policy allows nothing by default", () => {
  assert.match(HTML, /default-src 'none'/);
  assert.match(HTML, /script-src 'nonce-N0NCE'/);
  assert.equal(/unsafe-inline|unsafe-eval/.test(HTML), false);
});

test("nothing is loaded from a remote origin", () => {
  // §5.4: the webview must not reach the network. A CDN font or script would
  // also leak the fact that a developer is looking at a particular bug.
  assert.equal(/https?:\/\//.test(HTML), false);
  assert.equal(/https?:\/\//.test(CSS), false);
  assert.equal(/https?:\/\//.test(PAGE_JS), false);
});

test("the one script tag carries the nonce and the given source", () => {
  const scripts = [...HTML.matchAll(/<script\b[^>]*>/g)].map((match) => match[0]);
  assert.equal(scripts.length, 1, "an extra script tag would need its own nonce");
  assert.match(scripts[0]!, /nonce="N0NCE"/);
  assert.match(scripts[0]!, /src="vscode-webview:\/\/abc\/media\/panel\.js"/);
});

test("no colour is written into the markup or the stylesheet", () => {
  // This is what makes Light, Dark and both High Contrast themes work without
  // four sets of screenshots — and it is the rule most easily broken by a
  // "quick fix", so it is checked rather than reviewed.
  assert.equal(COLOUR_LITERAL.test(HTML), false, "the markup names a colour");
  const offender = COLOUR_LITERAL.exec(CSS);
  assert.equal(offender, null, `panel.css names a colour: ${offender?.[0]}`);
  assert.ok(CSS.includes("var(--vscode-foreground)"));
});

test("the stylesheet keeps the panel usable at sidebar width", () => {
  // The sidebar can be dragged to ~200px; a fixed pixel width on any control
  // produces a horizontal scrollbar there.
  // `max-width` is fine — it keeps the form readable in a wide editor tab. It
  // is a plain pixel `width` that breaks the narrow sidebar.
  const fixedWidth = /(?<![a-z-])width:\s*\d+px/.exec(CSS);
  assert.equal(fixedWidth, null, `fixed width in panel.css: ${fixedWidth?.[0]}`);
  assert.match(CSS, /box-sizing:\s*border-box/);
  assert.match(CSS, /overflow-wrap:\s*anywhere/);
});

test("focus is visible, using the theme's own focus colour", () => {
  assert.match(CSS, /:focus-visible[^{]*\{[^}]*var\(--vscode-focusBorder\)/s);
});

test("every control has a label a screen reader can read", () => {
  const controls = [...HTML.matchAll(/<(input|textarea|select)\b[^>]*id="([^"]+)"[^>]*>/g)];
  assert.ok(controls.length > 10, "expected the full form to be present");
  for (const [, , id] of controls) {
    const labelled =
      new RegExp(`<label[^>]*for="${id}"`).test(HTML) ||
      // A wrapping label: `<label class="choice"><input id="x"> Text</label>`
      new RegExp(`<label[^>]*>\\s*<input[^>]*id="${id}"[^>]*>\\s*[^<]`).test(HTML);
    assert.ok(labelled, `${id} has no associated label`);
  }
});

test("the form's fields are exactly the model's fields", () => {
  // Both directions: a field added to FormState but not to the page can never
  // be filled in, and a field on the page that the model does not have is
  // silently discarded on the way to argv.
  //
  // With one stated exception since UI-A1. `#issue` is a control, not a model
  // field: it carries `issueKey` or `description` depending on what is typed
  // into it, and the page decides which. Expanding it here rather than
  // exempting it is what keeps the guard honest — add a third thing to that
  // box and this fails until the mapping is written down.
  assert.deepEqual(
    [...TEXT_FIELD_IDS.filter((id) => id !== "issue"), ...ISSUE_FIELD_CARRIES].sort(),
    [...MODEL_TEXT_FIELDS].sort(),
  );
  assert.ok(TEXT_FIELD_IDS.includes("issue"), "the one input field is gone");
});

test("the one Issue field reads a Jira key the way the argv builder does", () => {
  // The page cannot import `form.ts`, so it carries its own copy of the pattern
  // — and a copy that drifted would classify input one way on screen and the
  // other way on the command line. The same duplication the Python identity
  // rule has, guarded the same way.
  const literal = /const JIRA_ISSUE_KEY_RE = \/(.+?)\/;/.exec(PAGE_JS)?.[1];
  assert.ok(literal, "the page has no Jira key pattern");
  assert.equal(literal, JIRA_ISSUE_KEY_RE.source);
});

test("there is one row, with one checkbox, for every workflow step", () => {
  // Both directions. A step in the model with no row can never be chosen, and
  // a row the model does not know about is a checkbox that changes nothing.
  for (const id of WORKFLOW_STEP_IDS) {
    assert.match(HTML, new RegExp(`id="step-${id}"`), `no row for ${id}`);
    assert.match(HTML, new RegExp(`id="plan-${id}"`), `no checkbox for ${id}`);
  }
  // Then Fix result (Batch 8), last, and the one row nobody ticks.
  const rows = [...HTML.matchAll(/id="step-([A-Za-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(rows, [...WORKFLOW_STEP_IDS, "fixResult"], "the rows are in the model's order");
  const checkboxes = [...HTML.matchAll(/<input type="checkbox" id="(plan-[A-Za-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual([...WORKFLOW_CHECKBOX_IDS].sort(), [...checkboxes].sort());
  assert.equal(HTML.includes('id="plan-fixResult"'), false, "Fix result became a choice");
});

test("the workflow is one section, not an Investigate box plus a Progress box", () => {
  // The refactor this file guards: three places describing one run became one.
  // A regression here is not cosmetic — it is the old shape coming back.
  assert.match(HTML, /id="workflow"/);
  assert.match(HTML, /Investigation &amp; AI Fix/);
  assert.match(HTML, /id="workflow-status"[^>]*role="status"/);
  for (const gone of ['id="handoff"', 'id="progress-section"', 'id="rows"', "<legend>"]) {
    assert.equal(HTML.includes(gone), false, `${gone} belongs to the old three-section layout`);
  }
});

test("the AI step is a workflow row rather than a button, and starts unticked", () => {
  // Ticked by default it would involve a model in every run, which is exactly
  // what R5 asks not to happen without a decision.
  const row = /<li[^>]*id="step-fixWithAI"[\s\S]*?<\/li>/.exec(HTML)?.[0] ?? "";
  assert.notEqual(row, "", "no Fix with AI row");
  assert.match(row, /<input type="checkbox" id="plan-fixWithAI">/);
  assert.equal(/ checked/.test(row), false, "Fix with AI must not arrive ticked");
  assert.match(row, /Fix with AI/);
});

test("no Claude-specific wording reaches the panel", () => {
  // The mechanism is still Claude-shaped underneath; the workflow must not be.
  // The agent picker's own option is the one allowed mention.
  const withoutOptions = HTML.replace(/<option[\s\S]*?<\/option>/g, "");
  assert.equal(/claude/i.test(withoutOptions), false, "the panel names Claude outside the picker");
  assert.match(HTML, /Run the prepared context with your AI coding agent/);
});

/** One workflow row's markup, from its `<li>` to its close. */
/** The Workflow Settings view, whole. */
const SETTINGS_VIEW = /<section id="workflow-settings-view"[\s\S]*?\n {2}<\/section>/.exec(HTML)?.[0] ?? "";

/** One section of it, heading to closing tag. */
function settingsSection(section: string): string {
  const found = new RegExp(`<section class="settings-section" id="settings-section-${section}"[\\s\\S]*?\\n {4}</section>`).exec(SETTINGS_VIEW)?.[0] ?? "";
  assert.notEqual(found, "", `no settings section ${section}`);
  return found;
}

function rowMarkup(id: string): string {
  const row = new RegExp(`<li[^>]*id="step-${id}"[\\s\\S]*?</li>`).exec(HTML)?.[0] ?? "";
  assert.notEqual(row, "", `no ${id} row`);
  return row;
}

test("the status icon is at the far right, away from the checkbox", () => {
  // The two ends answer different questions — "will this run" on the left,
  // "how did it go" on the right. Side by side, a ticked checkbox and a green
  // tick were one check mark too many.
  const row = rowMarkup("codeSearch");
  const order = [
    'id="plan-codeSearch"',
    'id="duration-codeSearch"',
    'id="status-codeSearch"',
  ].map((id) => row.indexOf(id));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "checkbox first, status last");
  // Nothing until the step has done something: the checkbox already says it is
  // going to run.
  assert.match(row, /id="status-codeSearch"[^>]*hidden/);

  // A row's result sits below its head line, never inside it (Batch 6).
  const built = rowMarkup("buildContext");
  assert.ok(built.indexOf('id="status-buildContext"') < built.indexOf('id="actions-buildContext"'));
});

test("every icon the panel asks for is one the vendored font declares", () => {
  // The failure this prevents is silent and ugly: an undeclared glyph renders
  // as a tofu box, which reads as a broken extension. It is easy to hit, too —
  // the step icons are built from a template, so no compiler sees them.
  const declared = new Set(
    [...CODICON_CSS.matchAll(/\.codicon-([a-z-]+):before/g)].map((match) => match[1]!),
  );
  const literal = [...HTML.matchAll(/codicon-([a-z-]+)/g), ...PAGE_JS.matchAll(/codicon-([a-z-]+)/g)]
    .map((match) => match[1]!);
  // The names the page substitutes into `codicon-${...}` at render time. The
  // workflow rows use none any more (§37.86): a dot, or the spinner, which is a
  // literal above.
  const templated = [...PAGE_JS.matchAll(/icon: "([a-z-]*)"/g)]
    .map((match) => match[1]!)
    .filter((name) => name !== "");

  const used = new Set([...literal, ...templated]);
  for (const name of used) {
    assert.ok(declared.has(name), `codicon-${name} is used but not declared in codicon.css`);
  }
  // And the other way: the file says it declares only what is used, so an
  // orphan means either a dead glyph or a renamed one still on screen.
  for (const name of declared) {
    assert.ok(used.has(name), `codicon-${name} is declared but nothing uses it`);
  }
});

test("each action lives on the row that owns it (Batch 6)", () => {
  // Open Context and Copy act on context.md, which Build context produced; the
  // Fix with AI row holds Start New Attempt's form, whose Start acts on the
  // prepared task; Open Folder reveals every artifact, so it belongs to the work
  // item, not to one row.
  const built = rowMarkup("buildContext");
  const buildButtons = [...built.matchAll(/<button[^>]*id="([A-Za-z-]+)"/g)].map((match) => match[1]);
  // Its gear, in the row's head, then what it produced.
  assert.deepEqual(buildButtons, ["settings-buildContext", "artifact-buildContext", "open-context", "copy-context"]);
  for (const id of ["open-context", "copy-context"]) {
    const tag = new RegExp(`<button[^>]*id="${id}"[^>]*>`).exec(built)?.[0] ?? "";
    assert.match(tag, /title="[^"]+"/, `${id} has no tooltip`);
    assert.match(tag, /\bhidden\b/, `${id} should start hidden`);
  }
  assert.match(built, /Open Context/);
  assert.match(built, /codicon-go-to-file/);

  const fix = rowMarkup("fixWithAI");
  assert.match(fix, /<div class="attempt-editor" id="attempt-editor" role="group" aria-labelledby="attempt-heading" hidden>/);
  assert.match(fix, /<button type="button" id="start-attempt">/);
  assert.equal(fix.includes('id="fix-with-ai"'), false, "the row still has a handoff button of its own");

  // Open Folder: at the foot of the workflow, on no row.
  for (const id of ["issueDetails", "codeSearch", "gitHistory", "similarFixes", "buildContext", "fixWithAI"]) {
    assert.equal(rowMarkup(id).includes('id="open-folder"'), false, `Open Folder is on the ${id} row`);
  }
  const foot = /<div class="workflow-foot" id="workflow-foot">[\s\S]*?<\/div>/.exec(HTML)?.[0] ?? "";
  assert.match(foot, /id="open-folder"[^>]*hidden/);
  assert.match(foot, /Open Folder/);
});

test("there is no Context Ready card: the workflow header is the one global status", () => {
  // §37.45, Option B. Everything the card held moved onto a row, and the line
  // it left said "Context Ready" directly above a header saying the same — or,
  // after a handoff, contradicting it.
  assert.equal(HTML.includes('id="context-ready"'), false);
  const visible = HTML.replace(/<!--[\s\S]*?-->/g, "");
  assert.equal(visible.includes("Context Ready"), false);
  assert.match(HTML, /<span id="workflow-status" class="workflow-status" role="status">/);
});

test("the workflow has no primary button: the one primary action is at the top", () => {
  // Fix with AI used to be a second primary button inside its row, a competing
  // answer to "what next?" under a disclosure that starts collapsed. Handing the
  // task over is the top button's job now, in every state that offers it.
  const workflow = HTML.slice(HTML.indexOf('<details class="group" id="workflow"'), HTML.indexOf('<details class="diagnostics"'));
  assert.notEqual(workflow, "", "no workflow disclosure");
  assert.deepEqual([...workflow.matchAll(/<button[^>]*class="primary"/g)].length, 0);
  // In the whole main view, exactly one: Run's. (Apply is the settings page's.)
  const main = /<section id="main-view">[\s\S]*?<section id="workflow-settings-view"/.exec(HTML)?.[0] ?? "";
  const primary = [...main.matchAll(/<button[^>]*id="([a-z-]+)"[^>]*class="primary"/g)].map((match) => match[1]);
  assert.deepEqual(primary, ["run"]);
});

// --- Workflow Settings: the row gears ------------------------------------------

test("a gear on exactly the rows that have settings, named for its step", () => {
  const withGear = WORKFLOW_STEP_IDS.filter((id) => SETTINGS_SECTION_OF_STEP[id] !== undefined);
  assert.deepEqual(withGear, ["issueDetails", "codeSearch", "buildContext", "fixWithAI"]);
  for (const id of withGear) {
    const section = SETTINGS_SECTION_OF_STEP[id]!;
    const head = /<div class="step-head">[\s\S]*?<\/div>/.exec(rowMarkup(id))?.[0] ?? "";
    const gear = new RegExp(`<button type="button" class="icon step-settings" id="settings-${id}"[^>]*>`).exec(head)?.[0] ?? "";
    assert.notEqual(gear, "", `${id} has no gear in its head`);
    // Named for its step, in the tooltip and for a screen reader alike.
    assert.match(gear, new RegExp(`title="${SETTINGS_ACTION_LABELS[section]}"`));
    assert.match(gear, new RegExp(`aria-label="${SETTINGS_ACTION_LABELS[section]}"`));
    // A real button, outside the label — pressing it never ticks the checkbox.
    const label = /<label class="step-label"[\s\S]*?<\/label>/.exec(head)?.[0] ?? "";
    assert.equal(label.includes("step-settings"), false, `${id}'s gear is inside its label`);
    assert.match(head, new RegExp(`id="settings-${id}"[^>]*><span class="codicon codicon-settings-gear" aria-hidden="true"></span></button>`));
    // And a line for its summary, empty until the host says something.
    assert.match(rowMarkup(id), new RegExp(`<p class="step-settings-summary" id="settings-summary-${id}" hidden></p>`));
  }
  assert.deepEqual(Object.values(SETTINGS_ACTION_LABELS), [
    "Configure Issue Details",
    "Configure Code Search",
    "Configure Build Context",
    // Fix Mode and Hint moved to the main page: this gear is the agent's (§37.90).
    "Configure AI Agent",
  ]);
});

test("rows with nothing to configure have no gear, and no summary line", () => {
  for (const id of ["gitHistory", "similarFixes", "fixResult"]) {
    const row = rowMarkup(id);
    assert.equal(row.includes("step-settings"), false, `${id} has a gear`);
    assert.equal(row.includes(`settings-summary-${id}`), false, `${id} has a summary line`);
  }
  // Six rows, four gears, one Workflow Settings entry: no gear called Settings.
  assert.equal([...HTML.matchAll(/class="icon step-settings"/g)].length, 4);
  assert.equal(/aria-label="Settings"|title="Settings"/.test(HTML), false);
});

test("the gear is quieter, never hidden, has a focus ring, and never squeezes its label", () => {
  // Visible at rest — a keyboard or a touch screen has no hover — and full
  // strength on hover or focus.
  const rule = /\.step-settings \{([^}]*)\}/.exec(CSS)?.[1] ?? "";
  assert.match(rule, /flex: none/);
  assert.match(rule, /opacity: 0\.6/);
  assert.equal(/display: none|visibility: hidden|opacity: 0;/.test(rule), false);
  assert.match(CSS, /\.step:hover \.step-settings,\s*\.step-settings:hover,\s*\.step-settings:focus-visible \{\s*opacity: 1;/);
  assert.match(CSS, /\.step-settings:focus-visible \{[^}]*outline: 1px solid var\(--vscode-focusBorder\)/s);
  // The label takes the space and may shrink; the summary is cut, not wrapped.
  assert.match(CSS, /\.step-label \{[^}]*flex: 1 1 8em;[^}]*min-width: 0;/s);
  // Found at 200px in the real window: with a duration, a status and the gear,
  // a label that took all the shrinking broke between every letter. The head
  // wraps instead, keeping the label a floor; the duration, status and gear
  // are one cluster that wraps under it and stays at the right (§37.86).
  assert.match(CSS, /\.step-head \{[^}]*flex-wrap: wrap;/s);
  assert.match(CSS, /\.step-meta \{[^}]*flex-wrap: wrap;[^}]*margin-left: auto;/s);
  assert.equal(/\.step-label \{[^}]*overflow-wrap: anywhere/s.test(CSS), false, "a name may break between letters");
  assert.match(CSS, /\.step-settings-summary \{[^}]*text-overflow: ellipsis/s);
  // The arrival highlight is an outline, which a high-contrast theme keeps —
  // and only an outline: a fill behind the section's inputs was loud enough in
  // a real window to read as an error.
  assert.match(CSS, /\.settings-section-target \{[^}]*outline-color: var\(--vscode-focusBorder\)/s);
  assert.equal(/\.settings-section-target \{[^}]*background/s.test(CSS), false, "the arrival highlight fills the section");
  assert.match(CSS, /@media \(prefers-reduced-motion: reduce\) \{\s*\.settings-section \{\s*transition: none;/);
});

test("the page's copy of the settings sections is the model's", () => {
  // The webview cannot import app/workflowSettings.ts, so it carries a copy;
  // this is what keeps the two from drifting.
  const read = (name: string) => {
    const literal = new RegExp(`const ${name} = (\\{[\\s\\S]*?\\n {2}\\});`).exec(PAGE_JS)?.[1];
    assert.ok(literal, `panel.js has no ${name}`);
    return new Function(`return ${literal};`)() as Record<string, unknown>;
  };
  const sections = read("SETTINGS_SECTIONS") as Record<string, { fields: string[]; focus: string[] }>;
  assert.deepEqual(Object.keys(sections), [...WORKFLOW_SETTINGS_SECTIONS]);
  for (const section of WORKFLOW_SETTINGS_SECTIONS) {
    assert.deepEqual(sections[section]!.fields, [...SETTINGS_SECTION_FIELDS[section]], section);
    // Everything a gear may focus is in that section.
    for (const id of sections[section]!.focus) {
      assert.ok(settingsSection(section).includes(`id="${id}"`), `${id} is not in ${section}`);
    }
  }
  assert.deepEqual(read("STEP_SETTINGS"), { ...SETTINGS_SECTION_OF_STEP });
});

test("a row's result survives a narrow sidebar", () => {
  // Wrapping secondaries, no absolute positioning. The panel is dragged to
  // about 200px, so none of this can assume a width.
  assert.match(CSS, /\.step-actions \{[^}]*flex-wrap: wrap/s);
  assert.match(CSS, /\.step-foot \{[^}]*flex-wrap: wrap/s);
  assert.match(CSS, /\.workflow-foot \{[^}]*flex-wrap: wrap/s);
  assert.equal(/\.step-[a-z-]+[^{]*\{[^}]*position: absolute/s.test(CSS), false);
  // A pixel width, not `min-width: 0`, which is the opposite thing: it is what
  // lets a flex child shrink below its content.
  assert.equal(/\.step-[a-z-]+[^{]*\{[^}]*[^-]width: \d+px/s.test(CSS), false);
});

test("a row with nothing but its summary is exactly as tall as before", () => {
  // The body's space is conditional on a visible child, and the two action
  // containers hide with their contents — otherwise an empty one would count
  // as visible and pad every row.
  assert.match(CSS, /\.step-body:has\(> :not\(\[hidden\]\)\) \{[^}]*margin-top/s);
  assert.equal(/\.step-body \{[^}]*margin-top/s.test(CSS), false);
  assert.match(HTML, /<div class="step-actions" id="actions-buildContext" hidden>/);
  assert.match(HTML, /<div class="attempt-editor" id="attempt-editor"[^>]*hidden>/);
  assert.match(CSS, /\.attempt-editor\[hidden\] \{\s*display: none;/);
});

test("Advanced Settings has a heading, a lede that says Apply is the act, and a way back", () => {
  assert.notEqual(SETTINGS_VIEW, "", "no settings view");
  assert.match(SETTINGS_VIEW, /<h2 id="settings-heading" class="view-title" tabindex="-1">Advanced Settings<\/h2>/);
  assert.match(SETTINGS_VIEW, /Changes take effect when you press Apply; Back and Cancel discard them\./);
  assert.match(SETTINGS_VIEW, /<button type="button" id="settings-back" class="link view-back">[\s\S]*?Back\s*<\/button>/);
  // Cancel, then Apply — the page's one primary button, at its foot.
  const actions = /<div class="settings-actions">[\s\S]*?<\/div>/.exec(SETTINGS_VIEW)?.[0] ?? "";
  assert.deepEqual([...actions.matchAll(/<button[^>]*id="([a-z-]+)"/g)].map((match) => match[1]), ["settings-cancel", "settings-apply"]);
  assert.deepEqual([...SETTINGS_VIEW.matchAll(/<button[^>]*id="([a-z-]+)"[^>]*class="primary"/g)].map((match) => match[1]), ["settings-apply"]);
  // Kept on screen while the page scrolls, so Apply is never a long way off —
  // and nothing the page scrolls into view, or focuses, ends up behind it.
  assert.match(CSS, /\.settings-actions \{[^}]*position: sticky/s);
  assert.match(CSS, /html:has\(#workflow-settings-view:not\(\[hidden\]\)\) \{\s*scroll-padding-bottom: 3\.5rem;/);
  // A field a run holds looks held, text boxes as well as selects.
  assert.match(CSS, /#workflow-settings-view :is\(input, textarea, select\):disabled \{\s*opacity: 0\.6;\s*cursor: default;/);
  // Said while Apply waits on the host, in words.
  assert.match(SETTINGS_VIEW, /<p class="muted settings-busy" id="settings-busy" role="status" hidden>/);
});

test("every setting has a header row with a real label in it", () => {
  // One layout for every row, including the agent picker and the checkbox.
  // Two layouts for the same kind of thing is what made the section look
  // assembled rather than designed.
  const rows = [...SETTINGS_VIEW.matchAll(/<div class="setting-header">([\s\S]*?)<\/div>/g)].map(
    (match) => match[1]!,
  );
  // The text fields, plus the three rows that are not text fields: the agent
  // picker, the attachment list and the checkbox. (Fix Mode and Hint are the
  // main page's now, §37.84.)
  assert.equal(rows.length, SETTINGS_FIELD_IDS.length + 3, "a row is missing the pattern");

  for (const row of rows) {
    const label = /<label[^>]*for="([^"]+)"/.exec(row);
    assert.ok(label, `a header row has no label: ${row}`);
    // Where a row does carry helper text, it is a sibling of the label — which
    // is what puts the two on one line.
    if (row.includes('class="hint"')) {
      assert.match(row, new RegExp(`id="${label[1]}-hint"`));
      assert.ok(row.indexOf("<label") < row.indexOf('<p class="hint"'), "helper before label");
    }
  }
});

test("helper text survives only where a placeholder could not carry it", () => {
  // The rule as it stands after UI-A2. A placeholder disappears the moment
  // somebody types, so helper text is for what must stay readable: a rule, a
  // consequence, or — new in UI-A2 — what a whole group of settings is *for*.
  //
  // The three that were added are the three the grouping is about. "Keywords"
  // alone does not say whether the search needs them, and a developer who
  // cannot tell an expert boost from a required field fills it in every time.
  // The ones that are still bare are the ones whose label and example say
  // everything: Ignore paths, Max files, Max search lines, Title.
  const advanced = SETTINGS_VIEW;
  // `[a-zA-Z-]+`, with the hyphen: the first version of this pattern could not
  // match `add-attachment-hint`, so a whole row's helper text slipped past the
  // guard unnoticed. A character class is a claim about what ids look like.
  const withHelper = [...advanced.matchAll(/<p class="hint" id="([a-zA-Z-]+)-hint">/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(
    [...withHelper].sort(),
    [
      // A rule or a consequence.
      "add-attachment", "agentCommand", "fresh",
      // What the setting is for, which is what UI-A2's grouping asserts.
      "focusFiles", "keywords",
    ].sort(),
    "helper text should remain only where a placeholder could not carry it",
  );
  // Where the files go and who reads them: not inferable from "Attachments",
  // and there is no input to hang a placeholder on.
  assert.match(advanced, /named in the agent's task file/);

  // And what each of them says is the reason it survived.
  assert.match(advanced, /\{prompt\} is replaced with the handoff prompt, already quoted\./);
  assert.match(advanced, /Off by default to avoid accidental data loss/);
  // And the three group-purpose lines, which are the reason the list grew.
  assert.match(HTML, /Add technical guidance, constraints, or suspected areas\./);
  assert.match(advanced, /Boost retrieval with known identifiers or technical terms\./);
  assert.match(advanced, /Prioritize files you already suspect are relevant\./);
  // A checkbox with no input to hang a placeholder on, saying what it lets the
  // improver read — and, just as importantly, what it does not.
  assert.match(HTML, /Includes only the issue title and description\. Repository files and history are not read\./);
  // Fix Mode, Hint and Include issue details keep their helper lines, on the form.
  const form = /<form id="form"[\s\S]*?<\/form>/.exec(HTML)?.[0] ?? "";
  for (const id of ["fixModeId", "hint", "useIssueDetails"]) assert.ok(form.includes(`id="${id}-hint"`), id);
});

test("a field with nothing to explain says nothing, and points at nothing", () => {
  // Not an empty paragraph left where the helper text was, and not an
  // `aria-describedby` naming an element that was never rendered.
  for (const id of ["title", "ignorePaths", "maxFiles", "maxSearchLines"]) {
    assert.equal(
      HTML.includes(`id="${id}-hint"`),
      false,
      `${id} still carries a helper element`,
    );
    const control = new RegExp(`<(?:input|textarea)[^>]*id="${id}"[^>]*>`).exec(HTML)?.[0] ?? "";
    assert.notEqual(control, "", id);
    assert.match(control, new RegExp(`aria-describedby="${id}-error"`), `${id} describedby`);
    // The label is still the accessible name — a placeholder is an example,
    // never a label.
    assert.match(HTML, new RegExp(`<label[^>]*for="${id}"`), `${id} lost its label`);
    assert.match(control, /placeholder="/, `${id} should show an example instead`);
  }
});

test("the label is stronger than the helper beside it", () => {
  assert.match(CSS, /\.setting-header > label \{[^}]*font-weight: 600/s);
  assert.match(CSS, /\.setting-header > label \{[^}]*var\(--vscode-foreground\)/s);
  assert.match(CSS, /\.hint \{[^}]*var\(--vscode-descriptionForeground\)/s);
  assert.match(CSS, /\.hint \{[^}]*font-size: 0\.9em/s);
});

test("a helper that does not fit wraps below its label rather than truncating", () => {
  // Responsive by construction: a floor under the helper, no breakpoint, and
  // nothing that could clip it. The panel is resizable to about 200px and
  // renders in both a sidebar and an editor tab, so no width can be assumed.
  assert.match(CSS, /\.setting-header \{[^}]*flex-wrap: wrap/s);
  assert.match(CSS, /\.setting-header > \.hint \{[^}]*flex: 1 1 \d+px/s);
  // The two things that would break it.
  assert.equal(/\.setting-header[^{]*\{[^}]*white-space: nowrap/s.test(CSS), false);
  assert.equal(/\.hint[^{]*\{[^}]*text-overflow/s.test(CSS), false);
});

test("the section is compact without being cramped", () => {
  // Roughly: 5px from a header to its control, 14px to the next setting. Named
  // here because "compact" is otherwise a matter of opinion that drifts.
  assert.match(CSS, /\.setting-header \{[^}]*margin-bottom: 5px/s);
  assert.match(CSS, /\.field \{[^}]*margin-bottom: 14px/s);
});

test("each icon carries the tone its kind of setting means", () => {
  // The whole mapping in one place, so a change to it is a decision rather
  // than a drift: blue for general/search/AI, yellow for guidance, grey for
  // ordinary file settings, red for exclusion.
  const expected: Record<string, string> = {
    hint: "icon-hint",
    keywords: "icon-primary",
    focusFiles: "icon-muted",
    ignorePaths: "icon-danger",
    maxFiles: "icon-muted",
    maxSearchLines: "icon-primary",
    agent: "icon-primary",
    agentCommand: "icon-primary",
    title: "icon-muted",
  };
  for (const [id, tone] of Object.entries(expected)) {
    const label = new RegExp(`<label[^>]*for="${id}"[^>]*>(.*?)</label>`, "s").exec(HTML)?.[1];
    assert.ok(label, `no label for ${id}`);
    assert.match(label, new RegExp(`\\b${tone}\\b`), `${id} should be ${tone}`);
  }
  // Advanced Settings' gear takes the entry's quiet colour (§37.91); the two
  // icons the page script creates keep theirs.
  assert.match(HTML, /<button type="button" id="open-settings"[^>]*>\s*<span class="codicon codicon-settings-gear" aria-hidden="true"><\/span>/);
  assert.match(HTML, /codicon-check icon-success/);
  assert.match(PAGE_JS, /codicon-warning icon-warning/);
});

test("the palette is six tones, defined once, in theme variables", () => {
  // One `:root` block rather than colours scattered through the rules, and no
  // literals: a hex fallback is exactly what breaks a light or high-contrast
  // theme, which is why every tone is a chain of --vscode-* tokens ending at
  // one this stylesheet already relies on.
  const root = /:root \{[\s\S]*?\}/.exec(CSS)?.[0] ?? "";
  assert.notEqual(root, "", "no :root palette");
  const tones = [...root.matchAll(/--bugpilot-icon-([a-z]+):/g)].map((match) => match[1]);
  assert.deepEqual(
    [...tones].sort(),
    ["danger", "hint", "muted", "primary", "success", "warning"],
    "the palette should stay six tones",
  );
  for (const tone of tones) {
    assert.match(CSS, new RegExp(`\\.icon-${tone} \\{[^}]*var\\(--bugpilot-icon-${tone}\\)`, "s"));
  }
  // Every value in the palette is a variable reference, all the way down.
  // Split on `;` rather than on newlines: a declaration is allowed to wrap,
  // and one of these does.
  const declarations = root
    .split(";")
    .map((entry) => entry.trim())
    .filter((entry) => entry.includes("--bugpilot-icon-"));
  assert.equal(declarations.length, tones.length);
  for (const declaration of declarations) {
    assert.match(
      declaration,
      /var\(--vscode-/,
      `${declaration.split(":")[0]} does not use a theme token`,
    );
  }
});

test("only the icon is tinted, never the label or the helper text", () => {
  // "[Yellow lightbulb] Hint helper" — not a yellow row. The tone classes may
  // only ever appear on a codicon span.
  for (const match of HTML.matchAll(/<[^>]*\bicon-(primary|hint|danger|muted|success|warning)\b[^>]*>/g)) {
    assert.match(match[0], /class="[^"]*\bcodicon\b/, `a tone on a non-icon element: ${match[0]}`);
  }
  // And the label's own colour is still the editor's foreground.
  assert.match(CSS, /\.setting-header > label \{[^}]*var\(--vscode-foreground\)/s);
  assert.equal(
    /\.setting-header > label \{[^}]*--bugpilot-icon/s.test(CSS),
    false,
    "the label must not take an icon tone",
  );
});

test("every field on the settings page carries an icon, so it can be scanned", () => {
  // A gap in that column is more distracting than an icon, which is why this
  // checks all of them rather than the ones the design named.
  for (const id of [...SETTINGS_FIELD_IDS, "agent", "add-attachment"]) {
    const label = new RegExp(`<label[^>]*for="${id}"[^>]*>(.*?)</label>`, "s").exec(SETTINGS_VIEW)?.[1];
    assert.ok(label, `no label for ${id}`);
    assert.match(label, /codicon-[a-z-]+/, `${id} has no icon`);
  }
});

test("the two limits share a row that is allowed to wrap", () => {
  // Side by side when there is room, stacked when there is not — decided by
  // `flex-wrap` and a floor rather than a breakpoint, because the panel is
  // resizable to about 200px and lives in both a sidebar and an editor tab.
  const limits = /<div class="limits">[\s\S]*?<\/div>\s*<\/div>/.exec(HTML)?.[0] ?? "";
  assert.ok(limits.includes('id="field-maxFiles"'), "maxFiles is not in the row");
  assert.ok(limits.includes('id="field-maxSearchLines"'), "maxSearchLines is not in the row");
  assert.match(CSS, /\.limits \{[^}]*flex-wrap: wrap/);
  assert.match(CSS, /\.limits > \.field \{[^}]*flex: 1 1 \d+px/);
});

test("the limits show their defaults without pretending to hold them", () => {
  // A placeholder, not a value. An empty field means "let the CLI decide" and
  // `buildPrepareArgs` then omits the flag; typing 10 in would start sending
  // --max-files=10 on every run and pin it against the CLI's own default
  // changing.
  assert.match(HTML, /id="maxFiles"[^>]*placeholder="10"/);
  assert.match(HTML, /id="maxSearchLines"[^>]*placeholder="300"/);
  assert.equal(/value="10"|value="300"/.test(HTML), false, "a real value would reach argv");
  // Neither the old "Default: 10" chip nor a sentence restating the label.
  assert.equal(/Default: ?10|Default: ?300/.test(HTML), false, "the default chips are gone");
  assert.equal(/Maximum number of/.test(HTML), false, "the number in the box says this already");
});

test("every field that can hold a paragraph is multi-line", () => {
  // Hint and Keywords were single-line inputs, which scroll sideways: a
  // developer who typed a sentence could no longer see the start of it. The
  // list is also what `parseKeywords` assumes — it splits on newlines, which
  // needs somewhere to type one.
  for (const id of ["issue", "hint", "keywords", "focusFiles", "ignorePaths"]) {
    assert.match(HTML, new RegExp(`<textarea[^>]*id="${id}"`), `${id} is not multi-line`);
    assert.equal(
      new RegExp(`<input[^>]*id="${id}"`).test(HTML),
      false,
      `${id} went back to a single line`,
    );
  }
});

test("the page grows exactly the form fields the markup made multi-line", () => {
  // Both directions, because neither failure is visible: a textarea missing
  // from the list silently stops growing, and an id in the list that no longer
  // matches a textarea grows nothing at all.
  //
  // The subject is the run form. Its controls carry a `name`, which is what
  // separates them from the Fix Mode editor's section boxes below — a separate
  // surface, reached from the gear, that keeps the height `rows` gives it.
  const declared = /const GROWING_FIELDS = \[([^\]]*)\]/.exec(PAGE_JS)?.[1] ?? "";
  const grown = [...declared.matchAll(/"([^"]+)"/g)].map((match) => match[1]!);
  const textareas = [...HTML.matchAll(/<textarea[^>]*name="([^"]+)"/g)].map((match) => match[1]!);
  assert.ok(textareas.length > 0, "expected the form to have textareas");
  assert.deepEqual(grown.sort(), textareas.sort());
});

test("the Fix Mode editor's section boxes are deliberately not grown", () => {
  // Recorded as a decision rather than left looking like an oversight. The
  // growing fields are typed into while composing a run; the editor is a
  // different surface with its own preview, and its boxes stay the size `rows`
  // asks for. They still inherit the ceiling from the stylesheet.
  //
  // It is also a trap worth guarding: `grow` is driven by the form's `input`
  // listener, so an editor id added to GROWING_FIELDS would be resized by
  // `growAll` and then never again while it was being typed into.
  const editors = [...HTML.matchAll(/<textarea[^>]*id="(editor-[^"]+)"/g)].map(
    (match) => match[1]!,
  );
  assert.ok(editors.length > 0, "expected the Fix Mode editor to have section boxes");
  const declared = /const GROWING_FIELDS = \[([^\]]*)\]/.exec(PAGE_JS)?.[1] ?? "";
  for (const id of editors) {
    assert.equal(declared.includes(`"${id}"`), false, `${id} grows but nothing resizes it`);
  }
});

test("growing has a ceiling, in the theme's own units", () => {
  // Without one, a pasted stack trace pushes Run off the bottom of the sidebar.
  // In em rather than px so it follows the font the theme chose.
  const rule = /textarea \{[^}]*\}/.exec(CSS)?.[0] ?? "";
  assert.match(rule, /max-height: [\d.]+em/, "nothing stops a field from growing");
  assert.match(rule, /overflow-y: auto/, "a capped field with no scrollbar hides its own text");
});

test("a path field says one-per-line by showing it", () => {
  // A multi-line placeholder does what a sentence about line breaks cannot.
  for (const id of ["focusFiles", "ignorePaths"]) {
    const tag = new RegExp(`<textarea[^>]*id="${id}"[^>]*>`).exec(HTML)?.[0] ?? "";
    assert.notEqual(tag, "", id);
    assert.match(tag, /placeholder="[^"]*&#10;/, `${id} has no multi-line placeholder`);
  }
});

test("the AI Agent picker is a label, the six options and one status line, and nothing else", () => {
  // The option text is the explanation, so the helper line and the note that
  // used to sit under it are both gone. What is not gone is the label: the
  // select is still named for a screen reader.
  const select = /<select id="agent"[\s\S]*?<\/select>/.exec(HTML)?.[0] ?? "";
  assert.deepEqual(
    [...select.matchAll(/<option value="([^"]+)">([^<]+)<\/option>/g)].map((match) => [match[1], match[2]]),
    [
      ["auto", "Auto-detect (Recommended)"],
      ["codex-cli", "Codex CLI"],
      ["claude-cli", "Claude CLI"],
      ["codex-extension", "Codex Extension"],
      ["claude-extension", "Claude Extension"],
      ["custom", "Custom command…"],
    ],
  );
  assert.match(HTML, /<label[^>]*for="agent"[^>]*>[\s\S]*?AI Agent<\/label>/);
  // The status line: quiet, announced politely, described by the select, empty
  // until the host says something.
  assert.match(select, /aria-describedby="agent-status"/);
  assert.match(HTML, /<p class="hint agent-status" id="agent-status" aria-live="polite" hidden><\/p>/);
  assert.equal(/id="agent-hint"/.test(HTML), false);
  assert.equal(/id="agent-auto-note"/.test(HTML), false);
  // And the rule it left behind: no dead stylesheet for a removed element.
  assert.equal(/\.note \{/.test(CSS), false, "the note's CSS outlived the note");
});

test("deleting artifacts is described, and is not recommended", () => {
  const row = /<div class="field field-check">[\s\S]*?<\/div>/.exec(HTML)?.[0] ?? "";
  assert.notEqual(row, "", "no checkbox row");
  const box = /<input type="checkbox" id="fresh"[^>]*>/.exec(row)?.[0] ?? "";
  assert.notEqual(box, "", "no checkbox");
  // The one thing about this control that must never drift.
  assert.equal(/ checked/.test(box), false, "Delete previous artifacts must start off");
  assert.match(row, /Off by default to avoid accidental data loss/);
});

test("the repository notice is a card, not loose footer text", () => {
  // Its text is host-computed, so the markup only has to provide the container
  // — and prove the footer no longer carries it.
  assert.match(HTML, /<section id="notices"[^>]*role="status"[^>]*hidden>/);
  const footer = /<footer[\s\S]*?<\/footer>/.exec(HTML)?.[0] ?? "";
  assert.equal(footer.includes('id="warnings"'), false, "the footer still holds the warning");
  assert.match(CSS, /\.notice \{/);
});

test("the footer is secondary to everything above it", () => {
  const footer = /<footer[\s\S]*?<\/footer>/.exec(HTML)?.[0] ?? "";
  assert.match(footer, /id="environment"/);
  assert.match(footer, /Jira:/);
  assert.match(footer, /id="set-credentials"/, "the credentials link must stay clickable");
  // Smaller and dimmer by rule, not by hope.
  assert.match(CSS, /\.footer \{[^}]*font-size: 0\.9em/s);
  assert.match(CSS, /\.footer \{[^}]*var\(--vscode-descriptionForeground\)/s);
});

test("every optional field is on the Workflow Settings page, and none is on the form", () => {
  assert.notEqual(SETTINGS_VIEW, "", "could not find the settings page");
  for (const id of [...SETTINGS_FIELD_IDS, "agent", "attachments"]) {
    assert.ok(SETTINGS_VIEW.includes(`id="field-${id}"`), `${id} is not on the settings page`);
    assert.equal(HTML.split(`id="field-${id}"`).length - 1, 1, `${id} has a second copy`);
  }
  assert.ok(SETTINGS_VIEW.includes('id="fresh"'));
  // The form keeps the issue, Fix Mode, Hint, the run, the workflow's
  // checkboxes — nothing else.
  const form = /<form id="form"[\s\S]*?<\/form>/.exec(HTML)?.[0] ?? "";
  for (const id of [...SETTINGS_FIELD_IDS, "agent", "fresh", "add-attachment"]) {
    assert.equal(form.includes(`id="${id}"`), false, `${id} is still on the form`);
  }
  // And Fix Mode and Hint the other way round: on the form, once, never on the settings page.
  for (const id of ["fixModeId", "hint", "useIssueDetails", "improve-hint", "manage-fix-modes"]) {
    assert.ok(form.includes(`id="${id}"`), `${id} is not on the form`);
    assert.equal(SETTINGS_VIEW.includes(`id="${id}"`), false, `${id} is still on the settings page`);
    assert.equal(HTML.split(`id="${id}"`).length - 1, 1, `${id} has a second copy`);
  }
});

test("the primary action, Stop and the ⋯ menu are one row, in that order", () => {
  // Their first home was the bottom of the form, below Advanced settings — far
  // from the button whose run they act on. Retry used to be the third; it is
  // Start New Attempt now, inside the menu, and only once an attempt exists.
  // The Run row's own buttons — not the Hint suggestion's, which sits above it now.
  const row = /<div class="run">\s*<div class="run-buttons">[\s\S]*?<\/div>/.exec(HTML)?.[0] ?? "";
  assert.notEqual(row, "", "could not find the button row");
  const buttons = [...row.matchAll(/<button[^>]*id="([a-z-]+)"/g)].map((match) => match[1]);
  assert.deepEqual(buttons, ["run", "stop", "more-actions"]);
  assert.equal(HTML.includes('id="retry"'), false, "Retry is still a button of its own");
  // Hidden in the markup too, not just after the first state push: the page is
  // built before the host answers, and both would flash there.
  for (const id of ["stop", "more-actions"]) {
    assert.match(row, new RegExp(`id="${id}"[^>]*hidden`), `${id} should start hidden`);
  }
  // The menu button says what it is to a screen reader, and which list it opens.
  assert.match(row, /id="more-actions"[^>]*aria-label="More actions"[^>]*aria-haspopup="menu"[^>]*aria-expanded="false"[^>]*aria-controls="more-menu"/);
  // Run is the only one that is always there, so it is the one that stretches.
  assert.match(CSS, /#run\s*\{[^}]*flex:\s*1/);
  assert.match(CSS, /#stop,\s*#more-actions\s*\{\s*flex: none;/);
});

test("the ⋯ menu holds Start New Attempt, Rebuild Context and Open AI Session, all hidden until offered", () => {
  const menu = /<div class="more-menu" id="more-menu" role="menu" aria-label="More actions" hidden>[\s\S]*?<\/div>/.exec(HTML)?.[0] ?? "";
  assert.notEqual(menu, "", "no menu under the button row");
  const items = [...menu.matchAll(/<button type="button" role="menuitem" class="menu-item" id="menu-([A-Za-z]+)" title="[^"]+" hidden>/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(items, ["startNewAttempt", "rebuildContext", "openSession"]);
  assert.match(menu, /<span>Start New Attempt<\/span>/);
  assert.match(menu, /<span>Rebuild Context<\/span>/);
  // Nothing in it is a primary button, and nothing is called Retry, Resume or Fresh.
  assert.equal(menu.includes('class="primary"'), false);
  for (const word of ["Retry", "Resume", "Fresh"]) assert.equal(menu.includes(word), false, `the menu says ${word}`);
  // And it lets `hidden` win, like the button row does.
  assert.match(CSS, /\.more-menu\[hidden\] \{\s*display: none;/);
  assert.match(CSS, /\.menu-item\[hidden\] \{\s*display: none;/);
});

test("Start New Attempt's form: optional feedback, the example, two helpers, Cancel and Start", () => {
  const form = /<div class="attempt-editor"[\s\S]*?<div class="attempt-actions">[\s\S]*?<\/div>\s*<\/div>/.exec(HTML)?.[0] ?? "";
  assert.notEqual(form, "", "no attempt form");
  assert.match(form, /Start a new AI attempt/);
  assert.match(form, /<label for="attempt-feedback">Optional feedback<\/label>/);
  assert.match(form, /<textarea id="attempt-feedback" rows="4" placeholder="What should the new attempt do differently\?"/);
  assert.match(form, /The previous fix changed the wrong class\. Focus on WidgetController\.cpp and keep the existing public API unchanged\./);
  // Said before it happens: feedback is written, empty is not.
  assert.match(form, /saved to user_feedback\.md[^<]*Left empty, nothing is written\./);
  // The helpers start hidden; the host lists them only when their files exist.
  assert.match(form, /id="attempt-helpers" hidden>/);
  assert.match(form, /id="use-review-findings"[^>]*hidden>[\s\S]*?<span>Use Review Findings<\/span>/);
  assert.match(form, /id="use-verification-evidence"[^>]*hidden>[\s\S]*?<span>Use Verification Evidence<\/span>/);
  // Cancel, then Start — quiet buttons, not a second primary.
  const actions = /<div class="attempt-actions">[\s\S]*?<\/div>/.exec(form)?.[0] ?? "";
  assert.deepEqual([...actions.matchAll(/<button[^>]*id="([a-z-]+)"/g)].map((match) => match[1]), ["cancel-attempt", "start-attempt"]);
  assert.equal(form.includes('class="primary"'), false);
  // A group, not a nested <form>: that would submit the panel — a Run.
  assert.equal(/<form\b/.test(form), false);
  // Nothing on it overclaims what a new attempt is.
  for (const claim of ["Retry", "verified", "approved", "fixed"]) {
    assert.equal(form.replace(/<!--[\s\S]*?-->/g, "").includes(claim), false, `the form says "${claim}"`);
  }
});

test("Run is one prominent button with its shortcut spelled out", () => {
  assert.match(HTML, /<button type="submit" id="run" class="primary">/);
  assert.match(HTML, /codicon-play/);
  assert.match(HTML, /Ctrl\+Enter/);
  // What Run does, and — since UI-A1 — what it does not: preparing context is
  // not fixing code, and the sentence has to survive a developer skimming it.
  assert.match(HTML, /Run prepares the issue context for AI-assisted fixing\./);
});

test("issue details is shown as fixed, not as an option that does nothing", () => {
  assert.match(HTML, /id="plan-issueDetails"[^>]*checked disabled/);
  assert.match(HTML, /Always runs/);
});

test("the live regions announce themselves", () => {
  assert.match(HTML, /id="activity"[^>]*aria-live="polite"/);
  assert.match(HTML, /id="failure"[^>]*role="alert"/);
  assert.match(HTML, /id="blocked"[^>]*role="alert"/);
});

// --- the page script -------------------------------------------------------

test("the page never assigns markup", () => {
  // Bug titles come from Jira and failure text from a CLI's stderr. Assigning
  // either as HTML would turn a bug report into script in the panel.
  for (const forbidden of ["innerHTML", "outerHTML", "insertAdjacentHTML", "document.write", "eval("]) {
    assert.equal(PAGE_JS.includes(forbidden), false, `panel.js uses ${forbidden}`);
  }
  assert.match(PAGE_JS, /textContent/);
});

test("every element the page reaches for exists in the document", () => {
  // A renamed id fails silently in a webview: `null.textContent` throws inside
  // a message handler nobody is watching, and the panel simply stops updating.
  const ids = new Set(
    [...PAGE_JS.matchAll(/byId\("([^"]+)"\)/g)].map((match) => match[1]!),
  );
  for (const field of TEXT_FIELD_IDS) {
    ids.add(field);
    ids.add(`field-${field}`);
    ids.add(`${field}-error`);
  }
  // The per-step ids are built from a template in the page, so the literal
  // scan above cannot see them — and a renamed row would fail silently.
  for (const step of WORKFLOW_STEP_IDS) {
    ids.add(`plan-${step}`);
    ids.add(`step-${step}`);
    ids.add(`status-${step}`);
    ids.add(`duration-${step}`);
    ids.add(`description-${step}`);
  }
  for (const id of ids) {
    assert.ok(new RegExp(`id="${id}"`).test(HTML), `panel.js uses #${id}, which the page lacks`);
  }
});

test("the page's field list is the document's field list", () => {
  const block = /const TEXT_FIELDS = \[([\s\S]*?)\];/.exec(PAGE_JS);
  assert.ok(block, "could not find TEXT_FIELDS in panel.js");
  const fields = [...block[1]!.matchAll(/"([a-zA-Z]+)"/g)].map((match) => match[1]!);
  assert.deepEqual(fields.sort(), [...TEXT_FIELD_IDS].sort());
});

test("state is kept with setState, not by pinning the webview in memory", () => {
  // §5.4 names retainContextWhenHidden as the thing not to use: it holds the
  // page resident for the whole session to save a rebuild that costs nothing.
  assert.match(PAGE_JS, /vscode\.setState\(/);
  assert.match(PAGE_JS, /vscode\.getState\(/);
  assert.equal(PAGE_JS.includes("retainContextWhenHidden"), false);
});

test("the markup's defaults are the model's defaults", () => {
  // The host pushes a form on load, but a page rendered before that arrives
  // must still tell the truth: with the boxes unticked, a Run means
  // --only-issue-details, an investigation that searches nothing.
  const fixTag = /<input[^>]*id="plan-fixWithAI"[^>]*>/.exec(HTML)?.[0] ?? "";
  assert.equal(/ checked/.test(fixTag), DEFAULT_FORM.fixWithAI);
  for (const [field, expected] of Object.entries(DEFAULT_FORM.plan)) {
    const tag = new RegExp(`<input[^>]*id="plan-${field}"[^>]*>`).exec(HTML)?.[0] ?? "";
    assert.notEqual(tag, "", `no checkbox for plan-${field}`);
    assert.equal(/ checked/.test(tag), expected, `plan-${field} default disagrees with the model`);
  }
});

test("an artifact name must be a plain file name", () => {
  // The host opens what it is given, and a bare "." or "" names the directory
  // itself rather than a file in it.
  for (const name of ["", ".", "..", "-rf", "a/b", "a\b", "a b.md"]) {
    assert.equal(parsePanelMessage({ type: "openArtifact", name }), undefined, JSON.stringify(name));
  }
  for (const name of ["task.md", "context.md", "retrieval.json", "run.json"]) {
    assert.ok(parsePanelMessage({ type: "openArtifact", name }), name);
  }
});


test("the page's checkbox list is the document's checkbox list", () => {
  const block = /const PLAN_FIELDS = \[([\s\S]*?)\];/.exec(PAGE_JS);
  assert.ok(block, "could not find PLAN_FIELDS in panel.js");
  const fields = [...block[1]!.matchAll(/"([a-zA-Z]+)"/g)].map((match) => match[1]!);
  // The page's five are the plan; the sixth row is read separately, because it
  // is not part of `form.plan` and must not become a CLI flag.
  assert.deepEqual(fields, WORKFLOW_STEP_IDS.filter((id) => id !== "fixWithAI"));
  assert.match(PAGE_JS, /byId\("plan-fixWithAI"\)\.checked/);
});

test("Ctrl+Enter runs, from anywhere in the form", () => {
  // Enter alone belongs to the description textarea, so the shortcut the panel
  // advertises has to be the one the page listens for.
  assert.match(PAGE_JS, /"keydown"/);
  assert.match(PAGE_JS, /event\.key === "Enter" && \(event\.ctrlKey \|\| event\.metaKey\)/);
});

test("attachments are a list the page renders, not a text field", () => {
  // The row has no input: the paths come from the editor's file dialog, which
  // only the host can open. A webview must never be able to name a path.
  const row = /<div class="field" id="field-attachments">[\s\S]*?<button[^>]*id="add-attachment"/.exec(
    HTML,
  )?.[0] ?? "";
  assert.notEqual(row, "", "no attachments row");
  assert.match(row, /<ul id="attachment-list"[^>]*hidden>/, "the list starts empty and hidden");
  assert.equal(/<input[^>]*id="attachments"/.test(HTML), false, "there must be no path input");
  assert.match(HTML, /codicon-attach/);
});

test("the page can remove an attachment but never invent one", () => {
  // The only way a path enters the page is a state push from the host; the
  // only message the page sends about them asks the host to open the dialog.
  assert.match(PAGE_JS, /type: "pickAttachments"/);
  assert.equal(/type: "addAttachments"/.test(PAGE_JS), false, "the page still merges into the host's form directly");
  assert.equal(
    /attachments\.push\(|attachments = \[\.\.\.attachments, /.test(PAGE_JS),
    false,
    "the page appends a path of its own",
  );
  assert.match(PAGE_JS, /attachments\.filter\(/, "no way to remove one");
});

test("the attachment ceiling is the one the CLI enforces", () => {
  // Duplicated across two languages, like the Jira key pattern and the error
  // table, so the check reads the Python source rather than trusting memory.
  const python = readFileSync(
    new URL("../../bugpilot/core/attachments.py", import.meta.url),
    "utf8",
  );
  const declared = /MAX_ATTACHMENTS = (\d+)/.exec(python)?.[1];
  assert.ok(declared, "could not find MAX_ATTACHMENTS in attachments.py");
  assert.equal(MAX_ATTACHMENTS, Number(declared));
});

// --- fix mode --------------------------------------------------------------

test("the one Fix Mode selector is on the form, under the Issue, with its gear and description", () => {
  assert.equal((HTML.match(/<select[^>]*id="fixModeId"/g) ?? []).length, 1, "not exactly one Fix Mode selector");
  assert.equal(HTML.split('id="field-fixModeId"').length - 1, 1);
  assert.equal(HTML.split('id="manage-fix-modes"').length - 1, 1);

  const form = /<form id="form"[\s\S]*?<\/form>/.exec(HTML)?.[0] ?? "";
  const field = /<div class="field" id="field-fixModeId">[\s\S]*?id="fixModeId-description"[^>]*><\/p>\s*<\/div>/.exec(form)?.[0] ?? "";
  assert.notEqual(field, "", "the Fix Mode field is not on the form");
  // Its description and its gear are with it: the gear still sits beside the
  // selector it manages.
  assert.ok(field.includes('<select id="fixModeId"'));
  assert.ok(field.includes('id="manage-fix-modes"'), "the gear did not move with the selector");
  assert.ok(field.includes('id="fixModeId-description"'), "the mode's description stayed behind");
  // On the form, a field like the Issue: no "Requires context rebuild" label —
  // the host says a context is stale, from the fingerprint, as for the Issue.
  assert.equal(field.includes("rebuild-label"), false);
  // And none of it on the settings page.
  for (const id of ["fixModeId", "field-fixModeId", "manage-fix-modes", "fixModeId-description"]) {
    assert.equal(SETTINGS_VIEW.includes(`id="${id}"`), false, `#${id} is still on the settings page`);
  }
});

test("the Advanced Settings entry is the button alone: the Fix Mode is on the form, in plain view", () => {
  const entry = /<div class="settings-entry">[\s\S]*?<\/div>/.exec(HTML)?.[0] ?? "";
  assert.notEqual(entry, "", "no settings entry");
  const button = /<button type="button" id="open-settings"[\s\S]*?<\/button>/.exec(entry)?.[0] ?? "";
  assert.match(button, /codicon-settings-gear/);
  assert.match(button, /Advanced Settings/);
  // The line that named a non-default mode beside it was for a selector hidden
  // on the settings page; it is gone with that.
  for (const gone of ["settings-strategy", "aria-describedby"]) assert.equal(entry.includes(gone), false, gone);
  assert.equal(CSS.includes(".settings-strategy"), false);
});

test("the Fix Mode selector is labelled and described for assistive tech", () => {
  assert.ok(HTML.includes('<label for="fixModeId"'), "the selector has no label");
  // What the setting is for and what the chosen mode does, both announced.
  const described = /<select id="fixModeId"[^>]*aria-describedby="([^"]+)"/.exec(HTML)?.[1] ?? "";
  assert.deepEqual(described.split(" ").sort(), ["fixModeId-description", "fixModeId-hint"]);
  assert.ok(HTML.includes('id="fixModeId-description"'));
  assert.ok(HTML.includes('id="fixModeId-hint"'));
  // The gear names what it does, for a screen reader and for a hover.
  assert.match(HTML, /id="manage-fix-modes"[^>]*title="Manage Fix Modes"[^>]*aria-label="Manage Fix Modes"/);
});

test("the page markup does not name any Fix Mode", () => {
  // The options are filled from `fix-mode list --json`; a name here would go
  // stale silently the day a mode is renamed or added.
  for (const name of ["Standard Fix", "Conservative Fix", "Investigate First"]) {
    assert.ok(!HTML.includes(name), `the markup hard-codes the mode name ${name}`);
  }
});

test("the panel declares its views, and only the form starts visible", () => {
  // The contract showView() rests on: one section per view, all siblings, and
  // every Fix Mode one hidden in the markup — so a webview that never receives
  // a state push is still a plain, working form.
  //
  // Four sections carry five views: New Fix Mode and Edit Fix Mode share the
  // editor form rather than declaring eleven fields and their ids twice. What
  // separates them is the title and the way back, which `page.test.ts` checks.
  const views = [
    "main-view",
    "fix-mode-manager-view",
    "fix-mode-preview-view",
    "fix-mode-editor-view",
  ];
  for (const id of views) {
    assert.match(HTML, new RegExp(`<section id="${id}"`), `no #${id} in the document`);
  }
  const opening = (id: string) => new RegExp(`<section id="${id}"[^>]*>`).exec(HTML)?.[0] ?? "";
  assert.equal(/ hidden/.test(opening("main-view")), false);
  for (const id of views.slice(1)) {
    assert.equal(/ hidden/.test(opening(id)), true, `#${id} does not start hidden`);
  }
});

test("the Fix Mode views sit beside the form, never inside it", () => {
  // Inside <form> they would submit with it, and Ctrl+Enter typed in a mode's
  // instructions would start a run.
  const form = HTML.slice(HTML.indexOf('<form id="form"'), HTML.indexOf("</form>"));
  for (const id of [
    "fix-mode-manager-view",
    "fix-mode-preview-view",
    "fix-mode-editor-view",
    "manage-list",
    "preview-body",
    "editor-save",
  ]) {
    assert.ok(!form.includes(`id="${id}"`), `#${id} is inside the run form`);
  }
});

test("each Fix Mode view says where back goes, and can take focus on arrival", () => {
  for (const [view, back, heading] of [
    ["fix-mode-manager-view", "manage-back", "manage-heading"],
    ["fix-mode-preview-view", "preview-back", "preview-heading"],
    ["fix-mode-editor-view", "editor-back", "editor-title"],
  ]) {
    const start = HTML.indexOf(`id="${back}"`);
    const button = HTML.slice(start, HTML.indexOf("</button>", start));
    assert.match(button, /Back/, `${view} has no back control with a readable name`);
    // Focused when the view opens, so assistive tech announces the new place.
    // A heading is not focusable on its own.
    assert.match(
      new RegExp(`id="${heading}"[^>]*`).exec(HTML)?.[0] ?? "",
      /tabindex="-1"/,
      `#${heading} cannot take focus when its view opens`,
    );
    assert.match(
      new RegExp(`<section id="${view}"[^>]*`).exec(HTML)?.[0] ?? "",
      new RegExp(`aria-labelledby="${heading}"`),
      `${view} is not named by its own heading`,
    );
  }
});

test("a view header stacks, so a narrow sidebar never has to fit it on one line", () => {
  // The panel is resizable down to about 200px. Back above the heading rather
  // than beside it also puts the way out first in the tab order.
  const rule = /\.view-head \{[^}]*\}/.exec(CSS)?.[0] ?? "";
  assert.match(rule, /flex-direction: column/, "the view header is not stacked");
});

test("a Fix Mode id from the page is shape-checked before it can become a flag", () => {
  const base = { type: "run", form: { ...DEFAULT_FORM, issueKey: "JR-1" } };
  const parsed = parsePanelMessage({ ...base, form: { ...base.form, fixModeId: "conservative" } });
  assert.equal(parsed?.type === "run" && parsed.form.fixModeId, "conservative");

  for (const hostile of ["../../etc/passwd", "Conservative", "a b", "", 7, null]) {
    const message = parsePanelMessage({ ...base, form: { ...base.form, fixModeId: hostile } });
    assert.equal(
      message?.type === "run" && message.form.fixModeId,
      "",
      `${JSON.stringify(hostile)} should not survive as a mode id`,
    );
  }
});

test("a class that sets display must let the hidden attribute win", () => {
  // The bug this exists for: `hidden` is only a UA-stylesheet
  // `display: none`, so ANY author rule that sets `display` on the same
  // element beats it and the "hidden" section renders. It shipped as three Fix
  // Mode views laid out down the Main view, under Advanced settings.
  //
  // The file already answers this for `.field`, `.attachments`, `.notices` and
  // the step rows. This is the same answer, enforced: every class the markup
  // ever pairs with `hidden` and that CSS gives a `display` must also carry a
  // `[hidden]` rule turning it back off.
  const hiddenClasses = new Set<string>();
  for (const tag of HTML.matchAll(/<[a-z][^>]*>/g)) {
    if (!/\shidden(\s|>|=)/.test(tag[0])) continue;
    const classes = /class="([^"]+)"/.exec(tag[0])?.[1] ?? "";
    for (const name of classes.split(/\s+/).filter(Boolean)) hiddenClasses.add(name);
  }
  assert.ok(hiddenClasses.size > 0, "no element in the markup uses hidden with a class");

  const declaresDisplay = (selector: string): boolean => {
    const rule = new RegExp(`(^|[,}])\\s*\\${selector}\\s*\\{([^}]*)\\}`, "m").exec(CSS);
    return rule !== null && /(^|[;{\s])display\s*:/.test(rule[2] ?? "");
  };

  for (const name of hiddenClasses) {
    if (!declaresDisplay(`.${name}`)) continue;
    assert.ok(
      new RegExp(`\\.${name}\\[hidden\\]\\s*\\{[^}]*display\\s*:\\s*none`).test(CSS),
      `.${name} sets display, so a .${name}[hidden] { display: none } rule is ` +
        "what stops a hidden element from laying itself out anyway",
    );
  }
});

/**
 * Every element with an id, and the ids of the elements it sits inside.
 *
 * A structural read rather than a string search: "is the editor inside
 * Advanced settings" is a question about ancestry, and `HTML.includes(...)`
 * answers a different one. Outermost ancestor first.
 */
function ancestorsById(html: string): Map<string, string[]> {
  const VOID = new Set([
    "area", "base", "br", "col", "embed", "hr", "img", "input",
    "link", "meta", "param", "source", "track", "wbr",
  ]);
  const found = new Map<string, string[]>();
  const open: { tag: string; id: string }[] = [];
  const tags = /<!--[\s\S]*?-->|<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*)>/g;
  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    const tag = match[2];
    if (tag === undefined) continue; // a comment
    const name = tag.toLowerCase();
    if (match[1]) {
      for (let i = open.length - 1; i >= 0; i--) {
        if (open[i]!.tag === name) {
          open.length = i;
          break;
        }
      }
      continue;
    }
    const attributes = match[3] ?? "";
    if (VOID.has(name) || attributes.trimEnd().endsWith("/")) continue;
    const id = /id="([^"]+)"/.exec(attributes)?.[1] ?? "";
    if (id) found.set(id, open.map((element) => element.id).filter(Boolean));
    open.push({ tag: name, id });
  }
  return found;
}

const FIX_MODE_VIEWS = [
  "workflow-settings-view",
  "fix-mode-manager-view",
  "fix-mode-preview-view",
  "fix-mode-editor-view",
];

test("the Fix Mode views are siblings of the main view, not part of it", () => {
  // Manual testing found all three laid out down the main view, under Advanced
  // settings. The cause was CSS rather than nesting, but the nesting is what
  // made the symptom that shape, and it is worth pinning: inside #main-view
  // they would be hidden and shown along with the form, and inside <details>
  // they would inherit its open/closed state.
  const tree = ancestorsById(HTML);
  for (const view of [...FIX_MODE_VIEWS, "main-view"]) {
    assert.ok(tree.has(view), `the document has no #${view}`);
  }
  for (const view of FIX_MODE_VIEWS) {
    const above = tree.get(view)!;
    for (const forbidden of ["main-view", "form"]) {
      assert.ok(!above.includes(forbidden), `#${view} is inside #${forbidden}: ${above}`);
    }
    assert.deepEqual(above, tree.get("main-view"), `#${view} is not a sibling of #main-view`);
  }
  // And the other way round: the way into the settings page stays on the form.
  assert.deepEqual(tree.get("open-settings"), ["main-view", "form"]);
});

test("the management and editor controls live in their own views", () => {
  const tree = ancestorsById(HTML);
  for (const [id, view] of [
    ["manage-list", "fix-mode-manager-view"],
    ["manage-back", "fix-mode-manager-view"],
    ["preview-body", "fix-mode-preview-view"],
    ["preview-actions", "fix-mode-preview-view"],
    ["editor-save", "fix-mode-editor-view"],
    ["editor-objective", "fix-mode-editor-view"],
  ]) {
    assert.ok(tree.get(id!)?.includes(view!), `#${id} is not inside #${view}`);
    assert.ok(!tree.get(id!)?.includes("main-view"), `#${id} is inside the main view`);
  }
});

test("the markup alone hides everything but the form", () => {
  // Before any state arrives. A page that needs a message to stop showing three
  // views is one that shows them for however long the first run of the CLI
  // takes — which is exactly when a developer is looking at it.
  const opening = (id: string) => new RegExp(`<section id="${id}"[^>]*>`).exec(HTML)?.[0] ?? "";
  assert.equal(/\shidden(\s|>)/.test(opening("main-view")), false);
  for (const view of FIX_MODE_VIEWS) {
    assert.ok(/\shidden(\s|>)/.test(opening(view)), `#${view} does not start hidden`);
  }
});

// --- UI-A1: what an untouched panel shows ----------------------------------

test("the default view is the Issue field, Run, two disclosures and the way into settings", () => {
  // The whole of UI-A1 in one assertion. What a developer sees before typing
  // anything should be the sentence the tool is about — enter the issue, press
  // Run — and not every control the panel owns at equal weight.
  const form = /<form id="form"[\s\S]*?<\/form>/.exec(HTML)?.[0] ?? "";
  assert.notEqual(form, "", "could not find the form");

  // Everything the form shows before the first disclosure, in reading order.
  const visible = form.slice(0, form.indexOf("<details"));
  const open = [...visible.matchAll(/id="(field-[A-Za-z]+|run)"/g)].map((match) => match[1]);
  // The problem's definition, then Run (§37.84): Issue, Fix Mode, Hint.
  assert.deepEqual(open, ["field-issue", "field-fixModeId", "field-hint", "run"]);

  // And everything after it is behind one of exactly two closed disclosures,
  // or on the settings page, so no optional control is on screen until it is
  // asked for.
  //
  // The disclosures *inside* the workflow — Code search's two, and the failure
  // cards' Details — are not among them: they are inside a closed disclosure,
  // so not on screen either. Sliced out rather than filtered by name — an
  // earlier version of this matched `id="([a-z]+)"`, which excluded hyphenated
  // ids by accident and would have let a fourth top-level disclosure through
  // the day one was named without a hyphen.
  const topLevel = form
    .replace(/<ol class="steps">[\s\S]*?<\/ol>/, "")
    .replace(/<div id="failure" class="failure"[\s\S]*?<\/details>\s*<\/div>/, "");
  const disclosures = [...topLevel.matchAll(/<details[^>]*id="([a-z-]+)"/g)].map(
    (match) => match[1],
  );
  // Diagnostics is last and always reachable rather than inside the result,
  // because "is this the environment I think it is" is asked most urgently when
  // nothing has run or a run has just failed. Advanced settings was the third;
  // it is a page now, reached from the entry between the two.
  assert.deepEqual(disclosures, ["workflow", "diagnostics"]);
  // The way into Advanced Settings is with the inputs: under Run, above the workflow (§37.91).
  assert.ok(form.indexOf('id="run-hint"') < form.indexOf('id="open-settings"'));
  assert.ok(form.indexOf('id="open-settings"') < form.indexOf('id="workflow"'));
  assert.equal(/<details[^>]*\bopen\b/.test(form), false, "a disclosure starts open");
});

test("the Issue field is one box that says it takes either kind of input", () => {
  assert.match(HTML, /<label[^>]*for="issue">Issue<\/label>/, "the label is not 'Issue'");
  // Multi-line, because the same box holds a six-character key and a pasted
  // bug report.
  assert.match(HTML, /<textarea[^>]*id="issue"[^>]*placeholder="Enter a Jira ticket \(e\.g\. JR-12345\) or describe the bug"/);
  assert.equal(HTML.includes("Jira ticket or bug description"), false, "the old placeholder is still there");
  // One quiet line under the box says the same in words, and the box is described by it.
  assert.match(HTML, /<p class="hint" id="issue-hint">Use a Jira issue ID, or describe the problem directly\.<\/p>/);
  assert.match(HTML, /<textarea[^>]*id="issue"[^>]*aria-describedby="issue-hint issue-note issue-error"/);
  // Above Run, the problem's definition and nothing else, in tab order: the
  // Issue, how the AI approaches it, and the guidance it carries (§37.84).
  const beforeRun = HTML.slice(0, HTML.indexOf('id="run"'));
  const controls = [...beforeRun.matchAll(/<(?:input|textarea|select|button)[^>]*id="([A-Za-z-]+)"/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(
    controls,
    // Improve with AI before Include issue details: the action, then the option (§37.92).
    ["issue", "fixModeId", "manage-fix-modes", "hint", "improve-hint", "useIssueDetails", "hint-use", "hint-keep"],
    "the order above Run is not Issue, Fix Mode, Hint",
  );
});

test("the input source is no longer a question the panel asks", () => {
  // The radio pair it replaced. Named here because its return would not fail
  // anything else: the page would simply stop deriving the source.
  for (const gone of ['id="source-jira"', 'id="source-manual"', 'role="radiogroup"']) {
    assert.equal(HTML.includes(gone), false, `${gone} is back`);
  }
  assert.equal(/class="radios"/.test(CSS), false, "the radio row's styling outlived it");
});

test("the workflow is a disclosure whose summary carries its status", () => {
  // Collapsed, it is one line: what the section is, and where the run got to.
  // That line is the "Ready" UI-A1 asks for, and it needs no second element.
  const summary = /<summary class="workflow-summary">[\s\S]*?<\/summary>/.exec(HTML)?.[0] ?? "";
  assert.notEqual(summary, "", "the workflow has no summary line");
  assert.match(summary, /id="workflow-heading"/);
  assert.match(summary, /id="workflow-status"[^>]*role="status"/);
  // Inline, so the triangle, the heading and the status share a line and wrap
  // together; `display` on the summary itself would take the triangle away.
  assert.match(CSS, /\.workflow-summary > h2 \{[^}]*display: inline/s);
});

test("Run says what it is doing, in a label the page can replace", () => {
  assert.match(HTML, /<span class="codicon codicon-play" id="run-icon"/);
  assert.match(HTML, /<span id="run-label">Run<\/span>/);
});

// --- UI-A2: how Advanced Settings is organised -----------------------------

/** The markup of one group inside Advanced settings, heading excluded. */
function advancedGroup(id: string): string {
  const advanced = /<details[^>]*id="advanced"[\s\S]*?<\/details>/.exec(HTML)?.[0] ?? "";
  const start = advanced.indexOf(`id="group-${id}"`);
  assert.notEqual(start, -1, `no group heading #group-${id}`);
  const rest = advanced.slice(start);
  const next = rest.indexOf('<h3 class="setting-group"', 1);
  return next === -1 ? rest : rest.slice(0, next);
}

test("Workflow Settings is one section per step that has settings, in the workflow's order", () => {
  const sections = [...SETTINGS_VIEW.matchAll(/<h3 class="settings-section-title" id="settings-title-([a-z-]+)" tabindex="-1">([^<]+)</g)];
  assert.deepEqual(
    sections.map((match) => [match[1], match[2]]),
    WORKFLOW_SETTINGS_SECTIONS.map((section) => [section, SETTINGS_SECTION_TITLES[section]]),
  );
  assert.deepEqual(WORKFLOW_SETTINGS_SECTIONS, ["issue-details", "code-search", "build-context", "fix-with-ai"]);
  // Git history and Similar fixes have nothing to configure beyond their
  // checkbox: no section pretends otherwise.
  assert.equal(/settings-section-(git-history|similar-fixes)/.test(HTML), false);
  // Each says whether its changes need a rebuild — the model's sentence.
  for (const section of WORKFLOW_SETTINGS_SECTIONS) {
    assert.match(settingsSection(section), new RegExp(`id="settings-note-${section}">${sectionRebuildNote(section).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</p>`));
  }
  // No disclosures and no nested forms: one page, read top to bottom.
  assert.equal(/<details|<form/.test(SETTINGS_VIEW), false);
  assert.equal(/<details[^>]*\bopen\b/.test(HTML), false);
});

test("Issue details' section is the title and attachments; Build context's is Fresh", () => {
  const issue = settingsSection("issue-details");
  assert.deepEqual([...issue.matchAll(/id="field-([A-Za-z-]+)"/g)].map((match) => match[1]), ["title", "attachments"]);
  // The issue itself stays on the form, where a run is composed.
  assert.equal(SETTINGS_VIEW.includes('id="issue"'), false, "the Issue field moved off the form");
  const build = settingsSection("build-context");
  assert.match(build, /id="fresh"/);
  assert.match(build, /Changes here apply to the next run and do not require rebuilding context\./);
  for (const id of ["ignorePaths", "maxFiles", "maxSearchLines", "keywords", "focusFiles", "agent", "hint"]) {
    assert.equal(issue.includes(`id="field-${id}"`) || build.includes(`id="field-${id}"`), false, `${id} is in the wrong section`);
  }
});

test("Fix with AI's section is the agent and its command — Fix Mode and Hint are on the form", () => {
  const fix = settingsSection("fix-with-ai");
  const fields = [...fix.matchAll(/id="field-([A-Za-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(fields, ["agent", "agentCommand"]);
  for (const id of ["fixModeId", "hint", "useIssueDetails", "improve-hint", "hint-suggestion", "manage-fix-modes"]) {
    assert.equal(fix.includes(`id="${id}"`), false, `${id} is still under Fix with AI`);
  }
  // No mixed section any more: nothing here changes the prepared context.
  assert.equal(fix.includes("rebuild-label"), false);
  assert.match(fix, /Changes here apply to the next run and do not require rebuilding context\./);
  // And nothing that steers the search: a retrieval field here would defeat the section.
  for (const id of ["keywords", "focusFiles", "ignorePaths", "title", "maxFiles"]) {
    assert.equal(fix.includes(`id="field-${id}"`), false, `${id} is under Fix with AI`);
  }
});

test("Code search's section is everything that steers the search", () => {
  // Ignore paths and the two limits decide what the search walks and how much
  // of it reaches the context, which is the same kind of thing the first two do.
  const search = settingsSection("code-search");
  const fields = [...search.matchAll(/id="field-([A-Za-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(fields, ["keywords", "focusFiles", "ignorePaths", "maxFiles", "maxSearchLines"]);

  // "(optional)" in the label, not in a helper line: it is the first thing read,
  // and the point is that a blank box is not a job half done.
  assert.match(search, /<label[^>]*for="keywords">[\s\S]*?Keywords \(optional\)<\/label>/);
  assert.match(search, /<label[^>]*for="focusFiles">[\s\S]*?Focus Files \(optional\)<\/label>/);
  assert.match(search, /Boost retrieval with known identifiers or technical terms\./);
  assert.match(search, /Prioritize files you already suspect are relevant\./);
  assert.match(search, /Changes here require rebuilding context\./);
});

test("the panel never teaches the retrieval pipeline's own vocabulary", () => {
  // §33's concepts — weights, term budgets, probing, the search surface — are
  // how retrieval works, not something a developer types a keyword against.
  for (const term of [
    "SearchTerm",
    "weight",
    "weighting",
    "term budget",
    "search surface",
    "shape expansion",
    "MRR",
  ]) {
    assert.equal(
      HTML.toLowerCase().includes(term.toLowerCase()),
      false,
      `the panel names "${term}"`,
    );
  }
});

test("Improve with AI says it uses AI, with a tooltip that says what it will do", () => {
  const button = /<button type="button" id="improve-hint"[\s\S]*?<\/button>/.exec(HTML)?.[0] ?? "";
  assert.notEqual(button, "", "the Improve with AI button is gone");
  assert.match(button, /<span id="improve-hint-label">Improve with AI<\/span>/);
  assert.match(button, /title="Improve this guidance with AI while preserving your intent"/);
  // The vendored font has no spark glyph; hubot is its AI icon and is already
  // what the AI agent setting uses. A name not in the subset renders as a box.
  assert.match(button, /codicon-hubot/);
});

test("the section headings are a rule, not a card", () => {
  // §12: whitespace and typography, not containers. A border on three sides
  // would be a box inside a page inside a panel.
  assert.match(CSS, /\.settings-section-title \{[^}]*border-bottom: 1px solid var\(--vscode-panel-border\)/s);
  assert.equal(/\.settings-section-title \{[^}]*border-radius/s.test(CSS), false);
  assert.equal(/\.settings-section-title \{[^}]*background/s.test(CSS), false);
  // Air between sections.
  assert.match(CSS, /\.settings-section \{[^}]*margin: 0 0 18px/s);
});

test("the hint row lets its two controls stack, Improve with AI first, the option whole on its line", () => {
  // At 200px "Improve with AI" and "Include issue details" cannot share a line.
  // Wrapping is the answer; overlapping or clipping would hide the feature. The
  // option and its helper are one group with a floor, so it wraps as one.
  assert.match(CSS, /\.hint-actions \{[^}]*flex-wrap: wrap/s);
  assert.match(CSS, /\.hint-include \{[^}]*flex: 1 1 14em;[^}]*min-width: 0;/s);
  assert.equal(/\.hint-actions \{[^}]*white-space: nowrap/s.test(CSS), false);
  assert.equal(/\.hint-actions \{[^}]*position: absolute/s.test(CSS), false);
});

test("every advanced field is still there, with the id its state is stored under", () => {
  // The regrouping moved markup. A field that lost its id would silently stop
  // restoring, and its validation message would have nowhere to land.
  for (const id of [
    "keywords", "focusFiles", "title", "ignorePaths",
    "maxFiles", "maxSearchLines", "agentCommand",
  ]) {
    assert.ok(SETTINGS_FIELD_IDS.includes(id), `${id} left SETTINGS_FIELD_IDS`);
    assert.match(HTML, new RegExp(`id="field-${id}"`), `${id} has no row`);
  }
  // The Hint moved to the form (§37.84), keeping its id and its row.
  assert.equal(SETTINGS_FIELD_IDS.includes("hint"), false);
  assert.ok(TEXT_FIELD_IDS.includes("hint"));
  assert.match(HTML, /id="field-hint"/);
  // And the three that are not text fields.
  for (const id of ["agent", "add-attachment", "fresh"]) {
    assert.match(HTML, new RegExp(`id="${id}"`), `${id} is gone`);
  }
});

// --- UI-B1: Relevant Files --------------------------------------------------

test("Relevant files is a collapsed disclosure inside Code search", () => {
  // Batch 6: the files are the search's result, so they are on its row.
  const row = rowMarkup("codeSearch");
  const files = /<details class="files" id="relevant-files"[\s\S]*?<\/details>/.exec(row)?.[0] ?? "";
  assert.notEqual(files, "", "Relevant files is not inside the Code search row");

  // A real disclosure, so it opens from the keyboard without any script.
  assert.match(files, /<summary id="relevant-files-summary">Relevant files<\/summary>/);
  assert.equal(/<details[^>]*\bopen\b/.test(files), false, "it starts expanded");
  // Hidden until the host sends files, which is what keeps §17's promise.
  assert.match(files, /^<details[^>]*\bhidden\b/);
  // Below the row's summary line, above its failure card.
  assert.ok(row.indexOf('id="description-codeSearch"') < row.indexOf('id="relevant-files"'));
  assert.ok(row.indexOf('id="relevant-files"') < row.indexOf('id="error-codeSearch"'));
  // The rows are the page's, built from what the host read.
  assert.match(files, /id="relevant-files-list"><\/div>/);
  // And nowhere else: one visual source for the list.
  assert.equal(HTML.split('id="relevant-files"').length - 1, 1);
});

test("nothing about the ranking is named anywhere in the panel", () => {
  // §13: the result section answers "what did it find", not "how does the
  // ranker work". These are the artifact's other five fields.
  // Comments stripped first, for the same reason the colour scan strips them:
  // the markup documents that these are *not* shown, so a plain grep finds the
  // sentence saying so and the guard becomes lenient exactly where it matters.
  const visible = HTML.replace(/<!--[\s\S]*?-->/g, "").toLowerCase();
  for (const internal of ["score", "match_count", "noise_flag", "confidence:", "rank"]) {
    assert.equal(visible.includes(internal.toLowerCase()), false, `the panel names "${internal}"`);
  }
});

test("a relevant file row is a button and a description, not a clickable div", () => {
  // §22. The page builds these, so the guard is on the page source: a filename
  // that opens a file has to be something a keyboard can reach.
  assert.match(PAGE_JS, /createElement\("button"\)/);
  assert.match(PAGE_JS, /className = "file-open"/);
  assert.equal(/createElement\("div"\)[\s\S]{0,200}addEventListener\("click"/.test(PAGE_JS), false);
});

test("a file name stays readable and a long path cannot scroll the panel", () => {
  assert.match(CSS, /\.file-name \{[^}]*overflow-wrap: anywhere/s);
  assert.match(CSS, /\.file-path,[\s\S]*?\{[^}]*overflow-wrap: anywhere/s);
  // The row is a column so the name and the path stack at any width, and the
  // button is full width rather than a fixed one.
  assert.match(CSS, /\.file-open \{[^}]*flex-direction: column/s);
  assert.match(CSS, /\.file-open \{[^}]*width: 100%/s);
  assert.equal(/\.file[^{]*\{[^}]*position: absolute/s.test(CSS), false);
  assert.equal(/\.file[^{]*\{[^}]*white-space: nowrap/s.test(CSS), false);
  assert.equal(/\.file[^{]*\{[^}]*text-overflow/s.test(CSS), false);
});

test("a relevant-file path is shape-checked before the host will look at it", () => {
  // The page only echoes paths the host gave it, but this is the untrusted side
  // of the boundary and the value becomes a file the editor opens.
  for (const bad of [
    undefined,
    null,
    7,
    "",
    "   ",
    "../../outside.txt",
    "src/../../outside.txt",
    "/etc/passwd",
    "C:/Windows/win.ini",
  ]) {
    assert.equal(
      parsePanelMessage({ type: "openRelevantFile", path: bad }),
      undefined,
      JSON.stringify(bad),
    );
  }
  assert.deepEqual(parsePanelMessage({ type: "openRelevantFile", path: "src/a.cpp" }), {
    type: "openRelevantFile",
    path: "src/a.cpp",
  });
});

// --- UI-B2: the failure card's markup ----------------------------------------

test("every failure card is the same shape, built once", () => {
  // Seven surfaces, one markup: the run failure no row owns, and one card per
  // row for a failure that row owns. The same three questions with different
  // answers; separate templates for that drift apart within a phase.
  const ids = ["failure", ...["issueDetails", "codeSearch", "gitHistory", "similarFixes", "buildContext", "fixWithAI"].map((id) => `error-${id}`)];
  for (const id of ids) {
    const card = new RegExp(`<div id="${id}" class="failure"[\\s\\S]*?</div>\\s*</div>`).exec(HTML)?.[0] ?? "";
    assert.notEqual(card, "", `no card for ${id}`);
    assert.match(card, new RegExp(`<div id="${id}"[^>]*role="alert"`), id);
    assert.match(card, new RegExp(`<div id="${id}"[^>]*\\bhidden\\b`), `${id} starts visible`);
    for (const part of ["title", "message", "actions", "details", "detail"]) {
      assert.ok(card.includes(`id="${id}-${part}"`), `${id} has no ${part}`);
    }
  }
  assert.equal(HTML.includes('id="handoff-error"'), false, "the old handoff card survived");
});

test("Details is a collapsed disclosure over preformatted text", () => {
  const card = /<div id="failure" class="failure"[\s\S]*?<\/div>\s*<\/div>/.exec(HTML)?.[0] ?? "";
  assert.match(card, /<details class="failure-details" id="failure-details" hidden>/);
  assert.match(card, /<summary>Details<\/summary>/);
  assert.equal(/<details[^>]*id="failure-details"[^>]*\bopen\b/.test(card), false);
  // `pre`, because a traceback's line breaks are the information.
  assert.match(card, /<pre class="failure-detail" id="failure-detail"><\/pre>/);
});

test("each card sits where its failure belongs", () => {
  // A row's card is inside that row: a later failure never replaces the
  // results above it. The card no row owns sits at the top of the workflow,
  // above the rows, where a failure before any step belongs.
  for (const id of ["issueDetails", "codeSearch", "gitHistory", "similarFixes", "buildContext", "fixWithAI"]) {
    assert.ok(rowMarkup(id).includes(`id="error-${id}"`), `${id}'s card is outside its row`);
  }
  const workflow = HTML.indexOf('id="workflow"');
  assert.ok(workflow < HTML.indexOf('id="failure"'), "the run card is outside the workflow");
  assert.ok(HTML.indexOf('id="failure"') < HTML.indexOf('<ol class="steps">'));
});

test("a failure is an icon and text, not a red panel", () => {
  // §15 and the panel's own rule: state is never colour alone, and a tinted
  // block is a tinted block whatever a high-contrast theme does to it.
  assert.match(HTML, /<span class="codicon codicon-error icon-danger"/);
  assert.equal(/\.failure \{[^}]*background/s.test(CSS), false);
  assert.equal(/\.failure \{[^}]*border:/s.test(CSS), false);
  // The old two-line card is gone with its classes.
  assert.equal(HTML.includes("card-failure"), false);
  assert.equal(HTML.includes('id="failure-summary"'), false);
});

test("a failure survives a narrow sidebar without a scrollbar", () => {
  assert.match(CSS, /\.failure-title \{[^}]*overflow-wrap: anywhere/s);
  assert.match(CSS, /\.failure-actions \{[^}]*flex-wrap: wrap/s);
  // Preformatted but wrapped: a horizontal scrollbar inside a disclosure is a
  // scrollbar nobody finds.
  assert.match(CSS, /\.failure-detail \{[^}]*white-space: pre-wrap/s);
  assert.match(CSS, /\.failure-detail \{[^}]*overflow-wrap: anywhere/s);
  assert.equal(/\.failure[^{]*\{[^}]*position: absolute/s.test(CSS), false);
  assert.equal(/\.failure[^{]*\{[^}]*[^-]width: \d+px/s.test(CSS), false);
});

test("the page classifies nothing about a failure", () => {
  // §5. The page has neither the error code nor the operation that produced it,
  // so a webview deciding "this looks like auth" would be guessing from the
  // least informed position in the system.
  // The error codes themselves, not the word Jira: the page legitimately knows
  // what a Jira *issue key* looks like, which is a different subject entirely.
  for (const smell of [
    'includes("401',
    "includes('401",
    'includes("claude',
    "JIRA_AUTH_FAILED",
    "JIRA_ISSUE_NOT_FOUND",
    "JIRA_NOT_CONFIGURED",
    "INTERNAL_ERROR",
    "HTTP ",
  ]) {
    assert.equal(PAGE_JS.includes(smell), false, `the page inspects failure text with ${smell}`);
  }
  // And it no longer reads the raw failure at all.
  assert.equal(PAGE_JS.includes("progress.failure"), false);
});

// --- UI-B3: the handoff outcome ----------------------------------------------

test("Fix with AI's row reads: what happened, which mode, the new-attempt form, its card", () => {
  const row = rowMarkup("fixWithAI");
  const order = ["description-fixWithAI", "detail-fixWithAI", "strategy-fixWithAI", "attempt-editor", "error-fixWithAI"];
  const positions = order.map((id) => row.indexOf(`id="${id}"`));
  assert.ok(positions.every((at) => at !== -1), `a slot is missing: ${order}`);
  assert.deepEqual([...positions].sort((a, b) => a - b), positions, "the row reordered itself");
  // Strategy keeps its label: what the agent was told, never the selector.
  assert.match(row, /<p class="step-strategy" id="strategy-fixWithAI" hidden><span class="result-label">Strategy<\/span>/);
});

test("a finished row's detail is text, not a banner", () => {
  // The issue title, which agent was started: quieter than the label, and no
  // background, border or colour of its own.
  assert.equal(/\.step-detail \{[^}]*background/s.test(CSS), false);
  assert.equal(/\.step-detail \{[^}]*border:/s.test(CSS), false);
  assert.match(CSS, /\.step-detail \{[^}]*overflow-wrap: anywhere/s);
});

test("the panel never claims a bug was fixed", () => {
  // BugPilot starts a terminal and stops watching. These are the claims a
  // developer would believe and the panel cannot check — and the markup is
  // where a stray one would end up.
  const visible = HTML.replace(/<!--[\s\S]*?-->/g, "").toLowerCase();
  for (const claim of [
    "bug fixed",
    "fix completed",
    "issue resolved",
    "changes applied",
    "tests passed",
    "files changed",
  ]) {
    assert.equal(visible.includes(claim), false, `the panel claims "${claim}"`);
  }
});

test("Fix with AI has no button of its own: the row is status, the top button acts", () => {
  // Busy is the row's state — a spinner and "Starting AI fix…" on the row — and
  // the press is the primary action's, whose label the host sets.
  assert.equal(HTML.includes('id="fix-with-ai"'), false);
  assert.equal(HTML.includes('id="actions-fixWithAI"'), false);
  assert.match(HTML, /<button type="submit" id="run" class="primary">\s*<span class="codicon codicon-play" id="run-icon" aria-hidden="true"><\/span>\s*<span id="run-label">Run<\/span>/);
});

// --- UI-V1: what rendering the page found ------------------------------------

test("a rule that reaches a hidden element through its parent must let hidden win", () => {
  // The same bug as the test above, through a shape that one cannot see.
  // `#stop` and `#retry` carry `hidden` and no class, so nothing matched them —
  // and `.run-buttons > button { display: flex }` reached them anyway. A greyed
  // Stop sat beside Run in every state, including an untouched panel, which is
  // the exact thing the markup's own comment says it avoids.
  //
  // Invisible to every test in this repository until UI-V1 rendered the page in
  // a browser and looked: the DOM stub records the `hidden` property and lays
  // nothing out, so it reported the button hidden while Chromium drew it.
  // A tag stack rather than a regex: `<div class="run">` wraps
  // `<div class="run-buttons">`, and a non-overlapping pattern match swallows
  // the inner opening tag along with the outer one — which is exactly how the
  // first attempt at this guard reported nothing to check.
  const parents = new Map<string, Set<string>>();
  const stack: string[][] = [];
  for (const tag of HTML.matchAll(/<\/?([a-z][a-z0-9]*)([^>]*)>/g)) {
    const [whole, name, attributes] = [tag[0], tag[1]!, tag[2] ?? ""];
    if (whole.startsWith("</")) {
      stack.pop();
      continue;
    }
    if (/\shidden(\s|>|=)/.test(whole)) {
      for (const parentClass of stack.at(-1) ?? []) {
        const tags = parents.get(parentClass) ?? new Set<string>();
        tags.add(name);
        parents.set(parentClass, tags);
      }
    }
    // Void elements never open a scope; `input` is the only one the panel uses.
    if (name === "input" || name === "br" || name === "meta" || name === "link") continue;
    stack.push((/class="([^"]*)"/.exec(attributes)?.[1] ?? "").split(/\s+/).filter(Boolean));
  }

  assert.ok(parents.size > 0, "no hidden element sits inside a classed container");

  let checked = 0;
  for (const [parentClass, tags] of parents) {
    for (const tag of tags) {
      const rule = new RegExp(`\\.${parentClass}\\s*>\\s*${tag}\\s*\\{([^}]*)\\}`).exec(CSS);
      if (!rule || !/(^|[;{\s])display\s*:/.test(rule[1] ?? "")) continue;
      checked += 1;
      assert.ok(
        new RegExp(
          `\\.${parentClass}\\s*>\\s*${tag}\\[hidden\\]\\s*\\{[^}]*display\\s*:\\s*none`,
        ).test(CSS),
        `.${parentClass} > ${tag} sets display on an element the markup hides, so a ` +
          `.${parentClass} > ${tag}[hidden] { display: none } rule is what stops it rendering`,
      );
    }
  }
  assert.ok(checked > 0, "the scan found no parent rule to check, so it proves nothing");
});

test("a label that is a whole sentence is allowed to wrap", () => {
  // "Delete previous artifacts first" is a sentence, not a name, and
  // `.setting-header > label { flex: none }` would not let it shrink — so at
  // 200px it pushed 19px past the panel and gave the page a horizontal
  // scrollbar. Measured in a browser at 200px rather than inferred.
  assert.match(CSS, /\.field-check \.setting-header > label \{[^}]*flex: 1 1 auto/s);
  assert.match(CSS, /\.field-check \.setting-header > label \{[^}]*min-width: 0/s);
});

test("the custom agent command's label may wrap, and only that one name label", () => {
  // Measured in the real window at 200px (§37.94): held at full width it stood
  // 3px past the panel and scrolled the page sideways. Every other name label
  // keeps `flex: none` — letting them all shrink wrapped one that fits exactly.
  assert.match(CSS, /#field-agentCommand \.setting-header > label \{[^}]*flex: 0 1 auto/s);
  assert.match(CSS, /#field-agentCommand \.setting-header > label \{[^}]*min-width: 0/s);
  assert.match(CSS, /\n\.setting-header > label \{[^}]*flex: none/s);
});

test("the agent error sits under the button it is about", () => {
  // Directly under Fix with AI, on its row: nothing a developer can still do
  // sits between the button and the reason it did not work.
  const row = rowMarkup("fixWithAI");
  assert.ok(row.indexOf('id="fix-with-ai"') < row.indexOf('id="error-fixWithAI"'));
});

// --- UI-C1: Retrieval Details ------------------------------------------------

test("Search details is a collapsed disclosure inside Code search, after Relevant files", () => {
  const row = rowMarkup("codeSearch");
  const terms = /<details class="terms" id="search-details"[\s\S]*?<\/details>/.exec(row)?.[0] ?? "";
  assert.notEqual(terms, "", "Search details is not inside the Code search row");

  assert.match(terms, /<summary id="search-details-summary">Search details<\/summary>/);
  assert.equal(/<details[^>]*id="search-details"[^>]*\bopen\b/.test(terms), false);
  assert.match(terms, /^<details[^>]*\bhidden\b/);
  assert.ok(row.indexOf('id="relevant-files"') < row.indexOf('id="search-details"'));
  // The rows are the page's, built from what the host read.
  assert.match(terms, /id="search-details-list"><\/div>/);
  assert.equal(HTML.includes("retrieval-details"), false, "the old section survived");
});

test("each result control exists exactly once, inside the row that owns it", () => {
  // §52: one Relevant files, one Search details, one Open Context, one Copy,
  // one Start Attempt. Checked by id and by what a developer reads, because a
  // second control could carry a new id and the same words.
  const controls = [...HTML.matchAll(/<(button|summary)\b[^>]*>([\s\S]*?)<\/\1>/g)].map((match) => ({
    markup: match[0],
    text: match[2]!.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim(),
  }));
  for (const [id, label, owner] of [
    ["relevant-files", "Relevant files", "codeSearch"],
    ["search-details", "Search details", "codeSearch"],
    ["open-context", "Open Context", "buildContext"],
    ["copy-context", "Copy", "buildContext"],
    ["start-attempt", "Start Attempt", "fixWithAI"],
    ["open-fix-report", "Open Fix Report", "fixResult"],
    ["copy-review-prompt", "Copy Review Prompt", "fixResult"],
    ["validation-summary", "Validation checklist", "fixResult"],
  ] as const) {
    assert.equal(HTML.split(`id="${id}"`).length - 1, 1, `#${id} is declared more than once`);
    assert.ok(rowMarkup(owner).includes(`id="${id}"`), `#${id} is outside the ${owner} row`);
    const labelled = controls.filter((control) => control.text === label);
    assert.equal(labelled.length, 1, `"${label}" is on ${labelled.length} controls`);
    assert.ok(rowMarkup(owner).includes(labelled[0]!.markup), `"${label}" is outside the ${owner} row`);
  }
});

test("Fix result is a row the markup keeps hidden, with no checkbox and no failure card", () => {
  // Batch 8. It exists only while fix_report.md does, so the page shows it
  // when the host's workflow includes it and never before.
  const row = rowMarkup("fixResult");
  assert.match(row, /^<li class="step" id="step-fixResult" hidden>/);
  // Nobody chooses it and no run performs it.
  assert.equal(/<input\b/.test(row), false, "Fix result has a checkbox");
  // Its only labels are Review Result's text areas (Batch 11) — never
  // one for a checkbox.
  assert.equal(/<label\b[^>]*for="plan-/.test(row), false, "Fix result has a label for a checkbox");
  // A report that cannot be previewed is not a failure: no card of the row's
  // own. The one card it holds is Review with AI's, about that action (Batch 10).
  assert.equal(row.includes('id="error-fixResult"'), false, "Fix result has a row failure card");
  assert.deepEqual([...row.matchAll(/class="failure"[^>]*/g)].length, 1);
  assert.match(row, /<div id="review-error" class="failure" role="alert" hidden>/);
  // Its lines, its file, then its one action — the same order as every row.
  const order = ['id="description-fixResult"', 'id="detail-fixResult"', 'id="artifact-fixResult"', 'id="open-fix-report"'].map((id) => row.indexOf(id));
  assert.ok(order.every((at) => at !== -1), "a slot is missing");
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  // Secondary, like Build context's actions: not a second primary button.
  assert.match(row, /<button type="button" class="result-link" id="open-fix-report" title="Open fix_report\.md in the editor" hidden>/);
  assert.equal(row.includes('class="primary"'), false);
  // And it is last.
  const rows = [...HTML.matchAll(/<li class="step[^"]*" id="step-([A-Za-z]+)"/g)].map((match) => match[1]);
  assert.equal(rows.at(-1), "fixResult");
});

test("Fix result's review aids: read the report, copy a review prompt, open the checklist", () => {
  // Batch 9. In that order — the report first — and all on the row that owns
  // the report they are about.
  const row = rowMarkup("fixResult");
  const order = ['id="open-fix-report"', 'id="copy-review-prompt"', 'id="validation-checklist"'].map((id) => row.indexOf(id));
  assert.ok(order.every((at) => at !== -1), "a review aid is not on the Fix result row");
  assert.deepEqual([...order].sort((a, b) => a - b), order);

  // The label says what the button does: it copies a prompt, and no review
  // runs. Secondary, like Open Fix Report, and hidden until a report is there.
  assert.match(row, /<button type="button" class="result-link" id="copy-review-prompt" title="Copy a prompt that asks a reviewer to review this result" hidden>/);
  assert.match(row, /<span id="copy-review-prompt-label">Copy Review Prompt<\/span>/);
  // "Review Result" is Batch 11's, and says only that a result was recorded;
  // nothing on the panel claims a review ran, passed or verified anything.
  for (const overclaim of [
    "Run Review",
    "Verify Fix",
    "Reviewed",
    "Verified",
    "Review Passed",
    "Review complete",
    "Complete Review",
    "Mark Reviewed",
    "Accept Review",
    "Approved",
  ]) {
    assert.equal(HTML.includes(overclaim), false, `the panel says "${overclaim}"`);
  }

  // A disclosure, closed and hidden in the markup, whose body is announced as
  // it fills.
  const disclosure = /<details class="validation" id="validation-checklist"[^>]*>/.exec(row)?.[0] ?? "";
  assert.match(disclosure, /\shidden>/);
  assert.equal(/\bopen\b/.test(disclosure), false, "the checklist starts open");
  assert.match(row, /<summary id="validation-summary">Validation checklist<\/summary>/);
  assert.match(row, /<div id="validation-body" aria-live="polite"><\/div>/);
  // Read-only guidance: no checkbox to tick.
  assert.equal(/<input\b/.test(row), false);
});

test("the checklist's disclosure lets the hidden attribute win, and draws no ticks or colours", () => {
  assert.match(CSS, /\.validation\[hidden\] \{\s*display: none/);
  const rules = /\.validation-steps[\s\S]*?\.validation-file \{[^}]*\}/.exec(CSS)?.[0] ?? "";
  assert.notEqual(rules, "");
  assert.equal(/--vscode-(testing|charts|terminal\.ansiGreen|terminal\.ansiRed)/.test(rules), false);
});

test("the Fix result label lines up with the other rows' text, and is not clickable", () => {
  // By id: the page rewrites each row's classes from its status, so a class
  // on the row in the markup would not survive the first render.
  assert.match(CSS, /#step-fixResult \.step-label \{[^}]*padding-left: 20px/s);
  assert.match(CSS, /#step-fixResult \.step-label \{[^}]*cursor: default/s);
});

test("a long report line is clamped only while collapsed, and still hidden when there is none", () => {
  // The clamp is a class the page sets while collapsed — and whenever it cuts
  // a line short, Show more is there (§37.89). No clamp without the class.
  assert.match(CSS, /#description-fixResult\.is-clamped,\s*#detail-fixResult\.is-clamped \{[^}]*-webkit-line-clamp: 3;[^}]*overflow: hidden;/s);
  assert.match(CSS, /#detail-fixResult\.is-clamped \{\s*-webkit-line-clamp: 2/);
  assert.equal(/#(description|detail)-fixResult(,\s*#detail-fixResult)? \{[^}]*(overflow: hidden|line-clamp|max-height|height:)/s.test(CSS), false, "a clip with no Show more");
  assert.match(CSS, /#detail-fixResult\[hidden\] \{\s*display: none/);
});

test("Show more is a quiet link on its own line: after the report's lines, before fix_report.md", () => {
  const row = rowMarkup("fixResult");
  const toggle = /<button type="button" class="link fix-summary-toggle" id="fix-summary-toggle"[^>]*>Show more<\/button>/.exec(row)?.[0] ?? "";
  assert.notEqual(toggle, "", "no Show more button");
  assert.match(toggle, /aria-controls="description-fixResult detail-fixResult"/);
  assert.match(toggle, /aria-expanded="false"/);
  assert.match(toggle, /aria-label="Show full Fix result"/);
  assert.match(toggle, / hidden/);
  const order = ["description-fixResult", "detail-fixResult", "fix-summary-toggle", "artifact-fixResult", "open-fix-report"].map((id) => row.indexOf(`id="${id}"`));
  assert.ok(order.every((at) => at !== -1));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.match(CSS, /\.fix-summary-toggle \{[^}]*align-self: flex-start;/s);
  assert.equal(toggle.includes("primary"), false);
});

test("each row reads top to bottom: its line, its detail, what it owns, its card", () => {
  const orders: Record<string, string[]> = {
    // The first line (choice, then status), the second line, the detail, then
    // the file on a line of its own, then what the row owns (§37.86).
    issueDetails: ["plan-issueDetails", "status-issueDetails", "description-issueDetails", "detail-issueDetails", "artifact-issueDetails", "error-issueDetails"],
    codeSearch: ["plan-codeSearch", "status-codeSearch", "description-codeSearch", "detail-codeSearch", "artifact-codeSearch", "relevant-files", "search-details", "error-codeSearch"],
    buildContext: ["plan-buildContext", "status-buildContext", "description-buildContext", "detail-buildContext", "artifact-buildContext", "actions-buildContext", "error-buildContext"],
  };
  for (const [id, order] of Object.entries(orders)) {
    const row = rowMarkup(id);
    const positions = order.map((slot) => row.indexOf(`id="${slot}"`));
    assert.ok(positions.every((at) => at !== -1), `${id}: a slot is missing: ${order}`);
    assert.deepEqual([...positions].sort((a, b) => a - b), positions, `${id} reordered itself`);
  }
});

test("Search details offers nothing to change", () => {
  // Transparency, not configuration. A control in here would be a tuning knob
  // over a record of something that already happened.
  const terms = /<details class="terms" id="search-details"[\s\S]*?<\/details>/.exec(HTML)?.[0] ?? "";
  assert.notEqual(terms, "", "no Search details section to check");
  for (const control of ["<button", "<input", "<select", "<textarea"]) {
    assert.equal(terms.includes(control), false, `Search details contains a ${control}`);
  }
});

test("a term row is typography, not a card or a chart", () => {
  // Twenty-eight bordered boxes in a 200px sidebar is a wall, and a bar chart
  // of match counts is an analytics dashboard.
  assert.equal(/\.term-row \{[^}]*border/s.test(CSS), false);
  assert.equal(/\.term-row \{[^}]*background/s.test(CSS), false);
  assert.equal(/\.term-(name|meta|origin) \{[^}]*(background|border)/s.test(CSS), false);
  // Long identifiers have no spaces to break at.
  assert.match(CSS, /\.term-name \{[^}]*overflow-wrap: anywhere/s);
  assert.match(CSS, /\.term-meta,[\s\S]*?\{[^}]*overflow-wrap: anywhere/s);
});

test("the panel never names the ranker's own constants", () => {
  const visible = HTML.replace(/<!--[\s\S]*?-->/g, "").toLowerCase();
  for (const internal of ["weight", "effective_weight", "threshold", "rank points"]) {
    assert.equal(visible.includes(internal), false, `the panel names "${internal}"`);
  }
});

// --- UI-C2: Diagnostics ------------------------------------------------------

test("Diagnostics is a collapsed disclosure over a definition list", () => {
  const block = /<details class="diagnostics" id="diagnostics"[\s\S]*?<\/details>/.exec(HTML)?.[0] ?? "";
  assert.notEqual(block, "", "no Diagnostics section");

  assert.match(block, /<summary id="diagnostics-summary">Diagnostics<\/summary>/);
  assert.equal(/<details[^>]*id="diagnostics"[^>]*\bopen\b/.test(block), false);
  assert.match(block, /^<details[^>]*\bhidden\b/);
  // A `dl`: label-and-value is a pairing, and putting it in the markup is what
  // makes it survive a screen reader.
  assert.match(block, /<dl id="diagnostics-list"><\/dl>/);
});

test("Diagnostics is read-only, and offers nothing to configure", () => {
  // If something needs changing, the existing Open Settings and Set Jira
  // Credentials actions are where that happens. A control here would make this
  // a second settings page over state it only observes.
  const block = /<details class="diagnostics" id="diagnostics"[\s\S]*?<\/details>/.exec(HTML)?.[0] ?? "";
  for (const control of ["<button", "<input", "<select", "<textarea", "<a "]) {
    assert.equal(block.includes(control), false, `Diagnostics contains a ${control}`);
  }
});

test("Diagnostics is last, and outside the workflow rather than inside it", () => {
  // Last in the details hierarchy, as §36 asks — and outside the workflow,
  // because a panel that can only answer "is this configured correctly" after a
  // successful run cannot answer it when the run failed.
  const workflow = HTML.slice(HTML.indexOf('<details class="group" id="workflow"'), HTML.indexOf('<details class="diagnostics"'));
  assert.notEqual(workflow, "");
  assert.equal(workflow.includes('id="diagnostics"'), false, "Diagnostics is inside the workflow");

  assert.ok(HTML.indexOf('id="relevant-files"') < HTML.indexOf('id="search-details"'));
  assert.ok(HTML.indexOf('id="search-details"') < HTML.indexOf('id="diagnostics"'));
  // Last in the form: never above something it should sit under, and reachable
  // whether or not a run has happened. Advanced Settings is far above it now.
  assert.ok(HTML.indexOf('id="open-settings"') < HTML.indexOf('id="workflow"'));
  assert.match(HTML.slice(HTML.indexOf('id="diagnostics"')), /^[\s\S]*?<\/details>\s*<\/form>/);
});


test("a diagnostic is a label above a value, not a two-column table", () => {
  // A table needs a width a 200px sidebar does not have.
  assert.match(CSS, /\.diagnostic-value \{[^}]*overflow-wrap: anywhere/s);
  assert.match(CSS, /\.diagnostic-detail \{[^}]*overflow-wrap: anywhere/s);
  assert.equal(/\.diagnostic[^{]*\{[^}]*display: (table|grid|flex)/s.test(CSS), false);
  // No dot, no badge, no colour: this is information, not monitoring.
  assert.equal(/\.diagnostic[^{]*\{[^}]*(background|border)/s.test(CSS), false);
});

test("the page decides nothing about what a diagnostic means", () => {
  // Every word comes from the host. A webview working out whether Jira is
  // configured would be inspecting things a webview must not reach.
  // "Configured" is excluded deliberately: the footer's Jira line has said it
  // since phase 5, which is frozen §34 code rather than a decision this phase
  // introduced.
  for (const smell of [
    "Credentials configured",
    "Not checked",
    "No repository",
    "Auto-detect",
    "Detected:",
    "Limited integration",
    "Native integration",
    "Not found on PATH",
    "secrets",
    "packageJSON",
    "process.env",
  ]) {
    assert.equal(PAGE_JS.includes(smell), false, `the page decides "${smell}" for itself`);
  }
});

// --- Review with AI (Batch 10) ------------------------------------------------

test("Review with AI is Fix result's third action, then its status and its card, then the checklist", () => {
  const row = rowMarkup("fixResult");
  const order = [
    'id="open-fix-report"',
    'id="copy-review-prompt"',
    'id="review-with-ai"',
    'id="review-status"',
    'id="review-error"',
    'id="validation-checklist"',
  ].map((id) => row.indexOf(id));
  assert.ok(order.every((at) => at !== -1), "a piece of Review with AI is not on the Fix result row");
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  // Declared once, in this row only.
  for (const id of ["review-with-ai", "review-status", "review-error"]) {
    assert.equal(HTML.split(`id="${id}"`).length - 1, 1, `#${id} is declared more than once`);
  }
});

test("Review with AI is a quiet secondary button whose label is its name", () => {
  const row = rowMarkup("fixResult");
  // The same style as Open Fix Report and Copy Review Prompt — not the Run /
  // Fix with AI primary — hidden until the host offers it.
  assert.match(
    row,
    /<button type="button" class="result-link" id="review-with-ai" title="Start the selected AI agent in a terminal with the review prompt\. Starting a reviewer is not a review result\." hidden>/,
  );
  assert.match(row, /<span id="review-with-ai-label">Review with AI<\/span>/);
  assert.equal(row.includes('class="primary"'), false);
  // What it does, and not what a reviewer might conclude.
  for (const overclaim of ["Review complete", "Review passed", "Reviewed", "Verified", "Approved"]) {
    assert.equal(HTML.includes(overclaim), false, `the panel says "${overclaim}"`);
  }
});

test("the review status is always in the document, as a live region the page can focus", () => {
  // Present while empty, so a screen reader hears it fill; focusable, so the
  // pressed button's focus has somewhere to go when the button goes.
  assert.match(rowMarkup("fixResult"), /<div class="review-status" id="review-status" role="status" tabindex="-1"><\/div>/);
  // Neutral: no tick, no colour for a start that is not a finish.
  const rules = /\.review-status \{[\s\S]*?\.review-status:focus:not\(:focus-visible\) \{[^}]*\}/.exec(CSS)?.[0] ?? "";
  assert.notEqual(rules, "");
  assert.equal(/--vscode-(testing|charts|terminal\.ansiGreen)|pass-filled|color: green/.test(rules), false);
  // Empty, it gives back the column gap it would otherwise add.
  assert.match(CSS, /\.review-status:empty \{\s*margin-top: -4px;/);
});

test("the page may ask for Review with AI and nothing more general", () => {
  assert.deepEqual(parsePanelMessage({ type: "action", id: "reviewWithAI" }), { type: "action", id: "reviewWithAI" });
  for (const id of ["launchAgentWithPrompt", "runAgent", "runPostFixCommand"]) {
    assert.equal(parsePanelMessage({ type: "action", id }), undefined, id);
  }
  // No prompt and no agent travel with it: the message is the action's name.
  assert.deepEqual(
    parsePanelMessage({ type: "action", id: "reviewWithAI", prompt: "rm -rf ~", agent: "sh" }),
    { type: "action", id: "reviewWithAI" },
  );
});

test("Verification Evidence sits in Fix result after Review Result, as buttons in a group, never a form", () => {
  // Batch 12. Record with the row's actions; the evidence, its Open and Edit,
  // then the form and the recording's own status and alert — all after
  // Review Result's.
  const row = rowMarkup("fixResult");
  const order = [
    'id="record-review-result"',
    'id="record-verification"',
    'id="review-result"',
    'id="review-capture-error"',
    'id="verification-result"',
    'id="open-verification-report"',
    'id="edit-verification"',
    'id="verification-editor"',
    'id="verification-capture-status"',
    'id="verification-capture-error"',
  ].map((id) => row.indexOf(id));
  assert.ok(order.every((at) => at !== -1), "a Verification Evidence slot is not on the Fix result row");
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  assert.equal(/<form\b/.test(row), false, "a nested form would submit the panel — a Run");
  for (const id of [
    "record-verification",
    "open-verification-report",
    "edit-verification",
    "add-verification-check",
    "done-verification",
    "retry-verification-save",
    "reload-verification",
    "overwrite-verification",
  ]) {
    assert.match(row, new RegExp(`<button type="button" class="result-link" id="${id}"`), `#${id} is not a plain button`);
  }
  assert.match(row, /<div class="verification-editor" id="verification-editor" role="group" aria-label="Verification evidence" hidden>/);
  assert.match(row, /<p class="verification-result-heading result-label" id="verification-result-heading" tabindex="-1">Verification Evidence<\/p>/);
  assert.match(row, /<div class="review-status" id="verification-capture-status" role="status" tabindex="-1"><\/div>/);
  assert.match(row, /<p class="error" id="verification-capture-error" role="alert" hidden><\/p>/);
  assert.match(row, /aria-controls="verification-editor" aria-expanded="false"/);
  for (const label of ["Add Verification Evidence", "Edit Verification Evidence", "Open Verification Report", "Add Check"]) {
    assert.ok(row.includes(`>${label}</span>`), `"${label}" is not a button label`);
  }
  // Auto-save (§37.83): no Save button; Done closes, and the problems have their own actions.
  for (const label of ["Done", "Retry Save", "Reload Saved Version", "Overwrite Saved Version"]) {
    assert.ok(row.includes(`>${label}</button>`), `"${label}" is not a button label`);
  }
  assert.equal(row.includes("Save Verification Evidence"), false, "the Save button is still there");
  assert.match(row, /<p class="muted verification-save-status" id="verification-save-status"><\/p>/);
  // Remove Check is per row, built by the page.
  assert.ok(PAGE_JS.includes('"Remove Check"'));
});

test("the post-fix actions say Review with AI, Paste Review Output, Add Review Result and Add Verification Evidence", () => {
  const row = rowMarkup("fixResult");
  // In the order the flow reads: start a reviewer, bring its reply back, or type
  // a review by hand; then the checks actually performed.
  const order = [
    'id="review-with-ai"',
    'id="paste-review-output"',
    'id="record-review-result"',
    'id="record-verification"',
    'id="review-paste"',
    'id="review-editor"',
  ].map((id) => row.indexOf(id));
  assert.ok(order.every((at) => at !== -1));
  assert.deepEqual([...order].sort((a, b) => a - b), order);
  for (const label of ["Review with AI", "Paste Review Output", "Add Review Result", "Replace Review Result", "Save Review Result", "Add Verification Evidence"]) {
    assert.ok(row.includes(`>${label}</span>`), `"${label}" is not a button label`);
  }
  // The old wording stays in ids only, never on screen.
  for (const old of [">Record Review Result<", ">Record Verification Evidence<"]) {
    assert.equal(row.includes(old), false, old);
  }
  assert.match(row, /<button type="button" class="result-link" id="paste-review-output" [^>]*aria-controls="review-paste" aria-expanded="false" hidden>/);
});

test("the paste box is a group of its own, with a described text area, Parse, Cancel and an alert", () => {
  const row = rowMarkup("fixResult");
  assert.match(row, /<div class="review-paste" id="review-paste" role="group" aria-label="Paste review output" hidden>/);
  assert.match(row, /<label for="review-paste-text">Review output<\/label>/);
  assert.match(row, /<textarea id="review-paste-text" rows="6" aria-describedby="review-paste-hint"><\/textarea>/);
  const hint = /<p class="hint" id="review-paste-hint">([^<]*)<\/p>/.exec(row)?.[1] ?? "";
  for (const heading of ["## Summary", "## Findings", "## Validation Notes", "## Recommendations"]) {
    assert.ok(hint.includes(heading), heading);
  }
  assert.match(hint, /nothing is saved until you press Save Review Result/);
  assert.match(row, /<p class="error" id="review-paste-error" role="alert" hidden><\/p>/);
  for (const id of ["parse-review-output", "cancel-review-paste"]) {
    assert.match(row, new RegExp(`<button type="button" class="result-link" id="${id}"`), `#${id} is not a plain button`);
  }
  assert.match(row, /<p class="review-prefill-note" id="review-prefill-note" hidden><\/p>/);
  assert.equal(/<form\b/.test(row), false, "a nested form would submit the panel — a Run");
});

test("nothing about verification claims more than recorded evidence", () => {
  // The wording the brief rules out, on the panel and in the page script.
  for (const overclaim of [
    "Verify Fix",
    "Mark Verified",
    "Approve Fix",
    "Fix verified",
    "Safe to merge",
    "Verified",
    "Approved",
    "Confidence",
    "Skipped",
  ]) {
    assert.equal(HTML.includes(overclaim), false, `the panel says "${overclaim}"`);
    assert.equal(PAGE_JS.includes(overclaim), false, `the page script says "${overclaim}"`);
  }
  // A new check starts as Not Run: the first status offered is the default.
  const statuses = /const CHECK_STATUSES = \[([\s\S]*?)\];/.exec(PAGE_JS)?.[1] ?? "";
  assert.match(statuses.trim(), /^\["not_run", "Not Run"\]/);
  assert.equal(statuses.includes("skipped"), false);
});

// --- Repository Files' quick fix (§37.85) -----------------------------------

test("the notice's quick fix wraps inside a 200px sidebar rather than widening it", () => {
  // The text column may shrink below its content, and the button may wrap its label.
  assert.match(CSS, /\.notice-body \{[^}]*min-width: 0;/);
  assert.match(CSS, /\.notice-actions \{[^}]*flex-wrap: wrap;/);
  assert.match(CSS, /\.notice-action \{[^}]*max-width: 100%;[^}]*white-space: normal;/);
  // A busy button is shown as such without losing its focus.
  assert.match(CSS, /\.notice-action\[aria-disabled="true"\]/);
});

test("the line that says what the quick fix did is a live region the page can focus, after the notices", () => {
  const line = /<p id="notice-status"[^>]*>/.exec(HTML)?.[0] ?? "";
  assert.notEqual(line, "", "no notice status line");
  assert.match(line, /role="status"/);
  assert.match(line, /tabindex="-1"/);
  assert.match(line, / hidden/);
  assert.ok(HTML.indexOf('id="notices"') < HTML.indexOf('id="notice-status"'));
});

// --- Investigation & AI Fix: status as words and a dot (§37.86) -------------

test("each row's first line is the choice, then the metadata — duration, status, gear — and the file is not among them", () => {
  for (const id of ["issueDetails", "codeSearch", "gitHistory", "similarFixes", "buildContext", "fixWithAI"]) {
    const row = rowMarkup(id);
    const meta = /<span class="step-meta">([\s\S]*?)<\/span>\s*<\/div>/.exec(row)?.[1] ?? "";
    assert.notEqual(meta, "", `${id}: no metadata cluster`);
    assert.ok(meta.includes(`id="duration-${id}"`), `${id}: duration`);
    assert.ok(meta.includes(`id="status-${id}"`), `${id}: status`);
    assert.equal(meta.includes("step-artifact"), false, `${id}: the artifact link is in the metadata`);
    // The checkbox comes first, in the label, before any of it.
    assert.ok(row.indexOf(`id="plan-${id}"`) < row.indexOf('class="step-meta"'), id);
  }
});

test("the status is words with a decorative mark — no tick glyph is ever in a row's markup", () => {
  for (const id of ["issueDetails", "codeSearch", "gitHistory", "similarFixes", "buildContext", "fixWithAI", "fixResult"]) {
    const row = rowMarkup(id);
    // The mark first, decorative; then the words, which are not.
    assert.ok(
      row.includes(
        `<span class="step-status" id="status-${id}" hidden><span class="step-mark" id="mark-${id}" aria-hidden="true"></span><span class="step-status-text" id="status-text-${id}"></span></span>`,
      ),
      id,
    );
    assert.equal(/codicon-(pass|pass-filled|check|circle-slash)(?![a-z-])/.test(row), false, `${id}: a tick or a prohibition glyph`);
  }
  // Nowhere in the page script either: the marks are a dot or the spinner.
  const marks = /const STEP_MARKS = \{([\s\S]*?)\};/.exec(PAGE_JS)?.[1] ?? "";
  assert.notEqual(marks, "");
  assert.equal(/pass|check|circle-slash/.test(marks), false);
  assert.equal([...marks.matchAll(/codicon-loading/g)].length, 1, "one running indicator");
});

test("the dot is small, round, sized without a pixel width, and coloured from the theme", () => {
  assert.match(CSS, /\.step-dot \{[^}]*padding: 3px;[^}]*border-radius: 50%;/s);
  for (const status of ["success", "ready", "skipped", "failed"]) {
    assert.match(CSS, new RegExp(`\\.step-${status} \\.step-dot \\{[^}]*background: var\\(--`), status);
  }
  // High Contrast draws a ring, so it is never colour alone.
  assert.match(CSS, /body\.vscode-high-contrast \.step-dot,\s*body\.vscode-high-contrast-light \.step-dot \{[^}]*outline: 1px solid/s);
});

test("gears only where a step has settings, as buttons in the metadata", () => {
  for (const id of ["issueDetails", "codeSearch", "buildContext", "fixWithAI"]) {
    const row = rowMarkup(id);
    assert.match(row, new RegExp(`<button type="button" class="icon step-settings" id="settings-${id}"`), id);
  }
  for (const id of ["gitHistory", "similarFixes"]) {
    assert.equal(rowMarkup(id).includes("step-settings"), false, `${id} has a gear`);
  }
});

test("lighter rows: a soft rule and a little air, at full strength in High Contrast", () => {
  assert.match(CSS, /\.step \{[^}]*padding: 5px 0;[^}]*border-top: 1px solid color-mix\(in srgb, var\(--vscode-panel-border\) 55%, transparent\);/s);
  assert.match(CSS, /body\.vscode-high-contrast \.step,\s*body\.vscode-high-contrast-light \.step \{\s*border-top-color: var\(--vscode-panel-border\);/);
  // Muted metadata: the duration and status are quieter than the name.
  assert.match(CSS, /\.step-duration \{[^}]*color: var\(--vscode-descriptionForeground\)/s);
  assert.match(CSS, /\.step-status \{[^}]*color: var\(--vscode-descriptionForeground\)/s);
});

// --- Open AI Session acknowledgement (§37.87) --------------------------------

test("Open AI Session's acknowledgement is a live region under the button, always in the document", () => {
  const line = /<p class="session-feedback" id="session-feedback"[^>]*><\/p>/.exec(HTML)?.[0] ?? "";
  assert.notEqual(line, "", "no session feedback line");
  assert.match(line, /role="status"/);
  assert.match(line, /aria-live="polite"/);
  // Not hidden: a live region added or unhidden with its text is not reliably read.
  assert.equal(/ hidden/.test(line), false);
  const run = HTML.indexOf('<div class="run">');
  assert.ok(run !== -1 && run < HTML.indexOf('id="session-feedback"'));
  assert.ok(HTML.indexOf('id="session-feedback"') < HTML.indexOf('id="run-hint"'));
});

test("the acknowledgement wraps in a narrow sidebar and is never styled as an error", () => {
  const rule = /\.session-feedback \{([^}]*)\}/.exec(CSS)?.[1] ?? "";
  assert.match(rule, /overflow-wrap: anywhere/);
  assert.equal(/(?<![a-z-])width:|white-space: nowrap/.test(rule), false);
  assert.equal(/\.session-feedback[^{]*\{[^}]*errorForeground/s.test(CSS), false, "a closed terminal is not a failure");
});

// --- Tooltip audit (§37.90) --------------------------------------------------

/** The opening tag of the button with this id. */
const buttonTag = (id: string) => new RegExp(`<button[^>]*id="${id}"[^>]*>`).exec(HTML)?.[0] ?? "";
const attr = (tag: string, name: string) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];

test("every icon-only control has a tooltip and an accessible name, and they agree", () => {
  const iconOnly = [
    ["settings-issueDetails", "Configure Issue Details"],
    ["settings-codeSearch", "Configure Code Search"],
    ["settings-buildContext", "Configure Build Context"],
    ["settings-fixWithAI", "Configure AI Agent"],
    ["more-actions", "More actions"],
    ["manage-fix-modes", "Manage Fix Modes"],
  ] as const;
  for (const [id, name] of iconOnly) {
    const tag = buttonTag(id);
    assert.notEqual(tag, "", id);
    assert.equal(attr(tag, "title"), name, `${id} tooltip`);
    assert.equal(attr(tag, "aria-label"), name, `${id} accessible name`);
  }
  // No gear anywhere says Fix with AI: that row's settings are the agent's now.
  assert.equal(HTML.includes("Configure Fix with AI"), false);
});

test("Open Context and Copy say what they act on, in sentence case", () => {
  assert.equal(attr(buttonTag("open-context"), "title"), "Open context");
  assert.equal(attr(buttonTag("copy-context"), "title"), "Copy context");
});

test("the compact next actions say what they really do: Open AI Session focuses, and never starts", () => {
  const session = attr(buttonTag("menu-openSession"), "title") ?? "";
  assert.equal(session, "Focus the existing BugPilot AI terminal");
  assert.doesNotMatch(session, /start|relaunch|restart|new/i);
  assert.equal(attr(buttonTag("menu-startNewAttempt"), "title"), "Start a new AI session using the current prepared context");
  assert.equal(attr(buttonTag("menu-rebuildContext"), "title"), "Rebuild prepared context from the current settings");
  // The primary button uses the same words when it is one of them.
  const titles = /const PRIMARY_TITLES = \{([\s\S]*?)\};/.exec(PAGE_JS)?.[1] ?? "";
  assert.match(titles, /openSession: "Focus the existing BugPilot AI terminal"/);
  assert.match(titles, /rebuildContext: "Rebuild prepared context from the current settings"/);
  assert.equal(/\brun:|fixWithAI:/.test(titles), false, "Run and Fix with AI gained a tooltip their labels already say");
});

test("Cancel Review stops the review, and says nothing about the fix", () => {
  const title = attr(buttonTag("cancel-review"), "title") ?? "";
  assert.equal(title, "Stop the current background AI review");
  assert.doesNotMatch(title, /fix/i);
});

test("clear text buttons carry no tooltip that only repeats their label", () => {
  for (const id of ["run", "stop", "hint-use", "hint-keep", "settings-apply", "settings-cancel", "start-attempt", "cancel-attempt", "save-review-result"]) {
    const tag = buttonTag(id);
    assert.notEqual(tag, "", id);
    assert.equal(attr(tag, "title"), undefined, `${id} has a redundant tooltip`);
  }
});

test("no tooltip names a credential, a token or a command line", () => {
  const titles = [...HTML.matchAll(/title="([^"]*)"/g), ...PAGE_JS.matchAll(/setAttribute\("title", ([^)]*)\)/g)].map((match) => match[1]!);
  for (const title of titles) {
    assert.doesNotMatch(title, /token|password|secret|credential|agentCommand|JIRA_/i, title);
  }
});

// --- Advanced Settings (§37.91) ----------------------------------------------

/** The main view's visible text, comments and attributes aside. */
const visibleText = (markup: string) =>
  markup.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");

test("the way into the settings page is Advanced Settings; Workflow Settings is no visible label anywhere", () => {
  const button = /<button type="button" id="open-settings"[\s\S]*?<\/button>/.exec(HTML)?.[0] ?? "";
  assert.match(button, /<span class="settings-open-label">Advanced Settings<\/span>/);
  assert.match(SETTINGS_VIEW, /<h2 id="settings-heading"[^>]*>Advanced Settings<\/h2>/);
  assert.equal(visibleText(HTML).includes("Workflow Settings"), false, "the old name is still on screen");
});

test("Advanced Settings sits with the inputs — after Issue, Fix Mode and Hint, under Run, above the workflow", () => {
  const at = (id: string) => HTML.indexOf(`id="${id}"`);
  for (const earlier of ["issue", "fixModeId", "hint", "run", "run-hint"]) {
    assert.ok(at(earlier) < at("open-settings"), `${earlier} is not above Advanced Settings`);
  }
  // Not in the result area, and not over Diagnostics.
  for (const later of ["workflow", "step-fixResult", "open-folder", "review-result", "diagnostics"]) {
    assert.ok(at("open-settings") < at(later), `Advanced Settings is below ${later}`);
  }
  const between = HTML.slice(at("open-folder"), at("diagnostics"));
  assert.equal(between.includes("settings-entry"), false, "a settings entry is left between the results and Diagnostics");
  assert.equal(HTML.split('class="settings-entry"').length - 1, 1, "more than one way in from the form");
});

test("Advanced Settings is a compact secondary button: bordered, unfilled, never the primary style", () => {
  const button = /<button type="button" id="open-settings"[^>]*>/.exec(HTML)?.[0] ?? "";
  assert.equal(button.includes("primary"), false);
  // The accessible name is the visible text; the tooltip says where it goes.
  assert.equal(button.includes("aria-label"), false);
  assert.match(button, /title="Open advanced workflow settings"/);
  assert.match(HTML, /<button type="button" id="open-settings"[^>]*>\s*<span class="codicon codicon-settings-gear" aria-hidden="true"><\/span>\s*<span class="settings-open-label">Advanced Settings<\/span>/);
  const rule = /\.settings-open \{([^}]*)\}/.exec(CSS)?.[1] ?? "";
  // A button now (§37.93), not the quiet link of §37.91.
  assert.match(rule, /border: 1px solid var\(--vscode-button-border, var\(--vscode-panel-border\)\);/);
  assert.match(rule, /padding: 3px 10px;/);
  assert.match(rule, /background: transparent;/);
  assert.match(rule, /color: var\(--vscode-foreground\);/);
  assert.equal(/border: none|descriptionForeground|text-decoration/.test(rule), false, "still the old muted link");
  // Never the primary's colours.
  assert.equal(/--vscode-button-background|--vscode-button-foreground/.test(rule), false);
  // Hover strengthens it; focus is the shared focus outline.
  assert.match(CSS, /\.settings-open:hover:not\(:disabled\) \{[^}]*background: var\(--vscode-toolbar-hoverBackground/s);
  assert.match(CSS, /button:focus-visible \{[^}]*outline: 1px solid var\(--vscode-focusBorder\)/s);
  // Content-sized, not a full-width bar.
  assert.equal(/(?<![a-z-])width: 100%|flex: 1/.test(rule), false);
});

test("Advanced Settings wraps between words at 200px, never inside one", () => {
  const rule = /\.settings-open \{([^}]*)\}/.exec(CSS)?.[1] ?? "";
  assert.match(rule, /max-width: 100%;/);
  assert.match(rule, /overflow-wrap: normal;/);
  assert.equal(/(?<![a-z-])width:|white-space: nowrap|word-break: break-all/.test(rule), false);
  assert.match(CSS, /\.settings-entry \{[^}]*flex-wrap: wrap;/s);
});

// --- Hint actions: Improve with AI, Include issue details (§37.92) -----------

const HINT_ROW = /<div class="hint-actions">[\s\S]*?<\/div>\s*<\/div>/.exec(HTML)?.[0] ?? "";

test("the hint actions say what they do: Improve with AI, Include issue details — the old labels are gone", () => {
  assert.notEqual(HINT_ROW, "", "no hint actions row");
  assert.match(HINT_ROW, /<span id="improve-hint-label">Improve with AI<\/span>/);
  assert.match(HINT_ROW, /<label class="choice" for="useIssueDetails"[^>]*>\s*<input type="checkbox" id="useIssueDetails"[^>]*>\s*Include issue details\s*<\/label>/);
  const visible = HTML.replace(/<!--[\s\S]*?-->/g, "").replace(/<[^>]+>/g, " ");
  assert.equal(visible.includes("Use issue details"), false, "the old checkbox label is still on screen");
  // "Improve" alone, as this button's label, is gone — the word may appear elsewhere.
  assert.equal(/<span id="improve-hint-label">Improve<\/span>/.test(HTML), false);
  assert.match(PAGE_JS, /label\.textContent = busy \? "Improving…" : "Improve with AI";/);
});

test("Improve with AI comes before Include issue details in the markup, so in the tab order too", () => {
  const improve = HINT_ROW.indexOf('id="improve-hint"');
  const include = HINT_ROW.indexOf('id="useIssueDetails"');
  assert.ok(improve !== -1 && include !== -1);
  assert.ok(improve < include, "the option comes before the action");
  // Not reordered by CSS behind the markup's back.
  for (const rule of ["order:", "flex-direction: row-reverse", "flex-direction: column-reverse"]) {
    assert.equal(new RegExp(`\\.(hint-actions|hint-include|choice)[^{]*\\{[^}]*${rule}`, "s").test(CSS), false, rule);
  }
});

test("the two controls' tooltips and names agree with what they do", () => {
  const button = /<button type="button" id="improve-hint"[^>]*>/.exec(HINT_ROW)?.[0] ?? "";
  assert.match(button, /title="Improve this guidance with AI while preserving your intent"/);
  // Its name is its text, Improve with AI — no aria-label to drift from it.
  assert.equal(button.includes("aria-label"), false);
  const label = /<label class="choice" for="useIssueDetails"[^>]*>/.exec(HINT_ROW)?.[0] ?? "";
  assert.match(label, /title="Include the current issue title and description in the AI guidance"/);
  // Nothing wider than the issue text is promised.
  assert.doesNotMatch(label, /repository|history|attachment|code search|comments/i);
  // The Hint itself gains no tooltip: its label and helper already explain it.
  assert.equal(/<textarea[^>]*id="hint"[^>]*title=/.test(HTML), false);
});

test("the helper belongs to Include issue details: in its group, under it, and describing it", () => {
  const group = /<div class="hint-include">[\s\S]*?<\/div>/.exec(HINT_ROW)?.[0] ?? "";
  assert.notEqual(group, "", "the option is not grouped with its helper");
  assert.match(group, /<p class="hint" id="useIssueDetails-hint">Includes only the issue title and description\. Repository files and history are not read\.<\/p>/);
  assert.ok(group.indexOf('id="useIssueDetails"') < group.indexOf('id="useIssueDetails-hint"'));
  assert.equal(group.includes('id="improve-hint"'), false);
  assert.match(group, /aria-describedby="useIssueDetails-hint"/);
  assert.equal(HTML.includes("The issue title and description only. No repository, history or files are read."), false, "the old helper is still there");
});
