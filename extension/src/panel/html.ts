/**
 * The panel's document.
 *
 * A static skeleton, built once: every control, label and ARIA relationship
 * lives here, and `media/panel.js` only fills in values, text and classes. That
 * split is deliberate — markup that a test can read is markup a test can check,
 * and it keeps the page's script small enough to be obviously correct.
 *
 * The shape is one column, read top to bottom, because that is the order the
 * work happens in:
 *
 *     input → Run → the six workflow steps → advanced settings
 *
 * It replaced three separate places that described the same run: an
 * "Investigate" fieldset of checkboxes, a "Progress" checklist repeating the
 * same five labels, and a "Hand off" card that appeared at the end with three
 * buttons. Now each step owns its own row: the checkbox that chooses it, the
 * status it reached, and — for Build context — the icons for what it produced.
 *
 * Three §5.4 rules are enforced by construction rather than by review:
 *
 *  - **No colours.** Nothing in here or in `panel.css` names a colour; every
 *    one comes from a `--vscode-*` variable, which is what makes the four
 *    required themes work without four sets of screenshots.
 *  - **A strict CSP.** `default-src 'none'`, styles and fonts only from the
 *    extension's own directory, and the one script tag carries a nonce. There
 *    is no inline script and no remote origin, so a bug title pulled from Jira
 *    has nothing to exploit even if it reaches the page.
 *  - **Every step row is here, not built by the page.** The checkbox is form
 *    state and belongs to the page; the status is the run's and belongs to the
 *    host. Static rows are what let both be true at once.
 *
 * The two ends of a row answer two different questions, which is why they are
 * at opposite ends: the checkbox on the left is *will this run*, the status on
 * the right is *how did it go*. They started out side by side, and a ticked
 * checkbox beside a green tick was one check mark too many.
 */

import { WORKFLOW_STEP_IDS, STEP_LABELS, stepDescription } from "../app/workflow.ts";
import type { WorkflowStepId } from "../app/workflow.ts";

export interface PanelHtmlOptions {
  /** A fresh random nonce per document load. */
  readonly nonce: string;
  /** `webview.cspSource`. */
  readonly cspSource: string;
  /** `asWebviewUri` for media/panel.css and media/panel.js. */
  readonly styleUri: string;
  readonly scriptUri: string;
  /** `asWebviewUri` for media/codicons/codicon.css. */
  readonly codiconUri: string;
}

interface TextField {
  readonly id: string;
  readonly label: string;
  readonly kind: "input" | "textarea" | "number";
  readonly hint?: string;
  readonly rows?: number;
  readonly placeholder?: string;
  /**
   * A codicon name, drawn in the gutter to the left of the label.
   *
   * What makes Advanced settings scannable: nine fields read as a list you can
   * run your eye down rather than nine paragraphs. Every field in the section
   * has one, because a gap in that column is more distracting than an icon.
   */
  readonly icon?: string;
  /** Which of the six semantic tones colours it. Defaults to `muted`. */
  readonly tone?: IconTone;
}

/**
 * The six tones an icon can take, defined as colours in `panel.css`.
 *
 * A small closed palette rather than a colour per setting: blue for
 * general/search/AI, yellow for guidance, grey for ordinary file settings, red
 * for exclusion, orange for a warning, green for success. Naming them here is
 * what keeps that discipline — adding a seventh tone means editing this type.
 */
export type IconTone = "primary" | "hint" | "danger" | "muted" | "success" | "warning";

/**
 * The input area: the one field the chosen source needs, and nothing else.
 *
 * Everything optional moved into Advanced settings. A developer preparing
 * JR-12345 types six characters and presses Run; the seven tuning fields that
 * used to sit between the issue key and the button are still there for the runs
 * that need them.
 */
const MAIN_FIELDS: readonly TextField[] = [
  {
    id: "issueKey",
    label: "Issue key",
    kind: "input",
    placeholder: "JR-12345",
  },
  {
    id: "description",
    label: "Bug description",
    kind: "textarea",
    rows: 5,
    hint: "What happens, and how to reproduce it.",
  },
];

/**
 * Collapsed by default. Nothing in here is needed for a normal run.
 *
 * The label says what the setting is and the placeholder shows an example, so
 * most of these carry no helper text at all: a line reading "One path per line"
 * above a box already showing three paths on three lines is clutter that has to
 * be read before it can be dismissed.
 *
 * Helper text is kept for exactly one kind of thing — a rule or a consequence
 * that a placeholder cannot carry, because **a placeholder disappears the
 * moment somebody types**. Two survive on that test: the custom command's
 * `{prompt}` substitution, and the destructive checkbox.
 */
