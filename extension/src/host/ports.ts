/**
 * The controller's ports, implemented against VS Code and the filesystem.
 *
 * Every function here is a one-liner over an editor API or `node:fs`. That is
 * the point: the interesting behaviour lives in `src/app/controller.ts`, which
 * knows nothing about VS Code and is therefore tested, and this file is small
 * enough to read in one go.
 */

import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import * as vscode from "vscode";

import { historyFromPayload } from "../app/artifacts.ts";
import type { HistoryList, WorkItemProbe } from "../app/artifacts.ts";
import { launcherNames } from "../executable.ts";
import { pickLatestSession, sessionIdFromFileName } from "../app/session.ts";
import { Runner } from "../runner.ts";
import type { SessionCandidate } from "../app/session.ts";
import type { FilesPort, UiPort } from "../app/controller.ts";
import type { PanelState } from "../panel/messages.ts";

export function createFilesPort(): FilesPort {
  return {
    listDirectory: async (directory) => {
      try {
        const entries = await readdir(directory, { withFileTypes: true });
        return {
          kind: "ok",
          names: entries.filter((entry) => entry.isFile()).map((entry) => entry.name),
        };
      } catch (error) {
        // Not there yet is the normal state before the first run; anything else
        // is a problem the developer has to see, not one to hide behind an
        // empty list.
        const code = (error as { code?: string }).code;
        if (code === "ENOENT" || code === "ENOTDIR") return { kind: "missing" };
        return { kind: "unreadable", detail: (error as Error).message };
      }
    },
    readFile: async (file) => {
      try {
        return await readFile(file, "utf8");
      } catch {
        return undefined;
      }
    },
    writeFile: async (file, contents) => {
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, contents, "utf8");
    },
  };
}

export interface UiPortDeps {
  readonly render: (state: PanelState) => void;
  readonly refreshViews: () => void;
  readonly editCredentials: () => Promise<void>;
}

export function createUiPort(deps: UiPortDeps): UiPort {
  return {
    render: deps.render,
    refreshViews: deps.refreshViews,
    editCredentials: deps.editCredentials,
    openFile: async (file) => {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      await vscode.window.showTextDocument(document, { preview: false });
    },
    copyToClipboard: async (text) => {
      await vscode.env.clipboard.writeText(text);
    },
    confirm: async (message, confirmLabel) => {
      // Modal: this is only used for destructive choices, and a toast that can
      // be missed is not consent.
      const answer = await vscode.window.showWarningMessage(
        message,
        { modal: true },
        confirmLabel,
      );
      return answer === confirmLabel;
    },
    runCommand: async (commandId) => {
      // Already checked against COMMANDS by the controller; this only executes.
      await vscode.commands.executeCommand(commandId);
    },
    runInTerminal: (name, cwd, commandLine) => {
      const terminal = vscode.window.createTerminal({ name, cwd });
      terminal.show();
      terminal.sendText(commandLine, true);
    },
    openFolder: async (directory) => {
      // The editor's own explorer rather than the OS file manager: the point is
      // to look at what the run wrote, and that is one click from here.
      await vscode.commands.executeCommand("revealInExplorer", vscode.Uri.file(directory));
    },
    pickFiles: async () => {
      const picked = await vscode.window.showOpenDialog({
        canSelectMany: true,
        canSelectFolders: false,
        openLabel: "Attach",
        title: "Attach files for the agent",
      });
      // `fsPath`, not `path`: on Windows the latter is "/c:/..." and every
      // consumer of this list hands it to a process.
      return (picked ?? []).map((uri) => uri.fsPath);
    },
    revealAgentPanel: async () => {
      // Read off the installed extension's own manifest rather than guessed:
      // anthropic.claude-code 2.1.263 contributes these, and none of its
      // twenty-six commands accepts a prompt — which is why the primary path
      // is a terminal and this is only about putting an agent's panel in front
      // of the developer after the prompt is on the clipboard. Other agents can
      // be added to the list; each one is a command id read from a real
      // manifest, never a guess.
      for (const command of ["claude-vscode.sidebar.open", "claude-vscode.editor.openLast"]) {
        try {
          await vscode.commands.executeCommand(command);
          return true;
        } catch {
          // Not installed, or renamed in a newer version. Try the next.
        }
      }
      return false;
    },
    notify: (kind, message) => {
      if (kind === "error") void vscode.window.showErrorMessage(message);
      else if (kind === "warning") void vscode.window.showWarningMessage(message);
      else void vscode.window.showInformationMessage(message);
    },
  };
}

/**
 * What each work item's directory says about it, keyed by its mtime.
 *
 * The history rows report an outcome, and working it out means a directory
 * listing plus one small JSON read per item — on every refresh, of which there
 * is one after every run, every clean and every tree reveal. So the answer is
 * kept until the directory changes.
 *
 * The mtime is a sound key for what is being asked: it moves when an entry is
 * added, removed or renamed, and the three files the outcome depends on all
 * arrive that way (`workflow_status.json` included — it is written through a
 * temporary file and renamed into place).
 */
const probes = new Map<string, { readonly mtimeMs: number; readonly probe: WorkItemProbe }>();

