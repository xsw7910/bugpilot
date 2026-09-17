/**
 * Deciding which repository bugpilot should operate on.
 *
 * This matters more than it looks. bugpilot writes `.ai/<work_item>/` into the
 * directory it is run from, so picking the wrong root scatters artifacts into
 * the wrong checkout. The same reasoning drove the MCP server to bind its root
 * at startup instead of taking it as a tool argument (§5.2).
 *
 * `vscode` is not imported: the two things needed from it — the open folders and
 * a directory-exists probe — arrive as a narrow interface, so this is testable
 * with plain objects.
 */

import path from "node:path";

/** The shape of `vscode.workspace.workspaceFolders[n]` that matters here. */
export interface Folder {
  readonly name: string;
  readonly fsPath: string;
}

export interface WorkspaceProbe {
  /** True when `<folder>/<child>` is a directory. */
  readonly hasDirectory: (folder: string, child: string) => boolean;
}

export type RepoChoice =
  | { readonly kind: "single"; readonly root: string }
  /** Several candidates: the developer has to say which, there is no safe guess. */
  | { readonly kind: "ambiguous"; readonly candidates: readonly Folder[] }
  | { readonly kind: "none"; readonly detail: string };

/**
 * Pick the repository root from the open workspace folders.
 *
 * A folder containing `.git` is treated as a repository. When exactly one
 * qualifies it is used; when several do the caller must ask, because guessing
 * "the first one" writes artifacts into whichever folder happened to be added
 * first. When none qualify but a single folder is open, that folder is used —
 * bugpilot degrades gracefully without git (it just produces no git context),
 * and refusing to run would be worse than running with less.
 */
export function chooseRepoRoot(folders: readonly Folder[], probe: WorkspaceProbe): RepoChoice {
  if (folders.length === 0) {
    return { kind: "none", detail: "No folder is open. Open the repository you are fixing bugs in." };
  }

  const repositories = folders.filter((folder) => probe.hasDirectory(folder.fsPath, ".git"));
  if (repositories.length === 1) {
    return { kind: "single", root: repositories[0]!.fsPath };
  }
  if (repositories.length > 1) {
    return { kind: "ambiguous", candidates: repositories };
  }
  if (folders.length === 1) {
    // Not a git checkout. bugpilot still works; git context is simply skipped.
    return { kind: "single", root: folders[0]!.fsPath };
  }
  return { kind: "ambiguous", candidates: folders };
}

/**
 * Whether a work item's artifacts belong to this root.
 *
 * The same containment question `validate_work_item_id` answers on the Python
 * side, asked here so a stale editor state cannot point a command at another
 * checkout.
 *
 * Two things a string prefix test gets wrong, and why this resolves paths first:
 *
 *  - `..` defeats it outright. `C:\work\app\..\other` starts with `C:\work\app`
 *    and would pass, which is exactly the escape the guard exists to stop.
 *  - Case folding is platform-specific. Windows paths are case-insensitive, but
 *    on POSIX `/work/App` and `/work/app` are different directories, so folding
 *    unconditionally makes distinct paths compare equal.
 */
export function isWithin(root: string, candidate: string, platform: string = process.platform): boolean {
  const windows = platform === "win32";
  const pathApi = windows ? path.win32 : path.posix;
  const normalize = (value: string) => {
    // Accept either separator regardless of platform: a path can arrive from a
    // config file written on the other one.
    const unified = windows ? value.replace(/\//g, "\\") : value.replace(/\\/g, "/");
    const resolved = pathApi.normalize(pathApi.resolve(unified));
    const trimmed = resolved.replace(/[\\/]+$/, "");
    return windows ? trimmed.toLowerCase() : trimmed;
  };

  const base = normalize(root);
  const target = normalize(candidate);
  if (target === base) return true;
  return target.startsWith(base + pathApi.sep);
}
