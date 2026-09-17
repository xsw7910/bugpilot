/**
 * Finding the agent session that ran in this repository.
 *
 * Claude Code stores a session transcript per working directory:
 *
 *     ~/.claude/projects/<cwd-slug>/<session-uuid>.jsonl
 *
 * so a session started by bugpilot in the terminal is visible to the editor's
 * Claude extension **only when the workspace root is the same directory**
 * (§5.6). That gives the extension something useful to offer — resume the last
 * agent session for this repository — and one obligation:
 *
 * **This is a fragile rule, not a contract.** The slug derivation is Claude
 * Code's implementation detail and an upgrade may change it. Every function
 * here therefore returns "I don't know" rather than a guess, and the caller
 * must degrade quietly instead of showing a broken entry point.
 */

/**
 * The directory name Claude Code uses for a working directory.
 *
 * Every character that is not a letter or digit becomes a dash, which is why
 * `c:\work\my-app` becomes `c--work-my-app`: the colon and the separator
 * each contribute one dash, and the existing dash survives as itself.
 */
export function claudeProjectSlug(root: string): string {
  return root.replace(/[^a-zA-Z0-9]/g, "-");
}

export interface SessionCandidate {
  /** The session id, which is the file name without `.jsonl`. */
  readonly id: string;
  readonly modifiedMs: number;
}

/**
 * The session to offer resuming.
 *
 * The most recently written transcript, because that is the run that just
 * finished. Ties are broken by id so the choice does not flicker between two
 * renders. Returns undefined for an empty list — there is nothing to resume,
 * which is a normal state and not an error.
 */
export function pickLatestSession(
  candidates: readonly SessionCandidate[],
): SessionCandidate | undefined {
  if (candidates.length === 0) return undefined;
  return [...candidates].sort((left, right) => {
    const byTime = right.modifiedMs - left.modifiedMs;
    return byTime !== 0 ? byTime : right.id.localeCompare(left.id);
  })[0];
}

/** The session id carried by a transcript file name, or undefined. */
export function sessionIdFromFileName(name: string): string | undefined {
  const match = /^([0-9a-fA-F-]{8,})\.jsonl$/.exec(name);
  return match?.[1];
}

/**
 * The command that continues a session in a terminal.
 *
 * Terminal-side resume is the honest option: two live processes writing one
 * transcript is not safe, so this is offered *after* an agent has exited
 * rather than as a live handover (§5.6).
 */
export function resumeCommand(sessionId: string | undefined): string {
  // `claude -c` continues the most recent session in this directory, which is
  // the right fallback when the id could not be determined but the directory
  // clearly holds sessions.
  return sessionId === undefined ? "claude -c" : `claude --resume ${sessionId}`;
}
