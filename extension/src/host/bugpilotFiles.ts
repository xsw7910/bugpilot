/**
 * What one of a repository's settings files is, without following a link: a
 * regular file the settings row's Edit may open in an editor tab, nothing, or
 * something else — a link, a folder, or a file reached through a linked
 * `settings` folder —
 * which Edit leaves alone, as the CLI's own reads and writes refuse it. The
 * contents are never read here.
 */
import { lstat } from "node:fs/promises";
import path from "node:path";

import { SETTINGS_FOLDER } from "../app/dataFolder.ts";

export type BugpilotFileKind = "absent" | "file" | "other";

/** `repositoryDir` is the repository's folder in BugPilot's data folder (`doctor`'s `storage.repository_dir`, 0.1.7). */
export async function bugpilotFileKind(repositoryDir: string, name: string): Promise<BugpilotFileKind> {
  // The folder first: a junction or symbolic link there would make the file
  // below it look like a plain settings file of this repository.
  const folder = await kindOf(path.join(repositoryDir, SETTINGS_FOLDER));
  if (folder !== "directory") return folder === "absent" ? "absent" : "other";
  const file = await kindOf(path.join(repositoryDir, SETTINGS_FOLDER, name));
  return file === "file" ? "file" : file === "absent" ? "absent" : "other";
}

async function kindOf(target: string): Promise<"absent" | "file" | "directory" | "other"> {
  try {
    const entry = await lstat(target);
    if (entry.isSymbolicLink()) return "other";
    return entry.isFile() ? "file" : entry.isDirectory() ? "directory" : "other";
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === "ENOENT" || code === "ENOTDIR" ? "absent" : "other";
  }
}
