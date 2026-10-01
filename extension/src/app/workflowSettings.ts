/**
 * Workflow Settings: which settings belong to which workflow step, whether
 * changing them makes a prepared context stale, and the one-line summary a
 * workflow row shows of them.
 *
 * The panel has one settings page, reached from a gear on each workflow row
 * that has settings of its own. It replaced "Advanced Settings (Optional)", a
 * disclosure at the foot of the form that grouped the same controls by kind —
 * Guidance, Retrieval Overrides, Run Options — rather than by the step they
 * change, so "what does Code search use?" had no one place to look. The
 * controls moved; none was added, renamed or given a second copy.
 *
 * A section exists only where a step has settings. Git history and Similar
 * fixes have none beyond their checkbox on the row, so they get no gear and no
 * section — a gear that opens an empty page is a control that lies.
 *
 * Everything here is data the host and the markup both read: the page cannot
 * import it (no bundler, see `panel/messages.ts`), so `media/panel.js` carries a
 * copy of the section list that `test/panel.test.ts` compares with this one.
 */

import { AGENT_LABELS } from "./agents.ts";
import { parseKeywords, parsePaths } from "./form.ts";
import type { FormState } from "./form.ts";
import type { WorkflowStepId } from "./workflow.ts";

/** The settings page's sections, top to bottom — the workflow's own order. */
export const WORKFLOW_SETTINGS_SECTIONS = ["issue-details", "code-search", "build-context", "fix-with-ai"] as const;
export type WorkflowSettingsSection = (typeof WORKFLOW_SETTINGS_SECTIONS)[number];

/**
 * Which row's gear opens which section. A row absent here has no gear.
 */
export const SETTINGS_SECTION_OF_STEP: Readonly<Partial<Record<WorkflowStepId, WorkflowSettingsSection>>> = {
  issueDetails: "issue-details",
  codeSearch: "code-search",
  buildContext: "build-context",
  fixWithAI: "fix-with-ai",
};

/** A section's heading: the name of the step it configures. */
export const SETTINGS_SECTION_TITLES: Readonly<Record<WorkflowSettingsSection, string>> = {
  "issue-details": "Issue details",
  "code-search": "Code search",
  "build-context": "Build context",
  "fix-with-ai": "Fix with AI",
};

/**
 * The form fields the settings page edits: everything in `FormState` except
 * what the main workflow page owns — the issue itself, how the AI is to
 * approach it (Fix Mode) and the guidance it carries (Hint, with the hint
 * improver's Use issue details), the plan's checkboxes and the Fix with AI box,
 * which stay where a run is composed (§37.84: Issue, Fix Mode and Hint are the
 * primary problem-definition controls, together at the top).
 */
export type SettingsField = Exclude<
  keyof FormState,
  "source" | "issueKey" | "description" | "plan" | "fixWithAI" | "fixModeId" | "hint" | "useIssueDetails"
>;

/** Whether a field is edited on the settings page at all. */
export function isSettingsField(field: string): field is SettingsField {
  return WORKFLOW_SETTINGS_SECTIONS.some((section) => (SETTINGS_SECTION_FIELDS[section] as readonly string[]).includes(field));
}

/**
 * Each section's fields, in the order the page shows them. Every settings field
 * is in exactly one section (a test checks), so no control has two homes.
 */
export const SETTINGS_SECTION_FIELDS: Readonly<Record<WorkflowSettingsSection, readonly SettingsField[]>> = {
  // A hand-written bug's title, and files to copy in beside the issue.
  "issue-details": ["title", "attachments"],
  // What the search boosts, prefers, skips, and how much it returns.
  "code-search": ["keywords", "focusFiles", "ignorePaths", "maxFiles", "maxSearchLines"],
  // How a preparation treats the work item's previous folder.
  "build-context": ["fresh"],
  // Who the task goes to. How it is approached, and the hint it carries, are
  // on the main page, under the issue.
  "fix-with-ai": ["agent", "agentCommand"],
};

/**
 * Whether changing a field makes a prepared context stale.
 *
 * A statement of `preparationFingerprint`'s rule, per field, for the labels on
 * the settings page — never a second rule: `test/workflowSettings.test.ts`
 * changes each field and checks the fingerprint moves exactly when this says
 * so. The host alone decides staleness, from the fingerprint.
 */
