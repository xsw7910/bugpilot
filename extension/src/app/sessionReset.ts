/**
 * Reset Session (§37.103): the current BugPilot session back to a fresh
 * first-use state.
 *
 * A session is what the panel is working on now: the issue, everything typed
 * or applied about it, and the work item a run bound it to. Reset Session puts
 * all of that back to the product defaults and detaches the panel from the work
 * item. It is not Clear History, not a reset of the extension's preferences, and
 * never a deletion of repository files. The controller owns the operation
 * (`Controller.resetSession`); this module holds the parts of it that are rules
 * rather than state:
 *
 *  - which `FormState` fields are the session's and which are the developer's
 *    standing preferences (`FORM_FIELD_SCOPE`), and the fresh form built from
 *    that (`resetSessionForm`);
 *  - the dialog's wording, one copy, which the markup renders and tests read;
 *  - deleting the current work item's generated files, when asked to
 *    (`deleteWorkItemArtifacts`): only `.ai/<work item>/`, only when it is a
 *    real directory inside the repository's own `.ai/`, and through the CLI's
 *    `clean` — the one delete BugPilot already has for that folder.
 */

import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { DEFAULT_FORM, isWorkItemId } from "./form.ts";
import type { FormState } from "./form.ts";

export interface ResetSessionOptions {
  /** Also delete the current work item's generated files. Never the default. */
  readonly deleteGeneratedFiles: boolean;
}

/**
 * What each form field is to Reset Session.
 *
 * `session`: about the issue on screen or how this run prepares it — the issue,
 * the hint, the shared Keywords and Focus Files, attachments, the workflow
 * steps, every Code Search, Git History and Similar Fixes setting, Fix Mode,
 * Fresh — back to its default.
 * `preference`: the developer's standing choice of AI agent and its custom
 * command, which says nothing about this issue and is kept.
 *
 * A `Record` over `keyof FormState`, so a field added to the form without being
 * classified here fails to compile — the decision cannot be skipped.
 * `useIssueDetails` is the session's: it sits beside the Hint it gates and ships
 * ticked, and a fresh session shows it ticked.
 */
export const FORM_FIELD_SCOPE: Readonly<Record<keyof FormState, "session" | "preference">> = {
  source: "session",
  issueKey: "session",
  title: "session",
  description: "session",
  hint: "session",
  useIssueDetails: "session",
  keywords: "session",
  focusFiles: "session",
  ignorePaths: "session",
  maxFiles: "session",
  maxSearchLines: "session",
  attachments: "session",
  attachmentDescriptions: "session",
  fixModeId: "session",
  plan: "session",
  fixWithAI: "session",
  agent: "preference",
  agentCommand: "preference",
  gitUseSharedKeywords: "session",
  gitUseSharedFocusFiles: "session",
  gitKeywords: "session",
  gitFiles: "session",
  gitSearchMessages: "session",
  gitSearchFileHistory: "session",
  gitHistoryDepth: "session",
  gitMaxCommits: "session",
  similarUseSharedKeywords: "session",
  similarKeywords: "session",
  similarMaxFixes: "session",
  fresh: "session",
};

/**
 * The form a reset session starts from: `DEFAULT_FORM`, with the preferences
 * carried over and Fix Mode at the catalog's default (`selectedFixModeId` of
 * nothing) — Standard Fix — rather than `DEFAULT_FORM`'s empty "not read yet".
 */
export function resetSessionForm(form: FormState, defaultFixModeId: string): FormState {
  const fresh: Record<string, unknown> = { ...DEFAULT_FORM, fixModeId: defaultFixModeId };
  for (const [field, scope] of Object.entries(FORM_FIELD_SCOPE)) {
    if (scope === "preference") fresh[field] = form[field as keyof FormState];
  }
  return fresh as unknown as FormState;
}

// --- the dialog's words ------------------------------------------------------

