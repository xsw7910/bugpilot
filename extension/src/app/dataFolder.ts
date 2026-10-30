/**
 * Where a repository's BugPilot files are: its folder in BugPilot's data folder (0.1.7).
 *
 * The CLI keeps a repository's work items, bug memory and settings in
 * `<data folder>/repositories/<repository id>/` — `work/<work item>/`,
 * `memory/<work item>.md`, `settings/<name>` — and never in the repository.
 * It is the only one that resolves that folder: `doctor --json` reports it as
 * `storage.repository_dir`, and this extension takes it from there. It never
 * computes the data folder or the repository id itself, never reads `HOME` or
 * `BUGPILOT_HOME` for them, and never falls back to a repository's `.ai/` or
 * `.bugpilot/`, which belong to BugPilot 0.1.6 and earlier and are not read.
 *
 * Below that folder it composes only two kinds of path, from fixed names and a
 * validated work item id; every read still goes through the link checks of
 * `workItemFiles.ts` and `sessionReset.ts`, with this folder as their base.
 *
 * Node-only: no `vscode` import.
 */

import path from "node:path";

import { isWorkItemId } from "./form.ts";

/** What `doctor --json` lists when its CLI keeps a repository's files in BugPilot's data folder. */
export const UNIFIED_STORAGE_CAPABILITY = "unified-storage";

/** The folder of a repository's work items, below its folder in the data folder. */
export const WORK_FOLDER = "work";
/** The folder of a repository's settings (Verification Policy, AI Behavior, …). */
export const SETTINGS_FOLDER = "settings";

export type RepositoryDirectory =
  | { readonly kind: "ok"; readonly directory: string }
  /** Storage refused this repository, or reported no folder: `problem` is the CLI's sentence. */
  | { readonly kind: "refused"; readonly problem: string };

/**
 * The repository's folder from a `doctor --json` report: `storage.repository_dir`, an absolute path, unless
 * storage refused it (a data folder inside the repository or a Git working tree, a link on the way, a record
 * naming another repository). Anything else is refused too: a folder this extension cannot trust is not used.
 */
export function repositoryDirectoryOf(report: Record<string, unknown> | undefined): RepositoryDirectory {
  const storage = report?.["storage"];
  const record = typeof storage === "object" && storage !== null && !Array.isArray(storage) ? (storage as Record<string, unknown>) : undefined;
  const problem = typeof record?.["problem"] === "string" && record["problem"].trim() !== "" ? record["problem"].trim() : undefined;
  if (record?.["state"] === "refused") {
    return { kind: "refused", problem: problem ?? "BugPilot's data folder cannot be used for this repository." };
  }
  const directory = record?.["repository_dir"];
  if (typeof directory !== "string" || directory === "" || !path.isAbsolute(directory)) {
    return { kind: "refused", problem: problem ?? "bugpilot did not say where this repository's files are." };
  }
  return { kind: "ok", directory };
}

/**
 * Whether a work item's folder may be given to an agent: the CLI's own answer, `doctor --json`'s
 * `storage.privacy` (0.1.7, S-2). Only `private` is a yes; anything else — `not-private`, `unverifiable`, a
 * report without the field — is a no, with the CLI's sentence when it gave one.
 */
export type WorkFolderPrivacy = { readonly private: true } | { readonly private: false; readonly problem: string };

export function workFolderPrivacyOf(report: Record<string, unknown> | undefined): WorkFolderPrivacy {
  const storage = report?.["storage"];
  const record = typeof storage === "object" && storage !== null && !Array.isArray(storage) ? (storage as Record<string, unknown>) : undefined;
  if (record?.["privacy"] === "private") return { private: true };
  const problem = record?.["privacy_problem"];
  return {
    private: false,
    problem:
      typeof problem === "string" && problem.trim() !== ""
        ? problem.trim()
        : "bugpilot did not say whether BugPilot's data folder is private to you.",
  };
}

/** `<repository folder>/work/<id>`, for a validated work item id only; `undefined` for anything else. */
export function workItemDirectory(repositoryDir: string, workItemId: string): string | undefined {
  return isWorkItemId(workItemId) ? path.join(repositoryDir, WORK_FOLDER, workItemId) : undefined;
}

/** `<repository folder>/settings/<name>`: one of the repository's settings files, by its fixed name. */
export function settingsFile(repositoryDir: string, name: string): string {
  return path.join(repositoryDir, SETTINGS_FOLDER, name);
}

/**
 * A path as an agent instruction names it: absolute, with forward slashes on every system — what
 * `prompt_path()` in `bugpilot/core/config.py` renders, so the handoff here and the CLI's say the same thing.
 */
export function promptPath(file: string): string {
  return file.replaceAll("\\", "/");
}
