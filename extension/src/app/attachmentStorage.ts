/**
 * Garbage collection for pasted and dropped attachments (§37.100).
 *
 * The host keeps each one at `globalStorage/attachments/<digest>/<name>`
 * (`createAttachmentStore`). Nothing ever removed them, so they accumulated.
 * This removes a stored file only when every one of these holds:
 *
 *  1. it is a regular file directly inside `attachments/<16 hex>/`, under the
 *     storage root, with no link anywhere on the way;
 *  2. no form in any workspace references it — the current form, and every
 *     workspace's recorded references (global storage is shared by all
 *     workspaces; each workspace's form is not);
 *  3. it is older than `ATTACHMENT_GC_RETENTION_DAYS`, by its own mtime — which
 *     a second paste of the same content refreshes, and which also covers a
 *     settings draft that was never applied and so is recorded nowhere — and
 *     reference tracking has been running for at least that long too.
 *
 * The last part is the migration (§37.101). Forms saved before references were
 * recorded are recorded only when their workspace is next opened, and no window
 * can list the workspaces that have not been. So the first start-up writes when
 * tracking began (`bugpilot.attachmentGcVersion`), and a blob's age is counted
 * from whichever is later, its mtime or that moment: a blob from before
 * tracking gets one full retention period of grace, every workspace a month to
 * be opened and say what it references; a blob written after ages as normal.
 *
 * Anything else in the folder is left exactly where it is. Every failure costs
 * that one entry and nothing else; nothing here throws.
 */

import { lstat, readdir, realpath, rmdir, unlink } from "node:fs/promises";
import path from "node:path";

/** How long an unreferenced blob is kept before it may be collected. */
export const ATTACHMENT_GC_RETENTION_DAYS = 30;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The digest directory's name: `attachmentDigest`'s 16 hex characters. */
const DIGEST_DIRECTORY = /^[0-9a-f]{16}$/;

const ATTACHMENTS_DIRECTORY = "attachments";

/**
 * When reference tracking began, in the shared global state: `{ version,
 * trackingSince }`. A version this build does not know turns collection off,
 * like an artifact with an unknown `schema_version` (§37.101).
 */
const GC_STATE_KEY = "bugpilot.attachmentGcVersion";
export const ATTACHMENT_GC_VERSION = 1;

/** Where a workspace's references are recorded in the shared global state. */
const REFERENCES_PREFIX = "bugpilot.attachmentReferences.";

/** The file-system calls the collector makes, injectable for a test that needs one to fail. */
export interface GcFileSystem {
  lstat: typeof lstat;
  readdir: typeof readdir;
  realpath: typeof realpath;
  rmdir: typeof rmdir;
  unlink: typeof unlink;
}

const NODE_FS: GcFileSystem = { lstat, readdir, realpath, rmdir, unlink };

/** VS Code's `Memento`, as much of it as the registry uses — so this file needs no `vscode`. */
export interface ReferenceMemento {
  keys(): readonly string[];
  get(key: string): unknown;
  update(key: string, value: unknown): PromiseLike<void>;
}

export interface GcReport {
  /** Stored files looked at. */
  readonly scanned: number;
  readonly removed: number;
  /** Referenced, or younger than the retention period. */
  readonly kept: number;
  /** Could not be read or deleted: locked, gone, denied. */
  readonly skipped: number;
  /** Not BugPilot's layout — another name, a link, a folder — and left alone. */
  readonly unexpected: number;
}

const EMPTY_REPORT: GcReport = { scanned: 0, removed: 0, kept: 0, skipped: 0, unexpected: 0 };

function sameCase(text: string, caseInsensitive: boolean): string {
  return caseInsensitive ? text.toLowerCase() : text;
}

/**
 * A stored attachment's identity: `<digest>/<name>` for a path directly inside
 * `<storageRoot>/attachments/<digest>/`, and `undefined` for any other path — a
 * file picked from disk, which is not ours to keep or collect.
 */
export function attachmentReferenceKey(
  storageRoot: string,
  file: string,
  caseInsensitive = process.platform === "win32",
): string | undefined {
  const pathApi = caseInsensitive ? path.win32 : path;
  const relative = pathApi.relative(pathApi.join(storageRoot, ATTACHMENTS_DIRECTORY), file);
  if (relative === "" || relative.startsWith("..") || pathApi.isAbsolute(relative)) return undefined;
  const parts = relative.split(/[\\/]/);
  if (parts.length !== 2) return undefined;
  const [digest, name] = parts as [string, string];
  if (!DIGEST_DIRECTORY.test(digest) || name === "" || name === "." || name === "..") return undefined;
  return sameCase(`${digest}/${name}`, caseInsensitive);
}

/** Every stored attachment the lists reference, as keys. */
export function referencedAttachmentKeys(
  storageRoot: string,
  lists: Iterable<readonly string[]>,
  caseInsensitive = process.platform === "win32",
): Set<string> {
  const keys = new Set<string>();
  for (const list of lists) {
    for (const file of list) {
      const key = attachmentReferenceKey(storageRoot, file, caseInsensitive);
      if (key !== undefined) keys.add(key);
    }
  }
  return keys;
}

