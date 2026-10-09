/**
 * Whether an AI CLI accepts flags BugPilot would like to use, from the CLI's
 * own `--help`.
 *
 * For Claude CLI's resumable sessions: `--session-id <uuid>` to start the
 * handoff under an id BugPilot chose, and `--resume <id>` to continue exactly
 * that conversation after the agent exited. BugPilot does not require a
 * particular Claude version, so it asks the installed one rather than assuming
 * — an older CLI would refuse an unknown option and the handoff would not start.
 *
 * Asked once per executable and version (its path, size and modification
 * time), by argv with no shell and a timeout; the help text itself is never
 * logged. Every doubt answers false — not found as a program that starts
 * without a shell (an npm `claude.cmd` shim on Windows), a timeout, an error,
 * a flag not listed — and false only means the session is started the way it
 * always was, and started fresh rather than resumed after it exits.
 */

import path from "node:path";

export interface FlagProbeDeps {
  /** The file a command resolves to, if it can be started without a shell. */
  locate(command: string): string | undefined;
  /** What identifies this build of that file, so an upgrade is asked again. */
  identity(file: string): Promise<string>;
  /** Run it, argv only, bounded by a timeout. */
  run(file: string, args: readonly string[]): Promise<{ code: number | null; stdout: string; stderr: string; aborted: boolean }>;
  log?(message: string): void;
}

export type FlagProbe = (command: string, flags: readonly string[]) => Promise<boolean>;

export function createFlagProbe(deps: FlagProbeDeps): FlagProbe {
  const answers = new Map<string, Promise<boolean>>();
  const said = new Set<string>();
  const say = (message: string) => {
    if (said.has(message)) return;
    said.add(message);
    deps.log?.(message);
  };

  async function ask(command: string, file: string, flags: readonly string[]): Promise<boolean> {
    try {
      const result = await deps.run(file, ["--help"]);
      if (result.aborted || result.code !== 0) {
        say(`${command}: its --help did not answer${result.aborted ? " in time" : ` (exit code ${String(result.code)})`}; not using ${flags.join(", ")}.`);
        return false;
      }
      const text = `${result.stdout}\n${result.stderr}`;
      const missing = flags.filter((flag) => !listsFlag(text, flag));
      say(
        missing.length === 0
          ? `${command}: its --help lists ${flags.join(", ")}.`
          : `${command}: its --help does not list ${missing.join(", ")}; not using ${flags.join(", ")}.`,
      );
      return missing.length === 0;
    } catch (error) {
      say(`${command}: its --help could not be run (${(error as { code?: string }).code ?? "error"}); not using ${flags.join(", ")}.`);
      return false;
    }
  }

  return async (command, flags) => {
    const file = deps.locate(command);
    if (file === undefined) {
      say(`${command}: not inspected — it is not a program that starts without a shell; not using ${flags.join(", ")}.`);
      return false;
    }
    let identity: string;
    try {
      identity = await deps.identity(file);
    } catch {
      return false;
    }
    const key = `${path.resolve(file)}\u0000${identity}\u0000${flags.join(" ")}`;
    let answer = answers.get(key);
    if (answer === undefined) {
      answer = ask(command, file, flags);
      answers.set(key, answer);
    }
    return answer;
  };
}

/** The flag as its own word in the help text: `--resume`, not `--resume-session` or `--no-resume`. */
function listsFlag(text: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[\\s,])${escaped}(?=$|[\\s,=<\\[])`, "m").test(text);
}