const ADVANCED_FIELDS: readonly TextField[] = [
  {
    id: "title",
    label: "Title",
    kind: "input",
    icon: "edit",
    tone: "muted",
    placeholder: "e.g. Crash when saving with no selection",
  },
  {
    id: "hint",
    label: "Hint",
    kind: "input",
    icon: "lightbulb",
    tone: "hint",
    placeholder: "e.g. Check initialization logic in the affected component",
  },
  {
    id: "keywords",
    label: "Keywords",
    kind: "input",
    icon: "search",
    tone: "primary",
    placeholder: "e.g. initialization, configuration, crash, validation",
  },
  {
    id: "focusFiles",
    label: "Focus files",
    kind: "textarea",
    rows: 4,
    icon: "file",
    tone: "muted",
    // A multi-line placeholder, which is what makes "one path per line" obvious
    // without a paragraph saying so — and is why that paragraph is gone.
    placeholder: "e.g.\nsrc/core/\nsrc/services/example.cpp\ninclude/example.h",
  },
  {
    id: "ignorePaths",
    label: "Ignore paths",
    kind: "textarea",
    rows: 4,
    icon: "circle-slash",
    tone: "danger",
    placeholder: "e.g.\nbuild/\nthird_party/\ngenerated/",
  },
];

/**
 * The two limits, side by side while there is room for them.
 *
 * Their defaults are shown as placeholders rather than filled in as values, and
 * that is a deliberate difference from the reference design: an empty field
 * means "let the CLI decide", and `buildPrepareArgs` omits the flag entirely.
 * Typing 10 into the box would start sending `--max-files=10` on every run —
 * the same behaviour today, and a value pinned against the CLI's own default
 * changing tomorrow. Grey 10 in the box says the same thing truthfully.
 */
const LIMIT_FIELDS: readonly TextField[] = [
  {
    id: "maxFiles",
    label: "Max files",
    kind: "number",
    icon: "file",
    tone: "muted",
    placeholder: "10",
  },
  {
    id: "maxSearchLines",
    label: "Max search lines",
    kind: "number",
    icon: "list-ordered",
    tone: "primary",
    placeholder: "300",
  },
];

const AGENT_COMMAND_FIELD: TextField = {
  id: "agentCommand",
  label: "Custom agent command",
  kind: "input",
  icon: "terminal",
  tone: "primary",
  placeholder: "my-agent --prompt {prompt}",
  // Kept: this is a rule, not a description. `{prompt}` arrives already quoted,
  // so somebody who adds their own quotes gets a broken command line — and a
  // placeholder cannot say that, because it is gone as soon as they type.
  hint: "{prompt} is replaced with the handoff prompt, already quoted.",
};

/**
 * The icons on the Build context row, in the order they appear.
 *
 * Icons rather than three more buttons, because the row is the label: an
 * "Open generated context" button says nothing that the row above it plus a
 * file icon does not. Each carries `title` and `aria-label`, so the meaning is
 * available to a mouse and to a screen reader alike.
 */
const STEP_ACTIONS: Readonly<
  Partial<Record<WorkflowStepId, readonly { id: string; icon: string; label: string }[]>>
> = {
  buildContext: [
    { id: "open-context", icon: "go-to-file", label: "Open generated context" },
    { id: "copy-context", icon: "copy", label: "Copy context prompt" },
    { id: "open-folder", icon: "folder-opened", label: "Open artifacts folder" },
  ],
};

