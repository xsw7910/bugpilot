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
 *     Issue, Fix Mode, Hint → Run → Advanced Settings → the workflow steps
 *
 * Only the first two of those are open on an untouched panel. §34's UI-A1
 * made the workflow a disclosure beside Advanced settings, so what greets a
 * developer is the one sentence the tool is about — type the issue, press
 * Run — rather than every control the panel owns laid out at equal weight.
 * Batch 7 took Fix Mode out of that sentence too: Standard Fix is what almost
 * every run uses, so choosing another is a setting — then under Advanced
 * settings → Strategy, now on the Workflow Settings page with the rest of Fix
 * with AI's settings — rather than a question asked before every Run.
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
import { NEXT_ACTION_LABELS, RUN_HINT } from "../app/nextAction.ts";
import type { NextActionId } from "../app/nextAction.ts";
import {
  REQUIRES_REBUILD_LABEL,
  SETTINGS_ACTION_LABELS,
  SETTINGS_SECTION_OF_STEP,
  SETTINGS_SECTION_TITLES,
  WORKFLOW_SETTINGS_SECTIONS,
  sectionRebuildNote,
  showsRebuildLabel,
  isSettingsField,
} from "../app/workflowSettings.ts";
import type { SettingsField, WorkflowSettingsSection } from "../app/workflowSettings.ts";

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
   * What makes the settings page scannable: its fields read as a list you can
   * run your eye down rather than paragraphs. Every field there has one,
   * because a gap in that column is more distracting than an icon.
   */
  readonly icon?: string;
  /** Which of the six semantic tones colours it. Defaults to `muted`. */
  readonly tone?: IconTone;
  /** Markup rendered under the control, for a field with its own actions. */
  readonly extra?: string;
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
 * The input area: one field, and nothing else.
 *
 * It was a radio pair and two fields — "Jira issue" with an issue key box,
 * "Bug description" with a textarea — which asked the developer to classify
 * their input before entering it. §34's UI-A1 removed the question, because the
 * answer is derivable from the input: a Jira key matches `JIRA_ISSUE_KEY_RE`
 * and everything else is prose. `media/panel.js` derives `source` and fills
 * `issueKey` or `description` from this one control, so `FormState`, the
 * message protocol and `buildPrepareArgs` never learn that the switch is gone.
 *
 * Multi-line because the same box now holds a six-character key and a pasted
 * bug report; two rows at rest, growing with what is typed like every other
 * textarea here.
 */
const ISSUE_FIELD = `      <div class="field" id="field-issue">
${settingHeader({ forId: "issue", label: "Issue" })}
        <textarea id="issue" name="issue" rows="2" placeholder="Enter a Jira ticket (e.g. JR-12345) or describe the bug" aria-describedby="issue-hint issue-note issue-error"></textarea>
        <p class="hint" id="issue-hint">Use a Jira issue ID, or describe the problem directly.</p>
        <p class="muted issue-note" id="issue-note" hidden></p>
        <p class="error" id="issue-error" hidden></p>
      </div>`;

/**
 * The hint's own actions: let an AI tidy it up, and decide what it may read.
 *
 * Rendered under the hint rather than as a section of its own, because it is
 * one field's affordance and not a second feature. The suggestion appears
 * beside the field and never in it — the developer's own words are not
 * something this replaces without being asked.
 */
const HINT_IMPROVEMENT = `      <div class="hint-actions">
        <label class="choice" for="useIssueDetails">
          <input type="checkbox" id="useIssueDetails" name="useIssueDetails" checked
                 aria-describedby="useIssueDetails-hint">
          Use issue details
        </label>
        <button type="button" id="improve-hint" class="link"
                title="Improve this hint with AI">
          <span class="codicon codicon-hubot" id="improve-hint-icon" aria-hidden="true"></span>
          <span id="improve-hint-label">Improve</span>
        </button>
      </div>
      <p class="hint" id="useIssueDetails-hint">The issue title and description only. No repository, history or files are read.</p>
      <p class="muted" id="hint-improve-notice" hidden></p>
      <p class="error" id="hint-improve-error" role="alert" hidden></p>
      <div id="hint-suggestion" class="hint-suggestion" hidden>
        <p class="card-title" id="hint-suggestion-heading" tabindex="-1">AI Suggestion</p>
        <p class="preview-text" id="hint-suggestion-text"></p>
        <div class="run-buttons">
          <button type="button" id="hint-use">Use Improved</button>
          <button type="button" id="hint-keep">Keep Original</button>
        </div>
      </div>
`;

/**
 * Strategy: how the agent approaches the bug — the one Fix Mode selector.
 *
 * On the main page, directly under the Issue (§37.84): what the bug is, how the
 * AI should approach it and any guidance for it are defined together, before
 * Run. It is a form field like the Issue — every change goes to the host, which
 * alone decides that a prepared context is now stale — and it has no second
 * copy on the settings page. The host still restores and normalizes the
 * selection, and the selected mode's description — including "Investigation
 * only" — stays directly under the selector it describes.
 *
 * The gear opens Manage Fix Modes (view, duplicate, create, edit, delete),
 * which is why it sits beside the selector rather than anywhere else.
 */
const FIX_MODE_FIELD = `        <div class="field" id="field-fixModeId">
${settingHeader({
  forId: "fixModeId",
  label: "Fix Mode",
  icon: "lightbulb",
  tone: "primary",
  hint: "How the AI works on this bug.",
})}
          <div class="fix-mode-row">
            <select id="fixModeId" name="fixModeId" aria-describedby="fixModeId-hint fixModeId-description">
              <option value="">Loading Fix Modes…</option>
            </select>
            <button type="button" id="manage-fix-modes" class="icon" title="Manage Fix Modes" aria-label="Manage Fix Modes">
              <span class="codicon codicon-settings-gear" aria-hidden="true"></span>
            </button>
          </div>
          <p class="hint fix-mode-note" id="fixModeId-description"></p>
        </div>`;

/**
 * Guidance: what the AI is told, beyond the bug report itself — on the main
 * page under Fix Mode (§37.84), with its Improve and Use issue details.
 *
 * One field, and that is the point of giving it a heading of its own. UI-A2's
 * question was which of these settings talk to the agent and which decide what
 * BugPilot searches, and a developer who cannot answer it types keywords into
 * the hint.
 */
