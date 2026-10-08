/**
 * The controller's ports, implemented against VS Code and the filesystem.
 *
 * Every function here is a one-liner over an editor API or `node:fs`. That is
 * the point: the interesting behaviour lives in `src/app/controller.ts`, which
 * knows nothing about VS Code and is therefore tested, and this file is small
 * enough to read in one go.
 */

import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import * as vscode from "vscode";

import { historyFromPayload } from "../app/artifacts.ts";
import type { HistoryList, WorkItemProbe } from "../app/artifacts.ts";
import {
  FIX_MODE_LIST_ARGS,
  FIX_MODE_MANAGED_ARGS,
  fixModeDiscoveryFailure,
  fixModesFromPayload,
  managedFixModesFromPayload,
} from "../app/fixModes.ts";
import type { FixModeCatalog, ManagedFixModes } from "../app/fixModes.ts";
import type { IssueDetails } from "../app/hintImprovement.ts";
import { childEnvironmentAdditions, locateExecutable } from "../executablePath.ts";
import { pickLatestSession, sessionIdFromFileName } from "../app/session.ts";
import { trustedRunner } from "../runner.ts";
import { writeWorkItemFile } from "../app/sessionReset.ts";
import { CAPTURED_REVIEW_TIMEOUT_MS } from "../app/reviewRun.ts";
import type { SessionCandidate } from "../app/session.ts";
import type { ControllerPorts, FilesPort, UiPort } from "../app/controller.ts";
import type { GitignoreEntry, GitignoreIo } from "../app/gitignore.ts";
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
    writeFile: async (file, contents, workItem) => {
      if (workItem !== undefined) {
        const name = path.basename(file);
        if (path.join(workItem.root, ".ai", workItem.workItemId, name) !== path.join(file)) {
          throw new Error(`${name} is not in this work item's .ai folder, so nothing was written.`);
        }
        await writeWorkItemFile({ ...workItem, name, contents });
        return;
      }
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, contents, "utf8");
    },
  };
}

export interface UiPortDeps {
  readonly render: (state: PanelState) => void;
  readonly refreshViews: () => void;
}

