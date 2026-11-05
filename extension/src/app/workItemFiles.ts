/**
 * Reading what BugPilot generated in a work item's folder, never through a link (O-1).
 *
 * A work item's folder is in BugPilot's data folder (0.1.7); before that it was
 * in the repository, where a clone could commit a symbolic link at it, at the
 * folder above it, or at a file in it. A reader that followed a link would show
 * the developer, copy to the clipboard, or hand on to an agent the content of
 * another file, so a read here still goes only through the folders
 * `checkArtifactDirectory` (`sessionReset.ts`) proves are the repository's own, takes a regular file only, reaches the very file it
 * looked at (device and file index), and stops at the CLI's limit. The CLI's
 * readers follow the same rule (`bugpilot/core/safe_paths.py`, `read_generated_file`).
 *
 * Node opens nothing relative to a folder handle, so the folders are looked at by
 * path, before the open and again after it. A link already there is refused; a
 * same-account process racing those looks is outside the threat model (plan
 * §10.1), and no protection against it is claimed. Where the system has them, the
 * file is opened with `O_NOFOLLOW` and `O_NONBLOCK`, so a link swapped in at the
 * file is refused and a FIFO never blocks.
 *
 * A refusal is a `WorkItemRefusal` whose message names the file relative to the
 * repository's folder in the data folder only (`work/<id>/<name>`) — never an
 * absolute path, and never what a link points at.
 */

import { constants } from "node:fs";
import type { BigIntStats } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import type { FileHandle } from "node:fs/promises";
import path from "node:path";

import type { DirectoryListing, WorkItemFolder } from "./controller.ts";
import { checkArtifactDirectory } from "./sessionReset.ts";
import type { DeletionRefusal } from "./sessionReset.ts";

/** The most bytes read from one generated file: the CLI's limit (16 MiB). */
export const WORK_ITEM_READ_LIMIT = 16 * 1024 * 1024;

/** A read refused before anything in the file was used. */
export class WorkItemRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkItemRefusal";
  }
}

/** Bytes asked for per read. */
const CHUNK = 64 * 1024;
/** Opens the file as itself where the system can: a link there fails, and a FIFO never blocks. */
const OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

/**
 * The text of `file`, a file BugPilot generated in `item`'s folder; `undefined` when it is not there, or cannot
 * be read just now (as before). Throws `WorkItemRefusal` for a link or junction on the way or at the file, for
 * anything but a regular file, and for a file larger than `limit`.
 */
export async function readWorkItemFile(
  file: string,
  item: WorkItemFolder,
  limit: number = WORK_ITEM_READ_LIMIT,
): Promise<string | undefined> {
  const seen = await lookAtFile(file, item);
  if (seen === undefined) return undefined;
  const shown = relative(item, file);
  if (seen.size > BigInt(limit)) throw refusal(shown, tooLarge(limit));
  let handle: FileHandle;
  try {
    handle = await open(file, OPEN_FLAGS);
  } catch (error) {
    if (errorCode(error) === "ELOOP") throw refusal(shown, "it is a symbolic link or junction");
    return undefined;
  }
  let text: string;
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameFile(seen, opened)) throw refusal(shown, "it changed while it was being opened");
    text = (await readBounded(handle, limit, shown)).toString("utf8");
  } finally {
    await handle.close();
  }
  await lookAtFolder(item, path.dirname(file), shown); // again: a folder made a link since the first look is refused
  return text;
}

/**
 * Whether `file` in `item`'s folder is a regular file reached through real folders: `"file"`, or `"missing"` when
 * nothing is there; a `WorkItemRefusal` for anything else. Nothing is read.
 */
export async function workItemFileState(file: string, item: WorkItemFolder): Promise<"file" | "missing"> {
  return (await lookAtFile(file, item)) === undefined ? "missing" : "file";
}

/**
 * The regular files in `item`'s folder, `directory`, as a listing: a link or junction at the folder or above it is
 * `unreadable`, with the refusal as its detail, and an entry that is a link is not listed.
 */