export function panelHtml(options: PanelHtmlOptions): string {
  const csp = [
    "default-src 'none'",
    `style-src ${options.cspSource}`,
    `font-src ${options.cspSource}`,
    `img-src ${options.cspSource} data:`,
    `script-src 'nonce-${options.nonce}'`,
  ].join("; ");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${options.codiconUri}">
<link rel="stylesheet" href="${options.styleUri}">
<title>BugPilot</title>
</head>
<body>
<main class="panel">

  <p id="checking" class="muted" role="status">Checking bugpilot…</p>

  <section id="blocked" class="card card-blocked" role="alert" hidden>
    <p id="blocked-summary" class="card-title"></p>
    <p id="blocked-action" class="muted"></p>
    <div id="blocked-actions" class="actions"></div>
  </section>

  <form id="form" autocomplete="off">

    <div class="radios" role="radiogroup" aria-label="Input source">
      <label class="choice"><input type="radio" name="source" id="source-jira" value="jira" checked> Jira issue</label>
      <label class="choice"><input type="radio" name="source" id="source-manual" value="manual"> Bug description</label>
    </div>

${MAIN_FIELDS.map(field).join("\n")}

    <div class="run">
      <div class="run-buttons">
        <button type="submit" id="run" class="primary">
          <span class="codicon codicon-play" aria-hidden="true"></span>
          Run
        </button>
        <button type="button" id="stop" hidden disabled>Stop</button>
        <button type="button" id="retry" hidden>Retry</button>
      </div>
      <span class="kbd">Ctrl+Enter</span>
    </div>
    <p class="hint" id="run-hint">Prepare context and optionally fix with AI.</p>

    <section class="group" id="workflow" aria-labelledby="workflow-heading">
      <div class="workflow-head">
        <h2 id="workflow-heading">Investigation &amp; AI Fix</h2>
        <span id="workflow-status" class="workflow-status" role="status">Ready to run</span>
      </div>
      <ol class="steps">
${WORKFLOW_STEP_IDS.map(step).join("\n")}
      </ol>
      <p id="activity" class="muted" aria-live="polite"></p>
      <p id="plan-note" class="muted" hidden>Without Build context, bugpilot only normalizes the report — search, history, similar fixes and the AI fix are skipped too.</p>
    </section>

    <details class="group advanced" id="advanced">
      <summary>
        <span class="codicon codicon-settings-gear adv-gear icon-primary" aria-hidden="true"></span>
        <span class="adv-heading">
          <span class="adv-title">Advanced Settings (Optional)</span>
          <span class="adv-subtitle">Fine-tune the investigation to get better results</span>
        </span>
        <span class="adv-toggle">
          <span class="codicon codicon-chevron-up" aria-hidden="true"></span>
          Hide Advanced
        </span>
      </summary>

${ADVANCED_FIELDS.map(field).join("\n")}

      <div class="limits">
${LIMIT_FIELDS.map(field).join("\n")}
      </div>

      <div class="field" id="field-agent">
${settingHeader({
        forId: "agent",
        label: "AI agent",
        icon: "hubot",
        tone: "primary",
      })}
        <select id="agent" name="agent">
          <option value="auto">Auto-detect (Recommended)</option>
          <option value="claude">Claude Code</option>
          <option value="custom">Custom command…</option>
        </select>
      </div>
${field(AGENT_COMMAND_FIELD)}

      <div class="field" id="field-attachments">
${settingHeader({
        forId: "add-attachment",
        label: "Attachments",
        icon: "attach",
        tone: "muted",
        hint: "Copied into the work item and named in the agent's task file.",
      })}
        <ul id="attachment-list" class="attachments" hidden></ul>
        <button type="button" id="add-attachment">
          <span class="codicon codicon-add" aria-hidden="true"></span>
          Add files…
        </button>
      </div>

      <div class="field field-check">
${settingHeader({
        forId: "fresh",
        label: "Delete previous artifacts first",
        control: '<input type="checkbox" id="fresh" aria-describedby="fresh-hint"> ',
        labelClass: "choice",
        // Kept, and the only helper text in the section that describes a
        // consequence rather than a field: this one deletes an agent's work.
        hint: "Removes existing generated artifacts before running. Off by default to avoid accidental data loss.",
      })}
      </div>
    </details>
  </form>

  <section id="failure" class="card card-failure" role="alert" hidden>
    <p id="failure-summary" class="card-title"></p>
    <p id="failure-action" class="muted"></p>
  </section>

  <section id="notices" class="notices" role="status" hidden></section>

  <footer class="footer">
    <p class="footer-line">
      <span class="codicon codicon-folder" aria-hidden="true"></span>
      <span id="environment"></span>
    </p>
    <p class="footer-line">
      <span class="codicon codicon-key" aria-hidden="true"></span>
      <span>Jira:</span>
      <span class="codicon codicon-check icon-success" id="jira-ok" aria-hidden="true" hidden></span>
      <span id="jira-status"></span>
      <button type="button" id="set-credentials" class="link">Set Jira credentials</button>
    </p>
  </footer>
</main>
<script nonce="${options.nonce}" src="${options.scriptUri}"></script>
</body>
</html>
`;
}

/**
 * A setting's label and its helper text, on one line while there is room.
 *
 * Every row in the panel goes through here — the text fields, the agent picker
 * and the checkbox — because two layouts for the same kind of thing is what
 * made the section look assembled rather than designed. The wrapping is the
 * stylesheet's business: `flex-wrap` with a floor under the helper, so it drops
 * below the label when the panel is narrow instead of being squeezed into a
 * column two words wide.
 *
 * The label stays a real `<label for=…>`; this only changes where it sits.
 */
function settingHeader(options: {
  readonly forId: string;
  readonly label: string;
  readonly icon?: string;
  readonly tone?: IconTone;
  readonly hint?: string;
  /** For a checkbox, whose control lives inside its own label. */
  readonly control?: string;
  readonly labelClass?: string;
}): string {
  // The tone is a class, never an inline style: the colours belong to the
  // stylesheet, where a theme can be reasoned about in one place.
  const icon = options.icon
    ? `<span class="codicon codicon-${options.icon} setting-icon icon-${
        options.tone ?? "muted"
      }" aria-hidden="true"></span>`
    : "";
  // Omitted entirely when there is nothing to say, rather than left hidden:
  // an empty paragraph is a gap where the helper text used to be.
  const hint = options.hint ? `<p class="hint" id="${options.forId}-hint">${options.hint}</p>` : "";
  const labelClass = options.labelClass ? ` class="${options.labelClass}"` : "";
  return `      <div class="setting-header">
        <label${labelClass} for="${options.forId}">${icon}${options.control ?? ""}${options.label}</label>
        ${hint}
      </div>`;
}

