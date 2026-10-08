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
 * A section exists where a step has settings — Git history since the Git
 * History Settings (Git History Retrieval v2, Batch 2), Similar fixes since the
 * Similar Fixes Settings (§37.113) — and one more holds what several steps
 * share: Retrieval inputs, the Keywords and Focus files. Code search always
 * uses them, Git history and Similar fixes may (each by its own *Use shared…*
 * switch), so they are no one step's settings and no row's gear opens them;
 * they sit just above Code search, the step that always reads them. A step
 * with no settings has no gear — a gear that opens an empty page is a control
 * that lies.
 *
 * Everything here is data the host and the markup both read: the page cannot
 * import it (no bundler, see `panel/messages.ts`), so `media/panel.js` carries a
 * copy of the section list that `test/panel.test.ts` compares with this one.
 */

import { AGENT_LABELS } from "./agents.ts";
import { branchPolicyOf, parseKeywords, parsePaths } from "./form.ts";
import type { BranchPolicy, FormState } from "./form.ts";
import type { WorkflowStepId } from "./workflow.ts";

/**
 * The settings page's sections, top to bottom — the workflow's own order, with
 * the shared Retrieval inputs before the retrieval steps that read them, and
 * Branch last (§37.127): which branch the agent works on, belonging to no one
 * step, and its own section because it changes task.md where Fix with AI's
 * agent settings do not — no section mixes the two.
 *
 * Repository (pre-release Batch 1) sits after the retrieval steps: what the
 * repository is, written into task.md. No one step's either, so no gear opens
 * it, and the repository's own setting rather than this session's. It also
 * holds the repository's Project instructions (pre-release Batch 2), and AI
 * instructions after it the developer's own User instructions: two documents,
 * each edited on its own page and saved there, so neither section's form
 * fields include them — every change to either changes task.md.
 */
export const WORKFLOW_SETTINGS_SECTIONS = [
  "issue-details",
  "retrieval-inputs",
  "code-search",
  "git-history",
  "similar-fixes",
  "repository",
  "ai-instructions",
  "build-context",
  "fix-with-ai",
  "branch",
] as const;
export type WorkflowSettingsSection = (typeof WORKFLOW_SETTINGS_SECTIONS)[number];

/** The sections that belong to one step: every one but the shared inputs, Repository, AI instructions and Branch. */
export type StepSettingsSection = Exclude<WorkflowSettingsSection, "retrieval-inputs" | "repository" | "ai-instructions" | "branch">;

/**
 * Which row's gear opens which section. A row absent here has no gear, and
 * Retrieval inputs is no row's: Code search's gear opens Code search, whose own
 * settings are Ignore paths and the limits.
 */
export const SETTINGS_SECTION_OF_STEP: Readonly<Partial<Record<WorkflowStepId, StepSettingsSection>>> = {
  issueDetails: "issue-details",
  codeSearch: "code-search",
  gitHistory: "git-history",
  similarFixes: "similar-fixes",
  buildContext: "build-context",
  fixWithAI: "fix-with-ai",
};

