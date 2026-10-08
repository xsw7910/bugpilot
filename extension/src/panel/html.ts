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
 * Fix Mode is out of that sentence too: Standard Fix is what almost
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

import { ALWAYS_RUNS, OVERALL_IDLE, WORKFLOW_STEP_IDS, STEP_LABELS, stepTooltip } from "../app/workflow.ts";
import { JIRA_SETUP_TEXT, jiraConnection } from "../app/jiraConnection.ts";
import type { WorkflowStepId } from "../app/workflow.ts";
import { NEXT_ACTION_LABELS, PRIMARY_SHORTCUT, PRIMARY_TOOLTIPS } from "../app/nextAction.ts";
import { AGENT_CHOICES, AGENT_LABELS } from "../app/agents.ts";
import type { AgentChoice } from "../app/agents.ts";
import type { NextActionId } from "../app/nextAction.ts";
import { BRANCH_POLICIES, SIMILAR_MAX_FIXES_DEFAULT, SIMILAR_MAX_FIXES_LIMIT } from "../app/form.ts";
import type { BranchPolicy } from "../app/form.ts";
import { REPOSITORY_FIELDS, REPOSITORY_PROFILE_LABELS, REPOSITORY_PROFILE_MODES } from "../app/repositoryProfile.ts";
import type { RepositoryField, RepositoryProfileMode } from "../app/repositoryProfile.ts";
import { INSTRUCTION_TEXT, MAX_INSTRUCTION_CHARS } from "../app/instructions.ts";
import { DEFAULT_BRANCH_TEMPLATE, MAX_BRANCH_TEMPLATE_CHARS, VERIFICATION_FIELDS } from "../app/projectSettings.ts";
import type { VerificationField } from "../app/projectSettings.ts";
import type { InstructionScope } from "../app/instructions.ts";
import {
  DELETE_FILES_HELPER,
  DELETE_FILES_HISTORY,
  DELETE_FILES_LABEL,
  GENERATED_FILES_LEGEND,
  KEEP_FILES_HELPER,
  KEEP_FILES_LABEL,
  NO_FILES_TO_DELETE,
  RESET_AND_DELETE_LABEL,
  RESET_DIALOG_BODY,
  RESET_DIALOG_TITLE,
  RESET_SESSION_LABEL,
  RESET_SESSION_TOOLTIP,
  RESETTING_LABEL,
} from "../app/sessionReset.ts";
import {
  REQUIRES_REBUILD_LABEL,
  SETTINGS_ACTION_LABELS,
  SETTINGS_SECTION_OF_STEP,
  SETTINGS_SECTION_TITLES,
  WORKFLOW_SETTINGS_SECTIONS,
  sectionRebuildNote,
  sectionRebuildTag,
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
  /** A line on screen beside the label: only for a rule that must stay readable while typing. */
  readonly hint?: string;
  /**
   * What the field is for, off the screen (Advanced Settings simplification):
   * the tooltip of the label and the control, and — visually hidden — the
   * control's accessible description, so a screen reader still hears it.
   */
  readonly help?: string;
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
  /** A tooltip for the label and the control: what the field is for, when no helper line says it. */
  readonly title?: string;
  /** An id for the label, for a group the label names (§37.119). */
  readonly labelId?: string;
  /** The most characters the control accepts, where the CLI has a limit. */
  readonly maxLength?: number;
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
 * What three main-page settings are for, as tooltips (§37.104). They used to
 * be lines on the panel; the panel now shows the controls and their state, and
 * these explain on hover — and, for Include issue details, as the checkbox's
 * accessible description, since what it lets the improver read is the point.
 */
const FIX_MODE_HELP = "Choose how BugPilot approaches the fix";
const HINT_HELP = "Add technical guidance, constraints, or suspected areas";
const INCLUDE_ISSUE_DETAILS_HELP =
  "Use the current issue details as context when improving the hint. Only the issue title and description are read; repository files and history are not.";
/**
 * The Issue's two kinds of input, in one sentence: the tooltip and the field's
 * accessible description — the example key lives here rather than in the
 * placeholder. "Jira ID or bug description", beside the label, said a shorter
 * version on screen until §37.112; the row shows how the input was read
 * instead, once there is input.
 */
const ISSUE_HELP =
  "Enter a Jira issue ID such as JR-12345, or describe the bug directly. BugPilot will detect which one you entered.";

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
 * Multi-line because the same box holds a six-character key and a pasted bug
 * report — but one row at rest (Issue compact input), because most of what goes
 * in is the key or a sentence, and a tall empty box beside Run says otherwise.
 * It grows with what is typed like every other textarea here, to four lines,
 * and scrolls after that.
 *
 * The label row is the label, its icon and — once something is typed — how it
 * was read: *Jira issue · JR-12345* or *Bug description*, at the row's right
 * (§37.112). It was a line under the box, with "Jira ID or bug description"
 * beside the label; now the row says what the input is rather than what it may
 * be, and nothing is under the box. The note stays the box's description, so it
 * is heard when the field is reached, and while the field is being typed in
 * `#issue-kind` says the kind once, when typing pauses. The example key and the
 * fact that BugPilot tells the two apart are the tooltip and the accessible
 * description (§37.104).
 */
const ISSUE_FIELD = `      <div class="field" id="field-issue">
${settingHeader({ forId: "issue", label: "Issue", icon: "bug", tone: "primary", title: ISSUE_HELP, note: true, labelId: "issue-label" })}
        <textarea id="issue" name="issue" rows="1" placeholder="Describe the bug or enter a Jira ID" title="${ISSUE_HELP}" aria-describedby="issue-note issue-error issue-help"></textarea>
        <p class="visually-hidden" id="issue-help">${ISSUE_HELP}</p>
        <p class="visually-hidden" id="issue-kind" role="status"></p>
        <p class="error" id="issue-error" hidden></p>
      </div>`;

/**
 * The hint's own actions: let an AI tidy it up, and decide what it may read.
 *
 * Rendered under the hint rather than as a section of its own, because it is
 * one field's affordance and not a second feature. The suggestion appears
 * beside the field and never in it — the developer's own words are not
 * something this replaces without being asked.
 *
 * Improve with AI first — the immediate action — then the option that shapes
 * it (§37.92), read as one phrase: "Improve with AI ☑ using Issue details"
 * (§37.128; §37.126 had the box after "using"). The box and its words are one
 * label, so a click on the words toggles it; unticked, the words go quiet
 * (panel.css), and the box stays the state. The checkbox is named by the
 * action's label and its own words — "Improve with AI using Issue details",
 * read from the page so neither drifts — so a screen reader hears what it
 * modifies, and speech input finds the words on screen. What it lets the
 * improver read is its tooltip and its accessible description, not a line on
 * the panel (§37.104). The order is the markup's, so the tab order is the
 * reading order. The box and its words wrap together, under the action, when
 * the sidebar is narrow.
 */
const HINT_IMPROVEMENT = `      <div class="hint-actions">
        <button type="button" id="improve-hint" class="link"
                title="Improve this guidance with AI while preserving your intent">
          <span class="codicon codicon-hubot" id="improve-hint-icon" aria-hidden="true"></span>
          <span id="improve-hint-label">Improve with AI</span>
        </button>
        <div class="hint-include">
          <label class="choice" for="useIssueDetails"
                 title="${INCLUDE_ISSUE_DETAILS_HELP}">
            <input type="checkbox" id="useIssueDetails" name="useIssueDetails" checked
                   aria-labelledby="improve-hint-label useIssueDetails-text"
                   aria-describedby="useIssueDetails-hint">
            <span class="hint-include-text" id="useIssueDetails-text">using Issue details</span>
          </label>
          <p class="visually-hidden" id="useIssueDetails-hint">${INCLUDE_ISSUE_DETAILS_HELP}</p>
        </div>
      </div>
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
 * selection.
 *
 * Just the label and the selector (§37.104). What the setting is for is the
 * label's tooltip; what the chosen mode does is the selector's tooltip and its
 * accessible description. The line under it shows only what changes what
 * happens: "Investigation only", a problem with the choice, or no catalog.
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
  title: FIX_MODE_HELP,
  labelId: "fixModeId-label",
})}
          <div class="fix-mode-row">
            <select id="fixModeId" name="fixModeId" aria-describedby="fixModeId-description">
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
 * page under Fix Mode (§37.84), with Improve with AI and Include issue details.
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
    // What it is for, in the box until something is typed, and in full on
    // hover (§37.104) — not a line beside the label as well.
    placeholder: "Add technical guidance or suspected areas",
    title: HINT_HELP,
    extra: HINT_IMPROVEMENT,
    labelId: "hint-label",
  },
];

/**
 * Retrieval inputs (§37.113): what the retrieval steps share — expert boosts
 * on searches that already run themselves.
 *
 * One Keywords and one Focus files, not a copy per step: Code search always
 * uses them, Git history and Similar fixes may, by their own *Use shared…*
 * switches (Similar fixes never reads a Focus file). They used to head the Code
 * search section, which made them look like Code search's alone.
 *
 * BugPilot retrieves without any of these, and a blank Keywords box is not a
 * job half done. That used to be said twice — "(optional)" in two labels and a
 * helper line under each — and is now said by the box being empty and by the
 * tooltip (Advanced Settings simplification): the label names the field, the
 * placeholder shows an example, the tooltip says what it is for and who uses it.
 *
 * Nothing here names a weight, a term budget or a search surface. Those are
 * §33's concepts and the panel has no business teaching them.
 */
const RETRIEVAL_INPUT_FIELDS: readonly TextField[] = [
  {
    id: "keywords",
    label: "Keywords",
    // Multi-line for visibility, plus one reason of its own: `parseKeywords`
    // splits on newlines as well as commas, so a list written one term per line
    // already worked — there was simply nowhere to type it.
    kind: "textarea",
    rows: 2,
    icon: "search",
    tone: "primary",
    help: "Shared search terms used by Code Search and optionally reused by Git History and Similar Fixes. Separate them with commas or new lines.",
    placeholder: "Enter names, identifiers, or technical terms related to the issue",
  },
  {
    id: "focusFiles",
    label: "Focus files",
    kind: "textarea",
    rows: 4,
    icon: "file",
    tone: "muted",
    help: "Files to prioritize in Code Search and optionally reuse for Git History. One path per line.",
    // A multi-line placeholder, which is what makes "one path per line" obvious
    // without a paragraph saying so.
    placeholder: "e.g.\nsrc/core/\nsrc/services/example.cpp\ninclude/example.h",
  },
];

/** Code search's own: what it skips. The limits follow it. */
const CODE_SEARCH_FIELDS: readonly TextField[] = [
  {
    id: "ignorePaths",
    label: "Ignore paths",
    kind: "textarea",
    rows: 4,
    icon: "circle-slash",
    tone: "danger",
    help: "Exclude these files or directories from code search. One path per line.",
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
 * The label says what the setting is, the placeholder shows an example and the
 * tooltip says what it is for; nothing on the page explains a field except a
 * **rule** that has to stay readable while somebody types, which a tooltip
 * cannot do. One survives that test: the custom command's `{prompt}`
 * substitution. The destructive checkbox keeps a warning mark, not a sentence.
 */
const RUN_OPTION_FIELDS: readonly TextField[] = [
  {
    id: "title",
    label: "Title",
    kind: "input",
    icon: "edit",
    tone: "muted",
    help: "A short title for a bug you describe yourself. A Jira issue brings its own.",
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
    help: "How many related files to keep. Empty uses the default, 10.",
    placeholder: "10",
  },
  {
    id: "maxSearchLines",
    label: "Max search lines",
    kind: "number",
    icon: "list-ordered",
    tone: "primary",
    help: "Line budget for the matched lines in the context. Empty uses the default, 300.",
    placeholder: "300",
  },
];

/**
 * Git History Settings: what Git history follows of the shared guidance, what
 * it adds of its own, which routes it searches, how far back, how many commits
 * it keeps. Every default is a run's behaviour before these existed, which is
 * why each switch arrives ticked and the two text boxes and the count empty.
 *
 * The one thing a developer has to know about each of Git history's own inputs
 * — Code search never reads it — is in its tooltip and its accessible
 * description (Advanced Settings simplification), not a line under it.
 */
const GIT_HISTORY_TEXT_FIELDS: readonly TextField[] = [
  {
    id: "gitKeywords",
    label: "Additional commit keywords",
    kind: "textarea",
    rows: 2,
    icon: "search",
    tone: "primary",
    help: "Searched in commit messages only. Code search does not use them.",
    placeholder: "Enter terms to match in commit messages only",
  },
  {
    id: "gitFiles",
    label: "Additional files",
    kind: "textarea",
    rows: 3,
    icon: "file",
    tone: "muted",
    help: "File history only: their history is read too. Code search does not use them. One path per line.",
    placeholder: "e.g.\nsrc/legacy/\nsrc/core/example.cpp",
  },
];

/** Max Related Commits: empty is the CLI's default, shown as the placeholder. */
const GIT_MAX_COMMITS_FIELD: TextField = {
  id: "gitMaxCommits",
  label: "Max related commits",
  kind: "number",
  icon: "git-commit",
  tone: "muted",
  help: "How many related commits to keep, from 1 to 25. Empty uses the default, 10.",
  placeholder: "10",
};

/**
 * One of a step's switches — Git history's, Similar fixes' — a checkbox inside
 * its own label, like Fresh. What it does is its tooltip and accessible
 * description, never a line under it.
 */
function settingSwitch(id: string, label: string, help: string, checked = true): string {
  return `        <div class="field field-check" id="field-${id}">
  ${settingHeader({
    forId: id,
    label,
    control: `<input type="checkbox" id="${id}" aria-describedby="${id}-hint"${checked ? " checked" : ""}> `,
    labelClass: "choice",
    help,
  })}
        </div>`;
}

/** History Depth: the two depths the backend has; what the second one means is the tooltip. */
const GIT_HISTORY_DEPTH_FIELD = `        <div class="field" id="field-gitHistoryDepth">
  ${settingHeader({
    forId: "gitHistoryDepth",
    label: "History depth",
    icon: "history",
    tone: "muted",
    help: "How far back Git history reads. Broader reads three times as far back per file.",
  })}
          <select id="gitHistoryDepth" name="gitHistoryDepth" title="How far back Git history reads. Broader reads three times as far back per file." aria-describedby="gitHistoryDepth-hint">
            <option value="recent">Recent</option>
            <option value="broader">Broader</option>
          </select>
        </div>`;

const GIT_HISTORY_SECTION = [
  // The shared inputs are named where they live: Retrieval inputs, a section
  // of their own since §37.113. `&gt;` because the words are markup here.
  settingSwitch(
    "gitUseSharedKeywords",
    "Use shared keywords",
    "Also use Retrieval inputs &gt; Keywords when searching related commits.",
  ),
  settingSwitch(
    "gitUseSharedFocusFiles",
    "Use shared focus files",
    "Also use Retrieval inputs &gt; Focus files when searching file history.",
  ),
  ...GIT_HISTORY_TEXT_FIELDS.map(field),
  settingSwitch("gitSearchMessages", "Search commit messages", "Search commit messages for the issue key and keywords."),
  settingSwitch("gitSearchFileHistory", "Search related file history", "Read the history of the files related to the issue."),
  `        <div class="limits">
${GIT_HISTORY_DEPTH_FIELD}
  ${field(GIT_MAX_COMMITS_FIELD)}
        </div>`,
].join("\n");

/**
 * Similar Fixes Settings (§37.113): whether Similar fixes follows the shared
 * Keywords, what it adds of its own, and how many past fixes it keeps. Never
 * the Focus files — a past fix is found by its words — so there is no switch
 * for them. Each default is the step's behaviour before these existed: the
 * switch ticked, the keywords empty, the count empty, which is five.
 *
 * The settings stay here, editable and kept, while the row's box is unticked:
 * the box decides whether the step runs, not what it would search with.
 */
const SIMILAR_FIXES_FIELDS: readonly TextField[] = [
  {
    id: "similarKeywords",
    label: "Additional keywords",
    kind: "textarea",
    rows: 2,
    icon: "search",
    tone: "primary",
    help: "Extra terms used only for Similar Fixes. Separate them with commas or new lines.",
    placeholder: "Enter extra terms to find related past fixes",
  },
  {
    id: "similarMaxFixes",
    label: "Max similar fixes",
    kind: "number",
    icon: "database",
    tone: "muted",
    // The range and the default are the ones the run is checked against.
    // Worded like Max related commits: "How many…", not "Maximum number of…",
    // which restates the label.
    help: `How many similar past fixes to include, from 1 to ${SIMILAR_MAX_FIXES_LIMIT}. Empty uses the default, ${SIMILAR_MAX_FIXES_DEFAULT}.`,
    placeholder: String(SIMILAR_MAX_FIXES_DEFAULT),
  },
];

const SIMILAR_FIXES_SECTION = [
  settingSwitch(
    "similarUseSharedKeywords",
    "Use shared keywords",
    "Also use Retrieval inputs &gt; Keywords when searching similar past fixes.",
  ),
  ...SIMILAR_FIXES_FIELDS.map(field),
].join("\n");

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
 * produced, so they sit on its row. Same ids, same messages, same
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
 * Fix result's one action: the report, in the editor.
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
 * The ⋯ More menu beside the primary action (§37.103): Reset Session first,
 * always, then — below a separator — the next steps that are not the next step.
 * Each of those is shown only while the host lists it in `primary.more`, so
 * Start New Attempt does not exist on screen before the first attempt does.
 *
 * Reset Session is an ordinary item, not a red one: it only opens a question,
 * and the question says what it does before anything happens.
 */
const RESET_MENU_ITEM = `        <button type="button" role="menuitem" class="menu-item" id="menu-resetSession" title="${RESET_SESSION_TOOLTIP}"><span class="codicon codicon-discard" aria-hidden="true"></span><span>${RESET_SESSION_LABEL}</span></button>
        <div class="menu-separator" id="menu-separator" role="separator" hidden></div>`;

const MORE_ACTIONS: readonly { readonly id: NextActionId; readonly icon: string; readonly title: string }[] = [
  {
    id: "startNewAttempt",
    icon: "debug-restart",
    title: "Start a new AI session using the current prepared context",
  },
  {
    id: "rebuildContext",
    icon: "refresh",
    title: PRIMARY_TOOLTIPS.rebuildContext,
  },
  {
    id: "openSession",
    icon: "terminal",
    // Focus only: Open AI Session never starts or restarts a session (§37.87).
    title: PRIMARY_TOOLTIPS.openSession,
  },
];

/**
 * Reset Session's question (§37.103): what resets, and what happens to the
 * generated files — Keep, the default, or Delete.
 *
 * A modal `<dialog>`, outside every view: the panel behind it is inert while
 * it is open, and Escape is Cancel. Not a `<form>`: Enter on a choice selects
 * it and presses nothing, so no single key resets anything. The focus starts on
 * the chosen option, never on the button that resets.
 *
 * Every sentence is here, in the markup — the page only shows and hides them:
 * Delete swaps the helper for the permanent-deletion warning and the History
 * consequence, and the button for Reset and Delete. The notes (a run that will
 * be stopped, an agent that will not be) are the host's and arrive per push.
 */
const RESET_DIALOG = `  <dialog class="reset-dialog" id="reset-dialog" aria-labelledby="reset-title" aria-describedby="reset-body">
    <h2 class="reset-title" id="reset-title">${RESET_DIALOG_TITLE}</h2>
    <p class="reset-body" id="reset-body">${RESET_DIALOG_BODY}</p>
    <fieldset class="reset-files" id="reset-files">
      <legend>${GENERATED_FILES_LEGEND}</legend>
      <label class="choice" for="reset-keep"><input type="radio" name="reset-files" id="reset-keep" value="keep" checked aria-describedby="reset-keep-hint"> ${KEEP_FILES_LABEL}</label>
      <label class="choice" for="reset-delete"><input type="radio" name="reset-files" id="reset-delete" value="delete" aria-describedby="reset-delete-hint reset-delete-history"> ${DELETE_FILES_LABEL}</label>
    </fieldset>
    <p class="hint reset-helper" id="reset-keep-hint">${KEEP_FILES_HELPER}</p>
    <p class="reset-helper reset-warning" id="reset-delete-hint" hidden><span class="codicon codicon-warning icon-warning" aria-hidden="true"></span><span>${DELETE_FILES_HELPER}</span></p>
    <p class="hint reset-helper" id="reset-delete-history" hidden>${DELETE_FILES_HISTORY}</p>
    <p class="hint reset-helper" id="reset-no-files" hidden>${NO_FILES_TO_DELETE}</p>
    <ul class="reset-notes" id="reset-notes" hidden></ul>
    <p class="muted reset-blocked" id="reset-blocked" hidden></p>
    <p class="error" id="reset-error" role="alert" hidden></p>
    <p class="muted reset-status" id="reset-status" role="status"></p>
    <div class="reset-actions">
      <button type="button" id="reset-cancel">Cancel</button>
      <button type="button" id="reset-confirm" class="primary" aria-describedby="reset-keep-hint"><span id="reset-confirm-keep">${RESET_SESSION_LABEL}</span><span id="reset-confirm-delete" hidden>${RESET_AND_DELETE_LABEL}</span><span id="reset-confirm-busy" hidden>${RESETTING_LABEL}</span></button>
    </div>
  </dialog>`;

/**
 * Jira Setup (§37.124): the email and the API token in one dialog in the
 * panel, with how to get a token and a way to Atlassian's page for it —
 * replacing two Quick Input prompts at the top of the window, one after the
 * other, that said nothing about where a token comes from.
 *
 * A modal `<dialog>` outside every view, like Reset Session's: centred over
 * the panel, the panel behind it inert, Escape is Cancel, a click on the
 * backdrop does nothing (typed credentials are not thrown away by a stray
 * click). Not a `<form>`, so nothing is submitted by the browser; Enter in the
 * token field saves, through the same check as the button.
 *
 * The token field is a password field that starts empty every time: the page
 * is never given the stored token, so there is nothing to show — not even
 * dots standing for it. Its describedby is the stored-token note and its
 * error, not the help: the instructions are read once, as their own region,
 * not on every visit to the field.
 */
const JIRA_SETUP_DIALOG = `  <dialog class="jira-dialog" id="jira-dialog" role="dialog" aria-modal="true" aria-labelledby="jira-title" aria-describedby="jira-intro">
    <div class="jira-dialog-head">
      <h2 class="jira-title" id="jira-title"><span class="codicon codicon-key jira-title-icon icon-muted" aria-hidden="true"></span>${JIRA_SETUP_TEXT.title}</h2>
      <p class="muted jira-intro" id="jira-intro">${JIRA_SETUP_TEXT.intro}</p>
    </div>
    <div class="jira-dialog-body" id="jira-dialog-body">
      <div class="jira-field">
        <label class="jira-label" for="jira-site">${JIRA_SETUP_TEXT.siteLabel}</label>
        <input type="url" id="jira-site" placeholder="${JIRA_SETUP_TEXT.sitePlaceholder}" autocomplete="off" spellcheck="false" aria-describedby="jira-site-description jira-site-environment jira-site-error">
        <p class="visually-hidden" id="jira-site-description">${JIRA_SETUP_TEXT.siteDescription}</p>
        <p class="muted jira-site-environment" id="jira-site-environment" hidden>${JIRA_SETUP_TEXT.siteFromEnvironment}</p>
        <p class="error jira-field-error" id="jira-site-error" role="alert" hidden></p>
      </div>
      <div class="jira-field">
        <label class="jira-label" for="jira-email">${JIRA_SETUP_TEXT.emailLabel}</label>
        <input type="email" id="jira-email" placeholder="${JIRA_SETUP_TEXT.emailPlaceholder}" autocomplete="off" spellcheck="false" aria-describedby="jira-email-description jira-email-error">
        <p class="visually-hidden" id="jira-email-description">${JIRA_SETUP_TEXT.emailDescription}</p>
        <p class="error jira-field-error" id="jira-email-error" role="alert" hidden></p>
      </div>
      <div class="jira-field">
        <label class="jira-label" for="jira-token">${JIRA_SETUP_TEXT.tokenLabel}</label>
        <div class="jira-token-row">
          <input type="password" id="jira-token" autocomplete="off" spellcheck="false" aria-describedby="jira-token-stored jira-token-error">
          <button type="button" class="icon jira-reveal" id="jira-token-reveal" aria-label="${JIRA_SETUP_TEXT.showToken}" title="${JIRA_SETUP_TEXT.showToken}"><span class="codicon codicon-eye" id="jira-token-reveal-icon" aria-hidden="true"></span></button>
        </div>
        <p class="muted jira-token-stored" id="jira-token-stored" hidden>${JIRA_SETUP_TEXT.tokenStored}</p>
        <p class="error jira-field-error" id="jira-token-error" role="alert" hidden></p>
      </div>
      <section class="jira-help" aria-labelledby="jira-help-title">
        <h3 class="jira-help-title" id="jira-help-title">${JIRA_SETUP_TEXT.helpTitle}</h3>
        <p class="jira-help-text">${JIRA_SETUP_TEXT.help}</p>
        <button type="button" class="link jira-link" id="jira-token-page" title="${JIRA_SETUP_TEXT.linkTitle}"><span>${JIRA_SETUP_TEXT.link}</span><span class="codicon codicon-link-external" aria-hidden="true"></span></button>
        <details class="jira-steps" id="jira-steps">
          <summary>${JIRA_SETUP_TEXT.stepsTitle}</summary>
          <ol class="jira-steps-list">
${JIRA_SETUP_TEXT.steps.map((step) => `            <li>${step}</li>`).join("\n")}
          </ol>
        </details>
      </section>
      <p class="error" id="jira-error" role="alert" hidden></p>
    </div>
    <div class="jira-dialog-actions">
      <button type="button" id="jira-cancel">${JIRA_SETUP_TEXT.cancel}</button>
      <button type="button" id="jira-save" class="primary"><span id="jira-save-label">${JIRA_SETUP_TEXT.save}</span></button>
    </div>
  </dialog>`;

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

      <!--
        The run form as six groups (§37.119), one under the other, in the
        order they are read and tabbed through: Issue (with Run and More),
        Fix Mode, Hint (with Improve with AI and Include issue details),
        Advanced Settings, Jira, Workflow Steps. Each is a quiet container
        named by its own title, so no control sits between two of them.
      -->
      <div class="workflow-group" id="group-issue" role="group" aria-labelledby="issue-label">
${ISSUE_FIELD}

      <!--
        The one primary action, directly under the Issue (§37.102): enter the
        issue, then Run — everything below it is optional tuning for the next
        run. Run, Fix with AI, Open AI Session or Rebuild Context — whichever is
        next for the work item and the form, as the host says
        (app/nextAction.ts) — or Running…. Its id stays "run" because it is
        still the form's submit, and Ctrl+Enter still presses it.

        Beside it only what cannot be pressed at the same time (Stop, during a
        run) or what is not the next step (the ⋯ More menu: Reset Session,
        Start New Attempt, Rebuild Context). Nothing here is a second primary
        button. ⋯ More is always there (§37.103): a quiet outlined button with
        its word, which a narrow sidebar drops before the row would overflow.
      -->
      <div class="run">
        <div class="run-buttons">
          <button type="submit" id="run" class="primary" title="${PRIMARY_TOOLTIPS.run} (${PRIMARY_SHORTCUT})" aria-describedby="run-hint" aria-keyshortcuts="Control+Enter">
            <span class="codicon codicon-play" id="run-icon" aria-hidden="true"></span>
            <span id="run-label">Run</span>
          </button>
          <button type="button" id="stop" hidden disabled>Stop</button>
          <button type="button" id="more-actions" class="more-button" title="More actions" aria-label="More actions" aria-haspopup="menu" aria-expanded="false" aria-controls="more-menu"><span class="codicon codicon-ellipsis" aria-hidden="true"></span><span class="more-label">More</span></button>
        </div>
        <!-- At most one short line, and usually none (§37.105): the host's
             state when it says something the button and the header do not —
             "Settings changed", "AI session started". Never a sentence and
             never the shortcut: both are the button's tooltip, and Ctrl+Enter
             its aria-keyshortcuts. The words describe the button, so a screen
             reader hears why it says Rebuild Context, without an announcement. -->
        <p class="run-hint" id="run-hint" hidden></p>
      </div>
      <!-- What Open AI Session came to (§37.87): a live region that is always in
           the document, empty until the host answers a press, so the answer is
           announced without moving the keyboard focus. -->
      <p class="session-feedback" id="session-feedback" role="status" aria-live="polite"></p>
      <div class="more-menu" id="more-menu" role="menu" aria-label="More actions" hidden>
${RESET_MENU_ITEM}
${MORE_ACTIONS.map(menuItem).join("\n")}
      </div>
      </div>

      <!--
        How the AI should approach the issue, and any guidance for it: optional
        tuning for the run above, in the order they are read and tabbed through
        (§37.84, §37.102) — each its own group (§37.119).
      -->
      <div class="workflow-group" id="group-fix-mode" role="group" aria-labelledby="fixModeId-label">
${FIX_MODE_FIELD}
      </div>
      <div class="workflow-group" id="group-hint" role="group" aria-labelledby="hint-label">
${GUIDANCE_FIELDS.map(field).join("\n")}
      </div>

      <!--
        Advanced Settings (§37.91): the one page where every step's settings live
        (app/workflowSettings.ts), also reached from each row's gear. After the
        main page's own settings and above the workflow — with the inputs, not
        after the results, where it read as part of the review above
        Diagnostics. Since §37.119 a compact group of its own that is one
        row: the whole row the button — the gear, its name, a chevron for
        "goes somewhere" — quieter than the groups above, and never a second
        primary beside Run, Fix with AI or Review with AI. Its name is its
        visible text; the tooltip says where it goes.
      -->
      <div class="workflow-group workflow-compact-group settings-entry" id="group-settings">
        <button type="button" id="open-settings" class="settings-open" title="Open advanced workflow settings">
          <span class="codicon codicon-settings-gear" aria-hidden="true"></span>
          <span class="settings-open-label">Advanced Settings</span>
          <span class="codicon codicon-chevron-right settings-open-chevron" aria-hidden="true"></span>
        </button>
      </div>
      <!-- The Jira row in a compact group of its own (§37.119). The container
           is a wrapper, not the row: the page rewrites the row's class on
           every push. -->
      <div class="workflow-group workflow-compact-group" id="group-jira">
${JIRA_ROW}
      </div>

      <!--
        A disclosure rather than a section, since UI-A1, so a developer can fold
        the rows away. Open from the start since §37.109: the rows are one line
        each now (§37.107, §37.108), and they are where the plan is chosen —
        including the only pre-run way to Fix with AI — so a closed list hid the
        panel's second half behind a triangle. Open in the markup and nowhere
        forced: the page script opens it again only on an event worth showing
        (a run starting, a new card, a reopened work item with results), never
        on an ordinary push, so a developer who folds it keeps it folded.
      -->
      <details class="workflow-group" id="workflow" aria-labelledby="workflow-heading" open>
        <summary class="workflow-summary">
          <span class="codicon codicon-list-unordered workflow-icon" aria-hidden="true"></span>
          <h2 id="workflow-heading">Workflow Steps</h2>
          <span id="workflow-status" class="workflow-status" role="status">${OVERALL_IDLE}</span>
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
        <div class="workflow-foot" id="workflow-foot">
          ${actionButton(OPEN_FOLDER)}
        </div>
      </details>
    </form>

    <section id="notices" class="notices" role="status" hidden></section>
    <!-- What a notice's quick fix did, once the notice is gone (§37.85): focus
         lands here rather than on a card that no longer exists. -->
    <p id="notice-status" class="notice-done" role="status" tabindex="-1" hidden></p>

  </section>

${settingsView()}

${INSTRUCTIONS_VIEW}

  <section id="fix-mode-manager-view" class="view" aria-labelledby="manage-heading" hidden>
${pageHeader({
  backId: "manage-back",
  backTitle: "Back to Workflow",
  titleId: "manage-heading",
  title: "Manage Fix Modes",
  titleAttributes: ` aria-describedby="manage-lede"`,
})}
    <p class="muted view-lede" id="manage-lede">Choose and customize AI fix workflows.</p>
    <p id="manage-error" class="error" role="alert" hidden></p>
    <p id="manage-success" class="success" role="status" hidden></p>
    <p id="manage-detail" class="muted" hidden></p>
    <!--
      Built-in, User and Project, each a disclosure the page builds from the
      host's catalog (§37.114): a row is the mode's glyph, its name, one line
      of description and the badges that change what it does, and every
      action it has, on the row (§37.116). The id and the version are the
      preview's.
    -->
    <div id="manage-list" class="manage-list"></div>
    <!-- Every Delete button's description: what it removes, and that it asks first. -->
    <p class="visually-hidden" id="manage-delete-help">Permanently deletes this Fix Mode's file. BugPilot asks you to confirm first.</p>
  </section>

  <!--
    One Fix Mode, read (§37.115): a header with the mode's glyph, its name, its
    source and description, and its action at the right; then its six sections,
    each a disclosure. The page fills all of it from the host's draft. The id,
    the version and the type are in Details, closed, at the foot.
  -->
  <section id="fix-mode-preview-view" class="view" aria-labelledby="preview-heading" hidden>
${pageHeader({ backId: "preview-back", backTitle: "Back to Fix Mode Manager", titleId: "preview-heading" })}
    <!-- Under the header, which names the mode (§37.120): its glyph, where it
         comes from and its action on one line, its description under them. -->
    <div class="preview-hero">
      <div class="preview-hero-top">
        <span class="codicon codicon-lightbulb preview-icon" id="preview-icon" aria-hidden="true"></span>
        <span class="preview-source" id="preview-source"></span>
        <div class="preview-actions" id="preview-actions"></div>
      </div>
      <p id="preview-description" class="preview-description"></p>
    </div>
    <p id="preview-error" class="error" role="alert" hidden></p>
    <p id="preview-success" class="success" role="status" hidden></p>
    <!--
      Rendered text, not disabled inputs: this is a mode being read, and a form
      full of greyed-out boxes reads as one the developer is failing to edit.
    -->
    <div id="preview-body" class="preview-body preview-sections"></div>
    <!-- What a mode is beyond its name — id, version, type, source, origin —
         for whoever needs it, closed: none of it helps read the workflow. -->
    <details class="preview-details" id="preview-details">
      <summary id="preview-details-head">Details</summary>
      <dl id="preview-meta" class="preview-facts"></dl>
    </details>
  </section>

${EDITOR_VIEW}

${RESET_DIALOG}

${JIRA_SETUP_DIALOG}
</main>
<script nonce="${options.nonce}" src="${options.scriptUri}"></script>
</body>
</html>
`;
}

