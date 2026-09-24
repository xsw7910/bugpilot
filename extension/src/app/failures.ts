/**
 * A failure, turned into something a developer can read and act on.
 *
 * Two questions, always in this order: **what failed**, and **what can I do
 * next**. The panel showed the first already — `diagnose()` has had good copy
 * for every CLI error code since phase 5 — and answered the second only
 * sometimes, with a sentence rather than a button. This adds a category, a
 * title, a preserved copy of the original message, and at most one action.
 *
 * **Nothing here reads an error message.** The categories come from the CLI's
 * own `error.code`, which the machine contract exists to make branchable, and
 * from `resolveAgent`'s typed result. That rule is what stops this file from
 * becoming a list of `includes("401")` — a substring check that is wrong on the
 * day someone rewords a message, and wrong silently.
 *
 * It is also why classification lives on the host. The page has neither the
 * code nor the operation that produced it, so a webview deciding "this looks
 * like an auth problem" would be guessing from the least informed position in
 * the system.
 */

import { COMMANDS } from "../commands.ts";
import type { ProgressView } from "./progress.ts";
import type { CommandAction } from "./environment.ts";

/**
 * Which kind of failure this is.
 *
 * Deliberately few. A category earns its place by changing what the developer
 * should do, not by being a different shape of problem: "Jira rejected the
 * token" and "Jira has no such issue" lead to different next actions, so they
 * are two; a rate limit and a timeout both lead to "try again", so they are one.
 */
export type ErrorKind = "agent" | "jira-access" | "jira-not-found" | "run";

export interface UserFacingError {
  readonly kind: ErrorKind;
  /** Three or four words. What failed. */
  readonly title: string;
  /** One or two sentences. What to do next. */
  readonly message: string;
  /**
   * The original technical text, verbatim.
   *
   * Never the primary message and never discarded: the card answers the
   * developer's first question and this answers the one they ask when the card
   * was not enough. Rendered behind a collapsed disclosure, as text.
   */
  readonly detail?: string;
  /** One command, when there is a useful one. Rendered as a button. */
  readonly action?: CommandAction;
}

/**
 * The codes that mean Jira would not let us in, as opposed to Jira being slow,
 * rate limiting, or unreachable.
 *
 * Kept narrow on purpose (§7 of the phase brief): a timeout is not an auth
 * failure, and telling somebody to check their token when their VPN is down
 * sends them to the wrong place.
 */
const JIRA_ACCESS_CODES = new Set(["JIRA_NOT_CONFIGURED", "JIRA_AUTH_FAILED"]);

const JIRA_NOT_FOUND_CODE = "JIRA_ISSUE_NOT_FOUND";

/** Where Jira credentials actually live: SecretStorage, not VS Code settings. */
const SET_CREDENTIALS: CommandAction = {
  title: "Set Jira Credentials",
  command: COMMANDS.setCredentials,
};

const OPEN_SETTINGS: CommandAction = {
  title: "Open Settings",
  command: COMMANDS.openSettings,
};

/**
 * A finished run's failure, as a card.
 *
 * `summary` and `action` are `diagnose()`'s, unchanged — this does not rewrite
 * copy that a phase of work already got right. What it adds is the category
 * (which decides the title and the button) and the detail (which the tracker
 * now keeps).
 *
 * @param workItemId the key the run was about, when one is known. Only used to
 * name it in the not-found message, which is the difference between "Issue not
 * found" and "BugPilot couldn't find JR-12345".
 */
export function runError(
  failure: ProgressView["failure"],
  workItemId?: string,
): UserFacingError | undefined {
  if (!failure) return undefined;
  const detail = failure.detail?.trim();
  const base = {
    message: [failure.summary, failure.action].filter((part) => part).join(" "),
    ...(detail ? { detail } : {}),
  };

  if (failure.code === JIRA_NOT_FOUND_CODE) {
    return {
      kind: "jira-not-found",
      title: "Issue not found",
      // Named when the run got far enough to know which key it was about. The
      // generic sentence is not a fallback apology — it is what is true when
      // the id was never established.
      message: workItemId
        ? `BugPilot couldn't find ${workItemId}. Check the Jira key, or describe the bug instead.`
        : "BugPilot couldn't find that issue. Check the Jira key, or describe the bug instead.",
      ...(detail ? { detail } : {}),
    };
  }

  if (JIRA_ACCESS_CODES.has(failure.code)) {
    return {
      kind: "jira-access",
      title: "Unable to access Jira",
      ...base,
      action: SET_CREDENTIALS,
    };
  }

  // Everything else, including a code this extension has never heard of.
  // `diagnose()` already falls back to the CLI's own message for those, so the
  // card is less specific rather than less informative.
  return { kind: "run", title: "Run failed", ...base };
}

/**
 * A handoff that could not start.
 *
 * A different state from a failed run and not a worse one: the package is built
 * and every artifact action still works, so this card appears *beside* Context
 * Ready rather than instead of it.
 *
 * Provider-neutral wording. `reason` is `resolveAgent`'s own sentence and may
 * name a command the developer configured — which is fine, because they wrote
 * it — but nothing here spells a vendor into the copy.
 */
export function handoffError(reason: string): UserFacingError {
  const detail = reason.trim();
  return {
    kind: "agent",
    title: "AI agent unavailable",
    message:
      "BugPilot couldn't start the selected AI agent. Check that it is installed and available from your terminal, or choose another in Advanced settings.",
    ...(detail === "" ? {} : { detail }),
    action: OPEN_SETTINGS,
  };
}