/**
 * Which stored attachments each workspace's form references, kept in the
 * global state every workspace shares — one key per workspace, so two windows
 * never overwrite each other's list.
 *
 * A workspace that is never opened again keeps its entry, and so keeps its
 * blobs: collecting them would need to know it is gone, and nothing does.
 */
export class AttachmentReferenceRegistry {
  readonly #memento: ReferenceMemento;
  readonly #key: string;
  readonly #storageRoot: string;
  #last: string | undefined;

  constructor(memento: ReferenceMemento, workspaceId: string, storageRoot: string) {
    this.#memento = memento;
    this.#key = `${REFERENCES_PREFIX}${workspaceId}`;
    this.#storageRoot = storageRoot;
  }

  /** Record what this workspace's form references now; written only when it changed. */
  record(attachments: readonly string[]): void {
    const keys = [...referencedAttachmentKeys(this.#storageRoot, [attachments])].sort();
    const serialized = JSON.stringify(keys);
    if (this.#last === undefined) this.#last = this.#stored();
    if (serialized === this.#last) return;
    // Best effort, and never a throw into the save or the activation that
    // called it: a record that failed to write is retried on the next change.
    try {
      void Promise.resolve(this.#memento.update(this.#key, keys.length > 0 ? keys : undefined)).then(
        () => {},
        () => {
          if (this.#last === serialized) this.#last = undefined;
        },
      );
      this.#last = serialized;
    } catch {
      this.#last = undefined;
    }
  }

  /** What an earlier session recorded for this workspace, so a restart rewrites nothing. */
  #stored(): string | undefined {
    try {
      const value = this.#memento.get(this.#key);
      if (value === undefined) return "[]";
      return Array.isArray(value) && value.every((entry) => typeof entry === "string") ? JSON.stringify([...value].sort()) : undefined;
    } catch {
      return undefined;
    }
  }

  /** Every workspace's references, this one's `current` form included. */
  referenced(current: readonly string[]): Set<string> {
    const keys = referencedAttachmentKeys(this.#storageRoot, [current]);
    for (const key of this.#memento.keys()) {
      if (!key.startsWith(REFERENCES_PREFIX)) continue;
      const value = this.#memento.get(key);
      if (!Array.isArray(value)) continue;
      for (const entry of value) if (typeof entry === "string") keys.add(entry);
    }
    return keys;
  }
}

/**
 * Remove old, unreferenced stored attachments; report what happened.
 *
 * Walks exactly `attachments/<digest>/<file>` — no deeper, and nowhere a link
 * leads. A digest folder left empty is removed too; the `attachments` folder
 * itself never is.
 */
export async function collectAttachmentGarbage(options: {
  readonly storageRoot: string;
  readonly referenced: ReadonlySet<string>;
  readonly now: number;
  /** When reference tracking began: no blob is older than that, for this rule. */
  readonly trackingSince?: number;
  readonly retentionMs?: number;
  readonly caseInsensitive?: boolean;
  readonly fs?: GcFileSystem;
}): Promise<GcReport> {
  const fs = options.fs ?? NODE_FS;
  const caseInsensitive = options.caseInsensitive ?? process.platform === "win32";
  const retentionMs = options.retentionMs ?? ATTACHMENT_GC_RETENTION_DAYS * DAY_MS;
  const root = path.join(options.storageRoot, ATTACHMENTS_DIRECTORY);
  const report = { ...EMPTY_REPORT };

  // The folder itself: a real directory, and the storage root's own child — not
  // a link or junction that would take every deletion below somewhere else.
  // (The storage root's ancestors are VS Code's business, so they are resolved
  // on both sides rather than required to be links-free.)
  try {
    const stat = await fs.lstat(root);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return { ...report, unexpected: 1 };
    const [resolved, resolvedStorage] = await Promise.all([fs.realpath(root), fs.realpath(options.storageRoot)]);
    if (sameCase(path.resolve(resolved), caseInsensitive) !== sameCase(path.join(path.resolve(resolvedStorage), ATTACHMENTS_DIRECTORY), caseInsensitive)) {
      return { ...report, unexpected: 1 };
    }
  } catch (error) {
    // No folder yet is the normal state: nothing was ever pasted or dropped.
    if ((error as { code?: string }).code === "ENOENT") return report;
    return { ...report, skipped: 1 };
  }

  let digests;
  try {
    digests = await fs.readdir(root, { withFileTypes: true });
  } catch {
    return { ...report, skipped: 1 };
  }

  for (const digest of digests) {
    if (!DIGEST_DIRECTORY.test(digest.name)) {
      report.unexpected += 1;
      continue;
    }
    const directory = path.join(root, digest.name);
    let entries;
    try {
      const stat = await fs.lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        report.unexpected += 1;
        continue;
      }
      entries = await fs.readdir(directory, { withFileTypes: true });
    } catch {
      report.skipped += 1;
      continue;
    }
    let remaining = entries.length;
    for (const entry of entries) {
      const file = path.join(directory, entry.name);
      let stat;
      try {
        stat = await fs.lstat(file);
      } catch {
        report.skipped += 1;
        continue;
      }
      if (!stat.isFile()) {
        // A folder or a link inside a digest folder is not something BugPilot wrote.
        report.unexpected += 1;
        continue;
      }
      report.scanned += 1;
      if (options.referenced.has(sameCase(`${digest.name}/${entry.name}`, caseInsensitive))) {
        report.kept += 1;
        continue;
      }
      // Counted from when tracking began if the blob is older: one grace
      // period for a blob a not-yet-reopened workspace may still reference.
      if (options.now - Math.max(stat.mtimeMs, options.trackingSince ?? stat.mtimeMs) < retentionMs) {
        report.kept += 1;
        continue;
      }
      try {
        // Looked at again just before: a paste of the same content since the
        // first look rewrote the file, and it is in someone's draft now.
        const again = await fs.lstat(file);
        if (!again.isFile() || again.mtimeMs !== stat.mtimeMs) {
          report.kept += 1;
          continue;
        }
        await fs.unlink(file);
        report.removed += 1;
        remaining -= 1;
      } catch {
        report.skipped += 1;
      }
    }
    if (remaining === 0) {
      // rmdir, not a recursive delete: it only succeeds on an empty folder.
      await fs.rmdir(directory).catch(() => {});
    }
  }
  return report;
}

/** The one log line a collection leaves: counts only — no name, no digest, no path. */
export function describeGc(report: GcReport): string {
  const parts = [`Attachment GC scanned ${report.scanned} blob${report.scanned === 1 ? "" : "s"}; removed ${report.removed}; kept ${report.kept}`];
  if (report.skipped > 0) parts.push(`skipped ${report.skipped} unreadable or locked`);
  if (report.unexpected > 0) parts.push(`left ${report.unexpected} unexpected entr${report.unexpected === 1 ? "y" : "ies"} alone`);
  return `${parts.join("; ")}.`;
}

interface GcLog {
  info(message: string): void;
  error(message: string): void;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * When reference tracking began — written now if no build has written it, so
 * the first start-up after the upgrade begins the migration grace period.
 *
 * At activation, not in the deferred pass: a window closed within seconds has
 * still started the clock. Never rejects. `undefined` means do not collect this
 * session: the state is a newer version's, or could not be written (then the
 * next start-up writes a later time, which only lengthens the grace). An
 * unreadable value is replaced the same way — the grace starts over, never
 * shortens. Saved forms are never read or rewritten here.
 */
export async function initializeAttachmentGc(memento: ReferenceMemento, now: number, log: GcLog): Promise<number | undefined> {
  try {
    const state = memento.get(GC_STATE_KEY);
    if (isRecord(state) && typeof state["version"] === "number" && state["version"] > ATTACHMENT_GC_VERSION) {
      log.info("Attachment GC is off: its state was written by a newer BugPilot.");
      return undefined;
    }
    if (
      isRecord(state) &&
      state["version"] === ATTACHMENT_GC_VERSION &&
      typeof state["trackingSince"] === "number" &&
      Number.isFinite(state["trackingSince"])
    ) {
      return state["trackingSince"];
    }
    await memento.update(GC_STATE_KEY, { version: ATTACHMENT_GC_VERSION, trackingSince: now });
    log.info(`Attachment GC started tracking references; stored attachments are kept at least ${ATTACHMENT_GC_RETENTION_DAYS} days from now.`);
    return now;
  } catch (error) {
    log.error(`Attachment GC state could not be saved (${(error as { code?: string }).code ?? "error"}); nothing is collected this session.`);
    return undefined;
  }
}

/**
 * One background collection: never throws, and says one line either way.
 * What it may not remove is decided before it looks at the disk.
 */
export async function runAttachmentGc(options: {
  readonly storageRoot: string;
  readonly registry: AttachmentReferenceRegistry;
  readonly current: readonly string[];
  /** From `initializeAttachmentGc`; `undefined` collects nothing. */
  readonly trackingSince: number | undefined;
  readonly log: GcLog;
  readonly now?: number;
  readonly fs?: GcFileSystem;
}): Promise<GcReport | undefined> {
  if (options.trackingSince === undefined) return undefined;
  try {
    const report = await collectAttachmentGarbage({
      storageRoot: options.storageRoot,
      referenced: options.registry.referenced(options.current),
      now: options.now ?? Date.now(),
      trackingSince: options.trackingSince,
      ...(options.fs ? { fs: options.fs } : {}),
    });
    if (report.scanned > 0 || report.skipped > 0 || report.unexpected > 0) options.log.info(describeGc(report));
    return report;
  } catch (error) {
    options.log.error(`Attachment GC did not run (${(error as { code?: string }).code ?? "error"}).`);
    return undefined;
  }
}
