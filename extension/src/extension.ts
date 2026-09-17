/**
 * Activation: wire VS Code to the pieces the rest of the extension is made of.
 *
 * This is the only orchestration file that imports `vscode`, and it stays thin
 * on purpose. Every decision it needs — which repository, whether bugpilot is
 * usable, what a form means, what the checklist shows, what to do when a run
 * fails — already lives in a tested module under `src/app/`. What is left here
 * is registration, dialogs, and handing the controller its ports.
 */

import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";

import { COMMANDS, SETTINGS, VIEWS, workItemFromTree } from "./commands.ts";
import type { CommandId } from "./commands.ts";
import { installInstructions, resolveEnvironment } from "./app/environment.ts";
import type { Environment } from "./app/environment.ts";
import { Controller } from "./app/controller.ts";
import { DEFAULT_FORM } from "./app/form.ts";
import type { FormState } from "./app/form.ts";
import { claudeProjectSlug, resumeCommand } from "./app/session.ts";
import { diagnose } from "./errors.ts";
import { discoverExecutable } from "./executable.ts";
import { Runner } from "./runner.ts";
import { CredentialStore } from "./secrets.ts";
import { PanelHost } from "./panel/provider.ts";
import { ArtifactsTree, HistoryTree } from "./views/trees.ts";
import {
  canRun,
  createFilesPort,
  createUiPort,
  findAgentSession,
  loadHistory,
  mcpConfigured,
} from "./host/ports.ts";
import { chooseRepoRoot } from "./workspace.ts";
import {
  FILE_SYSTEM_PROBE,
  channelLog,
  configuredExecutable,
  setConfiguredExecutable,
  workspaceFolders,
} from "./host/host.ts";

