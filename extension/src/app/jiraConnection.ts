/**
 * The Jira connection row: one line in Workflow that says whether Jira is set
 * up, and the one way to set it up (§37.110).
 *
 * It stays in Workflow, under Advanced Settings and above Workflow Steps,
 * because Jira credentials are an important configuration entry point: a Jira
 * key cannot be run without them, and an entry hidden under Results >
 * Diagnostics, a menu or the command palette is one somebody has to know
 * about. Diagnostics mirrors the status in the same words; it is never the
 * place to set it.
 *
 * Three states, all from facts the host already holds — nothing here asks Jira
 * anything:
 *
 * - **Not configured**: no credential is stored (SecretStorage).
 * - **Configured**: one is stored. Not "Connected": nobody has asked Jira.
 * - **Authentication failed**: one is stored, and the last run this session
 *   that asked Jira was turned away with the CLI's `JIRA_AUTH_FAILED`. Until
 *   the credentials are saved again, or a Jira run gets its issue through.
 *
 * The action is the existing `bugpilot.setCredentials` flow, by name: Configure
 * when there is nothing to replace, Replace otherwise.
 */

export type JiraConnectionState = "configured" | "notConfigured" | "authFailed";

export interface JiraConnectionView {
  readonly state: JiraConnectionState;
  /** Two or three words, beside the label. */
  readonly status: string;
  /** The button's visible word. */
  readonly action: "Configure" | "Replace";
  /** The button's accessible name: what the word does, to what. */
  readonly actionLabel: string;
  /** The row's tooltip and accessible description: what is known, and what the button opens. */
  readonly tooltip: string;
}

/** The code the CLI reports when Jira turned the stored credentials away. */
export const JIRA_AUTH_FAILED = "JIRA_AUTH_FAILED";

export function jiraConnection(configured: boolean, rejected: boolean): JiraConnectionView {
  if (!configured) {
    return {
      state: "notConfigured",
      status: "Not configured",
      action: "Configure",
      actionLabel: "Configure Jira credentials",
      tooltip: "Jira credentials are not configured. Configure opens Jira credential setup.",
    };
  }
  if (rejected) {
    return {
      state: "authFailed",
      status: "Authentication failed",
      action: "Replace",
      actionLabel: "Replace Jira credentials",
      tooltip: "Jira turned the stored credentials away on the last run. Replace opens Jira credential setup.",
    };
  }
  return {
    state: "configured",
    status: "Configured",
    action: "Replace",
    actionLabel: "Replace Jira credentials",
    tooltip: "Jira credentials are configured. Replace opens Jira credential setup.",
  };
}
