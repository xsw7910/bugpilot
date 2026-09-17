/**
 * The VS Code side of the extension: adapters, and nothing else.
 *
 * Every function here exists to turn a VS Code API into one of the narrow
 * interfaces the rest of the extension was written against (`Folder`,
 * `WorkspaceProbe`, `Log`, `SecretStore`). The rule from phase 4 holds: only
 * this file and `extension.ts` may import `vscode`, which is what lets
 * everything else run under `node --test` with no editor at all.
 *
 * Keep this file boring. Anything with a decision in it belongs in `src/app/`,
 * where it can be tested.
 */

import { statSync } from "node:fs";
import path from "node:path";
import * as vscode from "vscode";

import { SETTINGS } from "../commands.ts";
import type { Log } from "../app/log.ts";
import type { Folder, WorkspaceProbe } from "../workspace.ts";

/** The open workspace folders, in the shape `chooseRepoRoot` expects. */
export function workspaceFolders(): Folder[] {
  return (vscode.workspace.workspaceFolders ?? []).map((folder) => ({
    name: folder.name,
    fsPath: folder.uri.fsPath,
  }));
}

/**
 * A directory-exists probe backed by the real filesystem.
 *
 * Synchronous on purpose: it is called once per open folder to look for `.git`,
 * and an async probe would make `chooseRepoRoot` async for no benefit.
 */
export const FILE_SYSTEM_PROBE: WorkspaceProbe = {
  hasDirectory: (folder: string, child: string): boolean => {
    try {
      return statSync(path.join(folder, child)).isDirectory();
    } catch {
      // Missing, or not readable. Either way it does not count as present.
      return false;
    }
  },
};

/** The configured executable path, or undefined when the setting is empty. */
export function configuredExecutable(): string | undefined {
  const value = vscode.workspace
    .getConfiguration(SETTINGS.section)
    .get<string>(SETTINGS.executablePath);
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

/** Persist a chosen executable path so every window uses it. */
export async function setConfiguredExecutable(value: string): Promise<void> {
  await vscode.workspace
    .getConfiguration(SETTINGS.section)
    .update(SETTINGS.executablePath, value, vscode.ConfigurationTarget.Global);
}

/** An output channel presented as a `Log`. */
export function channelLog(channel: vscode.OutputChannel): Log {
  // Local time, not UTC: these lines are read next to the editor's own logs and
  // the developer's clock, and an eight-hour offset makes them useless for
  // working out what happened when.
  const stamp = () => new Date().toTimeString().slice(0, 8);
  return {
    info: (message: string) => channel.appendLine(`[${stamp()}] ${message}`),
    error: (message: string) => channel.appendLine(`[${stamp()}] ERROR ${message}`),
  };
}