/** A section's heading: the name of the step it configures, or of what the steps share. */
export const SETTINGS_SECTION_TITLES: Readonly<Record<WorkflowSettingsSection, string>> = {
  "issue-details": "Issue details",
  "retrieval-inputs": "Retrieval inputs",
  "code-search": "Code search",
  "git-history": "Git history",
  "similar-fixes": "Similar fixes",
  repository: "Repository",
  "ai-instructions": "AI instructions",
  "build-context": "Build context",
  "fix-with-ai": "Fix with AI",
  branch: "Branch",
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
  "issue-details": ["title", "attachments", "attachmentDescriptions"],
  // What the retrieval steps share: the terms they search for and the files
  // they prefer. One copy each — no step has a second.
  "retrieval-inputs": ["keywords", "focusFiles"],
  // Code search's own: what it skips, and how much it returns.
  "code-search": ["ignorePaths", "maxFiles", "maxSearchLines"],
  // Which shared inputs Git history follows, what it adds of its own, which
  // routes it searches, how far back, and how many commits it keeps.
  "git-history": [
    "gitUseSharedKeywords",
    "gitUseSharedFocusFiles",
    "gitKeywords",
    "gitFiles",
    "gitSearchMessages",
    "gitSearchFileHistory",
    "gitHistoryDepth",
    "gitMaxCommits",
  ],
  // Whether Similar fixes follows the shared Keywords, what it adds of its own,
  // and how many past fixes it keeps. Never the Focus files.
  "similar-fixes": ["similarUseSharedKeywords", "similarKeywords", "similarMaxFixes"],
  // What the repository is, for task.md: the profile, and its Custom details.
  repository: [
    "repositoryProfile",
    "repositoryLanguages",
    "repositoryFrameworks",
    "repositoryApplicationType",
    "repositoryBuildSystem",
    "repositoryTestFramework",
    "repositoryNotes",
  ],
  // The developer's User instructions (a document on its own page, not a form
  // field) and the repository's Verification Policy: all of it task.md's.
  "ai-instructions": ["verifyRelevantTests", "verifyStaticChecks", "verifyFullSuite", "verifyReportNotRun"],
  // How a preparation treats the work item's previous folder.
  "build-context": ["fresh"],
  // Who the task goes to. How it is approached, and the hint it carries, are
  // on the main page, under the issue.
  "fix-with-ai": ["agent", "agentCommand"],
  // Which branch the agent edits and commits on, and what a new one is called.
  branch: ["branchPolicy", "branchNaming", "branchTemplate"],
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
  // Named in task.md under each file, so prepared context like the files.
  attachmentDescriptions: true,
  keywords: true,
  focusFiles: true,
  ignorePaths: true,
  maxFiles: true,
  maxSearchLines: true,
  // Every one of them can change the Git History section of context.md.
  gitUseSharedKeywords: true,
  gitUseSharedFocusFiles: true,
  gitKeywords: true,
  gitFiles: true,
  gitSearchMessages: true,
  gitSearchFileHistory: true,
  gitHistoryDepth: true,
  gitMaxCommits: true,
  // Each one can change the Similar Fixes section of context.md.
  similarUseSharedKeywords: true,
  similarKeywords: true,
  similarMaxFixes: true,
  fresh: false,
  agent: false,
  agentCommand: false,
  // Written into task.md, as the Fix Mode is.
  branchPolicy: true,
  // The Verification Policy section of task.md, and the branch it names (Batch 3).
  verifyRelevantTests: true,
  verifyStaticChecks: true,
  verifyFullSuite: true,
  verifyReportNotRun: true,
  branchNaming: true,
  branchTemplate: true,
  // The Repository Context section of task.md: the mode and each detail.
  repositoryProfile: true,
  repositoryLanguages: true,
  repositoryFrameworks: true,
  repositoryApplicationType: true,
  repositoryBuildSystem: true,
  repositoryTestFramework: true,
  repositoryNotes: true,
};

/**
 * A row gear's name, for its tooltip and its accessible name: "Configure Code
 * Search", never six buttons all called Settings.
 */