export const SETTING_REQUIRES_REBUILD: Readonly<Record<SettingsField, boolean>> = {
  // On the manual path only, as on the command line; the section says so.
  title: true,
  attachments: true,
  keywords: true,
  focusFiles: true,
  ignorePaths: true,
  maxFiles: true,
  maxSearchLines: true,
  fresh: false,
  agent: false,
  agentCommand: false,
};

/**
 * A row gear's name, for its tooltip and its accessible name: "Configure Code
 * Search", never six buttons all called Settings.
 */
export const SETTINGS_ACTION_LABELS: Readonly<Record<WorkflowSettingsSection, string>> = {
  "issue-details": "Configure Issue Details",
  "code-search": "Configure Code Search",
  "build-context": "Configure Build Context",
  // Fix Mode and Hint are on the main page (§37.84): this gear is the agent's.
  "fix-with-ai": "Configure AI Agent",
};

/** The label beside a setting that changes the prepared context, in a mixed section. */
export const REQUIRES_REBUILD_LABEL = "Requires context rebuild";

/** The section a setting lives in. */
export function sectionOfField(field: SettingsField): WorkflowSettingsSection {
  return WORKFLOW_SETTINGS_SECTIONS.find((section) => SETTINGS_SECTION_FIELDS[section].includes(field))!;
}

/**
 * Whether a setting carries its own "Requires context rebuild" label: only in a
 * section where some settings do and some do not — elsewhere the section's note
 * already says it once for all of them.
 */
export function showsRebuildLabel(field: SettingsField): boolean {
  const flags = SETTINGS_SECTION_FIELDS[sectionOfField(field)].map((entry) => SETTING_REQUIRES_REBUILD[entry]);
  return SETTING_REQUIRES_REBUILD[field] && flags.some((flag) => !flag);
}

/**
 * The note under a section's heading: whether its changes make a prepared
 * context stale. Derived from the table above, so the words cannot drift from it.
 */
export function sectionRebuildNote(section: WorkflowSettingsSection): string {
  const flags = SETTINGS_SECTION_FIELDS[section].map((field) => SETTING_REQUIRES_REBUILD[field]);
  if (flags.every(Boolean)) return "Changes here require rebuilding context.";
  if (!flags.some(Boolean)) return "Changes here apply to the next run and do not require rebuilding context.";
  return `Settings marked “${REQUIRES_REBUILD_LABEL}” change the prepared context; the others do not.`;
}

/** What the Fix with AI summary calls each agent choice. Never the custom command itself. */
const AGENT_SUMMARY: Readonly<Record<FormState["agent"], string>> = {
  ...AGENT_LABELS,
  auto: "Auto-detected agent",
  custom: "Custom agent command",
};

/**
 * One short line per row with settings, from the form as the host holds it —
 * the applied settings, never a draft.
 *
 * Counts and names only: how many keywords, not which; "Custom agent
 * command", never the command. Nothing typed by the developer, read from Jira
 * or found on disk reaches a summary. A row whose settings are all at their
 * defaults has none, and keeps saying what it does. Fix with AI's is its agent
 * only: Fix Mode and Hint are on the main page, in plain view, and a summary of
 * settings the row's gear does not open would point at the wrong place.
 */
export function settingsSummaries(form: FormState): Partial<Record<WorkflowStepId, string>> {
  const summaries: Partial<Record<WorkflowStepId, string>> = {};

  const attached = form.attachments.filter((entry) => entry.trim() !== "").length;
  if (attached > 0) summaries.issueDetails = plural(attached, "attachment");

  const search = [
    counted(parseKeywords(form.keywords).length, "keyword"),
    counted(parsePaths(form.focusFiles).length, "focus path"),
    counted(parsePaths(form.ignorePaths).length, "ignored path"),
    limit(form.maxFiles, "file"),
    limit(form.maxSearchLines, "search line"),
  ].filter((part) => part !== "");
  if (search.length > 0) summaries.codeSearch = search.join(" · ");

  if (form.fresh) summaries.buildContext = "Deletes previous artifacts first";

  summaries.fixWithAI = AGENT_SUMMARY[form.agent];

  return summaries;
}

function counted(count: number, noun: string): string {
  return count === 0 ? "" : plural(count, noun);
}

/** "max 10 files", for a limit that is set; an empty or malformed one says nothing. */
function limit(raw: string, noun: string): string {
  const text = raw.trim();
  if (!/^\d+$/.test(text) || Number(text) < 1) return "";
  return `max ${Number(text)} ${noun}${Number(text) === 1 ? "" : "s"}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