function field(entry: TextField): string {
  // `aria-describedby` names only descriptions that exist. Most fields now have
  // no helper text, and pointing a screen reader at an element that was never
  // rendered is worse than pointing it at nothing.
  const described = entry.hint
    ? `${entry.id}-hint ${entry.id}-error`
    : `${entry.id}-error`;
  const placeholder = entry.placeholder
    ? ` placeholder="${entry.placeholder.replaceAll("\n", "&#10;")}"`
    : "";
  const control =
    entry.kind === "textarea"
      ? `<textarea id="${entry.id}" name="${entry.id}" rows="${entry.rows ?? 3}"${placeholder} aria-describedby="${described}"></textarea>`
      : entry.kind === "number"
        ? // `inputmode` rather than `type="number"`: the spinner steals the
          // field's width in a 200px sidebar, and the value still travels as a
          // string that `buildPrepareArgs` validates either way.
          `<input type="text" inputmode="numeric" id="${entry.id}" name="${entry.id}"${placeholder} aria-describedby="${described}">`
        : `<input type="text" id="${entry.id}" name="${entry.id}"${placeholder} aria-describedby="${described}">`;
  // A field with nothing to explain still carries the hint element, hidden: the
  // control's `aria-describedby` names it, and an empty visible paragraph
  // leaves a gap in the row for no reason.
  return `    <div class="field" id="field-${entry.id}">
${settingHeader({
    forId: entry.id,
    label: entry.label,
    ...(entry.icon === undefined ? {} : { icon: entry.icon }),
    ...(entry.tone === undefined ? {} : { tone: entry.tone }),
    ...(entry.hint === undefined ? {} : { hint: entry.hint }),
  })}
      ${control}
      <p class="error" id="${entry.id}-error" hidden></p>
    </div>`;
}

/**
 * One workflow row.
 *
 * Ticked in the markup — including `fixWithAI`, which is the one exception:
 * it starts unticked because involving a model is a decision of its own (R5),
 * and a box that arrives ticked has made that decision for the developer. The
 * rest match `DEFAULT_FORM`, so a Run that happens before the host's first
 * state push does what the boxes say. `test/panel.test.ts` compares both
 * against the model.
 */
function step(id: WorkflowStepId): string {
  const required = id === "issueDetails";
  const checked = id === "fixWithAI" ? "" : " checked";
  const box = `<input type="checkbox" id="plan-${id}"${checked}${required ? " disabled" : ""}>`;
  const note = required ? `<span class="step-note">Always runs</span>` : "";
  const actions = STEP_ACTIONS[id];
  // The Jira wording, because that is the source the form starts on; the host
  // replaces it with the manual wording on the first push after a switch.
  const description = stepDescription(id, "jira");
  return `        <li class="step" id="step-${id}">
          <div class="step-head">
            <label class="step-label" for="plan-${id}">${box}<span>${STEP_LABELS[id]}</span></label>
${
  actions
    ? `            <span class="step-actions" id="actions-${id}" hidden>${actions
        .map(
          (action) =>
            `<button type="button" class="icon" id="${action.id}" title="${action.label}" aria-label="${action.label}"><span class="codicon codicon-${action.icon}" aria-hidden="true"></span></button>`,
        )
        .join("")}</span>\n`
    : ""
}            <span class="step-duration" id="duration-${id}"></span>
            <span class="step-status codicon" id="status-${id}" aria-hidden="true" hidden></span>
          </div>
          <div class="step-foot">
            <p class="step-description" id="description-${id}">${description}</p>
            ${note}
          </div>
        </li>`;
}

/** The text field ids the page owns, exported so tests can compare them to `FormState`. */
export const TEXT_FIELD_IDS: readonly string[] = [
  ...MAIN_FIELDS,
  ...ADVANCED_FIELDS,
  ...LIMIT_FIELDS,
  AGENT_COMMAND_FIELD,
].map((entry) => entry.id);

/** The ids of the fields Advanced settings hides, so a test can check it hides them. */
export const ADVANCED_FIELD_IDS: readonly string[] = [
  ...ADVANCED_FIELDS.map((entry) => entry.id),
  ...LIMIT_FIELDS.map((entry) => entry.id),
  AGENT_COMMAND_FIELD.id,
];