/** An option's text: the label, with the picker's two decorations. */
const AGENT_OPTION_TEXT: Readonly<Record<AgentChoice, string>> = {
  ...AGENT_LABELS,
  auto: `${AGENT_LABELS.auto} (Recommended)`,
  custom: `${AGENT_LABELS.custom}…`,
};

/**
 * The AI Agent picker: one option per adapter in `agents.ts`, and one quiet
 * line under it — what Auto-detect found, or how the chosen agent stands
 * ("Installed · Limited integration"). The host fills the line from
 * `PanelState.agents`; the page never detects anything itself. The line is
 * state, so it stays on screen; what the picker is for is the label's tooltip.
 */
const AGENT_FIELD = `        <div class="field" id="field-agent">
  ${settingHeader({
    forId: "agent",
    label: "AI Agent",
    icon: "hubot",
    tone: "primary",
    title: "The coding agent Fix with AI hands the prepared task to.",
    rebuild: showsRebuildLabel("agent"),
  })}
          <select id="agent" name="agent" aria-describedby="agent-status">
${AGENT_CHOICES.map((choice) => `            <option value="${choice}">${AGENT_OPTION_TEXT[choice]}</option>`).join("\n")}
          </select>
          <p class="hint agent-status" id="agent-status" aria-live="polite" hidden></p>
        </div>`;