/** Where the developer's repository pick and last form are remembered. */
const ROOT_STATE_KEY = "bugpilot.repoRoot";
const FORM_STATE_KEY = "bugpilot.form";
const WORK_ITEM_STATE_KEY = "bugpilot.workItem";

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel("BugPilot");
  const log = channelLog(channel);
  context.subscriptions.push(channel);

  const credentials = new CredentialStore(context.secrets);
  let executable = "bugpilot";
  let artifactsView: ArtifactsTree | undefined;
  let historyView: HistoryTree | undefined;
  // Declared here because the UI port closes over it; assigned once the
  // provider exists. Only ever *called* later, like the controller itself.
  let artifactsTree: vscode.TreeView<unknown> | undefined;

  const panel = new PanelHost(context.extensionUri, (message) => {
    void controller.handle(message).catch((error: unknown) => {
      log.error(`Handling ${message.type} failed: ${(error as Error).message}`);
    });
  });

  const environment = async (): Promise<Environment> => {
    const resolved = await resolveEnvironment({
      folders: workspaceFolders(),
      probe: FILE_SYSTEM_PROBE,
      configured: configuredExecutable(),
      preferredRoot: context.workspaceState.get<string>(ROOT_STATE_KEY),
      discover: (input) => discoverExecutable({ cwd: input.cwd, configured: input.configured }),
    });
    if (resolved.kind === "ready") executable = resolved.executable;
    return resolved;
  };

  // Annotated because the panel's message callback above refers to it: without
  // a type here the inference is circular. It is only *called* later, so the
  // reference is safe at runtime.
  const controller: Controller = new Controller(
    {
      runner: {
        runStreaming: (args, options, onEvent) =>
          new Runner(executable).runStreaming(args, options, onEvent),
        runJson: (args, options) => new Runner(executable).runJson(args, options),
      },
      files: createFilesPort(),
      ui: createUiPort({
        render: (state) => panel.render(state),
        refreshViews: () => {
          artifactsView?.refresh();
          historyView?.refresh();
          // Otherwise a developer with two work items in history cannot tell
          // whose artifacts the tree is listing.
          if (artifactsTree) artifactsTree.description = controller.workItemId ?? "";
        },
        editCredentials: (): Promise<void> =>
          setCredentials(credentials, log, () => controller.refreshEnvironment()),
      }),
      log,
      environment,
      credentials: async () => ({
        configured: (await credentials.status()).configured,
        environment: await credentials.environment(),
      }),
      // Kept out of the repository: a scratch file for a description too long
      // for a command line is the extension's business, not the project's.
      descriptionFilePath: () =>
        path.join(context.globalStorageUri.fsPath, "bug-description.md"),
      saveForm: (form) => void context.workspaceState.update(FORM_STATE_KEY, form),
      saveWorkItem: (workItemId) =>
        void context.workspaceState.update(WORK_ITEM_STATE_KEY, workItemId),
      canRun,
    },
    context.workspaceState.get<FormState>(FORM_STATE_KEY) ?? DEFAULT_FORM,
  );

  artifactsView = new ArtifactsTree(() => controller.artifacts);
  historyView = new HistoryTree(async () => {
    const root = controller.root;
    if (!root) return { kind: "empty", detail: "Open the repository you are fixing bugs in." };
    return loadHistory(root, (args) =>
      new Runner(executable).runJson(args, { cwd: root, timeoutMs: 30_000 }),
    );
  });

  artifactsTree = vscode.window.createTreeView(VIEWS.artifacts, {
    treeDataProvider: artifactsView,
  }) as vscode.TreeView<unknown>;
  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEWS.panel, panel.provider, {
      // The page restores its own form from setState, so there is nothing to
      // keep resident (§5.4).
      webviewOptions: { retainContextWhenHidden: false },
    }),
    artifactsTree,
    vscode.window.createTreeView(VIEWS.history, { treeDataProvider: historyView }),
    // The tree views own their own disposal, but not the emitters we handed them.
    artifactsView,
    historyView,
    // A folder opened or removed changes the answer to "which repository", and
    // a changed executable path changes which binary runs. Without these the
    // panel keeps showing a stale answer until Check Environment is run by
    // hand — including the common case of opening a folder in an empty window.
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void controller.refreshEnvironment();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${SETTINGS.section}.${SETTINGS.executablePath}`)) {
        void controller.refreshEnvironment();
      }
    }),
  );

  // `CommandId`, not `string`: registering an id the table does not declare is
  // then a typecheck failure rather than a command that exists but is never
  // contributed — which fails at runtime with VS Code's "command not found".
  const register = (command: CommandId, handler: (...args: never[]) => Promise<void> | void) => {
    context.subscriptions.push(vscode.commands.registerCommand(command, handler));
  };

  // --- environment and setup ---

  register(COMMANDS.checkEnvironment, async () => {
    // The folder question is answered without running anything: asking
    // `environment()` first and then refreshing ran the `doctor` handshake
    // twice per invocation, and this command is also the wizard's Retry button.
    const choice = chooseRepoRoot(workspaceFolders(), FILE_SYSTEM_PROBE);
    if (choice.kind === "ambiguous") {
      const pick = await vscode.window.showQuickPick(
        choice.candidates.map((candidate) => ({
          label: candidate.name,
          description: candidate.fsPath,
        })),
        { title: "Which repository should BugPilot work on?", ignoreFocusOut: true },
      );
      if (pick?.description) {
        await context.workspaceState.update(ROOT_STATE_KEY, pick.description);
        log.info(`Repository root set to ${pick.description}`);
      }
    }
    await controller.refreshEnvironment();
    const after = controller.root;
    if (after) log.info(`Using ${executable} in ${after}`);
  });

  register(COMMANDS.showInstallInstructions, () => {
    // Multi-line guidance does not fit a notification, and it is something the
    // developer wants on screen while they act on it.
    channel.appendLine("");
    for (const line of installInstructions()) channel.appendLine(line);
    channel.show(true);
  });

  register(COMMANDS.chooseExecutable, async () => {
    const picked = await vscode.window.showOpenDialog({
      canSelectMany: false,
      openLabel: "Use this bugpilot",
      title: "Select the bugpilot executable",
    });
    const target = picked?.[0];
    if (!target) return;
    await setConfiguredExecutable(target.fsPath);
    log.info(`bugpilot.executablePath set to ${target.fsPath}`);
    await controller.refreshEnvironment();
  });

  register(COMMANDS.setCredentials, () =>
    setCredentials(credentials, log, () => controller.refreshEnvironment()),
  );

  register(COMMANDS.clearCredentials, async () => {
    await credentials.clear();
    log.info("Stored Jira credentials cleared.");
    await controller.refreshEnvironment();
    vscode.window.showInformationMessage("BugPilot: stored Jira credentials cleared.");
  });

  // --- the panel and a run ---

  register(COMMANDS.openPanelInEditor, () => panel.openInEditor());
  register(COMMANDS.stop, () => controller.stop());

  // --- artifacts ---

  /**
   * Run an action against the work item the developer pointed at.
   *
   * These commands come from two places with two different notions of "which
   * work item": the palette means the one on screen, and a History context
   * menu means the row that was right-clicked. So the panel is switched to
   * that row first, and only then does the action run — acting invisibly on a
   * different work item than the one being shown is how you delete the wrong
   * artifacts.
   */
  const onWorkItem = async (argument: unknown, action: () => Promise<void>): Promise<void> => {
    const workItemId = workItemFromTree(argument);
    if (workItemId !== undefined && controller.workItemId !== workItemId) {
      await controller.showWorkItem(workItemId);
      // `showWorkItem` refuses while a run is in flight, and says so. Carrying
      // on would apply the action to the previous work item instead.
      if (controller.workItemId !== workItemId) return;
      artifactsView?.refresh();
    }
    await action();
  };

  register(COMMANDS.retry, (argument: never) => onWorkItem(argument, () => controller.retry()));
  register(COMMANDS.openAgentTask, (argument: never) =>
    onWorkItem(argument, () => controller.openArtifact("agent_task.md")),
  );
  register(COMMANDS.copyHandoffPrompt, (argument: never) =>
    onWorkItem(argument, () => controller.copyHandoff()),
  );
  register(COMMANDS.openArtifactsFolder, (argument: never) =>
    onWorkItem(argument, () => controller.openArtifactsFolder()),
  );
  register(COMMANDS.fixWithAI, (argument: never) =>
    onWorkItem(argument, () => controller.fixWithAI()),
  );
  register(COMMANDS.openArtifact, async (name: never) => {
    if (typeof name === "string") await controller.openArtifact(name);
  });
  register(COMMANDS.showWorkItem, async (workItemId: never) => {
    if (typeof workItemId === "string") await controller.showWorkItem(workItemId);
  });
  register(COMMANDS.refreshViews, async () => {
    await controller.refreshArtifacts();
    artifactsView?.refresh();
    historyView?.refresh();
  });

  // --- diagnostics ---

  register(COMMANDS.doctor, async () => {
    const root = await requireRoot(controller);
    if (!root) return;
    channel.appendLine("");
    channel.appendLine("$ bugpilot doctor --json");
    try {
      const envelope = await new Runner(executable).runJson(["doctor"], {
        cwd: root,
        timeoutMs: 60_000,
      });
      if (!envelope.ok) {
        const diagnosis = diagnose(envelope.error.code, envelope.error.message);
        channel.appendLine(`FAILED (${envelope.error.code}): ${diagnosis.summary}`);
        if (diagnosis.action) channel.appendLine(`Next: ${diagnosis.action}`);
        channel.show(true);
        vscode.window.showErrorMessage(diagnosis.summary);
        return;
      }
      for (const [key, value] of Object.entries(asRecord(envelope["report"]))) {
        channel.appendLine(`  ${key}: ${JSON.stringify(value)}`);
      }
      for (const warning of envelope.warnings) channel.appendLine(`  warning: ${warning}`);
      channel.show(true);
    } catch (error) {
      log.error(`doctor failed: ${(error as Error).message}`);
      vscode.window.showErrorMessage(`BugPilot doctor could not run: ${(error as Error).message}`);
    }
  });

  register(COMMANDS.agentCheck, async () => {
    const root = await requireRoot(controller);
    if (root) await runText(executable, root, ["agent-check"], channel, log);
  });

  register(COMMANDS.clean, async (argument: never) => {
    const root = await requireRoot(controller);
    if (!root) return;
    // From a History row the work item is already chosen; asking again would be
    // a quick pick that repeats what the right-click said. The modal
    // confirmation below stays either way — that is the part that matters.
    const workItemId = workItemFromTree(argument) ?? (await askWorkItem(controller));
    if (!workItemId) return;
    const confirmed = await vscode.window.showWarningMessage(
      `Delete every artifact for ${workItemId}? Anything an agent wrote, including fix_summary.md, is removed.`,
      { modal: true },
      "Delete",
    );
    if (confirmed !== "Delete") return;
    await runText(executable, root, ["clean", workItemId], channel, log);
    await controller.refreshArtifacts();
    artifactsView?.refresh();
    historyView?.refresh();
  });

  register(COMMANDS.mcpStatus, async () => {
    const root = await requireRoot(controller);
    if (!root) return;
    const status = await mcpConfigured(root);
    channel.appendLine("");
    if (status.configured) {
      channel.appendLine("An MCP client in this workspace is configured for bugpilot.");
      channel.appendLine("Ask your agent to prepare the bug instead of running it here.");
    } else {
      channel.appendLine("No MCP configuration for bugpilot was found in this workspace.");
      channel.appendLine("Looked in:");
      for (const file of status.checked) channel.appendLine(`  ${file}`);
      channel.appendLine("See docs/mcp_setup.md in the bugpilot repository to add one.");
    }
    channel.show(true);
  });

  register(COMMANDS.resumeAgentSession, async () => {
    const root = await requireRoot(controller);
    if (!root) return;
    // Fragile by design (§5.6): the transcript layout is Claude Code's own
    // detail, so a miss is reported plainly rather than guessed around.
    const directory = path.join(os.homedir(), ".claude", "projects", claudeProjectSlug(root));
    const session = await findAgentSession(directory);
    if (!session) {
      vscode.window.showInformationMessage(
        "No previous agent session was found for this repository. Sessions are only visible when the workspace root is the directory the agent ran in.",
      );
      return;
    }
    const terminal = vscode.window.createTerminal({ name: "BugPilot agent", cwd: root });
    terminal.show();
    // Not sent as a live handover: two processes writing one transcript is not
    // safe, so this resumes after the previous agent exited.
    terminal.sendText(resumeCommand(session.id), true);
  });

  register(COMMANDS.showLog, () => channel.show(true));

  stopRunInFlight = () => controller.stop();
  log.info("BugPilot extension activated.");
  void controller
    .refreshEnvironment()
    .then(() => {
      // §5.4: after a restart the progress view comes back from
      // workflow_status.json — which only works if the window remembers which
      // work item to read it from.
      const last = context.workspaceState.get<string>(WORK_ITEM_STATE_KEY);
      return last ? controller.showWorkItem(last) : undefined;
    })
    .catch((error: unknown) => log.error(`Start-up failed: ${(error as Error).message}`));
}

/**
 * Set at activation so `deactivate` can end a run in flight.
 *
 * Nothing else kills it: a spawned bugpilot is not a child VS Code tracks, and
 * on POSIX the Runner detaches it into its own process group — so closing the
 * window would otherwise leave a bugpilot and its ripgrep running.
 */
let stopRunInFlight: (() => void) | undefined;

export function deactivate(): void {
  stopRunInFlight?.();
  stopRunInFlight = undefined;
}

/** Prompt for the Jira email and token, then store them in SecretStorage. */
async function setCredentials(
  credentials: CredentialStore,
  log: { info: (message: string) => void },
  refresh: () => Promise<void>,
): Promise<void> {
  const status = await credentials.status();
  const email = await vscode.window.showInputBox({
    title: "Jira email",
    value: status.email ?? "",
    ignoreFocusOut: true,
    prompt: "The account the API token belongs to.",
  });
  if (email === undefined) return;
  const token = await vscode.window.showInputBox({
    title: "Jira API token",
    // Masked, and never read back out: `CredentialStore` only ever yields the
    // token as a spawn environment.
    password: true,
    ignoreFocusOut: true,
    prompt: "Created in your Atlassian account settings.",
  });
  if (token === undefined) return;
  try {
    await credentials.save({ email, token });
  } catch (error) {
    vscode.window.showErrorMessage((error as Error).message);
    return;
  }
  log.info("Jira credentials stored for this machine.");
  await refresh();
}

/** The repository root, resolving the environment first if necessary. */
async function requireRoot(controller: Controller): Promise<string | undefined> {
  if (controller.root) return controller.root;
  await controller.refreshEnvironment();
  if (!controller.root) {
    vscode.window.showWarningMessage(
      "BugPilot needs a repository. Open the folder you are fixing bugs in.",
    );
    return undefined;
  }
  return controller.root;
}

/** Which work item a palette command should act on. */
async function askWorkItem(controller: Controller): Promise<string | undefined> {
  const current = controller.workItemId;
  const entered = await vscode.window.showInputBox({
    title: "Work item",
    value: current ?? "",
    ignoreFocusOut: true,
    prompt: "The Jira issue key or local work item id.",
  });
  const trimmed = entered?.trim();
  return trimmed === undefined || trimmed === "" ? undefined : trimmed;
}

/** Run a command that has no machine-readable output and show it verbatim. */
async function runText(
  executable: string,
  root: string,
  args: readonly string[],
  channel: vscode.OutputChannel,
  log: { error: (message: string) => void },
): Promise<void> {
  channel.appendLine("");
  channel.appendLine(`$ bugpilot ${args.join(" ")}`);
  try {
    const result = await new Runner(executable).run(args, { cwd: root, timeoutMs: 120_000 });
    for (const line of `${result.stdout}${result.stderr}`.split("\n")) {
      if (line.trim() !== "") channel.appendLine(`  ${line}`);
    }
    channel.appendLine(`  exit ${result.code ?? "aborted"}`);
    channel.show(true);
  } catch (error) {
    log.error(`${args.join(" ")} failed: ${(error as Error).message}`);
    vscode.window.showErrorMessage(`BugPilot could not run ${args[0]}: ${(error as Error).message}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