async function probeWorkItem(directory: string, mtimeMs: number): Promise<WorkItemProbe> {
  const cached = probes.get(directory);
  if (cached && cached.mtimeMs === mtimeMs) return cached.probe;

  let files: string[] = [];
  try {
    files = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile())
      .map((entry) => entry.name);
  } catch {
    // Unreadable is a real state; it just is not one this row can describe.
  }
  let status: unknown;
  if (files.includes("workflow_status.json")) {
    try {
      status = JSON.parse(await readFile(path.join(directory, "workflow_status.json"), "utf8"));
    } catch {
      // A truncated status file leaves the outcome to the file list alone,
      // rather than dropping the row.
    }
  }
  const probe: WorkItemProbe = { files, ...(status === undefined ? {} : { status }) };
  probes.set(directory, { mtimeMs, probe });
  return probe;
}

/**
 * The history list: `bugpilot list --json`, ordered by how recently each work
 * item's directory changed, each row carrying what became of it.
 *
 * The CLI reports neither timestamps nor outcomes, so both are read here. A
 * failure to stat one entry costs it its position in the ordering and its
 * outcome, and nothing else.
 */
export async function loadHistory(
  root: string,
  runJson: (args: readonly string[]) => Promise<unknown>,
): Promise<HistoryList> {
  let payload: unknown;
  try {
    payload = await runJson(["list"]);
  } catch {
    // §5.4: history degrades to empty rather than becoming an error that stops
    // the developer from starting a new run.
    return { kind: "empty", detail: "The work item list could not be read." };
  }
  // A failure envelope does not throw — the CLI writes it and exits non-zero on
  // purpose. Without this check the developer is told "No work items yet. The
  // first run creates one." when the truth is that listing them failed.
  if ((payload as { ok?: unknown } | undefined)?.ok === false) {
    return { kind: "empty", detail: "The work item list could not be read." };
  }
  const times = new Map<string, number>();
  const probed = new Map<string, WorkItemProbe>();
  const items = (payload as { work_items?: { work_item_id?: unknown }[] } | undefined)?.work_items;
  for (const item of Array.isArray(items) ? items : []) {
    const id = item?.work_item_id;
    if (typeof id !== "string") continue;
    const directory = path.join(root, ".ai", id);
    try {
      const mtimeMs = (await stat(directory)).mtimeMs;
      times.set(id, mtimeMs);
      probed.set(id, await probeWorkItem(directory, mtimeMs));
    } catch {
      // Deleted between listing and stat, or unreadable. It still gets listed.
    }
  }
  return historyFromPayload(
    payload,
    (id) => times.get(id),
    (id) => probed.get(id),
  );
}

/**
 * The agent session to offer resuming, or undefined.
 *
 * Fragile by construction (§5.6): the directory layout is Claude Code's
 * implementation detail, so every failure here means "no offer", never an error.
 */
export async function findAgentSession(
  sessionsDirectory: string,
): Promise<SessionCandidate | undefined> {
  let names: string[];
  try {
    names = await readdir(sessionsDirectory);
  } catch {
    return undefined;
  }
  const candidates: SessionCandidate[] = [];
  for (const name of names) {
    const id = sessionIdFromFileName(name);
    if (!id) continue;
    try {
      candidates.push({ id, modifiedMs: (await stat(path.join(sessionsDirectory, name))).mtimeMs });
    } catch {
      // Ignore: a transcript we cannot stat is one we should not offer.
    }
  }
  return pickLatestSession(candidates);
}

/**
 * Whether an MCP client in this workspace is pointed at bugpilot.
 *
 * Both file locations from `docs/mcp_setup.md` are checked. This only reports;
 * writing a client's configuration is not the extension's business.
 */
export async function mcpConfigured(
  root: string,
): Promise<{ configured: boolean; checked: readonly string[] }> {
  const checked = [path.join(root, ".mcp.json"), path.join(root, ".vscode", "mcp.json")];
  for (const file of checked) {
    try {
      const text = await readFile(file, "utf8");
      if (text.includes("bugpilot")) return { configured: true, checked };
    } catch {
      // Not there, which is the normal case.
    }
  }
  return { configured: false, checked };
}


/**
 * Whether an executable can be started at all.
 *
 * A `--version` handshake, because that is the cheapest question that proves a
 * spawn works; ENOENT is the answer that matters. Used before offering to run
 * `claude` in a terminal, since a terminal printing "command not found" reads
 * as a bug in this extension rather than a missing tool.
 *
 * ENOENT alone would be too harsh a verdict on Windows, where a spawn probe
 * cannot see a `.cmd` launcher that a terminal runs happily — see
 * `launcherNames`. So a failed probe is followed by a file lookup along PATH,
 * and the question the whole function answers is the one the caller actually
 * has: will the terminal find this.
 */
export async function canRun(executable: string): Promise<boolean> {
  try {
    await new Runner(executable).run(["--version"], { cwd: process.cwd(), timeoutMs: 15_000 });
    return true;
  } catch (error) {
    const code = (error as { code?: string } | undefined)?.code;
    if (code === "ENOENT") return existsOnPath(executable);
    // Anything else — a non-zero exit, unreadable output — still proves the
    // program exists, which is the only question here.
    return true;
  }
}

/** Whether any launcher for a bare command name exists in a PATH directory. */
async function existsOnPath(executable: string): Promise<boolean> {
  // An explicit path was not found by the spawn, and no PATH search would
  // change that.
  if (executable.includes("/") || executable.includes("\\")) return false;
  const names = launcherNames(executable, process.env["PATHEXT"], process.platform);
  if (names.length === 0) return false;
  const directories = (process.env["PATH"] ?? "").split(path.delimiter).filter(Boolean);
  for (const directory of directories) {
    for (const name of names) {
      try {
        if ((await stat(path.join(directory, name))).isFile()) return true;
      } catch {
        // A PATH entry that does not exist is ordinary, not an error.
      }
    }
  }
  return false;
}