/**
 * Branch (§37.127): which branch the AI agent works and commits on, written
 * into task.md. Use current branch, the default, is the checked-out branch —
 * no branch per run — with a feature branch only from main/master or a
 * detached HEAD, and only after the agent asks; One branch per issue is one
 * branch made once for the work item and reused; Ask before editing has the
 * agent ask which. main and master are never edited under any of them. The
 * option names say which; what each means is its tooltip, and with the
 * field's sentence the select's tooltip and description.
 */
const BRANCH_POLICY_LABELS: Readonly<Record<BranchPolicy, string>> = {
  current: "Use current branch (Recommended)",
  "per-issue": "One branch per issue",
  ask: "Ask before editing",
};

const BRANCH_POLICY_MEANING: Readonly<Record<BranchPolicy, string>> = {
  current: "Work on the checked-out branch and do not create or switch branches.",
  "per-issue": "Create or reuse one branch for the issue.",
  ask: "Ask whether to stay on the current branch or create/switch before editing.",
};

const BRANCH_POLICY_HELP = [
  "Choose which branch the AI agent edits and commits on. Main and master are always protected.",
  ...BRANCH_POLICIES.map(
    (policy) => `${BRANCH_POLICY_LABELS[policy].replace(" (Recommended)", "")}: ${BRANCH_POLICY_MEANING[policy]}`,
  ),
].join(" ");

