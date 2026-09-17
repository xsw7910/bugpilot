/**
 * `error.code` → what to tell the developer, and what they can do about it.
 *
 * The contract (docs/adapter_design.md §5.1) says a consumer branches on
 * `error.code` and never parses `error.message`. This is that branch, in one
 * place, so no UI code grows its own copy.
 *
 * Codes are append-only on the CLI side, which means this table will inevitably
 * be behind a newer bugpilot. An unknown code therefore falls back to the CLI's
 * own message rather than a generic apology: being slightly less helpful is
 * fine, discarding the only explanation available is not.
 */

export interface Diagnosis {
  /** One line for a notification. */
  readonly summary: string;
  /** What the developer can do next, if anything. */
  readonly action?: string;
  /** True when retrying the same command could plausibly work. */
  readonly retryable: boolean;
  /** True when this client had no entry for the code. */
  readonly unknownCode: boolean;
}

interface Entry {
  readonly summary: string;
  readonly action?: string;
  readonly retryable?: boolean;
}

const TABLE: Record<string, Entry> = {
  // --- Jira ---------------------------------------------------------------
  JIRA_NOT_CONFIGURED: {
    summary: "Jira is not configured.",
    action: "Run `bugpilot setup` in a terminal to store your Jira email and API token.",
  },
  JIRA_AUTH_FAILED: {
    summary: "Jira rejected the stored credentials.",
    action: "Re-run `bugpilot setup`; an API token may have been revoked or rotated.",
  },
  JIRA_ISSUE_NOT_FOUND: {
    summary: "Jira has no such issue, or the account cannot see it.",
    action: "Check the issue key and your project permissions.",
  },
  JIRA_RATE_LIMITED: {
    summary: "Jira is rate limiting this account.",
    action: "Wait a minute and try again.",
    retryable: true,
  },
  JIRA_TIMEOUT: {
    summary: "Jira did not respond in time.",
    action: "Check VPN or proxy, then try again.",
    retryable: true,
  },
  JIRA_NETWORK_ERROR: {
    summary: "Could not reach Jira.",
    action: "Check VPN, proxy, DNS and the configured Jira URL.",
    retryable: true,
  },
  JIRA_INVALID_RESPONSE: { summary: "Jira returned something bugpilot could not read." },
  JIRA_ERROR: { summary: "Jira request failed.", retryable: true },

  // --- source-mode gates --------------------------------------------------
  JIRA_ONLY_COMMAND: {
    summary: "That only applies to a Jira work item.",
    action: "This bug was described by hand, so there is no Jira issue to act on.",
  },
  NO_JIRA_TARGET: {
    summary: "This bug has no Jira issue to write back to.",
    action: "It was described by hand. Prepare it from a Jira issue key if you need Jira updates.",
  },

  // --- local state --------------------------------------------------------
  WORK_ITEM_NOT_FOUND: {
    summary: "That work item has not been prepared yet.",
    action: "Prepare the bug first.",
  },
  ARTIFACT_NOT_FOUND: {
    summary: "An expected file is missing from the work item.",
    action: "Re-prepare the bug to rebuild its artifacts.",
  },
  MISSING_RESULTS: {
    summary: "The fix attempt has not written all of its result files.",
    action: "Finish the attempt, or start a second one with Retry.",
  },
  INVALID_INPUT: { summary: "bugpilot rejected those arguments." },

  // --- other --------------------------------------------------------------
  EMAIL_SEND_FAILED: {
    summary: "The notification email could not be sent.",
    action: "Check the SMTP or Graph settings; the local draft was still written.",
  },
  INTERNAL_ERROR: {
    summary: "bugpilot hit an unexpected error.",
    action: "Check the work item's execution.log for the full trace.",
  },
};

/**
 * Turn a code and the CLI's own message into something worth showing.
 *
 * `message` is used only as the fallback body for an unrecognised code — never
 * pattern-matched, which is the point of having codes at all.
 */
export function diagnose(code: string, message = ""): Diagnosis {
  const entry = TABLE[code];
  if (!entry) {
    const summary = message.trim() !== "" ? message.trim() : `bugpilot reported ${code}.`;
    return {
      summary,
      action: "This version of the extension does not recognise that error; updating it may help.",
      retryable: false,
      unknownCode: true,
    };
  }
  return {
    summary: entry.summary,
    ...(entry.action === undefined ? {} : { action: entry.action }),
    retryable: entry.retryable ?? false,
    unknownCode: false,
  };
}

/** Every code this client knows. Exported so a test can compare against the CLI. */
export function knownCodes(): string[] {
  return Object.keys(TABLE).sort();
}