export async function listWorkItemFolder(directory: string, item: WorkItemFolder): Promise<DirectoryListing> {
  const shown = relative(item, directory);
  let folder: string | undefined;
  try {
    folder = await lookAtFolder(item, directory, shown);
  } catch (error) {
    if (error instanceof WorkItemRefusal) return { kind: "unreadable", detail: error.message };
    throw error;
  }
  if (folder === undefined) return { kind: "missing" };
  let names: string[];
  try {
    names = (await readdir(folder, { withFileTypes: true })).filter((entry) => entry.isFile()).map((entry) => entry.name);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
    return { kind: "unreadable", detail: `${shown} could not be listed (${code}).` };
  }
  try {
    await lookAtFolder(item, directory, shown); // again, after the listing
  } catch (error) {
    if (error instanceof WorkItemRefusal) return { kind: "unreadable", detail: error.message };
    throw error;
  }
  return { kind: "ok", names };
}

/** The file's own look (never followed) once its folder passed; `undefined` when it, or a folder, is not there. */
async function lookAtFile(file: string, item: WorkItemFolder): Promise<BigIntStats | undefined> {
  const shown = relative(item, file);
  const name = path.basename(file);
  if (name === "" || name === "." || name === ".." || /[\\/:]/.test(name)) {
    throw refusal(shown, "it is not a file name BugPilot generates");
  }
  if ((await lookAtFolder(item, path.dirname(file), shown)) === undefined) return undefined;
  let seen: BigIntStats;
  try {
    seen = await lstat(file, { bigint: true });
  } catch {
    return undefined; // not there, or not readable just now
  }
  if (seen.isSymbolicLink()) throw refusal(shown, "it is a symbolic link or junction");
  if (!seen.isFile()) throw refusal(shown, "it is not a regular file");
  return seen;
}

/**
 * `folder`, when it is `item`'s folder and `checkArtifactDirectory` proves it the repository's own; `undefined`
 * when it is not there or cannot be examined just now; a refusal, worded for `shown`, for the rest.
 */
async function lookAtFolder(item: WorkItemFolder, folder: string, shown: string): Promise<string | undefined> {
  const check = await checkArtifactDirectory(item.base, item.workItemId);
  switch (check.kind) {
    case "missing":
    case "failed":
      return undefined;
    case "refused":
      throw refusal(shown, FOLDER_REASONS[check.reason](relative(item, folder)));
    case "ok":
      if (path.join(check.directory) !== path.join(folder)) throw refusal(shown, "it is not in this work item's folder");
      return check.directory;
  }
}

const FOLDER_REASONS: Readonly<Record<DeletionRefusal, (folder: string) => string>> = {
  link: (folder) => `${folder}, or the folder above it, is a symbolic link or junction`,
  "not-a-directory": (folder) => `${folder}, or the folder above it, is not a folder`,
  outside: (folder) => `${folder} resolves outside this repository's folder in BugPilot's data folder`,
  "invalid-id": () => "its work item id is not one BugPilot could have created",
};

/** Whether the open reached the file the look found; a file system that reports no file index proves nothing. */
function sameFile(seen: BigIntStats, opened: BigIntStats): boolean {
  if (seen.ino === 0n || opened.ino === 0n) return true;
  return seen.ino === opened.ino && seen.dev === opened.dev;
}

async function readBounded(handle: FileHandle, limit: number, shown: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  while (total <= limit) {
    const chunk = Buffer.alloc(Math.min(CHUNK, limit + 1 - total));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
    if (bytesRead === 0) break;
    chunks.push(chunk.subarray(0, bytesRead));
    total += bytesRead;
  }
  if (total > limit) throw refusal(shown, tooLarge(limit));
  return Buffer.concat(chunks, total);
}

/** A path as messages name it: relative to the repository's folder in the data folder, with forward slashes, never absolute. */
function relative(item: WorkItemFolder, file: string): string {
  return path.relative(item.base, file).split(path.sep).join("/");
}

function refusal(shown: string, reason: string): WorkItemRefusal {
  return new WorkItemRefusal(
    `BugPilot will not read ${shown}: ${reason}. It reads the files it generated only as regular files in real ` +
      "folders, never through a link, and nothing in this one was used.",
  );
}

function tooLarge(limit: number): string {
  const mib = 1024 * 1024;
  const size = limit % mib === 0 ? `${limit / mib} MiB` : `${limit} bytes`;
  return `it is larger than the ${size} BugPilot reads from one generated file`;
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException | undefined)?.code ?? "unknown";
}