/**
 * Branch naming: only the name a new branch would get —
 * whether one is made is the policy above. Default is BugPilot's own name;
 * Custom shows the template, which is the repository's (`project_settings.json`,
 * written on Apply) and judged by the CLI. The field is hidden until Custom is
 * chosen: a template that is not used is not on screen.
 */
const BRANCH_NAMING_HELP =
  "The name a new branch gets, when the branch policy calls for one. It never creates or switches a branch itself, " +
  "and a work item keeps the branch it already has. Saved for the repository in .bugpilot/project_settings.json.";

const BRANCH_NAMING_FIELD = `        <div class="field" id="field-branchNaming">
  ${settingHeader({
    forId: "branchNaming",
    label: "Branch naming",
    icon: "tag",
    tone: "muted",
    help: BRANCH_NAMING_HELP,
    rebuild: showsRebuildLabel("branchNaming"),
  })}
          <select id="branchNaming" name="branchNaming" title="${BRANCH_NAMING_HELP}" aria-describedby="branchNaming-hint">
            <option value="default" title="${DEFAULT_BRANCH_TEMPLATE}">Default (${DEFAULT_BRANCH_TEMPLATE})</option>
            <option value="custom" title="The repository's own template">Custom template</option>
          </select>
        </div>`;

const BRANCH_TEMPLATE_FIELD: TextField = {
  id: "branchTemplate",
  label: "Template",
  kind: "input",
  icon: "edit",
  tone: "muted",
  help:
    "Must include {issue}: the Jira key, or bug- and a hash of the title for a bug you describe. {slug} is the title. " +
    "Letters, digits, '.', '_', '-' and '/' only.",
  placeholder: "bugfix/{issue}-{slug}",
  maxLength: MAX_BRANCH_TEMPLATE_CHARS,
};