export const SETTINGS_ACTION_LABELS: Readonly<Record<StepSettingsSection, string>> = {
  "issue-details": "Configure Issue Details",
  "code-search": "Configure Code Search",
  "git-history": "Configure Git History",
  "similar-fixes": "Configure Similar Fixes",
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

/** How much of a section makes a prepared context stale: all of it, none of it, or some. */
function rebuildScope(section: WorkflowSettingsSection): "all" | "none" | "some" {
  const flags = SETTINGS_SECTION_FIELDS[section].map((field) => SETTING_REQUIRES_REBUILD[field]);
  if (flags.every(Boolean)) return "all";
  return flags.some(Boolean) ? "some" : "none";
}

/**
 * Whether a section's changes make a prepared context stale, as a sentence:
 * the tooltip of the section's tag. Derived from the table above, so the words
 * cannot drift from it.
 */
export function sectionRebuildNote(section: WorkflowSettingsSection): string {
  switch (rebuildScope(section)) {
    case "all":
      return "Changes here require rebuilding context.";
    case "none":
      return "Changes here apply to the next run and do not require rebuilding context.";
    case "some":
      return `Settings marked “${REQUIRES_REBUILD_LABEL}” change the prepared context; the others do not.`;
  }
}

/**
 * The same fact in a few words, beside the section's heading (Advanced Settings
 * simplification): the sentence above said it under every heading, five times
 * on one page. The sentence is the tag's tooltip.
 *
 * Worded as what a change *needs*, not what the section does: "Rebuilds
 * context" read as though applying rebuilt it. Nothing rebuilds until the
 * developer presses Rebuild Context.
 */
export function sectionRebuildTag(section: WorkflowSettingsSection): string {
  switch (rebuildScope(section)) {
    case "all":
      return "Requires rebuild";
    case "none":
      return "Next run only";
    case "some":
      return "Some require rebuild";
  }
}

/**
 * What the Fix with AI summary calls each agent the developer chose. Never the
 * custom command itself. Auto-detect has none: it is the default, and a row at
 * its defaults says nothing (§37.108).
 */
const AGENT_SUMMARY: Readonly<Record<Exclude<FormState["agent"], "auto">, string>> = {
  ...AGENT_LABELS,
  custom: "Custom agent command",
};

/**
 * One short line per row with settings, from the form as the host holds it —
 * the applied settings, never a draft.
 *
 * Counts and names only: how many keywords, not which; "Custom agent
 * command", never the command. Nothing typed by the developer, read from Jira
 * or found on disk reaches a summary. A row whose settings are all at their
 * defaults has none — Fix with AI's included, on Auto-detect (§37.108). Fix
 * with AI's is its agent only: Fix Mode and Hint are on the main page, in plain
 * view, and a summary of settings the row's gear does not open would point at
 * the wrong place.
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

  const routesOff = !form.gitSearchMessages && !form.gitSearchFileHistory;
  const history = [
    counted(parseKeywords(form.gitKeywords).length, "commit keyword"),
    counted(parsePaths(form.gitFiles).length, "additional file"),
    form.gitUseSharedKeywords ? "" : "shared keywords off",
    form.gitUseSharedFocusFiles ? "" : "shared focus files off",
    routesOff ? "both searches off" : "",
    !routesOff && !form.gitSearchMessages ? "commit search off" : "",
    !routesOff && !form.gitSearchFileHistory ? "file history off" : "",
    form.gitHistoryDepth === "broader" ? "broader history" : "",
    limit(form.gitMaxCommits, "commit"),
  ].filter((part) => part !== "");
  if (history.length > 0) summaries.gitHistory = history.join(" · ");

  const similar = [
    counted(parseKeywords(form.similarKeywords).length, "additional keyword"),
    form.similarUseSharedKeywords ? "" : "shared keywords off",
    limit(form.similarMaxFixes, "similar fix", "similar fixes"),
  ].filter((part) => part !== "");
  if (similar.length > 0) summaries.similarFixes = similar.join(" · ");

  if (form.fresh) summaries.buildContext = "Deletes previous artifacts first";

  const fix = [
    form.agent !== "auto" ? AGENT_SUMMARY[form.agent] : "",
    // At its default, the current branch, the row says nothing.
    BRANCH_POLICY_SUMMARY[branchPolicyOf(form.branchPolicy)],
  ].filter((part) => part !== "");
  if (fix.length > 0) summaries.fixWithAI = fix.join(" · ");

  return summaries;
}

/** What the Fix with AI summary says of a branch policy that is not the default. */
const BRANCH_POLICY_SUMMARY: Readonly<Record<BranchPolicy, string>> = {
  current: "",
  "per-issue": "one branch per issue",
  ask: "asks which branch",
};

function counted(count: number, noun: string): string {
  return count === 0 ? "" : plural(count, noun);
}

/** "max 10 files", for a limit that is set; an empty or malformed one says nothing. */
function limit(raw: string, noun: string, nouns = `${noun}s`): string {
  const text = raw.trim();
  if (!/^\d+$/.test(text) || Number(text) < 1) return "";
  return `max ${Number(text)} ${Number(text) === 1 ? noun : nouns}`;
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}