export function createUiPort(deps: UiPortDeps): UiPort {
  return {
    render: deps.render,
    refreshViews: deps.refreshViews,
    openExternal: async (url) => {
      // The editor's own external-link path: the browser, never the webview.
      await vscode.env.openExternal(vscode.Uri.parse(url));
    },
    openFile: async (file) => {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
      await vscode.window.showTextDocument(document, { preview: false });
    },
    copyToClipboard: async (text) => {
      await vscode.env.clipboard.writeText(text);
    },
    confirm: async (message, confirmLabel, keepLabel) => {
      // Modal: this is only used for destructive choices, and a toast that can
      // be missed is not consent.
      if (keepLabel !== undefined) {
        // Both choices named — "Cancel Review" beside VS Code's own "Cancel"
        // would say the same word for opposite things. The keep choice is the
        // close affordance, so Escape and the close button keep, too.
        const confirm: vscode.MessageItem = { title: confirmLabel };
        const keep: vscode.MessageItem = { title: keepLabel, isCloseAffordance: true };
        const picked = await vscode.window.showWarningMessage(message, { modal: true }, confirm, keep);
        return picked === confirm;
      }
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
      // The shell resolves the agent's name; with this switch cmd.exe — and every
      // program started inside the terminal, such as an npm shim's `node` — skips
      // the repository, the working directory.
      const terminal = vscode.window.createTerminal({ name, cwd, env: { ...childEnvironmentAdditions() } });
      terminal.show();
      terminal.sendText(commandLine, true);
    },
    revealTerminal: (matches) => {
      // The newest match that is still open: a later attempt's terminal is the
      // session to go back to, and one whose shell has exited is not a session.
      const terminal = [...vscode.window.terminals]
        .reverse()
        .find((candidate) => candidate.exitStatus === undefined && matches(candidate.name));
      if (!terminal) return false;
      terminal.show();
      return true;
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
 * arrive that way (`run.json` included — it is written through a
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
  if (files.includes("run.json")) {
    try {
      status = JSON.parse(await readFile(path.join(directory, "run.json"), "utf8"));
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
 * The AI Fix Modes this bugpilot offers: `fix-mode list --json`.
 *
 * The same shape as `loadHistory` above — spawn here, interpret in a pure
 * module — so what the catalog means is testable without a process. A failure
 * becomes `unavailable` with a reason rather than a thrown error or a
 * hard-coded list: the page has to be able to say "this BugPilot does not offer
 * Fix Modes" and still let the developer prepare a package.
 */
export async function loadFixModes(
  runJson: (args: readonly string[]) => Promise<unknown>,
): Promise<FixModeCatalog> {
  let payload: unknown;
  try {
    payload = await runJson(FIX_MODE_LIST_ARGS);
  } catch (error) {
    return fixModeDiscoveryFailure(error);
  }
  return fixModesFromPayload(payload);
}

/**
 * Every physical Fix Mode definition: `fix-mode list --all-scopes --json`.
 *
 * A second call rather than a field on the first, because the two answer
 * different questions and the panel needs them at different times: the selector
 * asks on every environment resolution, management only when it is opened.
 */
export async function loadManagedFixModes(
  runJson: (args: readonly string[]) => Promise<unknown>,
): Promise<ManagedFixModes> {
  try {
    return managedFixModesFromPayload(await runJson(FIX_MODE_MANAGED_ARGS));
  } catch (error) {
    return fixModeDiscoveryFailure(error);
  }
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
 * Whether an AI CLI is there to run: resolved under
 * `executablePath.ts`'s policy — PATH's absolute entries, never the working
 * directory — and not executed at all. A program Node can start (`.exe`) or a
 * launcher a terminal's shell runs (`claude.cmd`) both count: the question the
 * caller has is "will this agent start", and nothing needs to run to answer it.
 * A relative path is never trusted, so it is never "there".
 */
export async function canRun(executable: string): Promise<boolean> {
  if (locateExecutable(executable, { purpose: "spawn" }).kind === "found") return true;
  return locateExecutable(executable, { purpose: "shell" }).kind === "found";
}

/**
 * One issue's title and description, for improving a hint.
 *
 * `bugpilot issue-details --json` rather than `fetch`: the same Jira client and
 * the same parser, reading only. `fetch` writes `.ai/<issue>/` because a run
 * needs those artifacts, and creating a work item as a side effect of improving
 * a sentence would be a surprise.
 *
 * Every failure is `undefined`, never a throw. Jira being unreachable is a
 * reason to improve the wording alone, which the controller says out loud.
 */
export async function loadIssueDetails(
  runJson: (args: readonly string[]) => Promise<unknown>,
  issueKey: string,
): Promise<IssueDetails | undefined> {
  let payload: unknown;
  try {
    payload = await runJson(["issue-details", issueKey]);
  } catch {
    return undefined;
  }
  const record = payload as { ok?: unknown; title?: unknown; description?: unknown } | undefined;
  if (!record || record.ok !== true) return undefined;
  const title = typeof record.title === "string" ? record.title : "";
  const description = typeof record.description === "string" ? record.description : "";
  if (title === "" && description === "") return undefined;
  return { title, description };
}

/**
 * Ask an AI CLI to rewrite a hint.
 *
 * Three things make this safe to point at untrusted prose:
 *
 *  - the prompt goes on **stdin**, so no hint ever reaches a command line;
 *  - argv is the provider's own fixed arguments, nothing interpolated;
 *  - the child runs in an **empty temporary directory**, not the repository, so
 *    a CLI that has file tools has no project files within reach. That is a
 *    stronger guarantee than a permission flag this code would have to guess at,
 *    and it holds for every provider.
 *
 * Nothing of the developer's environment is added: no Jira credentials, no
 * secrets. stderr is kept for the message when the tool fails.
 */
export async function improveHintWithProvider(request: {
  readonly provider: { readonly label: string; readonly command: string; readonly args: readonly string[] };
  readonly prompt: string;
}): Promise<{ ok: true; text: string } | { ok: false; reason: string }> {
  const scratch = await mkdtemp(path.join(tmpdir(), "bugpilot-hint-"));
  try {
    const result = await trustedRunner(request.provider.command).run([...request.provider.args], {
      cwd: scratch,
      input: request.prompt,
      timeoutMs: 120_000,
    });
    if (result.aborted) {
      return { ok: false, reason: `${request.provider.label} did not answer in time.` };
    }
    if (result.code !== 0) {
      const detail = firstLine(result.stderr) || `exit code ${result.code}`;
      return { ok: false, reason: `${request.provider.label} could not improve the hint: ${detail}` };
    }
    return { ok: true, text: result.stdout };
  } catch (error) {
    const code = (error as { code?: string } | undefined)?.code;
    if (code === "ENOENT") {
      return { ok: false, reason: `${request.provider.command} was not found on PATH.` };
    }
    return { ok: false, reason: `${request.provider.label} could not be run: ${(error as Error).message}` };
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * `.gitignore` as Repository Files' quick fix sees it (§37.85): the editor's
 * open document when there is one, VS Code's file system otherwise. No shell.
 *
 * The document is found by path, so an open `.gitignore` — dirty or not — is
 * edited through a `WorkspaceEdit` and the developer's unsaved text stays in
 * the buffer. What to write is decided in `src/app/gitignore.ts`.
 */
export function createGitignoreIo(): GitignoreIo {
  const sameFile = (a: string, b: string) =>
    process.platform === "win32" ? path.resolve(a).toLowerCase() === path.resolve(b).toLowerCase() : path.resolve(a) === path.resolve(b);
  return {
    document: (file) => {
      const document = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.scheme === "file" && !candidate.isClosed && sameFile(candidate.uri.fsPath, file),
      );
      if (!document) return undefined;
      return {
        text: document.getText(),
        eol: document.eol === vscode.EndOfLine.CRLF ? "\r\n" : "\n",
        dirty: document.isDirty,
        append: async (text) => {
          const edit = new vscode.WorkspaceEdit();
          edit.insert(document.uri, document.positionAt(document.getText().length), text);
          return vscode.workspace.applyEdit(edit);
        },
        save: () => Promise.resolve(document.save()),
      };
    },
    stat: async (file): Promise<GitignoreEntry> => {
      try {
        const found = await vscode.workspace.fs.stat(vscode.Uri.file(file));
        if (found.type & vscode.FileType.SymbolicLink) return "symlink";
        return found.type & vscode.FileType.File ? "file" : "other";
      } catch (error) {
        if (error instanceof vscode.FileSystemError && error.code === "FileNotFound") return "missing";
        throw error;
      }
    },
    read: async (file) => vscode.workspace.fs.readFile(vscode.Uri.file(file)),
    write: async (file, bytes) => vscode.workspace.fs.writeFile(vscode.Uri.file(file), bytes),
  };
}

/**
 * Watch one work item's artifact directory (§37.81): the files directly in
 * `.ai/<id>/`, created, changed or deleted — not the repository, not
 * recursively, nothing under `.git` or `node_modules`. The callback gets the
 * file name only; the controller debounces and re-reads.
 */
export function watchArtifactDirectory(directory: string, onEvent: (name: string) => void): vscode.Disposable {
  const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(vscode.Uri.file(directory), "*"));
  const fire = (uri: vscode.Uri) => onEvent(path.basename(uri.fsPath));
  const listeners = [watcher.onDidCreate(fire), watcher.onDidChange(fire), watcher.onDidDelete(fire)];
  return {
    dispose: () => {
      for (const listener of listeners) listener.dispose();
      watcher.dispose();
    },
  };
}

/**
 * Run a captured one-shot review (§37.80) and hand back what it printed.
 *
 * The agent's fixed argv (`CapturedReviewInvocation`), no shell, the review
 * prompt on **stdin**, and the repository root as its working directory — the
 * reviewer reads that repository's files and diff. Its own flags keep it
 * read-only. The prompt is the canonical one from `review-package`; nothing of
 * the developer's secrets is added to the environment. A spawn that fails
 * throws, which the controller reads as "never started".
 */
export async function runCapturedReview(request: {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly input: string;
  readonly signal?: AbortSignal;
  readonly onStarted?: () => void;
}): Promise<{ code: number | null; stdout: string; stderr: string; aborted: boolean }> {
  return trustedRunner(request.command).run([...request.args], {
    cwd: request.cwd,
    input: request.input,
    // A review reads a diff and a few files; past this it is not coming back.
    timeoutMs: CAPTURED_REVIEW_TIMEOUT_MS,
    // Cancel Review: `Runner` ends the whole tree it started — `taskkill /T /F`
    // on its own pid on Windows, the process group elsewhere — and nothing else.
    ...(request.signal === undefined ? {} : { signal: request.signal }),
    ...(request.onStarted === undefined ? {} : { onSpawn: request.onStarted }),
  });
}

function firstLine(text: string): string {
  return text.trim().split("\n")[0]?.trim() ?? "";
}

/**
 * The installed AI extensions, as VS Code's extension API reports them (§37.94).
 *
 * `getExtension` answers undefined for an extension that is not installed and
 * for one that is disabled, which is the right answer for both: neither can be
 * handed anything. The command list is the installed manifest's own
 * `contributes.commands` — what this version declares, read without activating
 * it — so `agents.ts` never runs a command that is not there. Which ids to ask
 * about and which commands to run are `agents.ts`'s; this only answers and
 * executes.
 */
export function createExtensionsPort(): NonNullable<ControllerPorts["extensions"]> {
  return {
    get: (id) => {
      const extension = vscode.extensions.getExtension(id);
      if (!extension) return undefined;
      const manifest = extension.packageJSON as { version?: unknown; contributes?: { commands?: unknown } } | undefined;
      const declared = Array.isArray(manifest?.contributes?.commands) ? manifest.contributes.commands : [];
      return {
        version: typeof manifest?.version === "string" ? manifest.version : "",
        active: extension.isActive,
        commands: declared
          .map((entry) => (entry as { command?: unknown } | null)?.command)
          .filter((command): command is string => typeof command === "string"),
      };
    },
    executeCommand: async (command, ...args) => {
      await vscode.commands.executeCommand(command, ...args);
    },
  };
}

/**
 * Where pasted and dropped attachments are kept (§37.98): the extension's own
 * global storage, `attachments/<digest>/<name>` — outside every repository, so
 * nothing lands in a working tree until a run copies it into `.ai/<id>/`.
 * The same content is the same directory, so a second paste rewrites the same
 * file rather than making another.
 */
export function createAttachmentStore(storageRoot: string): NonNullable<ControllerPorts["storeAttachment"]> {
  return async (digest, name, bytes) => {
    const directory = path.join(storageRoot, "attachments", digest);
    await mkdir(directory, { recursive: true });
    const file = path.join(directory, name);
    await writeFile(file, bytes);
    return file;
  };
}
