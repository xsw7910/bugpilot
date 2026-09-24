/**
 * What to say when a handoff worked.
 *
 * The narrow claim is the whole point of this file. BugPilot starts a terminal
 * with the prepared prompt in it and then stops watching — it does not read the
 * agent's output, it does not diff the repository, and it does not wait. So the
 * furthest honest statement is that an agent was started, and every word here
 * is chosen to say that and nothing more.
 *
 * `overallStatus` has drawn the same line since phase 5: "Complete" is not
 * among its answers, and "AI fix started" is where it stops. This reuses that
 * phrase rather than inventing a second vocabulary for one fact.
 *
 * The copy is provider-neutral. Which agent resolved is a detail the host
 * records — it is in `FixWithAiOutcome.detail` and on the workflow row — but the
 * headline the developer reads names no vendor, for the same reason the button
 * says "Fix with AI".
 */

import type { FixWithAiOutcome } from "./workflow.ts";

/**
 * A handoff that started an agent.
 *
 * Named for what it is. `fixSucceeded` would be a claim about the bug, and this
 * is a claim about a terminal.
 */
export interface HandoffOutcome {
  /** Three words, and the same three `overallStatus` uses. */
  readonly title: string;
  /** What actually happened, in one sentence, naming no vendor. */
  readonly message: string;
  /**
   * The host's own record of the launch, which does name the agent.
   *
   * Secondary and optional: it is the same sentence the workflow row carries,
   * shown here because "which agent" is the obvious next question and the
   * answer is already known.
   */
  readonly detail?: string;
}

export const HANDOFF_STARTED_TITLE = "AI fix started";

export const HANDOFF_STARTED_MESSAGE =
  "The prepared context was handed to the configured AI agent.";

/**
 * The outcome block, for a handoff that actually started something.
 *
 * `undefined` for every other state, which is what keeps the three apart:
 * not attempted still offers the button, and a skip is explained by the UI-B2
 * error card. A skip is never dressed up as a success — nothing was launched,
 * and the prompt went to the clipboard for the developer to use themselves.
 */
export function handoffOutcome(fix: FixWithAiOutcome | undefined): HandoffOutcome | undefined {
  if (fix?.status !== "success") return undefined;
  const detail = fix.detail?.trim();
  return {
    title: HANDOFF_STARTED_TITLE,
    message: HANDOFF_STARTED_MESSAGE,
    ...(detail ? { detail } : {}),
  };
}
