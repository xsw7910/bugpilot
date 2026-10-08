/**
 * Telling a bugpilot CLI that is too old for this extension from every other
 * failure (pre-release Batch 1, D).
 *
 * The extension and the CLI ship separately, and an older CLI passes the
 * start-up handshake (`doctor --json` has existed since the first release) and
 * then rejects the first Run, because every Run sends flags that arrived later
 * — `--replace-attachments`, `--branch-policy`. argparse rejects those with
 * exit code 2 and a usage message on stderr, and nothing on stdout, which the
 * panel used to report as "bugpilot stopped before finishing and did not say
 * why" with a Retry that could only fail the same way.
 *
 * The rule is narrow on purpose. Exit code 2 alone is any usage error — a
 * mistyped count, a bad choice — and those are this extension's bugs or the
 * developer's input, not a version mismatch. Only argparse's own two sentences
 * for "this CLI has never heard of that" count:
 *
 *     bugpilot bug: error: unrecognized arguments: --repository-profile=auto
 *     bugpilot: error: argument command: invalid choice: 'repository-profile' (…)
 *
 * This reads stderr, which `failures.ts` deliberately never does: the CLI's
 * error codes cannot describe a CLI too old to know them, so the observation is
 * made here, once, and handed on as a code of its own.
 */

/** What a finished process left behind, as far as this rule needs. */
export interface ProcessExit {
  readonly code: number | null;
  readonly stderr: string;
}

const UNRECOGNIZED_ARGUMENTS = /^[^\n]*\berror: unrecognized arguments: ([^\n]*)$/m;
const UNKNOWN_COMMAND = /^[^\n]*\berror: argument command: invalid choice: '([A-Za-z0-9_-]+)'/m;

/**
 * The flags (or the command) an out-of-date CLI rejected, or `undefined` when
 * this exit is anything else.
 *
 * Names only, never values: argparse quotes the rejected argument whole, and
 * `--description=<the bug>` is the developer's text. An empty list still means
 * "out of date" — argparse said so — it just names nothing worth showing.
 */
export function rejectedByOutdatedCli(exit: ProcessExit): readonly string[] | undefined {
  if (exit.code !== 2) return undefined;
  const flags = UNRECOGNIZED_ARGUMENTS.exec(exit.stderr);
  if (flags) {
    const names = flags[1]!
      .split(/\s+/)
      .filter((token) => /^--[A-Za-z0-9][A-Za-z0-9-]*(=|$)/.test(token))
      .map((token) => token.split("=", 1)[0]!);
    return [...new Set(names)];
  }
  const command = UNKNOWN_COMMAND.exec(exit.stderr);
  return command ? [command[1]!] : undefined;
}

export const CLI_OUTDATED_CODE = "CLI_OUTDATED";
export const CLI_NOT_FOUND_CODE = "CLI_NOT_FOUND";

export const CLI_OUTDATED_SUMMARY = "BugPilot CLI is out of date.";
export const CLI_OUTDATED_ACTION =
  "This version of the extension requires a newer BugPilot CLI. Update bugpilot, or choose a newer executable, then check the environment again.";
export const CLI_NOT_FOUND_SUMMARY = "BugPilot CLI was not found.";
export const CLI_NOT_FOUND_ACTION =
  "Install bugpilot, or set bugpilot.executablePath to the executable, then check the environment again.";

/** The Details line for an out-of-date CLI: what it did not accept, by name. */
export function outdatedCliDetail(rejected: readonly string[]): string {
  return rejected.length === 0
    ? "The installed bugpilot rejected this extension's arguments."
    : `The installed bugpilot does not accept: ${rejected.join(", ")}.`;
}

/** Whether a spawn failure means the executable is not there at all. */
export function isMissingCli(error: unknown): boolean {
  return typeof error === "object" && error !== null && (error as { code?: unknown }).code === "ENOENT";
}