const BRANCH_POLICY_FIELD = `        <div class="field" id="field-branchPolicy">
  ${settingHeader({
    forId: "branchPolicy",
    label: "Branch policy",
    icon: "source-control",
    tone: "muted",
    help: BRANCH_POLICY_HELP,
    rebuild: showsRebuildLabel("branchPolicy"),
  })}
          <select id="branchPolicy" name="branchPolicy" title="${BRANCH_POLICY_HELP}" aria-describedby="branchPolicy-hint">
${BRANCH_POLICIES.map((policy) => `            <option value="${policy}" title="${BRANCH_POLICY_MEANING[policy]}">${BRANCH_POLICY_LABELS[policy]}</option>`).join("\n")}
          </select>
        </div>`;

/**
 * Repository: how task.md describes the repository.
 * Auto-detect, the default, reads high-confidence facts from the repository's
 * build and package files; Generic assumes nothing; Custom uses the details
 * typed below, which appear only when Custom is chosen. The profile is the
 * repository's own — `.bugpilot/repository_profile.json`, written on Apply —
 * so the CLI and the MCP server describe the repository the same way.
 *
 * The select's options are names; what each means is its tooltip, and the
 * field's sentence the select's tooltip and description. Under it, one quiet
 * line of state: what Auto-detect finds in this repository, filled by the page
 * from the host's `repositoryProfile`, as the agent picker's status line is.
 */
const REPOSITORY_PROFILE_MEANING: Readonly<Record<RepositoryProfileMode, string>> = {
  auto: "Use high-confidence facts from the repository's build and package files.",
  generic: "Make no language or framework assumptions.",
  custom: "Use the repository details you provide.",
};

const REPOSITORY_PROFILE_HELP =
  "Describe the repository context BugPilot gives to the AI agent. Auto-detect uses high-confidence project files. " +
  "Generic makes no language or framework assumptions. Custom uses the repository details you provide. " +
  "Saved for the repository in .bugpilot/repository_profile.json.";

const REPOSITORY_PROFILE_FIELD = `        <div class="field" id="field-repositoryProfile">
  ${settingHeader({
    forId: "repositoryProfile",
    label: "Repository profile",
    icon: "folder",
    tone: "muted",
    help: REPOSITORY_PROFILE_HELP,
    rebuild: showsRebuildLabel("repositoryProfile"),
  })}
          <select id="repositoryProfile" name="repositoryProfile" title="${REPOSITORY_PROFILE_HELP}" aria-describedby="repositoryProfile-hint repositoryProfile-detected">
${REPOSITORY_PROFILE_MODES.map((mode) => `            <option value="${mode}" title="${REPOSITORY_PROFILE_MEANING[mode]}">${REPOSITORY_PROFILE_LABELS[mode]}</option>`).join("\n")}
          </select>
          <p class="hint repository-detected" id="repositoryProfile-detected" aria-live="polite" hidden></p>
        </div>`;

/** What each Custom detail is for, and an example of the kind of answer. */
const REPOSITORY_DETAIL_TEXT: Readonly<Record<RepositoryField, { readonly help: string; readonly placeholder: string; readonly icon: string }>> = {
  repositoryLanguages: { help: "The repository's main programming languages.", placeholder: "Python, TypeScript", icon: "tag" },
  repositoryFrameworks: { help: "Frameworks the code is built on.", placeholder: "Django, React", icon: "files" },
  repositoryApplicationType: { help: "What the software is.", placeholder: "Web service", icon: "target" },
  repositoryBuildSystem: { help: "How the repository is built.", placeholder: "CMake, npm", icon: "tools" },
  repositoryTestFramework: { help: "How the repository is tested.", placeholder: "pytest", icon: "beaker" },
  repositoryNotes: {
    help: "Anything else the AI agent should know about the codebase, in a sentence or two.",
    placeholder: "Public APIs must stay backward compatible",
    icon: "note",
  },
};

const REPOSITORY_DETAIL_FIELDS: readonly TextField[] = REPOSITORY_FIELDS.map((entry) => ({
  id: entry.field,
  label: entry.label,
  kind: entry.field === "repositoryNotes" ? "textarea" : "input",
  ...(entry.field === "repositoryNotes" ? { rows: 2 } : {}),
  icon: REPOSITORY_DETAIL_TEXT[entry.field].icon,
  tone: "muted",
  help: REPOSITORY_DETAIL_TEXT[entry.field].help,
  placeholder: REPOSITORY_DETAIL_TEXT[entry.field].placeholder,
  maxLength: entry.max,
}));

/**
 * What each instruction scope is, for its row's tooltip and description: where
 * the file is, whom it applies to, and that it never overrides BugPilot.
 */
const INSTRUCTION_HELP: Readonly<Record<InstructionScope, string>> = {
  user:
    "Your own instructions for the AI agent, in every repository: ~/.bugpilot/instructions.md. " +
    "They refine how it works and never override BugPilot's safety rules. Changing them requires rebuilding context.",
  project:
    "Instructions for the AI agent shared with this repository: .bugpilot/instructions.md, which can be committed. " +
    "They refine how it works and never override BugPilot's safety rules. Changing them requires rebuilding context.",
};

/**
 * An instruction row: the name, Edit, and under them one
 * quiet line of state the page fills from the host — the empty state until
 * there is something to say. A document is not edited in this narrow column:
 * Edit opens its own page.
 */
function instructionRow(scope: InstructionScope): string {
  const id = `${scope}-instructions`;
  const text = INSTRUCTION_TEXT[scope];
  return `        <div class="field instruction-row" id="field-${id}">
          <div class="setting-header">
            <label for="${id}-edit" title="${INSTRUCTION_HELP[scope]}"><span class="codicon codicon-${scope === "user" ? "checklist" : "file-text"} setting-icon icon-muted" aria-hidden="true"></span>${text.title}</label>
            <button type="button" class="instruction-edit" id="${id}-edit" aria-label="${text.editLabel}" title="${INSTRUCTION_HELP[scope]}" aria-describedby="${id}-edit-hint ${id}-status">Edit</button>
            <p class="visually-hidden" id="${id}-edit-hint">${INSTRUCTION_HELP[scope]}</p>
          </div>
          <p class="hint instruction-status" id="${id}-status">${text.empty}</p>
        </div>`;
}

/**
 * The Verification Policy: four switches under one
 * heading, what each asks for in its tooltip. The repository's, saved in
 * `.bugpilot/project_settings.json` on Apply; how an attempt verifies stays
 * the Fix Mode's.
 */
const VERIFICATION_HELP: Readonly<Record<VerificationField, { readonly label: string; readonly help: string }>> = {
  verifyRelevantTests: { label: "Run relevant tests", help: "Ask the agent to run the tests relevant to the changed behavior." },
  verifyStaticChecks: {
    label: "Run existing static checks",
    help: "Ask the agent to run the repository's existing linters, type checks or compiler warnings when they are available.",
  },
  verifyFullSuite: {
    label: "Run full test suite",
    help: "Ask the agent to run the repository's full test suite before reporting, if it can run here.",
  },
  verifyReportNotRun: {
    label: "Report tests not run",
    help: "Ask the agent to list the relevant verification it did not run, and why.",
  },
};

const VERIFICATION_GROUP_HELP =
  "The verification this repository expects from a fix. The Fix Mode decides how each attempt verifies within it. " +
  "Saved for the repository in .bugpilot/project_settings.json.";

const VERIFICATION_GROUP = `        <div class="setting-group" id="field-verification" role="group" aria-labelledby="verification-label" aria-describedby="verification-description">
          <p class="setting-group-label" id="verification-label" title="${VERIFICATION_GROUP_HELP}"><span class="codicon codicon-beaker setting-icon icon-muted" aria-hidden="true"></span>Verification</p>
          <p class="visually-hidden" id="verification-description">${VERIFICATION_GROUP_HELP}</p>
${VERIFICATION_FIELDS.map((entry) => settingSwitch(entry.field, VERIFICATION_HELP[entry.field].label, VERIFICATION_HELP[entry.field].help, entry.default)).join("\n")}
        </div>`;

/** The Custom details are drawn hidden; the page shows them while Custom is chosen. */
const REPOSITORY_SECTION = [
  REPOSITORY_PROFILE_FIELD,
  ...REPOSITORY_DETAIL_FIELDS.map((entry) => field(entry).replace(`<div class="field" id="field-${entry.id}">`, `<div class="field" id="field-${entry.id}" hidden>`)),
  instructionRow("project"),
].join("\n");

/**
 * The instruction editor: one page for either scope,
 * reached from a row's Edit, with the shared Back header. The title, the
 * scope line and the text are the host's, filled once per open; nothing on
 * this page is part of the form. Save writes the file — empty text removes it
 * — and Back, Cancel and Escape write nothing. The count is the limit the CLI
 * enforces, said before Save rather than after.
 */
const INSTRUCTIONS_VIEW = `  <section id="instructions-editor-view" class="view instructions-editor" aria-labelledby="instructions-title" hidden>
${pageHeader({ backId: "instructions-back", backTitle: "Back to Advanced Settings — discards the changes", titleId: "instructions-title", title: "Instructions" })}

    <p class="instructions-scope" id="instructions-scope"></p>
    <p class="hint instructions-empty" id="instructions-empty" hidden></p>
    <p class="hint instructions-problem" id="instructions-problem" hidden></p>
    <label class="visually-hidden" for="instructions-text" id="instructions-text-label">Instructions</label>
    <textarea id="instructions-text" class="instructions-text" rows="14" spellcheck="true" placeholder="Plain text or Markdown" aria-describedby="instructions-scope instructions-guide instructions-count instructions-error"></textarea>
    <p class="visually-hidden" id="instructions-guide">Plain text or Markdown, up to ${MAX_INSTRUCTION_CHARS.toLocaleString("en-US")} characters. They refine how the AI agent works and never override BugPilot's safety rules. Saving empty text removes the file. Ctrl+Enter saves; Escape cancels.</p>
    <p class="hint instructions-count" id="instructions-count"></p>
    <p class="error" id="instructions-error" role="alert" hidden></p>

    <div class="settings-actions">
      <button type="button" id="instructions-cancel">Cancel</button>
      <button type="button" id="instructions-save" class="primary">Save</button>
    </div>
  </section>`;