export const RESET_SESSION_LABEL = "Reset Session";
export const RESET_SESSION_TOOLTIP = "Start a fresh session: clear the issue, its settings and the prepared context";
export const RESET_AND_DELETE_LABEL = "Reset and Delete";
export const RESET_DIALOG_TITLE = "Reset BugPilot Session?";
export const RESET_DIALOG_BODY = "Reset the current issue, workflow settings, and prepared context.";
export const GENERATED_FILES_LEGEND = "Generated files";
export const KEEP_FILES_LABEL = "Keep generated files";
export const DELETE_FILES_LABEL = "Delete generated files";
export const KEEP_FILES_HELPER = "History will be kept.";
export const DELETE_FILES_HELPER =
  "The current generated context and artifacts will be permanently deleted. Repository source files will not be deleted.";
/**
 * History lists the work item folders under `.ai/`, so deleting this one's
 * removes its row. Said, rather than discovered afterwards.
 */
export const DELETE_FILES_HISTORY = "This work item will no longer appear in History; other History entries are kept.";
export const NO_FILES_TO_DELETE = "This session has no generated files yet.";
/** The confirm button while the host works. */
export const RESETTING_LABEL = "Resetting…";

/** What Reset Session will stop, or leave running, said before it is pressed. */
export const RESET_STOPS_RUN = "The current BugPilot run will be stopped.";
export const RESET_CANCELS_REVIEW = "The AI review BugPilot is running will be cancelled.";
export const RESET_LEAVES_AGENT =
  "An AI agent BugPilot handed this work item to keeps running in its own terminal or view; Reset Session cannot stop it.";

/** What a reset came to, as a notification. */
export const SESSION_RESET = "Session reset.";
export const SESSION_RESET_DELETED = "Session reset. Generated files deleted.";
export const SESSION_RESET_NOTHING_TO_DELETE = "Session reset. There were no generated files to delete.";

// --- deleting the generated files --------------------------------------------

/** Why a deletion was refused before anything was deleted. */
export type DeletionRefusal = "invalid-id" | "link" | "not-a-directory" | "outside";

export type ArtifactDeletion =
  | { readonly kind: "deleted" }
  /** There was no `.ai/<work item>/` to delete. */
  | { readonly kind: "missing" }
  /** Not deleted: the folder is not one BugPilot can prove is its own. Nothing was touched. */
  | { readonly kind: "refused"; readonly reason: DeletionRefusal }
  /**
   * The delete ran and did not finish: `reason` is a safe error type (an exit
   * code, an errno code), never a path. Some files may be gone.
   */
  | { readonly kind: "failed"; readonly reason: string };

/** The two file-system calls the check makes, injectable for a test that needs one to fail. */
export interface DeletionFileSystem {
  readonly lstat: typeof lstat;
  readonly realpath: typeof realpath;
}

const NODE_FS: DeletionFileSystem = { lstat, realpath };

/** The artifacts folder, as `#itemFile` and the CLI name it. */
const ARTIFACT_ROOT = ".ai";

type DirectoryCheck =
  | { readonly kind: "ok"; readonly directory: string }
  | { readonly kind: "missing" }
  | { readonly kind: "refused"; readonly reason: DeletionRefusal }
  | { readonly kind: "failed"; readonly reason: string };

/**
 * Whether `<root>/.ai/<work item>/` is a folder BugPilot may delete: the id is
 * one BugPilot could have created (`isWorkItemId`, shared with the CLI), and
 * both `.ai` and the work item folder are real directories — not a symbolic
 * link, not a junction — whose resolved path is the repository's own
 * `.ai/<work item>`. The attachment collector's rule (§37.100), applied to the
 * artifacts folder: a link anywhere on the way could take a delete somewhere
 * else, so it is refused rather than followed.
 */
