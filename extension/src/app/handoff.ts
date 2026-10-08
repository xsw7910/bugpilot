/**
 * What to say when a handoff worked.
 *
 * The narrow claim is the whole point of this file. BugPilot starts a terminal
 * with the prepared prompt in it and then stops watching — it does not read the
 * agent's output, it does not diff the repository, and it does not wait. So the
 * furthest honest statement is that an agent was started, and every word here
 * is chosen to say that and nothing more.
 *
 * The words are spoken by the Fix with AI row itself
 * (`workflow.ts`): this phrase is its summary, and the host's own record of the
 * launch — "Handed to Claude Code in a terminal." — is its detail line. The
 * headline is provider-neutral, for the same reason the button says "Fix with
 * AI"; which agent resolved is the detail's to say.
 */

/**
 * Three words, shared by the Fix with AI row and the workflow header.
 *
 * `overallStatus` has said "AI fix started" since phase 5; one phrase for one
 * fact, because a second vocabulary for it is how a panel starts contradicting
 * itself.
 */
export const HANDOFF_STARTED_TITLE = "AI fix started";

/**
 * The same narrow claim for Review with AI, said under Fix result.
 *
 * A reviewer was started with the review prompt, and nothing further: whether
 * it finished, what it found, whether the result holds up — none of that comes
 * back to BugPilot, so none of it is said.
 */
export const REVIEW_STARTED_TITLE = "AI review started";
