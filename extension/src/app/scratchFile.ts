/**
 * A file that exists for one command and is gone after it (0.1.5, plan §44.6 S4: F10, F11).
 *
 * The extension hands the CLI two kinds of input in a file rather than on a
 * command line: a Fix Mode, review or verification payload (in the system's
 * temporary folder), and a description too long for a command line (in the
 * extension's global storage). Both are someone's prose, and both used to be
 * written with a plain create that would write into a file — or through a link
 * — already at the name, and the description's name was one fixed file every
 * window shared and nobody removed.
 *
 * Here a scratch file is:
 *
 * - **named so nobody can predict it** — a random UUID — so nothing can be
 *   planted at its name first;
 * - **created new** (`wx`: exclusive create), so a file or link that is there
 *   anyway is an error, never something written into or through. Windows'
 *   exclusive create follows a *dangling* link and creates its target (observed,
 *   0.1.5 Batch 4), so anything at the name is refused first, and the file
 *   opened is checked to be the one at its name before a byte is written;
 * - **owner-only** (`0600` on POSIX) from its creation;
 * - **removed after its command**, by the caller, whatever the outcome.
 *
 * Node-only: no `vscode` import, so the whole lifecycle is testable on the real
 * file system.
 */

import { randomUUID } from "node:crypto";
import { lstat, mkdir, open, rm } from "node:fs/promises";
import path from "node:path";

/** `<prefix>-<random UUID><extension>`: a name nobody can predict. */
export function scratchFileName(prefix: string, extension: string): string {
  return `${prefix}-${randomUUID()}${extension}`;
}

function taken(file: string): Error {
  return Object.assign(new Error(`EEXIST: something is already at ${path.basename(file)}, so nothing was written`), {
    code: "EEXIST",
  });
}

/** Whether anything — a file, a folder, a link, a dangling link — is at `file`. */
async function exists(file: string): Promise<boolean> {
  try {
    await lstat(file);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/** Create `file` new, owner-only, and write `contents` into it; a name already taken is an error. */
export async function writeScratchFile(file: string, contents: string): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  if (await exists(file)) throw taken(file);
  const handle = await open(file, "wx", 0o600);
  let written = false;
  try {
    const [opened, named] = await Promise.all([handle.stat({ bigint: true }), lstat(file, { bigint: true })]);
    if (named.isSymbolicLink() || opened.ino !== named.ino || opened.dev !== named.dev) throw taken(file);
    await handle.writeFile(contents, "utf8");
    written = true;
  } finally {
    await handle.close();
    // A link made at the name in the instant before the create: the name goes (a link is removed as a link);
    // the empty file Windows created where it pointed is not BugPilot's to touch.
    if (!written) await rm(file, { force: true }).catch(() => {});
  }
}

/** Remove a scratch file: a link is removed as a link, never followed; one already gone is not an error. */
export async function removeScratchFile(file: string): Promise<void> {
  await rm(file, { force: true });
}