export async function checkArtifactDirectory(
  root: string,
  workItemId: string,
  fs: DeletionFileSystem = NODE_FS,
  caseInsensitive = process.platform === "win32",
): Promise<DirectoryCheck> {
  if (!isWorkItemId(workItemId)) return { kind: "refused", reason: "invalid-id" };
  const artifacts = path.join(root, ARTIFACT_ROOT);
  const directory = path.join(artifacts, workItemId);
  for (const entry of [artifacts, directory]) {
    let stat;
    try {
      stat = await fs.lstat(entry);
    } catch (error) {
      const code = errorCode(error);
      if (code === "ENOENT") return { kind: "missing" };
      return { kind: "failed", reason: code };
    }
    if (stat.isSymbolicLink()) return { kind: "refused", reason: "link" };
    if (!stat.isDirectory()) return { kind: "refused", reason: "not-a-directory" };
  }
  // Belt and braces: a reparse point `lstat` does not report as a link still
  // resolves somewhere else, and that is what is compared.
  let resolved: string;
  let resolvedRoot: string;
  try {
    [resolved, resolvedRoot] = await Promise.all([fs.realpath(directory), fs.realpath(root)]);
  } catch (error) {
    return { kind: "failed", reason: errorCode(error) };
  }
  const expected = path.join(path.resolve(resolvedRoot), ARTIFACT_ROOT, workItemId);
  if (sameCase(path.resolve(resolved), caseInsensitive) !== sameCase(expected, caseInsensitive)) {
    return { kind: "refused", reason: "outside" };
  }
  return { kind: "ok", directory };
}

/**
 * Delete the work item's generated files: check, then the CLI's `clean`, then
 * look again.
 *
 * `clean` is `bugpilot clean <work item>` — the Clean command's delete, which
 * removes `.ai/<work item>/` and nothing else (its memory entry is kept), and
 * does not follow a link inside it. It runs only after the check passed. The
 * folder is looked at afterwards: success is the folder being gone, never an
 * exit code alone, and a delete that stopped half-way says so.
 */
export async function deleteWorkItemArtifacts(options: {
  readonly root: string;
  readonly workItemId: string;
  readonly clean: () => Promise<{ readonly code: number | null; readonly aborted?: boolean }>;
  readonly fs?: DeletionFileSystem;
  readonly caseInsensitive?: boolean;
}): Promise<ArtifactDeletion> {
  const fs = options.fs ?? NODE_FS;
  const check = await checkArtifactDirectory(options.root, options.workItemId, fs, options.caseInsensitive);
  if (check.kind !== "ok") return check;

  let exit: string | undefined;
  try {
    const result = await options.clean();
    if (result.aborted) exit = "timeout";
    else if (result.code !== 0) exit = `exit-${result.code ?? "none"}`;
  } catch (error) {
    // Never started, or broke on the way: the folder is looked at all the same.
    exit = `spawn-${errorCode(error)}`;
  }
  try {
    await fs.lstat(check.directory);
  } catch (error) {
    const code = errorCode(error);
    if (code === "ENOENT") return exit === undefined ? { kind: "deleted" } : { kind: "failed", reason: exit };
    return { kind: "failed", reason: exit ?? code };
  }
  return { kind: "failed", reason: exit ?? "still-present" };
}

/**
 * Why Reset Session stopped before resetting anything, for the dialog. Nothing
 * here names a path beyond the work item's own folder, which the panel already
 * shows.
 */
export function deletionProblem(deletion: Exclude<ArtifactDeletion, { kind: "deleted" | "missing" }>, workItemId: string): string {
  const folder = `.ai/${workItemId}/`;
  if (deletion.kind === "refused") {
    switch (deletion.reason) {
      case "invalid-id":
        return "Session not reset: this work item's id is not one BugPilot could have created, so nothing was deleted.";
      case "link":
        return `Session not reset: ${folder} or .ai/ is a link or junction, and BugPilot does not delete through one. Nothing was deleted.`;
      case "not-a-directory":
        return `Session not reset: ${folder} is not a folder BugPilot created. Nothing was deleted.`;
      case "outside":
        return `Session not reset: ${folder} resolves outside this repository's .ai/ folder. Nothing was deleted.`;
    }
  }
  return `Session not reset: the generated files in ${folder} could not all be deleted. Some may already be gone — Current, in Results, shows what is left. Close any file open from that folder and try again, or keep the files.`;
}

function errorCode(error: unknown): string {
  const code = (error as { code?: unknown } | undefined)?.code;
  return typeof code === "string" && /^[A-Z0-9_]{1,32}$/.test(code) ? code : "error";
}

function sameCase(text: string, caseInsensitive: boolean): string {
  return caseInsensitive ? text.toLowerCase() : text;
}