/**
 * How files get to Attachments — the dialog, a drop, the clipboard. Not
 * inferable from the label, and there is no box to hang a placeholder on, so it
 * is the label's and the button's tooltip and the button's description.
 */
const ATTACHMENTS_HELP = "Add files, drag and drop while holding Shift, or paste from the clipboard.";

/** Files to copy in beside the issue: a list the page renders, and the dialog's button. */
const ATTACHMENTS_FIELD = `        <div class="field" id="field-attachments">
  ${settingHeader({
    forId: "add-attachment",
    label: "Attachments",
    icon: "attach",
    tone: "muted",
    help: ATTACHMENTS_HELP,
  })}
          <ul id="attachment-list" class="attachments" hidden></ul>
          <p class="hint attachment-status" id="attachment-status" role="status" hidden></p>
          <button type="button" id="add-attachment" title="${ATTACHMENTS_HELP}" aria-describedby="add-attachment-hint">
            <span class="codicon codicon-add" aria-hidden="true"></span>
            Add files…
          </button>
        </div>`;

/**
 * Delete previous artifacts first — Fresh. The one setting on the page that
 * deletes an agent's work, so it is the one that keeps a mark on screen: a
 * warning glyph after the label, decorative, with the sentence as its tooltip
 * and as the checkbox's description rather than as a line under it.
 */
const FRESH_FIELD = `        <div class="field field-check">
  ${settingHeader({
    forId: "fresh",
    label: "Delete previous artifacts first",
    control: '<input type="checkbox" id="fresh" aria-describedby="fresh-hint"> ',
    labelClass: "choice",
    help: "Removes the work item's existing generated artifacts before running. Off by default to avoid accidental data loss.",
    warning: true,
  })}
        </div>`;

/** What each section holds, in the order `SETTINGS_SECTION_FIELDS` lists its fields. */
function sectionBody(section: WorkflowSettingsSection): string {
  switch (section) {
    case "issue-details":
      return `${RUN_OPTION_FIELDS.map(field).join("\n")}\n${ATTACHMENTS_FIELD}`;
    case "retrieval-inputs":
      return RETRIEVAL_INPUT_FIELDS.map(field).join("\n");
    case "code-search":
      return `${CODE_SEARCH_FIELDS.map(field).join("\n")}
        <div class="limits">
  ${LIMIT_FIELDS.map(field).join("\n")}
        </div>`;
    case "git-history":
      return GIT_HISTORY_SECTION;
    case "similar-fixes":
      return SIMILAR_FIXES_SECTION;
    case "repository":
      return REPOSITORY_SECTION;
    case "ai-instructions":
      return `${instructionRow("user")}\n${VERIFICATION_GROUP}`;
    case "build-context":
      return FRESH_FIELD;
    case "fix-with-ai":
      return `${AGENT_FIELD}\n${field(AGENT_COMMAND_FIELD)}`;
    case "branch":
      return [
        BRANCH_POLICY_FIELD,
        BRANCH_NAMING_FIELD,
        field(BRANCH_TEMPLATE_FIELD).replace('<div class="field" id="field-branchTemplate">', '<div class="field" id="field-branchTemplate" hidden>'),
      ].join("\n");
  }
}

/**
 * Workflow Settings: one page, one section per step that has settings, in the
 * workflow's order — so a row's gear lands on its section and the whole
 * configuration can still be read top to bottom.
 *
 * A view like the Fix Mode ones, outside the form: Enter in one of its fields
 * must not submit a Run, and nothing typed here is part of the form until
 * Apply. Each section's heading takes focus when a gear lands on it. Apply is
 * the page's one primary button; Back and Cancel both discard.
 *
 * A compact form, not a document (Advanced Settings simplification): fields
 * and values first, and the explanations in tooltips and accessible
 * descriptions. What used to be a sentence under every heading — whether the
 * section's changes make a prepared context stale, from
 * `SETTING_REQUIRES_REBUILD` — is a short tag beside it, *Requires rebuild* or
 * *Next run only*, with the sentence as its tooltip; and the page's own lede
 * (Apply applies, Back and Cancel discard) is the title's tooltip and the
 * heading's description.
 */
const SETTINGS_LEDE = "Configure workflow inputs and limits. Changes apply when you press Apply. Back and Cancel discard them.";

/**
 * A secondary page's header (§37.120): Back and the page's title on one row —
 * the title under Back when a narrow sidebar cannot fit both — held at the
 * top of the panel while the page scrolls under it. One renderer for every
 * page that has a way back (Advanced Settings, Manage Fix Modes, a Fix Mode's
 * page, New / Edit Fix Mode), so they cannot drift apart again.
 *
 * The visible words are always "Back"; where it goes is the button's tooltip
 * (and so its description), because the page's title already says where you
 * are. The title is the page's `h2` — the heading the view is named by and the
 * focus lands on — cut to one line with an ellipsis, so nothing pushes Back
 * off. `actions` is a slot at the right for a page that needs one; none does
 * yet.
 */
function pageHeader(options: {
  readonly backId: string;
  readonly backTitle: string;
  readonly titleId: string;
  readonly title?: string;
  /** More attributes for the heading: a tooltip, a description. */
  readonly titleAttributes?: string;
  /** Anything else that belongs to the header, such as a visually hidden description. */
  readonly extra?: string;
  readonly actions?: string;
}): string {
  const actions = options.actions ? `\n      <div class="page-header-actions">${options.actions}</div>` : "";
  const extra = options.extra ? `\n${options.extra}` : "";
  return `    <div class="page-header">
      <button type="button" id="${options.backId}" class="page-back" title="${options.backTitle}"><span class="codicon codicon-arrow-left" aria-hidden="true"></span><span class="page-back-label">Back</span></button>
      <h2 id="${options.titleId}" class="page-title" tabindex="-1"${options.titleAttributes ?? ""}>${options.title ?? ""}</h2>${actions}${extra}
    </div>`;
}

function settingsView(): string {
  const sections = WORKFLOW_SETTINGS_SECTIONS.map(
    (section) => `    <section class="settings-section" id="settings-section-${section}" aria-labelledby="settings-title-${section}">
      <div class="settings-section-head">
        <h3 class="settings-section-title" id="settings-title-${section}" tabindex="-1" aria-describedby="settings-note-${section}">${SETTINGS_SECTION_TITLES[section]}</h3>
        <span class="settings-tag" id="settings-note-${section}" title="${sectionRebuildNote(section)}">${sectionRebuildTag(section)}</span>
      </div>
${sectionBody(section)}
    </section>`,
  ).join("\n\n");
  return `  <section id="workflow-settings-view" class="view" aria-labelledby="settings-heading" hidden>
${pageHeader({
  backId: "settings-back",
  backTitle: "Back to Workflow — discards the changes",
  titleId: "settings-heading",
  title: "Advanced Settings",
  titleAttributes: ` title="${SETTINGS_LEDE}" aria-describedby="settings-lede"`,
  extra: `      <p class="visually-hidden" id="settings-lede">${SETTINGS_LEDE}</p>`,
})}

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
  /** The label's tooltip: what the setting is for, where no helper line says it. */
  readonly title?: string;
  /**
   * How the page read what was typed, on the label's row at its right: an
   * empty, hidden `<forId>-note` the page fills (§37.112). Not a live region —
   * the control's `aria-describedby` names it, so it is heard when the field is
   * reached, not on every keystroke. Carries the label's tooltip.
   */
  readonly note?: boolean;
  /**
   * What the setting is for, off the screen: the label's tooltip, and a visually
   * hidden `<forId>-hint` for the control's `aria-describedby` to name.
   */
  readonly help?: string;
  /** A decorative warning mark after the label, for a setting that deletes work. */
  readonly warning?: boolean;
  /** An id for the label, so the group it heads can be named by it (§37.119). */
  readonly labelId?: string;
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
  // A visible line, or — for an explanation that moved off the screen — the
  // same id, visually hidden, so the control's description is unchanged.
  const hint = options.hint
    ? `<p class="hint" id="${options.forId}-hint">${options.hint}</p>`
    : options.help
      ? `<p class="visually-hidden" id="${options.forId}-hint">${options.help}</p>`
      : "";
  const labelClass = options.labelClass ? ` class="${options.labelClass}"` : "";
  const labelId = options.labelId ? ` id="${options.labelId}"` : "";
  const tooltip = options.title ?? options.help;
  const title = tooltip ? ` title="${tooltip}"` : "";
  const rebuild = options.rebuild ? `<span class="rebuild-label" id="${options.forId}-rebuild">${REQUIRES_REBUILD_LABEL}</span>` : "";
  const note = options.note ? `<span class="setting-note" id="${options.forId}-note"${title} hidden></span>` : "";
  const warning = options.warning
    ? `<span class="codicon codicon-warning setting-warning icon-warning" aria-hidden="true"></span>`
    : "";
  return `      <div class="setting-header">
        <label${labelClass} for="${options.forId}"${labelId}${title}>${icon}${options.control ?? ""}${options.label}${warning}</label>
        ${note}${rebuild}${hint}
      </div>`;
}

function field(entry: TextField): string {
  // `aria-describedby` names only descriptions that exist. Most fields now have
  // no helper text, and pointing a screen reader at an element that was never
  // rendered is worse than pointing it at nothing.
  const described = entry.hint || entry.help
    ? `${entry.id}-hint ${entry.id}-error`
    : `${entry.id}-error`;
  const placeholder = entry.placeholder
    ? ` placeholder="${entry.placeholder.replaceAll("\n", "&#10;")}"`
    : "";
  // The field's purpose on hover, on the box as well as its label: a tooltip
  // supplements the label, which stays the accessible name.
  const tooltip = entry.title ?? entry.help;
  const title = tooltip ? ` title="${tooltip}"` : "";
  const limit = entry.maxLength === undefined ? "" : ` maxlength="${entry.maxLength}"`;
  const control =
    entry.kind === "textarea"
      ? `<textarea id="${entry.id}" name="${entry.id}" rows="${entry.rows ?? 3}"${placeholder}${limit}${title} aria-describedby="${described}"></textarea>`
      : entry.kind === "number"
        ? // `inputmode` rather than `type="number"`: the spinner steals the
          // field's width in a 200px sidebar, and the value still travels as a
          // string that `buildPrepareArgs` validates either way.
          `<input type="text" inputmode="numeric" id="${entry.id}" name="${entry.id}"${placeholder}${title} aria-describedby="${described}">`
        : `<input type="text" id="${entry.id}" name="${entry.id}"${placeholder}${limit}${title} aria-describedby="${described}">`;
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
    ...(entry.help === undefined ? {} : { help: entry.help }),
    ...(entry.title === undefined ? {} : { title: entry.title }),
    ...(entry.labelId === undefined ? {} : { labelId: entry.labelId }),
    rebuild: isSettingsField(entry.id) && showsRebuildLabel(entry.id),
  })}
      ${control}
      <p class="error" id="${entry.id}-error" hidden></p>
