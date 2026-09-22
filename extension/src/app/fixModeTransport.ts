/**
 * Getting a Fix Mode definition to the CLI without putting it on a command line.
 *
 * Six multiline sections do not belong in argv: a command line has a length
 * limit, and quoting rules that differ per shell and per platform. Worse, text
 * on a command line is text something might interpret — a mode's constraints
 * are the developer's prose, and prose with a backtick in it is not a thing to
 * hand to a shell. So the definition goes to a file and only its path is
 * passed.
 *
 * Node-only: no `vscode` import, so the file's whole lifecycle is testable.
 */

import { rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import type { FixModeRequest } from "./controller.ts";
import type { Envelope } from "../protocol.ts";

/**
 * Run one Fix Mode management command, with its definition in a file.
 *
 * The payload never rides on the command line. Six multiline sections would hit
 * a length limit and, worse, would be text a shell could read: written to a
 * file and named by path, a mode's constraints are data whatever they contain.
 * The file is temporary, outside the repository so it cannot be committed by
 * accident, uniquely named so two saves cannot collide, and removed whether the
 * command succeeded or failed.
 */
export async function runFixModeCommand(
  runJson: (args: readonly string[]) => Promise<Envelope>,
  request: FixModeRequest,
): Promise<Envelope> {
  if (request.payload === undefined) return runJson(request.args(""));
  const file = path.join(
    tmpdir(),
    `bugpilot-fix-mode-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.json`,
  );
  await writeFile(file, `${JSON.stringify(request.payload, null, 2)}\n`, "utf8");
  try {
    return await runJson(request.args(file));
  } finally {
    // Cleanup on both paths: a failed save leaves nothing behind either.
    await rm(file, { force: true }).catch(() => {});
  }
}

/**
 * The Fix Mode management port, refusing to run without a repository.
 *
 * Every other Fix Mode call already declines when there is no workspace root;
 * this one used to fall back to the process's own directory, which for an
 * extension host is somewhere the developer never chose — and `--scope project`
 * would then create `.bugpilot/` in it. A command that cannot name its target
 * repository is a command not worth running.
 */
export function fixModeCommandPort(
  root: () => string | undefined,
  runJson: (args: readonly string[], cwd: string) => Promise<Envelope>,
): (request: FixModeRequest) => Promise<Envelope> {
  return async (request) => {
    const cwd = root();
    if (!cwd) {
      return {
        ok: false,
        command: "fix-mode",
        error: {
          code: "INVALID_INPUT",
          message: "No workspace repository is available for Fix Mode management.",
        },
      };
    }
    return runFixModeCommand((args) => runJson(args, cwd), request);
  };
}