const GUIDANCE_FIELDS: readonly TextField[] = [
  {
    id: "hint",
    label: "Hint",
    // Multi-line, although a hint is still a pointer rather than a document.
    // The reason is not room, it is visibility: a single-line input scrolls
    // sideways, so by the time a developer has typed a sentence the start of it
    // is gone. Three rows, growing with what is typed until `panel.css` stops
    // it — which keeps the section scannable when the field is empty.
    kind: "textarea",
    rows: 3,
    icon: "lightbulb",
    tone: "hint",
    hint: "Add technical guidance, constraints, or suspected areas.",
    placeholder: "e.g. Check initialization logic in the affected component",
    extra: HINT_IMPROVEMENT,
  },
];

/**
 * Retrieval overrides: expert boosts on a search that already runs itself.
 *
 * The heading and the two "(optional)" labels exist to say the thing the old
 * flat list did not: BugPilot retrieves without either of these, and a blank
 * Keywords box is not a job half done. Both carry helper text for the same
 * reason — "Keywords" alone does not distinguish a required input from a
 * thumb on the scale, and a placeholder cannot say so because it disappears the
 * moment somebody types.
 *
 * Nothing here names a weight, a term budget or a search surface. Those are
 * §33's concepts and the panel has no business teaching them.
 */
const RETRIEVAL_FIELDS: readonly TextField[] = [
  {
    id: "keywords",
    label: "Keywords (optional)",
    // Multi-line for visibility, plus one reason of its own: `parseKeywords`
    // splits on newlines as well as commas, so a list written one term per line
    // already worked — there was simply nowhere to type it.
    kind: "textarea",
    rows: 2,
    icon: "search",
    tone: "primary",
    hint: "Boost retrieval with known identifiers or technical terms.",
    placeholder: "e.g. VolumeDescriptor, OpenVDS, outputType",
  },
  {
    id: "focusFiles",
    label: "Focus Files (optional)",
    kind: "textarea",
    rows: 4,
    icon: "file",
    tone: "muted",
    hint: "Prioritize files you already suspect are relevant.",
    // A multi-line placeholder, which is what makes "one path per line" obvious
    // without a paragraph saying so.
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
 * Everything that is about the run rather than about what it searches.
 *
 * Title is the odd one and is here for want of a better home: it is part of the
 * bug report, not of the run, and it only applies to a hand-written bug. The
 * rest — the agent, its command, attachments and the destructive checkbox — are
 * rendered inline below rather than listed here, because none of them is a
 * plain text field.
 *
 * Ignore paths, Max files and Max search lines used to be here. UI-A2c moved
 * them into Retrieval Overrides, which is what they are.
 *
 * The label says what the setting is and the placeholder shows an example, so
 * none of these carries helper text except where a **rule or a consequence**
 * has to stay readable after somebody starts typing — which a placeholder
 * cannot do. Two survive that test: the custom command's `{prompt}`
 * substitution, and the destructive checkbox.
 */
const RUN_OPTION_FIELDS: readonly TextField[] = [
  {
    id: "title",
    label: "Title",
    kind: "input",
    icon: "edit",
    tone: "muted",
    placeholder: "e.g. Crash when saving with no selection",
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

interface ActionButton {
  readonly id: string;
  readonly action: string;
  readonly icon: string;
  readonly label: string;
  readonly title: string;
}

/**
 * Build context's own actions: they act on `context.md`, the file that step
 * produced, so they sit on its row (Batch 6). Same ids, same messages, same
 * tooltips as when they lived in the Context Ready card.
 *
 * Icon *and* label: a pair of bare glyphs under a row reads as decoration; the
 * words are what make them findable, and the `title` carries the longer
 * sentence for a hover.
 */
const BUILD_CONTEXT_ACTIONS: readonly ActionButton[] = [
  {
    id: "open-context",
    action: "openContext",
    icon: "go-to-file",
    label: "Open Context",
    title: "Open context",
  },
  {
    id: "copy-context",
    action: "copyContext",
    icon: "copy",
    label: "Copy",
    title: "Copy context",
  },
];

/**
 * Fix result's one action (Batch 8): the report, in the editor.
 *
 * Not a new host action: it posts the same constrained `openArtifact` message
 * the row's file link does, with the file name the host put on the row — so it
 * can only ever open `fix_report.md` inside the current work item.
 */
const OPEN_FIX_REPORT: ActionButton = {
  id: "open-fix-report",
  action: "openFixReport",
  icon: "go-to-file",
  label: "Open Fix Report",
  title: "Open fix_report.md in the editor",
};

/**
 * The work item's own action. Not Build context's: the folder holds every
 * artifact the run wrote, so it sits at the foot of the workflow rather than
 * beside two buttons that act on one file.
 */
const OPEN_FOLDER: ActionButton = {
  id: "open-folder",
  action: "openFolder",
  icon: "folder-opened",
  label: "Open Folder",
  title: "Reveal the generated artifacts in the explorer",
};

/**
 * The ⋯ menu beside the primary action: the next steps that are not the next
 * step. Each item is shown only while the host lists it in `primary.more`, so
 * Start New Attempt does not exist on screen before the first attempt does.
 */
const MORE_ACTIONS: readonly { readonly id: NextActionId; readonly icon: string; readonly title: string }[] = [
  {
    id: "startNewAttempt",
    icon: "debug-restart",
    title: "Start a new AI session using the current prepared context",
  },
  {
    id: "rebuildContext",
    icon: "refresh",
    title: "Rebuild prepared context from the current settings",
  },
  {
    id: "openSession",
    icon: "terminal",
    // Focus only: Open AI Session never starts or restarts a session (§37.87).
    title: "Focus the existing BugPilot AI terminal",
  },
];

function menuItem(entry: (typeof MORE_ACTIONS)[number]): string {
  return `        <button type="button" role="menuitem" class="menu-item" id="menu-${entry.id}" title="${entry.title}" hidden><span class="codicon codicon-${entry.icon}" aria-hidden="true"></span><span>${NEXT_ACTION_LABELS[entry.id]}</span></button>`;
}

function actionButton(entry: ActionButton): string {
  return `<button type="button" class="result-link" id="${entry.id}" title="${entry.title}" hidden><span class="codicon codicon-${entry.icon}" aria-hidden="true"></span>${entry.label}</button>`;
}

/**
 * A failure card: what failed, what to do next, and the original underneath.
 *
 * One shape rendered in two places — a run that could not finish, and a handoff
 * that could not start — because they are the same three questions with
 * different answers, and two markups for that would drift apart within a phase.
 *
 * The Details disclosure is collapsed and its contents are written with
 * `textContent`: the text inside it is a CLI's stderr and a Jira response, and
 * an error message is exactly the string an attacker would reach for.
 */
function errorCard(id: string): string {
  // A div rather than a section: six of the seven live inside a workflow row,
  // and a nested <section> there would make every "a row is everything up to
  // its closing tag" reading of this document wrong.
  return `      <div id="${id}" class="failure" role="alert" hidden>
        <p class="failure-head">
          <span class="codicon codicon-error icon-danger" aria-hidden="true"></span>
          <span class="failure-title" id="${id}-title"></span>
        </p>
        <p class="muted failure-message" id="${id}-message"></p>
        <div class="failure-actions" id="${id}-actions"></div>
        <details class="failure-details" id="${id}-details" hidden>
          <summary>Details</summary>
          <pre class="failure-detail" id="${id}-detail"></pre>
        </details>
      </div>`;
}

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

  <!--
    One webview, three views: the workflow form, the Fix Mode catalogue, and the
    editor for one mode. Exactly one is ever visible, chosen by showView() in
    panel.js from the host's state. Management used to unhide below the form,
    which in a 300px sidebar meant it appeared off-screen and looked like the
    click had done nothing.
  -->
  <section id="main-view">
    <p id="checking" class="muted" role="status">Checking bugpilot…</p>

    <section id="blocked" class="card card-blocked" role="alert" hidden>
      <p id="blocked-summary" class="card-title"></p>
      <p id="blocked-action" class="muted"></p>
      <div id="blocked-actions" class="actions"></div>
    </section>

    <form id="form" autocomplete="off">

${ISSUE_FIELD}

      <!--
        How the AI should approach the issue, and any guidance for it: with the
        issue itself, the problem as the developer defines it — above Run, in
        the order they are read and tabbed through (§37.84).
      -->
${FIX_MODE_FIELD}
${GUIDANCE_FIELDS.map(field).join("\n")}

      <!--
        The one primary action, under the problem's definition: Run, Fix with AI,
        Open AI Session or Rebuild Context — whichever is next for the work item
        and the form, as the host says (app/nextAction.ts) — or Running…. Its id
        stays "run" because it is still the form's submit, and Ctrl+Enter still
        presses it.

        Beside it only what cannot be pressed at the same time (Stop, during a
        run) or what is not the next step (the ⋯ menu: Start New Attempt,
        Rebuild Context). Nothing here is a second primary button.
      -->
      <div class="run">
        <div class="run-buttons">
          <button type="submit" id="run" class="primary">
            <span class="codicon codicon-play" id="run-icon" aria-hidden="true"></span>
            <span id="run-label">Run</span>
          </button>
          <button type="button" id="stop" hidden disabled>Stop</button>
          <button type="button" id="more-actions" class="icon" title="More actions" aria-label="More actions" aria-haspopup="menu" aria-expanded="false" aria-controls="more-menu" hidden><span class="codicon codicon-ellipsis" aria-hidden="true"></span></button>
        </div>
        <span class="kbd">Ctrl+Enter</span>
      </div>
      <!-- What Open AI Session came to (§37.87): a live region that is always in
           the document, empty until the host answers a press, so the answer is
           announced without moving the keyboard focus. -->
      <p class="session-feedback" id="session-feedback" role="status" aria-live="polite"></p>
      <div class="more-menu" id="more-menu" role="menu" aria-label="More actions" hidden>
${MORE_ACTIONS.map(menuItem).join("\n")}
      </div>
      <p class="hint" id="run-hint">${RUN_HINT}</p>

      <!--
        Advanced Settings (§37.91): the one page where every step's settings live
        (app/workflowSettings.ts), also reached from each row's gear. Under Run
        and its hint and above the workflow — with the inputs, not after the
        results, where it read as part of the review above Diagnostics. A quiet
        link: never a button beside Run, Fix with AI or Review with AI. Its name
        is its visible text; the tooltip says where it goes.
      -->
      <div class="settings-entry">
        <button type="button" id="open-settings" class="settings-open" title="Open advanced workflow settings">
          <span class="codicon codicon-settings-gear" aria-hidden="true"></span>
          <span class="settings-open-label">Advanced Settings</span>
        </button>
      </div>

      <!--
        A disclosure rather than a section, since UI-A1: the six rows were the
        largest thing on an untouched panel and said nothing a developer who has
        not typed an issue yet needs. They carry two different things — the
        checkboxes that choose what runs, and the statuses of a run in flight —
        so hiding them until a run starts would take away the only pre-run way
        to reach Fix with AI. Collapsed instead, and the page script opens it
        the moment a run begins.
      -->
      <details class="group" id="workflow" aria-labelledby="workflow-heading">
        <summary class="workflow-summary">
          <h2 id="workflow-heading">Investigation &amp; AI Fix</h2>
          <span id="workflow-status" class="workflow-status" role="status">Ready to run</span>
        </summary>
        <!--
          A run failure no row owns: one before any step started, or one the
          extension observed itself. A failure while a step was in flight is on
          that step's row instead, and the rows before it keep their results.
        -->
${errorCard("failure")}
        <ol class="steps">
  ${WORKFLOW_STEP_IDS.map(step).join("\n")}
${FIX_RESULT_ROW}
        </ol>
        <p id="activity" class="muted" aria-live="polite"></p>
        <p id="plan-note" class="muted" hidden>Without Build context, bugpilot only normalizes the report — search, history, similar fixes and the AI fix are skipped too.</p>
        <div class="workflow-foot" id="workflow-foot">
          ${actionButton(OPEN_FOLDER)}
        </div>
      </details>

      <!--
        What BugPilot is configured with, for the developer who is not sure
        which install, which repository or which agent is in play.

        Outside the workflow rather than inside it, a deliberate departure from
        UI-C2's sketch: the question this answers — is this the environment I
        think it is — is asked most urgently when nothing has run or when a run
        has just failed, and it must not depend on a run's results. It reads
        last in the details.

        Read-only and passive: opening it makes no request and spawns no probe,
        which is why it is a definition list and not a single control.
      -->
      <details class="diagnostics" id="diagnostics" hidden>
        <summary id="diagnostics-summary">Diagnostics</summary>
        <dl id="diagnostics-list"></dl>
      </details>
    </form>

    <section id="notices" class="notices" role="status" hidden></section>
    <!-- What a notice's quick fix did, once the notice is gone (§37.85): focus
         lands here rather than on a card that no longer exists. -->
    <p id="notice-status" class="notice-done" role="status" tabindex="-1" hidden></p>

  </section>

${settingsView()}

  <section id="fix-mode-manager-view" class="view" aria-labelledby="manage-heading" hidden>
    <div class="view-head">
      <button type="button" id="manage-back" class="link view-back">
        <span class="view-back-mark" aria-hidden="true">&lsaquo;</span>
        Back
      </button>
      <h2 id="manage-heading" class="view-title" tabindex="-1">Manage Fix Modes</h2>
      <p class="muted view-lede">The AI workflows available to this repository.</p>
    </div>
    <p id="manage-error" class="error" role="alert" hidden></p>
    <p id="manage-success" class="success" role="status" hidden></p>
    <p id="manage-detail" class="muted" hidden></p>
    <div id="manage-list"></div>
  </section>

  <section id="fix-mode-preview-view" class="view" aria-labelledby="preview-heading" hidden>
    <div class="view-head">
      <button type="button" id="preview-back" class="link view-back">
        <span class="view-back-mark" aria-hidden="true">&lsaquo;</span>
        Back to Fix Mode Manager
      </button>
      <h2 id="preview-heading" class="view-title" tabindex="-1"></h2>
      <p id="preview-description" class="muted"></p>
      <p id="preview-meta" class="preview-meta"></p>
    </div>
    <p id="preview-error" class="error" role="alert" hidden></p>
    <p id="preview-success" class="success" role="status" hidden></p>
    <!--
      Rendered text, not disabled inputs: this is a mode being read, and a form
      full of greyed-out boxes reads as one the developer is failing to edit.
    -->
    <div id="preview-body" class="preview-body"></div>
    <div class="run-buttons" id="preview-actions"></div>
  </section>

  <section id="fix-mode-editor-view" class="view" aria-labelledby="editor-title" hidden>
    <div class="view-head">
      <button type="button" id="editor-back" class="link view-back">
        <span class="view-back-mark" aria-hidden="true">&lsaquo;</span>
        <span id="editor-back-label">Back to Fix Mode Manager</span>
      </button>
      <h2 id="editor-title" class="view-title" tabindex="-1"></h2>
      <p id="editor-origin" class="muted"></p>
    </div>
    <!--
      The same message the manager shows, rendered again here: a refused save
      keeps the editor open, and an error left behind in the manager would be on
      a view the developer cannot see.
    -->
    <p id="editor-error" class="error" role="alert" hidden></p>

    <div class="field">
      <label for="editor-name">Name</label>
      <input type="text" id="editor-name">
    </div>
    <div class="field">
      <label for="editor-id">ID</label>
      <input type="text" id="editor-id">
      <p class="hint" id="editor-id-hint">Lowercase letters, digits and hyphens. Fixed once the mode exists.</p>
    </div>
    <div class="field">
      <label for="editor-description">Description</label>
      <input type="text" id="editor-description">
    </div>
    <div class="field">
      <label for="editor-executionKind">Execution kind</label>
      <select id="editor-executionKind">
        <option value="fix">Fix — change source code</option>
        <option value="investigate">Investigate — diagnose first, no source changes</option>
      </select>
    </div>
    <div class="field">
      <label for="editor-scope">Scope</label>
      <select id="editor-scope">
        <option value="user">User — your home directory</option>
        <option value="project">Project — this repository, shareable</option>
      </select>
      <p class="hint" id="editor-scope-hint">Fixed once the mode exists. Duplicate it to move it.</p>
    </div>

${EDITOR_SECTIONS.map(section).join("\n")}

    <div class="run-buttons">
      <button type="button" id="editor-save" class="primary">Save Fix Mode</button>
      <button type="button" id="editor-preview">Preview Generated Instructions</button>
      <button type="button" id="editor-cancel">Cancel</button>
    </div>
    <div id="editor-preview-pane" hidden>
      <p id="editor-preview-heading" class="card-title" tabindex="-1">Instruction Preview</p>
      <p class="muted">
        What this mode tells the agent. BugPilot's own evidence, branch, Jira and
        delivery rules are added around it and are not editable here.
      </p>
      <div id="editor-preview-body"></div>
    </div>
  </section>

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

/** The AI agent picker: three choices, no helper text — each option says what it does. */
const AGENT_FIELD = `        <div class="field" id="field-agent">
  ${settingHeader({
    forId: "agent",
    label: "AI agent",
    icon: "hubot",
    tone: "primary",
    rebuild: showsRebuildLabel("agent"),
  })}
          <select id="agent" name="agent">
            <option value="auto">Auto-detect (Recommended)</option>
            <option value="claude">Claude Code</option>
            <option value="custom">Custom command…</option>
          </select>
        </div>`;

/** Files to copy in beside the issue: a list the page renders, and the dialog's button. */
const ATTACHMENTS_FIELD = `        <div class="field" id="field-attachments">
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
        </div>`;

/**
 * Delete previous artifacts first — Fresh. Kept with the only helper text in the
 * page that describes a consequence rather than a field: this one deletes an
 * agent's work.
 */
const FRESH_FIELD = `        <div class="field field-check">
  ${settingHeader({
    forId: "fresh",
    label: "Delete previous artifacts first",
    control: '<input type="checkbox" id="fresh" aria-describedby="fresh-hint"> ',
    labelClass: "choice",
    hint: "Removes existing generated artifacts before running. Off by default to avoid accidental data loss.",
  })}
        </div>`;

/** What each section holds, in the order `SETTINGS_SECTION_FIELDS` lists its fields. */
function sectionBody(section: WorkflowSettingsSection): string {
  switch (section) {
    case "issue-details":
      return `${RUN_OPTION_FIELDS.map(field).join("\n")}\n${ATTACHMENTS_FIELD}`;
    case "code-search":
      return `${RETRIEVAL_FIELDS.map(field).join("\n")}
        <div class="limits">
  ${LIMIT_FIELDS.map(field).join("\n")}
        </div>`;
    case "build-context":
      return FRESH_FIELD;
    case "fix-with-ai":
      return `${AGENT_FIELD}\n${field(AGENT_COMMAND_FIELD)}`;
  }
}

/**
 * Workflow Settings: one page, one section per step that has settings, in the
 * workflow's order — so a row's gear lands on its section and the whole
 * configuration can still be read top to bottom.
 *
 * A view like the Fix Mode ones, outside the form: Enter in one of its fields
 * must not submit a Run, and nothing typed here is part of the form until
 * Apply. Each section's heading takes focus when a gear lands on it, and its
 * note says — from `SETTING_REQUIRES_REBUILD` — whether its changes make a
 * prepared context stale. Apply is the page's one primary button; Back and
 * Cancel both discard.
 */
function settingsView(): string {
  const sections = WORKFLOW_SETTINGS_SECTIONS.map(
    (section) => `    <section class="settings-section" id="settings-section-${section}" aria-labelledby="settings-title-${section}">
      <h3 class="settings-section-title" id="settings-title-${section}" tabindex="-1">${SETTINGS_SECTION_TITLES[section]}</h3>
      <p class="hint settings-rebuild" id="settings-note-${section}">${sectionRebuildNote(section)}</p>
${sectionBody(section)}
    </section>`,
  ).join("\n\n");
  return `  <section id="workflow-settings-view" class="view" aria-labelledby="settings-heading" hidden>
    <div class="view-head">
      <button type="button" id="settings-back" class="link view-back">
        <span class="view-back-mark" aria-hidden="true">&lsaquo;</span>
        Back
      </button>
      <h2 id="settings-heading" class="view-title" tabindex="-1">Advanced Settings</h2>
      <p class="muted view-lede">What each workflow step uses. Changes take effect when you press Apply; Back and Cancel discard them.</p>
    </div>

${sections}

    <p class="muted settings-busy" id="settings-busy" role="status" hidden>BugPilot is working on this work item. Apply is available once it finishes.</p>
    <div class="settings-actions">
      <button type="button" id="settings-cancel">Cancel</button>
      <button type="button" id="settings-apply" class="primary">Apply</button>
    </div>
  </section>`;
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
  /** Say, beside the label, that changing this setting makes a prepared context stale. */
  readonly rebuild?: boolean;
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
  const rebuild = options.rebuild ? `<span class="rebuild-label" id="${options.forId}-rebuild">${REQUIRES_REBUILD_LABEL}</span>` : "";
  return `      <div class="setting-header">
        <label${labelClass} for="${options.forId}">${icon}${options.control ?? ""}${options.label}</label>
        ${rebuild}${hint}
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
    rebuild: isSettingsField(entry.id) && showsRebuildLabel(entry.id),
  })}
      ${control}
      <p class="error" id="${entry.id}-error" hidden></p>
${entry.extra ?? ""}    </div>`;
}

/**
 * One workflow row: the choice, the status, and — since Batch 6 — the result.
 *
 * Ticked in the markup — including `fixWithAI`, which is the one exception:
 * it starts unticked because involving a model is a decision of its own (R5),
 * and a box that arrives ticked has made that decision for the developer. The
 * rest match `DEFAULT_FORM`, so a Run that happens before the host's first
 * state push does what the boxes say. `test/panel.test.ts` compares both
 * against the model.
 *
 * Every slot below the summary line starts hidden and is filled by the page
 * from the host's `WorkflowStepResult`: a detail line, the owned artifact as a
 * quiet link, whatever the step owns (Code search's two disclosures, Build
 * context's two actions, Fix with AI's button and Strategy line), and the row's
 * own failure card.
 */
function step(id: WorkflowStepId): string {
  const required = id === "issueDetails";
  const checked = id === "fixWithAI" ? "" : " checked";
  const box = `<input type="checkbox" id="plan-${id}"${checked}${required ? " disabled" : ""}>`;
  const note = required ? `<span class="step-note" id="note-${id}">Always runs</span>` : "";
  // The Jira wording, because that is the source the form starts on; the host
  // replaces it with the manual wording on the first push after a switch.
  const description = stepDescription(id, "jira");
  // A gear only where the step has a settings section: Git history and Similar
  // fixes are configured by their checkbox alone. Named for its step — "Configure
  // Code Search" — because six buttons all called Settings are one name read six
  // times. Visible at rest (quieter until hovered or focused), never hover-only.
  const section = SETTINGS_SECTION_OF_STEP[id];
  const gear = section
    ? `\n            <button type="button" class="icon step-settings" id="settings-${id}" title="${SETTINGS_ACTION_LABELS[section]}" aria-label="${SETTINGS_ACTION_LABELS[section]}"><span class="codicon codicon-settings-gear" aria-hidden="true"></span></button>`
    : "";
  const summary = section ? `\n            <p class="step-settings-summary" id="settings-summary-${id}" hidden></p>` : "";
  // First line: the choice (the checkbox and the name), then the metadata —
  // how long it took, how it went, its gear. The status is words with a small
  // dot or the spinner beside them, never a second tick (§37.86). The
  // artifact link sits under the row's lines, not among the metadata.
  return `        <li class="step" id="step-${id}">
          <div class="step-head">
            <label class="step-label" for="plan-${id}">${box}<span class="step-name">${STEP_LABELS[id]}</span></label>
            <span class="step-meta">
              <span class="step-duration" id="duration-${id}"></span>
              ${stepStatus(id)}${gear}
            </span>
          </div>
          <div class="step-foot" id="foot-${id}">
            <p class="step-description" id="description-${id}">${description}</p>
            ${note}
          </div>
          <div class="step-body">${summary}
            <p class="step-detail" id="detail-${id}" hidden></p>
            ${stepArtifact(id)}
${stepContent(id)}
${errorCard(`error-${id}`)}
          </div>
        </li>`;
}

/**
 * The seventh row, present only while `fix_report.md` is (Batch 8).
 *
 * Built like the six so it reads as part of the same list, with two
 * differences that are the point: no checkbox — nobody chooses it and no run
 * performs it — and no row failure card, because a report that cannot be
 * previewed is still a report, not an error. (The one card it has is Review
 * with AI's, about that action.) Hidden in the markup; the page shows it only
 * while the host's workflow includes it.
 */
const FIX_RESULT_ROW = `        <li class="step" id="step-fixResult" hidden>
          <div class="step-head">
            <span class="step-label"><span class="step-name">${STEP_LABELS.fixResult}</span></span>
            <span class="step-meta">
              <span class="step-duration" id="duration-fixResult"></span>
              ${stepStatus("fixResult")}
            </span>
          </div>
          <div class="step-foot" id="foot-fixResult">
            <p class="step-description" id="description-fixResult">${stepDescription("fixResult", "jira")}</p>
          </div>
          <div class="step-body">
            <p class="step-detail" id="detail-fixResult" hidden></p>
            <!-- Show more / Show less (§37.89): only while the report's lines are
                 actually cut short; the whole text is in the lines above either way. -->
            <button type="button" class="link fix-summary-toggle" id="fix-summary-toggle" aria-controls="description-fixResult detail-fixResult" aria-expanded="false" aria-label="Show full Fix result" title="Show full Fix result" hidden>Show more</button>
            ${stepArtifact("fixResult")}
${stepContent("fixResult")}
          </div>
        </li>`;

/**
 * A row's status: a mark — a small dot, or the spinner while it runs — and the
 * words. The mark is decorative; the words are the status, for everyone.
 */
function stepStatus(id: WorkflowStepId): string {
  return `<span class="step-status" id="status-${id}" hidden><span class="step-mark" id="mark-${id}" aria-hidden="true"></span><span class="step-status-text" id="status-text-${id}"></span></span>`;
}

/** The canonical artifact a row owns, as a quiet file link on a line of its own. */
function stepArtifact(id: WorkflowStepId): string {
  return `<button type="button" class="step-artifact" id="artifact-${id}" hidden><span class="codicon codicon-file" aria-hidden="true"></span><span id="artifact-${id}-name"></span></button>`;
}

/** What a row owns beyond its summary, in its body. */
function stepContent(id: WorkflowStepId): string {
  if (id === "codeSearch") {
    // Which files, and why those: collapsed, because the row's summary line is
    // the answer to "what did it find" and these are for the developer who
    // wants to look. The rows are built by the page from what the host read
    // out of retrieval.json; nothing here names a file, a score or a rank.
    return `            <details class="files" id="relevant-files" hidden>
              <summary id="relevant-files-summary">Relevant files</summary>
              <div id="relevant-files-list"></div>
              <p class="muted" id="relevant-files-more" hidden></p>
            </details>
            <details class="terms" id="search-details" hidden>
              <summary id="search-details-summary">Search details</summary>
              <div id="search-details-list"></div>
            </details>`;
  }
  if (id === "buildContext") {
    return `            <div class="step-actions" id="actions-buildContext" hidden>
              ${BUILD_CONTEXT_ACTIONS.map(actionButton).join("\n              ")}
            </div>`;
  }
  if (id === "fixResult") {
    // Read the report first; then, if wanted, prepare someone else's review of
    // it (Batch 9), or start one with the selected agent (Batch 10). Each label
    // says what its button does — one copies a prompt, one starts a reviewer;
    // neither is a review — in its own span, so the page can say it is busy
    // without dropping the icon. All three are the same quiet secondary style:
    // the report is what this row is about.
    //
    // Under them, what Review with AI did: a status that is always in the
    // document, so a screen reader hears it fill, and the row's own failure
    // card — Fix result has no other, since a report that cannot be previewed
    // is not a failure. While a captured review runs, a progress card sits
    // under the status (§37.82): the elapsed time — outside the live region,
    // so it is not read out every second — Show details, and Cancel Review.
    //
    // Then Review Result (Batch 11): what somebody saved after a review, in
    // their words, and never more than that — "Review result saved" is the
    // whole claim. Add Review Result sits with the row's actions while none is
    // saved; once one is, Open and Replace sit with it. Paste Review Output
    // sits beside either: it reads a reviewer's reply in the canonical four
    // sections into the same form, which the developer checks and saves —
    // reading is never saving. The form is four plain text areas, each with a
    // line on what belongs in it; its status is a live region and its failure
    // an alert, both about the saving and never about the review. A group, not
    // a <form>: the rows sit inside the panel's own form, where a nested one is
    // ignored and its submit button would submit the panel — a Run.
    //
    // Then Verification Evidence (Batch 12): the checks the developer recorded
    // and the status they gave each, counted — "Recorded checks: 2 passed,
    // 1 failed" — with the checks by name and one generated, scoped phrase; no
    // badge, and nothing that says verified. The form saves itself (§37.83): a
    // compact status says Unsaved changes, Saving…, Saved, or why not, with Retry
    // Save after a failure and Reload / Overwrite after a conflict; Done closes it
    // once saved. Add Verification Evidence sits
    // with the row's actions while none is recorded; Open and Edit sit with the
    // evidence once it is. The form says first that it is for checks actually
    // performed — a review's observations belong in Review Result — and holds
    // one group per check, built by the page (Add Check, Remove Check), each
    // field with a line on what goes in it; a new check starts as Not Run,
    // never Passed. The examples are placeholders, never saved.
    return `            <div class="step-actions" id="actions-fixResult" hidden>
              ${actionButton(OPEN_FIX_REPORT)}
              <button type="button" class="result-link" id="copy-review-prompt" title="Copy a prompt that asks a reviewer to review this result" hidden><span class="codicon codicon-copy" aria-hidden="true"></span><span id="copy-review-prompt-label">Copy Review Prompt</span></button>
              <button type="button" class="result-link" id="review-with-ai" title="Start the selected AI agent in a terminal with the review prompt. Starting a reviewer is not a review result." hidden><span class="codicon codicon-hubot" aria-hidden="true"></span><span id="review-with-ai-label">Review with AI</span></button>
              <button type="button" class="result-link" id="paste-review-output" title="Paste a reviewer's reply in the four review sections to fill in the review result before saving it" aria-controls="review-paste" aria-expanded="false" hidden><span class="codicon codicon-comment-discussion" aria-hidden="true"></span><span>Paste Review Output</span></button>
              <button type="button" class="result-link" id="record-review-result" title="Enter what a review said — by a person, another tool or an AI reviewer — and save it" aria-controls="review-editor" aria-expanded="false" hidden><span class="codicon codicon-edit" aria-hidden="true"></span><span>Add Review Result</span></button>
              <button type="button" class="result-link" id="record-verification" title="Record the checks you actually performed and what you observed for each" aria-controls="verification-editor" aria-expanded="false" hidden><span class="codicon codicon-list-ordered" aria-hidden="true"></span><span>Add Verification Evidence</span></button>
            </div>
            <div class="review-status" id="review-status" role="status" tabindex="-1"></div>
            <div class="review-progress" id="review-progress" aria-busy="false" hidden>
              <p class="review-progress-elapsed" id="review-elapsed-line">Elapsed: <span id="review-elapsed">00:00</span></p>
              <div class="step-actions review-progress-actions">
                <button type="button" class="result-link" id="review-details-toggle" aria-controls="review-details" aria-expanded="false"><span id="review-details-toggle-label">Show details</span></button>
                <button type="button" class="result-link" id="cancel-review" title="Stop the current background AI review" hidden><span class="codicon codicon-close" aria-hidden="true"></span><span>Cancel Review</span></button>
              </div>
              <dl class="review-details" id="review-details" aria-label="AI review details" hidden></dl>
            </div>
${errorCard("review-error")}
            <details class="validation" id="validation-checklist" hidden>
              <summary id="validation-summary">Validation checklist</summary>
              <div id="validation-body" aria-live="polite"></div>
            </details>
            <div class="review-result" id="review-result" role="group" aria-labelledby="review-result-heading" hidden>
              <p class="review-result-heading result-label" id="review-result-heading" tabindex="-1"><span id="review-result-status"></span></p>
              <p class="review-result-summary" id="review-result-summary"></p>
              <p class="step-detail" id="review-result-detail" hidden></p>
              <p class="muted review-result-also" id="review-result-also" hidden></p>
              <div class="step-actions" id="actions-reviewResult">
                <button type="button" class="result-link" id="open-review-report" title="Open review_report.md in the editor" hidden><span class="codicon codicon-go-to-file" aria-hidden="true"></span><span>Open Review Report</span></button>
                <button type="button" class="result-link" id="replace-review-result" title="Save a new review result in place of this one" aria-controls="review-editor" aria-expanded="false" hidden><span class="codicon codicon-edit" aria-hidden="true"></span><span>Replace Review Result</span></button>
              </div>
            </div>
            <div class="review-paste" id="review-paste" role="group" aria-label="Paste review output" hidden>
              <label for="review-paste-text">Review output</label>
              <p class="hint" id="review-paste-hint">Paste the reviewer's reply with its four sections: ## Summary, ## Findings, ## Validation Notes and ## Recommendations. BugPilot fills in the review result from them; nothing is saved until you press Save Review Result.</p>
              <textarea id="review-paste-text" rows="6" aria-describedby="review-paste-hint"></textarea>
              <p class="error" id="review-paste-error" role="alert" hidden></p>
              <div class="review-editor-actions">
                <button type="button" class="result-link" id="parse-review-output">Parse</button>
                <button type="button" class="result-link" id="cancel-review-paste">Cancel</button>
              </div>
            </div>
            <div class="review-editor" id="review-editor" role="group" aria-label="Review result" hidden>
              <p class="muted review-editor-note">What the review said, in the reviewer's words. BugPilot keeps it with this work item's files; it does not check it or read a verdict into it.</p>
              <p class="review-prefill-note" id="review-prefill-note" hidden></p>
              <label for="review-summary">Summary</label>
              <p class="hint" id="review-summary-hint">Overall review conclusion in the reviewer's own words.</p>
              <textarea id="review-summary" rows="2" aria-describedby="review-summary-hint"></textarea>
              <label for="review-findings">Findings</label>
              <p class="hint" id="review-findings-hint">Specific problems, risks, omissions, or observations.</p>
              <textarea id="review-findings" rows="3" aria-describedby="review-findings-hint"></textarea>
              <label for="review-validation-notes">Validation Notes</label>
              <p class="hint" id="review-validation-notes-hint">What the reviewer actually inspected or ran. Do not imply tests ran if they did not.</p>
              <textarea id="review-validation-notes" rows="2" aria-describedby="review-validation-notes-hint"></textarea>
              <label for="review-recommendations">Recommendations</label>
              <p class="hint" id="review-recommendations-hint">Suggested next actions.</p>
              <textarea id="review-recommendations" rows="2" aria-describedby="review-recommendations-hint"></textarea>
              <div class="review-editor-actions">
                <button type="button" class="result-link" id="save-review-result"><span id="save-review-result-label">Save Review Result</span></button>
                <button type="button" class="result-link" id="cancel-review-result">Cancel</button>
              </div>
            </div>
            <div class="review-status" id="review-capture-status" role="status" tabindex="-1"></div>
            <p class="error" id="review-capture-error" role="alert" hidden></p>
            <div class="verification-result" id="verification-result" role="group" aria-labelledby="verification-result-heading" hidden>
              <p class="verification-result-heading result-label" id="verification-result-heading" tabindex="-1">Verification Evidence</p>
              <p class="verification-result-counts" id="verification-result-counts"></p>
              <p class="step-detail" id="verification-result-overall" hidden></p>
              <ul class="verification-checks" id="verification-result-checks" aria-label="Recorded checks"></ul>
              <p class="muted" id="verification-result-more" hidden></p>
              <div class="step-actions" id="actions-verificationResult">
                <button type="button" class="result-link" id="open-verification-report" title="Open verification_report.md in the editor" hidden><span class="codicon codicon-go-to-file" aria-hidden="true"></span><span>Open Verification Report</span></button>
                <button type="button" class="result-link" id="edit-verification" title="Change the recorded checks; saving replaces verification_report.md" aria-controls="verification-editor" aria-expanded="false" hidden><span class="codicon codicon-edit" aria-hidden="true"></span><span>Edit Verification Evidence</span></button>
              </div>
            </div>
            <div class="verification-editor" id="verification-editor" role="group" aria-label="Verification evidence" hidden>
              <p class="muted verification-editor-note" id="verification-editor-note">Record checks you actually performed and what you observed. BugPilot does not run these checks or infer the result. What a reviewer noticed while reading the change belongs in Review Result.</p>
              <p class="muted verification-editor-note" id="verification-editor-replace-note" hidden>This report is not in BugPilot's format, so its checks could not be read into the form. Your first change replaces it with the checks below.</p>
              <p class="muted verification-editor-note" id="verification-autosave-note">Changes are saved automatically.</p>
              <div class="verification-rows" id="verification-rows"></div>
              <div class="verification-editor-actions">
                <button type="button" class="result-link" id="add-verification-check"><span class="codicon codicon-add" aria-hidden="true"></span><span>Add Check</span></button>
                <button type="button" class="result-link" id="done-verification" title="Close the form; any change not yet saved is saved first">Done</button>
              </div>
              <p class="muted verification-save-status" id="verification-save-status"></p>
              <div class="verification-save-problem" id="verification-save-problem" hidden>
                <div class="verification-editor-actions">
                  <button type="button" class="result-link" id="retry-verification-save" hidden>Retry Save</button>
                  <button type="button" class="result-link" id="reload-verification" hidden>Reload Saved Version</button>
                  <button type="button" class="result-link" id="overwrite-verification" hidden>Overwrite Saved Version</button>
                </div>
              </div>
            </div>
            <div class="review-status" id="verification-capture-status" role="status" tabindex="-1"></div>
            <p class="error" id="verification-capture-error" role="alert" hidden></p>`;
  }
  if (id === "fixWithAI") {
    // The mode the task was prepared with — what the agent was actually told,
    // never what the selector says now. No button: handing the task over is
    // the panel's primary action, at the top, and a second primary one here
    // was a competing answer to "what next?".
    //
    // Then Start New Attempt's form, opened from the ⋯ menu beside the primary
    // action and only once an attempt exists. A group, not a <form>, for the
    // reason Review Result's form gives: a nested one would submit the panel.
    // Its feedback is optional — empty writes nothing — and the two helpers
    // only copy text in when pressed; Start Attempt is the one act.
    return `            <p class="step-strategy" id="strategy-fixWithAI" hidden><span class="result-label">Strategy</span> <span id="strategy-fixWithAI-value"></span></p>
            <div class="attempt-editor" id="attempt-editor" role="group" aria-labelledby="attempt-heading" hidden>
              <p class="attempt-heading" id="attempt-heading" tabindex="-1">Start a new AI attempt</p>
              <p class="muted attempt-note">A new AI session on the prepared context. To keep talking to the current one, use Open AI Session instead.</p>
              <label for="attempt-feedback">Optional feedback</label>
              <textarea id="attempt-feedback" rows="4" placeholder="What should the new attempt do differently?" aria-describedby="attempt-example attempt-storage"></textarea>
              <p class="hint attempt-example" id="attempt-example">Example: The previous fix changed the wrong class. Focus on WidgetController.cpp and keep the existing public API unchanged.</p>
              <p class="hint" id="attempt-storage">Feedback is saved to user_feedback.md for the new attempt, replacing earlier feedback. Left empty, nothing is written.</p>
              <div class="step-actions attempt-helpers" id="attempt-helpers" hidden>
                <button type="button" class="result-link" id="use-review-findings" title="Add the Findings and Recommendations recorded in review_report.md" hidden><span class="codicon codicon-comment-discussion" aria-hidden="true"></span><span>Use Review Findings</span></button>
                <button type="button" class="result-link" id="use-verification-evidence" title="Add the checks recorded as Failed or Not Run in verification_report.md" hidden><span class="codicon codicon-checklist" aria-hidden="true"></span><span>Use Verification Evidence</span></button>
              </div>
              <p class="error" id="attempt-error" role="alert" hidden></p>
              <div class="attempt-actions">
                <button type="button" id="cancel-attempt">Cancel</button>
                <button type="button" id="start-attempt"><span id="start-attempt-label">Start Attempt</span></button>
              </div>
            </div>`;
  }
  return "";
}

/**
 * The six editable sections, as the editor shows them.
 *
 * The ids match `FixModeDraft`'s fields exactly, so the page reads and writes
 * them by name rather than keeping a second mapping that could drift.
 */
export const EDITOR_SECTIONS: readonly { readonly id: string; readonly label: string }[] = [
  { id: "objective", label: "Objective" },
  { id: "investigation", label: "Investigation" },
  { id: "implementation", label: "Implementation" },
  { id: "verification", label: "Verification" },
  { id: "constraints", label: "Constraints" },
  { id: "completion", label: "Completion Requirements" },
];

function section(entry: { readonly id: string; readonly label: string }): string {
  return `    <div class="field">
      <label for="editor-${entry.id}">${entry.label}</label>
      <textarea id="editor-${entry.id}" rows="4"></textarea>
    </div>`;
}

/** The ids of the text fields the Workflow Settings page holds, so a test can check it holds them. */
export const SETTINGS_FIELD_IDS: readonly string[] = [
  ...RETRIEVAL_FIELDS,
  ...LIMIT_FIELDS,
  ...RUN_OPTION_FIELDS,
  AGENT_COMMAND_FIELD,
].map((entry) => entry.id);

/**
 * The text field ids the page owns, exported so tests can compare them to
 * `FormState`.
 *
 * `issue` is the one that is not a `FormState` key: it carries both `issueKey`
 * and `description`, and which of the two it fills is derived from what is in
 * it. `test/panel.test.ts` states that mapping rather than exempting it.
 *
 * The Hint is the form's, under Fix Mode (§37.84). Everything else is what
 * the Workflow Settings page holds — one list, so a field cannot be added to a
 * section and forgotten here.
 */
export const TEXT_FIELD_IDS: readonly string[] = ["issue", ...GUIDANCE_FIELDS.map((entry) => entry.id), ...SETTINGS_FIELD_IDS];