${entry.extra ?? ""}    </div>`;
}

/**
 * The Jira row (§37.110): whether Jira credentials are set up, and the one way
 * to set them up — the existing Set Jira Credentials flow, worded Configure or
 * Replace — between Advanced Settings and Workflow Steps.
 *
 * Here and not in Results > Diagnostics, which mirrors the status: a Jira key
 * cannot run without credentials, so the way to them stays in plain view
 * rather than under a tree, a menu or the palette. One line: the key, the name,
 * the status (which gives way first in a narrow sidebar, whole in the tooltip),
 * the action. The page fills it from the host's `jira` on every push; the
 * markup starts as the host does, with no credential known.
 *
 * The row is a named group — "Jira, Configured" — so the button, named for what
 * it does ("Replace Jira credentials"), is heard with the state it acts on; the
 * tooltip's two sentences are its description.
 */
const JIRA_INITIAL = jiraConnection(false, false);
const JIRA_ROW = `      <div class="jira-row jira-${JIRA_INITIAL.state}" id="jira-row" role="group" aria-labelledby="jira-label jira-status-text" title="${JIRA_INITIAL.tooltip}">
        <span class="codicon codicon-key jira-icon icon-muted" aria-hidden="true"></span>
        <span class="jira-label" id="jira-label">Jira</span>
        <span class="jira-status">
          <span class="codicon jira-state-icon" id="jira-state-icon" aria-hidden="true" hidden></span>
          <span class="jira-status-text" id="jira-status-text">${JIRA_INITIAL.status}</span>
        </span>
        <button type="button" id="set-credentials" class="link jira-action" aria-label="${JIRA_INITIAL.actionLabel}" aria-describedby="jira-row-description">${JIRA_INITIAL.action}</button>
        <span class="visually-hidden" id="jira-row-description">${JIRA_INITIAL.tooltip}</span>
      </div>`;

/**
 * The leading slot of a row with no checkbox: as wide as the checkbox's, so the
 * name starts where every other row's does. Presentation only — no control, no
 * role, nothing to focus or announce.
 */
const STEP_LEAD_SPACER = `<span class="step-lead" aria-hidden="true"></span>`;

/**
 * The gear's place on a row with no settings (Fix result), kept so that every
 * row's status ends at the same point. Presentation only.
 */
const STEP_SETTINGS_SPACER = `<span class="step-settings-spacer" aria-hidden="true"></span>`;

/**
 * What the step does, for assistive technology: the name's tooltip says it on
 * hover, and this says it in the row's reading order — and, through the
 * checkbox's `aria-describedby`, when the box is focused. Visually hidden, like
 * the settings page's explanations (§37.104); never a visible line (§37.107).
 * For a row with no box it also says the step always runs (§37.108).
 */
function stepPurpose(id: WorkflowStepId): string {
  return `<p class="visually-hidden" id="purpose-${id}">${stepTooltip(id)}</p>`;
}

/**
 * Each row's icon (§37.108), between the leading slot and the name: what the
 * step works on, at a glance — the issue, the code, the history, past fixes,
 * the package, the agent. Decoration, never the only way to tell the rows
 * apart: the name says it, so the icon is hidden from assistive technology.
 * Fix with AI's is the robot of the Fix with AI button, not the terminal Open
 * AI Session already uses. The colours are tones the theme supplies
 * (`panel.css`); the glyphs are declared in `codicons/codicon.css`.
 */
const STEP_ICONS: Readonly<Record<WorkflowStepId, { readonly glyph: string; readonly tone: string }>> = {
  issueDetails: { glyph: "file-text", tone: "blue" },
  codeSearch: { glyph: "search", tone: "blue" },
  gitHistory: { glyph: "source-control", tone: "green" },
  similarFixes: { glyph: "database", tone: "amber" },
  buildContext: { glyph: "files", tone: "cyan" },
  fixWithAI: { glyph: "hubot", tone: "purple" },
  // The agent's report: its own glyph, so it is not mistaken for Issue details.
  fixResult: { glyph: "output", tone: "purple" },
};

function stepIcon(id: WorkflowStepId): string {
  const { glyph, tone } = STEP_ICONS[id];
  return `<span class="codicon codicon-${glyph} step-icon step-icon-${tone}" aria-hidden="true"></span>`;
}

/**
 * One workflow row: the choice, the status, and the result.
 *
 * Every row has the same parts on its first line (§37.107, §37.108): a leading
 * slot — the checkbox, or a spacer as wide — then the step's icon and its
 * name, then the metadata ending in the gear (or a spacer as wide), so names
 * start on one line down the list and gears stand in one column. What the step
 * does is the name's tooltip and, visually hidden, the row's description; the
 * line under the name is for state only.
 *
 * The boxes are ticked in the markup — except `fixWithAI`, which starts
 * unticked because involving a model is a decision of its own (R5), and a box
 * that arrives ticked has made that decision for the developer. The rest match
 * `DEFAULT_FORM`, so a Run that happens before the host's first state push
 * does what the boxes say. `test/panel.test.ts` compares both against the
 * model.
 *
 * Every slot below the first line starts hidden and is filled by the page
 * from the host's `WorkflowStepResult`: the state line, a detail line, the
 * owned artifact as a quiet link, whatever the step owns (Code search's two
 * disclosures, Build context's two actions, Fix with AI's Strategy line), and
 * the row's own failure card.
 */
function step(id: WorkflowStepId): string {
  // Two rows have no checkbox (§37.107): Issue details is the input, and Build
  // context is the package every later step and the AI fix work from — both
  // run on every run. Not a disabled box, which reads as a setting somebody
  // locked and is still announced as a checkbox: the row's leading slot holds
  // a spacer instead, so its name starts where the others' do. That they
  // always run is in the tooltip, not on screen (§37.108).
  const required = ALWAYS_RUNS.includes(id);
  const checked = id === "fixWithAI" ? "" : " checked";
  const lead = required
    ? STEP_LEAD_SPACER
    : `<span class="step-lead"><input type="checkbox" id="plan-${id}"${checked} aria-describedby="purpose-${id}"></span>`;
  // A gear only where the step has a settings section — every step but Fix
  // result, Similar fixes since §37.113. Named for its step — "Configure
  // Code Search" — because six buttons all called Settings are one name read six
  // times. Visible at rest (quieter until hovered or focused), never hover-only.
  const section = SETTINGS_SECTION_OF_STEP[id];
  const gear = section
    ? `<button type="button" class="icon step-settings" id="settings-${id}" title="${SETTINGS_ACTION_LABELS[section]}" aria-label="${SETTINGS_ACTION_LABELS[section]}"><span class="codicon codicon-settings-gear" aria-hidden="true"></span></button>`
    : STEP_SETTINGS_SPACER;
  const summary = section ? `\n            <p class="step-settings-summary" id="settings-summary-${id}" hidden></p>` : "";
  // First line: the choice (the checkbox, or its empty slot, the icon and the
  // name), then the metadata — how long it took, how it went, its gear. The
  // status is words with a small dot or the spinner beside them, never a second
  // tick (§37.86). The artifact link sits under the row's lines, not among the
  // metadata. Clicking the name of a row with a box ticks it, as before; the
  // name of a row without one is plain text.
  const name = `${lead}${stepIcon(id)}<span class="step-main"><span class="step-name">${STEP_LABELS[id]}</span></span>`;
  const label = required
    ? `<span class="step-label" title="${stepTooltip(id)}">${name}</span>`
    : `<label class="step-label" for="plan-${id}" title="${stepTooltip(id)}">${name}</label>`;
  return `        <li class="step" id="step-${id}">
          <div class="step-head">
            ${label}
            ${stepPurpose(id)}
            <span class="step-meta">
              <span class="step-duration" id="duration-${id}"></span>
              ${stepStatus(id)}
              ${gear}
            </span>
          </div>
          <div class="step-foot" id="foot-${id}" hidden>
            <p class="step-description" id="description-${id}" hidden></p>
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
 * The seventh row, present only while `fix_report.md` is.
 *
 * Built like the six so it reads as part of the same list, with two
 * differences that are the point: no checkbox — nobody chooses it and no run
 * performs it, so its leading slot is a spacer like Issue details' — and no
 * row failure card, because a report that cannot be previewed is still a
 * report, not an error. (The one card it has is Review with AI's, about that
 * action.) Hidden in the markup; the page shows it only while the host's
 * workflow includes it.
 */
