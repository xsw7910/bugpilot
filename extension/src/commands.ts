/**
 * Every command id in one place.
 *
 * A command id appears in three places that must agree: the manifest's
 * `contributes.commands`, the `registerCommand` call, and whatever button, menu
 * or tree item invokes it. A typo in any one of them fails at runtime with VS
 * Code's "command 'x' not found", which is a bad way to find out. So the ids
 * live here and `test/manifest.test.ts` checks the manifest against this table
 * in both directions, while `npm run smoke` checks that activation registers
 * exactly these.
 */

export const COMMANDS = {
  // --- environment and setup ---
  /** Re-run the readiness check after the developer fixed something. */
  checkEnvironment: "bugpilot.checkEnvironment",
  /** Show how to install the CLI, for a machine that has no bugpilot at all. */
  showInstallInstructions: "bugpilot.showInstallInstructions",
  /** Point `bugpilot.executablePath` at a chosen file. */
  chooseExecutable: "bugpilot.chooseExecutable",
  /** Store the Jira email and API token in SecretStorage. */
  setCredentials: "bugpilot.setCredentials",
  clearCredentials: "bugpilot.clearCredentials",

  // --- the panel ---
  /** Open the panel as an editor tab, for the wide layout. */
  openPanelInEditor: "bugpilot.openPanelInEditor",

  // --- a run ---
  /** Cancel the run in flight, killing the process tree. */
  stop: "bugpilot.stop",
  /** Second attempt: opens the feedback file, then builds the retry package. */
  retry: "bugpilot.retry",

  // --- artifacts ---
  openAgentTask: "bugpilot.openAgentTask",
  copyHandoffPrompt: "bugpilot.copyHandoffPrompt",
  /** Reveal `.ai/<work_item>/` in the explorer. */
  openArtifactsFolder: "bugpilot.openArtifactsFolder",
  /**
   * Hand the prepared package to a coding agent and let it start working.
   *
   * Named for what it does rather than for who does it: the agent is chosen in
   * Advanced settings, and the panel never puts one vendor's name in front of
   * the developer.
   */
  fixWithAI: "bugpilot.fixWithAI",
  /** Invoked by a tree item with the artifact's file name. */
  openArtifact: "bugpilot.openArtifact",
  /** Invoked by a history item with the work item id. */
  showWorkItem: "bugpilot.showWorkItem",
  refreshViews: "bugpilot.refreshViews",

  // --- diagnostics ---
  doctor: "bugpilot.doctor",
  agentCheck: "bugpilot.agentCheck",
  /** Remove a work item's artifacts. Destructive, so it confirms first. */
  clean: "bugpilot.clean",
  /** Whether an MCP client here is configured to reach bugpilot. */
  mcpStatus: "bugpilot.mcpStatus",
  /** Continue the agent session that ran in this repository, in a terminal. */
  resumeAgentSession: "bugpilot.resumeAgentSession",
  showLog: "bugpilot.showLog",
} as const;

export type CommandId = (typeof COMMANDS)[keyof typeof COMMANDS];

/** Commands invoked only by a tree item, which would be meaningless in the palette. */
export const HIDDEN_FROM_PALETTE: readonly string[] = [
  COMMANDS.openArtifact,
  COMMANDS.showWorkItem,
];

/** Configuration keys, for the same reason. */
export const SETTINGS = {
  section: "bugpilot",
  executablePath: "executablePath",
} as const;

/**
 * A tree item's `contextValue`, which the manifest's menus match on.
 *
 * Here for the same reason the command ids are: it appears in the manifest's
 * `when` clause and in the code that sets it, and a typo in either one gives no
 * menu and no error. `test/manifest.test.ts` compares the two.
 */
export const HISTORY_ITEM_CONTEXT = "bugpilot.workItem";

/**
 * The work item id in a command argument from a tree view, if that is what it is.
 *
 * A `view/item/context` command is handed the tree node itself; the same command
 * from the palette is handed nothing. Read defensively rather than cast, and
 * strictly: only the node shape counts. One of these commands deletes files, so
 * accepting a bare string — which any caller could pass — would make "which
 * work item do I delete" answerable by anyone.
 */
export function workItemFromTree(argument: unknown): string | undefined {
  const value = (argument as { workItemId?: unknown } | undefined)?.workItemId;
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** View ids, shared between the manifest and the code that registers them. */
export const VIEWS = {
  panel: "bugpilot.panel",
  artifacts: "bugpilot.artifacts",
  history: "bugpilot.history",
} as const;
