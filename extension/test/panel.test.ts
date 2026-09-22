import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  MAX_ATTACHMENTS,
  PANEL_ACTIONS,
  WORKFLOW_CHECKBOX_IDS,
  parsePanelMessage,
} from "../src/panel/messages.ts";
import { ADVANCED_FIELD_IDS, TEXT_FIELD_IDS, panelHtml } from "../src/panel/html.ts";
import { DEFAULT_FORM } from "../src/app/form.ts";
import { WORKFLOW_STEP_IDS } from "../src/app/workflow.ts";

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
  agent: "claude",
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
  for (const field of TEXT_FIELD_IDS) {
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
  assert.deepEqual(parsePanelMessage({ type: "openArtifact", name: "agent_task.md" }), {
    type: "openArtifact",
    name: "agent_task.md",
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
  const understood = new Set([
    "ready",
    "run",
    "stop",
    "retry",
    "formChanged",
    "addAttachments",
    "action",
    "command",
    "openArtifact",
    "manageFixModes",
    "closeFixModes",
    "fixModeAction",
    "saveFixMode",
  ]);
  for (const type of sent) {
    assert.ok(understood.has(type), `the page sends "${type}", which the host drops`);
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
  const modelFields = Object.keys(DEFAULT_FORM).filter(
    // `attachments` is a list built by a file dialog, not a text field, and
    // `agent` and `fixModeId` are selects whose options come from elsewhere —
    // the agent list from the markup, the Fix Modes from the CLI.
    (key) =>
      !["source", "plan", "fresh", "fixWithAI", "agent", "attachments", "fixModeId"].includes(key),
  );
  assert.deepEqual([...TEXT_FIELD_IDS].sort(), modelFields.sort());
});

test("there is one row, with one checkbox, for every workflow step", () => {
  // Both directions. A step in the model with no row can never be chosen, and
  // a row the model does not know about is a checkbox that changes nothing.
  for (const id of WORKFLOW_STEP_IDS) {
    assert.match(HTML, new RegExp(`id="step-${id}"`), `no row for ${id}`);
    assert.match(HTML, new RegExp(`id="plan-${id}"`), `no checkbox for ${id}`);
  }
  const rows = [...HTML.matchAll(/id="step-([A-Za-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(rows, [...WORKFLOW_STEP_IDS], "the rows are in the model's order");
  assert.deepEqual([...WORKFLOW_CHECKBOX_IDS].sort(), rows.map((id) => `plan-${id}`).sort());
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

test("the status icon is at the far right, away from the checkbox", () => {
  // The two ends answer different questions — "will this run" on the left,
  // "how did it go" on the right. Side by side, a ticked checkbox and a green
  // tick were one check mark too many.
  const row = /<li[^>]*id="step-codeSearch"[\s\S]*?<\/li>/.exec(HTML)?.[0] ?? "";
  assert.notEqual(row, "", "no Code search row");
  const order = [
    'id="plan-codeSearch"',
    'id="duration-codeSearch"',
    'id="status-codeSearch"',
  ].map((id) => row.indexOf(id));
  assert.deepEqual([...order].sort((a, b) => a - b), order, "checkbox first, status last");
  // Nothing until the step has done something: the checkbox already says it is
  // going to run.
  assert.match(row, /id="status-codeSearch"[^>]*hidden/);

  // On the one row that has them, the action icons come before both.
  const built = /<li[^>]*id="step-buildContext"[\s\S]*?<\/li>/.exec(HTML)?.[0] ?? "";
  assert.ok(
    built.indexOf('id="actions-buildContext"') < built.indexOf('id="status-buildContext"'),
  );
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
  // The names the page substitutes into `codicon-${...}` at render time.
  const templated = [...PAGE_JS.matchAll(/icon: "([a-z-]*)"/g)]
    .map((match) => match[1]!)
    .filter((name) => name !== "");
  assert.ok(templated.length >= 4, "expected the step-state icons to be found");

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

test("Build context carries its actions as icons on its own row", () => {
  const row = /<li[^>]*id="step-buildContext"[\s\S]*?<\/li>/.exec(HTML)?.[0] ?? "";
  assert.notEqual(row, "", "no Build context row");
  const buttons = [...row.matchAll(/<button[^>]*id="([a-z-]+)"/g)].map((match) => match[1]);
  assert.deepEqual(buttons, ["open-context", "copy-context", "open-folder"]);
  // Icons only, which is only usable if each says what it does — on hover and
  // to a screen reader.
  for (const id of buttons) {
    const tag = new RegExp(`<button[^>]*id="${id}"[^>]*>`).exec(row)?.[0] ?? "";
    assert.match(tag, /title="[^"]+"/, `${id} has no tooltip`);
    assert.match(tag, /aria-label="[^"]+"/, `${id} has no accessible name`);
  }
  // Hidden until the step has produced them; the host decides when.
  assert.match(row, /id="actions-buildContext"[^>]*hidden/);
  assert.match(row, /codicon-go-to-file/);
});

test("Advanced settings has a heading that says what it is for", () => {
  const advanced = /<details[^>]*id="advanced"[\s\S]*?<\/details>/.exec(HTML)?.[0] ?? "";
  const summary = /<summary>[\s\S]*?<\/summary>/.exec(advanced)?.[0] ?? "";
  assert.notEqual(summary, "", "no summary");
  assert.match(summary, /codicon-settings-gear/);
  assert.match(summary, /Advanced Settings \(Optional\)/);
  assert.match(summary, /Fine-tune the investigation/);
  // The way back out, offered only once the section is open — and inside the
  // summary, so the element's own toggle closes it and no script is needed.
  assert.match(summary, /Hide Advanced/);
  assert.match(CSS, /\.advanced\[open\] > summary > \.adv-toggle \{\s*display: flex/);
});

test("every setting has a header row with a real label in it", () => {
  // One layout for every row, including the agent picker and the checkbox.
  // Two layouts for the same kind of thing is what made the section look
  // assembled rather than designed.
  const advanced = /<details[^>]*id="advanced"[\s\S]*?<\/details>/.exec(HTML)?.[0] ?? "";
  const rows = [...advanced.matchAll(/<div class="setting-header">([\s\S]*?)<\/div>/g)].map(
    (match) => match[1]!,
  );
  // The text fields, plus the three rows that are not text fields: the agent
  // picker, the attachment list and the checkbox.
  assert.equal(rows.length, ADVANCED_FIELD_IDS.length + 3, "a row is missing the pattern");

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
  // The rule: label says what it is, placeholder shows an example, helper text
  // is for a rule or a consequence. A placeholder disappears the moment
  // somebody types, so anything that must stay readable while they type cannot
  // live in one.
  const advanced = /<details[^>]*id="advanced"[\s\S]*?<\/details>/.exec(HTML)?.[0] ?? "";
  // `[a-zA-Z-]+`, with the hyphen: the first version of this pattern could not
  // match `add-attachment-hint`, so a whole row's helper text slipped past the
  // guard unnoticed. A character class is a claim about what ids look like.
  const withHelper = [...advanced.matchAll(/<p class="hint" id="([a-zA-Z-]+)-hint">/g)].map(
    (match) => match[1],
  );
  assert.deepEqual(
    [...withHelper].sort(),
    ["add-attachment", "agentCommand", "fresh"],
    "helper text should remain only where a placeholder could not carry it",
  );
  // Where the files go and who reads them: not inferable from "Attachments",
  // and there is no input to hang a placeholder on.
  assert.match(advanced, /named in the agent's task file/);

  // And what each of them says is the reason it survived.
  assert.match(advanced, /\{prompt\} is replaced with the handoff prompt, already quoted\./);
  assert.match(advanced, /Off by default to avoid accidental data loss/);
});

test("a field with nothing to explain says nothing, and points at nothing", () => {
  // Not an empty paragraph left where the helper text was, and not an
  // `aria-describedby` naming an element that was never rendered.
  for (const id of ["hint", "keywords", "focusFiles", "ignorePaths", "maxFiles", "maxSearchLines"]) {
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
  // The gear, and the two icons the page script creates.
  assert.match(HTML, /codicon-settings-gear[^"]*icon-primary/);
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

test("every field in the section carries an icon, so it can be scanned", () => {
  // A gap in that column is more distracting than an icon, which is why this
  // checks all of them rather than the ones the design named.
  const advanced = /<details[^>]*id="advanced"[\s\S]*?<\/details>/.exec(HTML)?.[0] ?? "";
  for (const id of [...ADVANCED_FIELD_IDS, "agent", "add-attachment"]) {
    const label = new RegExp(`<label[^>]*for="${id}"[^>]*>(.*?)</label>`, "s").exec(advanced)?.[1];
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
  for (const id of ["description", "hint", "keywords", "focusFiles", "ignorePaths"]) {
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

test("the AI agent picker is a label and three options, and nothing else", () => {
  // The option text is the explanation, so the helper line and the note that
  // used to sit under it are both gone. What is not gone is the label: the
  // select is still named for a screen reader.
  assert.match(HTML, /<option value="auto">Auto-detect \(Recommended\)<\/option>/);
  assert.match(HTML, /<label[^>]*for="agent"/);
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

test("every optional field is inside the collapsed Advanced settings", () => {
  const advanced = /<details[^>]*id="advanced"[\s\S]*?<\/details>/.exec(HTML)?.[0] ?? "";
  assert.notEqual(advanced, "", "could not find the advanced section");
  // Collapsed: no `open` attribute. The whole point is that a normal run needs
  // nothing in here.
  assert.equal(/<details[^>]*\bopen\b/.test(HTML), false, "Advanced settings starts open");
  for (const id of ADVANCED_FIELD_IDS) {
    assert.ok(advanced.includes(`id="field-${id}"`), `${id} is not inside Advanced settings`);
  }
  // And the input area is only the source switch plus the field it needs.
  const beforeRun = HTML.slice(0, HTML.indexOf('id="run"'));
  for (const id of ADVANCED_FIELD_IDS) {
    assert.equal(
      beforeRun.includes(`id="field-${id}"`),
      false,
      `${id} is still above the Run button`,
    );
  }
});

test("Run, Stop and Retry are one row, in that order", () => {
  // Their first home was the bottom of the form, below Advanced settings — far
  // from the button whose run they act on.
  const row = /<div class="run-buttons">[\s\S]*?<\/div>/.exec(HTML)?.[0] ?? "";
  assert.notEqual(row, "", "could not find the button row");
  const buttons = [...row.matchAll(/<button[^>]*id="([a-z]+)"/g)].map((match) => match[1]);
  assert.deepEqual(buttons, ["run", "stop", "retry"]);
  // Hidden in the markup too, not just after the first state push: the page is
  // built before the host answers, and both would flash there.
  for (const id of ["stop", "retry"]) {
    assert.match(row, new RegExp(`id="${id}"[^>]*hidden`), `${id} should start hidden`);
  }
  // Run is the only one that is always there, so it is the one that stretches.
  assert.match(CSS, /#run\s*\{[^}]*flex:\s*1/);
});

test("Run is one prominent button with its shortcut spelled out", () => {
  assert.match(HTML, /<button type="submit" id="run" class="primary">/);
  assert.match(HTML, /codicon-play/);
  assert.match(HTML, /Ctrl\+Enter/);
  assert.match(HTML, /Prepare context and optionally fix with AI\./);
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
  for (const name of ["agent_task.md", "bug_context.md", "search_quality.json", "execution.log"]) {
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
  assert.match(PAGE_JS, /type: "addAttachments"/);
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

test("the page has a Fix Mode selector outside Advanced settings", () => {
  // Outside on purpose: this is an execution choice, not retrieval tuning, and
  // burying it would make Investigate First a setting nobody finds.
  const advanced = HTML.slice(HTML.indexOf('id="advanced"'));
  assert.ok(HTML.includes('<select id="fixModeId"'), "no Fix Mode selector in the page");
  assert.ok(!advanced.includes('id="fixModeId"'), "the Fix Mode selector is inside Advanced settings");
  assert.ok(
    HTML.indexOf('id="field-fixModeId"') < HTML.indexOf('id="run"'),
    "the Fix Mode selector should sit above the run button",
  );
});

test("the Fix Mode selector is labelled and described for assistive tech", () => {
  assert.ok(HTML.includes('<label for="fixModeId"'), "the selector has no label");
  assert.ok(HTML.includes('aria-describedby="fixModeId-description"'));
  assert.ok(HTML.includes('id="fixModeId-description"'));
});

test("the page markup does not name any Fix Mode", () => {
  // The options are filled from `fix-mode list --json`; a name here would go
  // stale silently the day a mode is renamed or added.
  for (const name of ["Standard Fix", "Conservative Fix", "Investigate First"]) {
    assert.ok(!HTML.includes(name), `the markup hard-codes the mode name ${name}`);
  }
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