const FIX_RESULT_ROW = `        <li class="step" id="step-fixResult" hidden>
          <div class="step-head">
            <span class="step-label" title="${stepTooltip("fixResult")}">${STEP_LEAD_SPACER}${stepIcon("fixResult")}<span class="step-main"><span class="step-name">${STEP_LABELS.fixResult}</span></span></span>
            ${stepPurpose("fixResult")}
            <span class="step-meta">
              <span class="step-duration" id="duration-fixResult"></span>
              ${stepStatus("fixResult")}
              ${STEP_SETTINGS_SPACER}
            </span>
          </div>
          <div class="step-foot" id="foot-fixResult" hidden>
            <p class="step-description" id="description-fixResult" hidden></p>
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
  if (id === "gitHistory") {
    // Which commits, and why those: collapsed like Code search's two, because
    // the summary line ("6 related commits found") is the answer and this is
    // for the developer who wants to look. Built by the page from the
    // structured record the host read out of retrieval.json — never from
    // context.md — and only while that record has commits to list.
    //
    // Then Supporting files: what those commits also changed that Code
    // search did not return. A list of its own, under the row whose evidence it
    // is, so it can never be read as Code search's Relevant files.
    return `            <details class="commits" id="related-commits" hidden>
              <summary id="related-commits-summary">Related commits</summary>
              <div id="related-commits-list"></div>
            </details>
            <details class="files" id="supporting-files" hidden>
              <summary id="supporting-files-summary">Supporting files</summary>
              <div id="supporting-files-list"></div>
            </details>`;
  }
  if (id === "buildContext") {
    return `            <div class="step-actions" id="actions-buildContext" hidden>
              ${BUILD_CONTEXT_ACTIONS.map(actionButton).join("\n              ")}
            </div>`;
  }
  if (id === "fixResult") {
    // Read the report first; then, if wanted, prepare someone else's review of
    // it, or start one with the selected agent. Each label
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
    // Then Review Result: what somebody saved after a review, in
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
    // Then Verification Evidence: the checks the developer recorded
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

/** One of the editor's six instruction sections (§37.118). */
export interface EditorSection {
  readonly id: string;
  readonly label: string;
  /** Its glyph and tone: the detail page's for the same section, which a test holds them to. */
  readonly glyph: string;
  readonly tone: "cyan" | "purple" | "green" | "blue" | "amber";
  /** Open when the editor opens: the four that say how the work goes. */
  readonly open: boolean;
  /** The box's resting height, by how much a section usually says; it grows from there. */
  readonly rows: number;
}

/**
 * The six editable sections, as the editor shows them.
 *
 * The ids match `FixModeDraft`'s fields exactly, so the page reads and writes
 * them by name rather than keeping a second mapping that could drift. New Fix
 * Mode and Edit Fix Mode are one form, so this is the only list (§37.118).
 */
export const EDITOR_SECTIONS: readonly EditorSection[] = [
  { id: "objective", label: "Objective", glyph: "target", tone: "cyan", open: true, rows: 2 },
  { id: "investigation", label: "Investigation", glyph: "search", tone: "purple", open: true, rows: 4 },
  { id: "implementation", label: "Implementation", glyph: "tools", tone: "green", open: true, rows: 3 },
  { id: "verification", label: "Verification", glyph: "check-all", tone: "blue", open: true, rows: 3 },
  { id: "constraints", label: "Constraints", glyph: "warning", tone: "amber", open: false, rows: 3 },
  { id: "completion", label: "Completion Requirements", glyph: "checklist", tone: "purple", open: false, rows: 3 },
];

/**
 * One instruction section: the detail page's disclosure (§37.115) — glyph,
 * title, chevron and, closed, one line of what it says — with the box to edit
 * it in. The title names the box; the one line is for the eye only. Each has
 * its own error line, for a save core refused because of this section.
 */
function section(entry: EditorSection): string {
  return `        <details class="preview-section editor-instruction" id="field-editor-${entry.id}"${entry.open ? " open" : ""}>
          <summary class="preview-section-head" id="editor-${entry.id}-head">
            <span class="codicon codicon-${entry.glyph} preview-section-icon preview-tone-${entry.tone}" aria-hidden="true"></span>
            <h4 class="preview-section-title" id="editor-${entry.id}-label">${entry.label}</h4>
            <span class="codicon codicon-chevron-down preview-chevron" aria-hidden="true"></span>
            <span class="preview-snippet" id="editor-${entry.id}-snippet" aria-hidden="true"></span>
          </summary>
          <div class="preview-section-body">
            <textarea id="editor-${entry.id}" rows="${entry.rows}" aria-labelledby="editor-${entry.id}-label" aria-describedby="editor-${entry.id}-error"></textarea>
            <p class="error" id="editor-${entry.id}-error" hidden></p>
          </div>
        </details>`;
}

/**
 * One Basic info field: the Workflow Settings header (label, glyph, helper at
 * its right while there is room), the control, and its error line.
 */
function editorField(options: {
  readonly id: string;
  readonly label: string;
  readonly icon: string;
  readonly control: string;
  readonly hint?: string;
}): string {
  return `        <div class="field" id="field-editor-${options.id}">
${settingHeader({ forId: `editor-${options.id}`, label: options.label, icon: options.icon, ...(options.hint ? { hint: options.hint } : {}) })}
          ${options.control}
          <p class="error" id="editor-${options.id}-error" hidden></p>
        </div>`;
}

/** What a field's control points a screen reader at: its helper, if any, and its error. */
function editorDescribed(id: string, hint: boolean): string {
  return hint ? `editor-${id}-hint editor-${id}-error` : `editor-${id}-error`;
}

/**
 * The Fix Mode editor (§37.118): one form for New Fix Mode and Edit Fix Mode,
 * which differ only in what the page writes into it — the title, the line
 * under it, the helpers, which fields are fixed and the primary action's
 * words. Basic info, then Workflow instructions, then the actions in a footer
 * that stays at the bottom of the panel while the page scrolls.
 */
const EDITOR_VIEW = `  <section id="fix-mode-editor-view" class="view fix-mode-editor" aria-labelledby="editor-title" hidden>
${pageHeader({
  backId: "editor-back",
  backTitle: "Back to Fix Mode Manager",
  titleId: "editor-title",
  titleAttributes: ` aria-describedby="editor-subject"`,
})}
    <!-- Under the header, which says New or Edit (§37.120): what is being
         edited — or, new, what the page is for — and where it came from. -->
    <div class="editor-head">
      <p id="editor-subject" class="editor-subject"></p>
      <p id="editor-origin" class="muted editor-origin" hidden></p>
    </div>
    <!--
      The same message the manager shows, rendered again here: a refused save
      keeps the editor open, and an error left behind in the manager would be on
      a view the developer cannot see. When it names a field, the page shows it
      under that field instead.
    -->
    <p id="editor-error" class="error" role="alert" hidden></p>

    <section class="editor-section" aria-labelledby="editor-basic-title">
      <h3 class="editor-section-title" id="editor-basic-title"><span class="codicon codicon-settings editor-section-icon" aria-hidden="true"></span>Basic info</h3>
      <div class="editor-section-body">
${editorField({ id: "name", label: "Name", icon: "edit", control: `<input type="text" id="editor-name" aria-describedby="${editorDescribed("name", false)}">` })}
${editorField({ id: "id", label: "ID", icon: "tag", hint: "Lowercase letters, digits and hyphens.", control: `<input type="text" id="editor-id" aria-describedby="${editorDescribed("id", true)}">` })}
${editorField({ id: "description", label: "Description", icon: "note", control: `<input type="text" id="editor-description" aria-describedby="${editorDescribed("description", false)}">` })}
        <div class="editor-pair">
${editorField({
  id: "executionKind",
  label: "Execution kind",
  icon: "play",
  control: `<select id="editor-executionKind" aria-describedby="${editorDescribed("executionKind", false)}">
            <option value="fix">Fix — change source code</option>
            <option value="investigate">Investigate — diagnose first, no source changes</option>
          </select>`,
})}
${editorField({
  id: "scope",
  label: "Scope",
  icon: "folder",
  hint: "Fixed once the mode exists. Duplicate it to move it.",
  control: `<select id="editor-scope" aria-describedby="${editorDescribed("scope", true)}">
            <option value="user">User — your home directory</option>
            <option value="project">Project — this repository, shareable</option>
          </select>`,
})}
        </div>
      </div>
    </section>

    <section class="editor-section" aria-labelledby="editor-workflow-title">
      <h3 class="editor-section-title" id="editor-workflow-title"><span class="codicon codicon-list-ordered editor-section-icon" aria-hidden="true"></span>Workflow instructions</h3>
      <div class="editor-instructions">
${EDITOR_SECTIONS.map(section).join("\n")}
      </div>
    </section>

    <div id="editor-preview-pane" hidden>
      <p id="editor-preview-heading" class="card-title" tabindex="-1">Instruction Preview</p>
      <p class="muted">
        What this mode tells the agent. BugPilot's own evidence, branch, Jira and
        delivery rules are added around it and are not editable here.
      </p>
      <div id="editor-preview-body"></div>
    </div>

    <div class="editor-footer">
      <button type="button" id="editor-save" class="primary"><span class="codicon codicon-save" id="editor-save-icon" aria-hidden="true"></span><span id="editor-save-label">Save Fix Mode</span></button>
      <div class="editor-footer-more">
        <button type="button" id="editor-preview" title="Preview the generated AI instructions."><span class="codicon codicon-eye" aria-hidden="true"></span><span>Preview</span></button>
        <button type="button" id="editor-cancel"><span class="codicon codicon-close" aria-hidden="true"></span><span>Cancel</span></button>
      </div>
    </div>
  </section>`;

/** The ids of the text fields the Workflow Settings page holds, so a test can check it holds them. */
export const SETTINGS_FIELD_IDS: readonly string[] = [
  ...RETRIEVAL_INPUT_FIELDS,
  ...CODE_SEARCH_FIELDS,
  ...LIMIT_FIELDS,
  ...GIT_HISTORY_TEXT_FIELDS,
  GIT_MAX_COMMITS_FIELD,
  ...SIMILAR_FIXES_FIELDS,
  ...REPOSITORY_DETAIL_FIELDS,
  ...RUN_OPTION_FIELDS,
  AGENT_COMMAND_FIELD,
  BRANCH_TEMPLATE_FIELD,
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
