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

/**
 * Jira Setup (§37.124): one dialog in the panel for the email and the token,
 * replacing the two Quick Input prompts at the top of the window.
 *
 * Atlassian's own page for API tokens. Opened by the host with the editor's
 * external-link mechanism; the page never names a URL. BugPilot sends the
 * email and token to the configured Jira site's `/rest/api/3/...` — the
 * classic API token, not one "with scopes", which works only through
 * Atlassian's API gateway — so the help says Create API token.
 */
export const JIRA_API_TOKENS_URL = "https://id.atlassian.com/manage-profile/security/api-tokens";

/** The dialog's words, one table: the markup renders them and the tests read them. */
export const JIRA_SETUP_TEXT = {
  title: "Jira Setup",
  intro: "Connect BugPilot to Jira using your Atlassian account email and API token.",
  emailLabel: "Jira email",
  emailPlaceholder: "Atlassian account email",
  emailDescription: "Email address for the Atlassian account that created the API token.",
  tokenLabel: "API token",
  tokenStored: "A token is already stored. Enter a new token to replace it.",
  showToken: "Show API token",
  hideToken: "Hide API token",
  helpTitle: "Need an API token?",
  help: "Open Atlassian API tokens, select Create API token, choose a name and an expiration date, then copy the new token and paste it here.",
  link: "Open Atlassian API tokens",
  linkTitle: "Opens Atlassian's API token page in your browser",
  stepsTitle: "Step by step",
  steps: [
    "Open Atlassian API tokens.",
    "Select Create API token — not the one with scopes.",
    "Enter a name you will recognize.",
    "Choose an expiration date, 1 to 365 days away.",
    "Select Create, then copy the token: Atlassian shows it only once.",
    "Paste it into API token above.",
  ],
  save: "Save",
  saving: "Saving…",
  cancel: "Cancel",
} as const;

/** What the dialog says about a field that cannot be saved, the host's and the page's alike. */
export const JIRA_SETUP_PROBLEMS = {
  emailMissing: "Enter your Atlassian account email.",
  emailInvalid: "Enter a valid email address.",
  tokenMissing: "Enter an API token.",
} as const;

/** An address with one `@`, something before it, and a dotted domain after; no spaces. */
const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * The first field Save cannot store, or undefined when both can be.
 *
 * A token is required every time — on Replace too: the store keeps the two
 * together in one write, and nothing reads the stored token back to keep it.
 * No length rule for the token: Atlassian's tokens vary.
 */
export function jiraSetupProblem(
  email: string,
  token: string,
): { readonly field: "email" | "token"; readonly message: string } | undefined {
  const address = email.trim();
  if (address === "") return { field: "email", message: JIRA_SETUP_PROBLEMS.emailMissing };
  if (!EMAIL_SHAPE.test(address)) return { field: "email", message: JIRA_SETUP_PROBLEMS.emailInvalid };
  if (token.trim() === "") return { field: "token", message: JIRA_SETUP_PROBLEMS.tokenMissing };
  return undefined;
}
