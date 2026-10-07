/**
 * What may be written to the BugPilot output channel (§37.95).
 *
 * The channel is a log a developer pastes into an issue or a chat when asking
 * for help, so it gets operational facts only: which command, which flags,
 * which work item, which agent, how it ended. Never what somebody typed or what
 * Jira said — a bug description, a title, a hint, keywords, paths they chose,
 * a custom agent command, a prompt.
 *
 * The rule is an allowlist. A flag keeps its value only when BugPilot itself
 * chose that value (a Fix Mode id, a number); every other value — including one
 * a future flag carries — is `<redacted>`. A blocklist would leak the first
 * flag nobody remembered to add to it.
 */

import { isWorkItemId } from "./form.ts";

export const REDACTED = "<redacted>";

/**
 * Flags whose values are BugPilot's own: an id from the Fix Mode registry, a
 * validated number, and the extension's scratch file for a long description
 * (its path, never its contents).
 */
const SAFE_VALUE_FLAGS: ReadonlySet<string> = new Set([
  "--fix-mode",
  "--max-files",
  "--max-search-lines",
  // A choice and a count: neither is anything the developer typed in prose.
  "--git-history-depth",
  "--git-max-commits",
  // A count, checked from 1 to 20 before it is sent (§37.113).
  "--max-similar-fixes",
  "--description-file",
]);

/** A subcommand: `bug`, `clean`, `agent-check`, `issue-details`. */
const SUBCOMMAND = /^[a-z][a-z-]*$/;

/**
 * One bugpilot invocation as the log shows it: `bugpilot bug JR-1
 * --description=<redacted> --fix-mode=standard --resume`.
 *
 * Still a command line, because that is what the channel has always promised —
 * enough to see which flags a run had and to reproduce it with your own text —
 * but every value somebody typed is replaced. A positional that is not the
 * subcommand stays only if it is a work item id.
 */
export function commandForLog(args: readonly string[]): string {
  const shown = args.map((arg, index) => {
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      if (equals === -1) return arg;
      const name = arg.slice(0, equals);
      return SAFE_VALUE_FLAGS.has(name) ? arg : `${name}=${REDACTED}`;
    }
    if (index === 0 && SUBCOMMAND.test(arg)) return arg;
    return isWorkItemId(arg) ? arg : REDACTED;
  });
  return ["bugpilot", ...shown].join(" ");
}

/** The values `commandForLog` hides, for scrubbing them out of what a process echoed back. */
export function sensitiveValues(args: readonly string[]): string[] {
  const values: string[] = [];
  args.forEach((arg, index) => {
    if (arg.startsWith("--")) {
      const equals = arg.indexOf("=");
      if (equals !== -1 && !SAFE_VALUE_FLAGS.has(arg.slice(0, equals))) values.push(arg.slice(equals + 1));
      return;
    }
    if (index === 0 && SUBCOMMAND.test(arg)) return;
    if (!isWorkItemId(arg)) values.push(arg);
  });
  return values;
}

/**
 * Text a process or an error produced, with every known sensitive value
 * replaced — argparse's "unrecognized arguments: …", a traceback quoting a
 * path, an error carrying the argv.
 *
 * Values under three characters are left alone: replacing every "a" would
 * wreck the message and protect nothing. Longest first, so a value inside
 * another is not half-replaced.
 */
export function redactKnown(text: string, values: readonly string[]): string {
  const known = [...new Set(values.map((value) => value.trim()).filter((value) => value.length >= 3))].sort(
    (a, b) => b.length - a.length,
  );
  let result = text;
  for (const value of known) result = result.split(value).join(REDACTED);
  return result;
}

/**
 * An untrusted string that failed validation — a work item id that is not one,
 * from a saved state, a stream or an input box — by its length only. Whatever it
 * was, it was not an id, and it may have been somebody's sentence.
 */
export function rejectedValueForLog(value: unknown): string {
  return typeof value === "string" ? `(${value.length} characters)` : `(${typeof value})`;
}

/** At most this many trailing lines of a process's stderr reach the log. */
const STDERR_LINES = 40;

/** The end of a process's stderr, scrubbed: where a traceback says what went wrong. */
export function stderrForLog(stderr: string, values: readonly string[]): string {
  const lines = stderr.trim().split(/\r?\n/);
  const tail = lines.length > STDERR_LINES ? [`(${lines.length - STDERR_LINES} earlier lines omitted)`, ...lines.slice(-STDERR_LINES)] : lines;
  return redactKnown(tail.join("\n"), values);
}
