/**
 * Activation: wire VS Code to the pieces the rest of the extension is made of.
 *
 * This is the only orchestration file that imports `vscode`, and it stays thin
 * on purpose. Every decision it needs — which repository, whether bugpilot is
 * usable, what a form means, what the checklist shows, what to do when a run
 * fails — already lives in a tested module under `src/app/`. What is left here
 * is registration, dialogs, and handing the controller its ports.
 */

import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";
import * as vscode from "vscode";

import { COMMANDS, SETTINGS, VIEWS, workItemFromTree } from "./commands.ts";
import type { CommandId } from "./commands.ts";
import { installInstructions, resolveEnvironment } from "./app/environment.ts";
import type { Environment } from "./app/environment.ts";
import { TASK_ARTIFACT } from "./app/artifacts.ts";
import { AttachmentReferenceRegistry, initializeAttachmentGc, runAttachmentGc } from "./app/attachmentStorage.ts";
import { Controller } from "./app/controller.ts";
import { isWorkItemId, restoreForm } from "./app/form.ts";
import { commandForLog, redactKnown, rejectedValueForLog, sensitiveValues } from "./app/logSafety.ts";
import { deleteWorkItemArtifacts } from "./app/sessionReset.ts";
import { fixModeCommandPort, payloadCommandPort } from "./app/fixModeTransport.ts";
import type { FormState } from "./app/form.ts";
import { claudeProjectSlug, resumeCommand } from "./app/session.ts";
import { diagnose } from "./errors.ts";
import { discoverExecutable } from "./executable.ts";
import { Runner } from "./runner.ts";
import { CredentialStore } from "./secrets.ts";
import { PanelHost } from "./panel/provider.ts";
import { reviewedFixStore } from "./app/reviewRun.ts";
import { ResultsTree } from "./views/trees.ts";
import {
  improveHintWithProvider,
  runCapturedReview,
  watchArtifactDirectory,
  createGitignoreIo,
  loadIssueDetails,
  canRun,
  createAttachmentStore,
  createExtensionsPort,
  createFilesPort,
  createUiPort,
  findAgentSession,
  loadFixModes,
  loadManagedFixModes,
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
/** Which fix each work item's last review attempt was for (§37.80); host state, never a repository file. */
const REVIEWED_FIXES_STATE_KEY = "bugpilot.reviewedFixes";
/**
 * The AI agent the last handoff reached, for Auto-detect (§37.94). Global, not
 * per workspace: which agents are installed is a fact about the machine.
 */
const LAST_AGENT_STATE_KEY = "bugpilot.lastAgent";

/**
 * This extension's id, as the marketplace and an `@ext:` settings filter spell
 * it.
 *
 * Written here rather than read from the manifest at runtime: the filter has to
 * match `publisher.name` exactly, and `test/manifest.test.ts` compares this
 * against package.json so the two cannot drift apart.
 */
export const EXTENSION_ID = "ShiweiX.bugpilot";

export function activate(context: vscode.ExtensionContext): void {
  const channel = vscode.window.createOutputChannel("BugPilot");
  const log = channelLog(channel);
  context.subscriptions.push(channel);

  const credentials = new CredentialStore(context.secrets);
  let executable = "bugpilot";
  // Declared here because the UI port closes over it; assigned once the
  // controller exists. Only ever *called* later, like the controller itself.
  let results: ResultsTree | undefined;

  const panel = new PanelHost(context.extensionUri, (message) => {
    void controller.handle(message).catch((error: unknown) => {
      log.error(`Handling ${message.type} failed: ${(error as Error).message}`);
    });
  });

  const storageRoot = context.globalStorageUri.fsPath;
  const attachmentReferences = new AttachmentReferenceRegistry(context.globalState, workspaceReferenceId(), storageRoot);
  // Recorded at start-up too: a form saved before references were recorded
  // (§37.100) is protected from this window's first collection on.
  attachmentReferences.record(restoreForm(context.workspaceState.get<FormState>(FORM_STATE_KEY)).attachments);
  // And the first start-up after the upgrade starts the migration grace
  // period now, not when the deferred pass gets round to it (§37.101). Never
  // rejects; a failure only means nothing is collected this session.
  const attachmentGcTracking = initializeAttachmentGc(context.globalState, Date.now(), log);

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
      // This extension's own version, which is not the CLI's — on a machine
      // with a pipx copy and a checkout, telling them apart is the whole point
      // of showing either. VS Code parses the manifest already.
      extensionVersion:
        typeof context.extension?.packageJSON?.version === "string"
          ? context.extension.packageJSON.version
          : undefined,
      ui: createUiPort({
        render: (state) => {
          panel.render(state);
          // Results > Diagnostics mirrors state the push just carried (§37.110):
          // redrawn only when it changed.
          results?.syncDiagnostics();
        },
        refreshViews: () => results?.refresh(),
        editCredentials: (): Promise<void> =>
          setCredentials(credentials, log, () => controller.credentialsSaved()),
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
      saveForm: (form) => {
        void context.workspaceState.update(FORM_STATE_KEY, form);
        // The form is this workspace's; the attachments it names live in
        // storage every workspace shares, so what it references is recorded
        // where every window's collection can see it.
        attachmentReferences.record(form.attachments);
      },
      // `undefined` after Reset Session: the key is removed, so a restart
      // reopens nothing (§37.103).
      saveWorkItem: (workItemId) =>
        void context.workspaceState.update(WORK_ITEM_STATE_KEY, workItemId),
      // Reset Session's Delete generated files: `.ai/<work item>/`, checked to
      // be the repository's own real folder, then removed by the CLI's `clean`
      // — the Clean command's own delete — and looked at again. Nothing of its
      // output reaches the log: the controller says what happened.
      deleteWorkItemArtifacts: (root, workItemId) =>
        deleteWorkItemArtifacts({
          root,
          workItemId,
          clean: () => new Runner(executable).run(["clean", workItemId], { cwd: root, timeoutMs: 120_000 }),
        }),
      // One spawn for the whole catalog, from the one place that knows the
      // discovery command. The controller asks when the environment resolves,
      // which is also when the executable can have changed.
      listFixModes: async () => {
        const root = controller.root;
        if (!root) {
          return { kind: "unavailable", detail: "No repository is open, so AI Fix Modes could not be read." };
        }
        return loadFixModes((args) =>
          new Runner(executable).runJson(args, { cwd: root, timeoutMs: 30_000 }),
        );
      },
      listManagedFixModes: async () => {
        const root = controller.root;
        if (!root) {
          return { kind: "unavailable", detail: "No repository is open, so AI Fix Modes could not be read." };
        }
        return loadManagedFixModes((args) =>
          new Runner(executable).runJson(args, { cwd: root, timeoutMs: 30_000 }),
        );
      },
      // The payload file and its cleanup live in the app layer; the controller
      // only says what the command is and what definition it carries, and the
      // port refuses outright when there is no repository to run it against.
      runFixModeCommand: fixModeCommandPort(
        () => controller.root,
        (args, cwd) => new Runner(executable).runJson(args, { cwd, timeoutMs: 30_000 }),
      ),
      // Record Review Result: the review goes the same way a Fix Mode does — a
      // temporary file outside the repository, removed afterwards — so four
      // sections of someone's prose are never argv and never shell text.
      runReviewCommand: payloadCommandPort(
        () => controller.root,
        (args, cwd) => new Runner(executable).runJson(args, { cwd, timeoutMs: 30_000 }),
        {
          command: "record-review",
          prefix: "bugpilot-review",
          noRepository: "No workspace repository is open to record a review result in.",
        },
      ),
      // Record Verification Evidence: the checks go the same way — a temporary
      // file, removed afterwards — so a command line or a pasted log is never argv
      // and never shell text. The extension runs none of the checks.
      runVerificationCommand: payloadCommandPort(
        () => controller.root,
        (args, cwd) => new Runner(executable).runJson(args, { cwd, timeoutMs: 30_000 }),
        {
          command: "record-verification",
          prefix: "bugpilot-verification",
          noRepository: "No workspace repository is open to record verification evidence in.",
        },
      ),
      // Improving a hint reads the issue and asks an AI CLI; it never builds
      // context, and it never runs when there is no repository to read from.
      loadIssueDetails: async (issueKey) => {
        const root = controller.root;
        if (!root) return undefined;
        const environment = await credentials.environment();
        const runJson = (args: readonly string[]) =>
          new Runner(executable).runJson(args, { cwd: root, env: environment, timeoutMs: 30_000 });
        return loadIssueDetails(runJson, issueKey);
      },
      improveHint: improveHintWithProvider,
      // Review with AI's captured one-shot run: the agent's own argv, the prompt
      // on stdin, the repository as cwd, stdout read at exit. No terminal.
      runCapturedReview,
      // The shown work item's `.ai/<id>/`, and nothing wider: an agent's
      // fix_report.md shows up without a reload (§37.81).
      watchArtifacts: watchArtifactDirectory,
      // Repository Files' quick fix: the open .gitignore through the editor,
      // the file through VS Code's file system (§37.85).
      gitignore: createGitignoreIo(),
      reviewedFixes: reviewedFixStore(
        () => context.workspaceState.get(REVIEWED_FIXES_STATE_KEY),
        (value) => void context.workspaceState.update(REVIEWED_FIXES_STATE_KEY, value),
      ),
      canRun,
      extensions: createExtensionsPort(),
      // Pasted and dropped attachments, kept beside the long-description file.
      storeAttachment: createAttachmentStore(storageRoot),
      lastAgent: {
        get: () => context.globalState.get<string>(LAST_AGENT_STATE_KEY),
        set: (id) => void context.globalState.update(LAST_AGENT_STATE_KEY, id),
      },
    },
    // Through `restoreForm`, so a choice saved by an older version — `claude` —
    // comes back as the agent it meant rather than as Auto-detect.
    restoreForm(context.workspaceState.get<FormState>(FORM_STATE_KEY)),
  );

  results = new ResultsTree(
    {
      artifacts: () => controller.artifacts,
      history: async () => {
        const root = controller.root;
        if (!root) return { kind: "empty", detail: "Open the repository you are fixing bugs in." };
        return loadHistory(root, (args) =>
          new Runner(executable).runJson(args, { cwd: root, timeoutMs: 30_000 }),
        );
      },
      // State the controller already holds: no probe, no request (§37.110).
      diagnostics: () => controller.diagnostics,
      now: Date.now,
    },
    () => controller.workItemId,
  );

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(VIEWS.panel, panel.provider, {
      // The page restores its own form from setState, so there is nothing to
      // keep resident (§5.4).
      webviewOptions: { retainContextWhenHidden: false },
    }),
    vscode.window.createTreeView(VIEWS.results, { treeDataProvider: results }),
    // The tree view owns its own disposal, but not the emitter we handed it.
    results,
    // The artifact watcher and any refresh still scheduled (§37.81).
    { dispose: () => controller.dispose() },
    // A folder opened or removed changes the answer to "which repository", and
    // a changed executable path changes which binary runs. Without these the
    // panel keeps showing a stale answer until Check Environment is run by
    // hand — including the common case of opening a folder in an empty window.
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      void controller.refreshEnvironment();
    }),
    // An AI extension installed, removed, enabled or disabled: what Auto-detect
    // found may be wrong now.
    vscode.extensions.onDidChange(() => {
      void controller.agentsChanged();
    }),
    vscode.workspace.onDidChangeConfiguration((event) => {
      if (event.affectsConfiguration(`${SETTINGS.section}.${SETTINGS.executablePath}`)) {
        void controller.refreshEnvironment();
      }
    }),
    // The repository's own .gitignore saved: what git ignores may have changed,
    // and a quick fix left in an unsaved buffer lands now (§37.85).
    vscode.workspace.onDidSaveTextDocument((document) => {
      const root = controller.root;
      if (root === undefined || document.uri.scheme !== "file") return;
      const relative = path.relative(root, document.uri.fsPath);
      if ((process.platform === "win32" ? relative.toLowerCase() : relative) !== ".gitignore") return;
      void controller.gitignoreSaved().catch((error: unknown) => {
        log.error(`Re-checking .gitignore failed: ${(error as Error).message}`);
      });
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
    setCredentials(credentials, log, () => controller.credentialsSaved()),
  );

  register(COMMANDS.openSettings, async () => {
    // Filtered to this extension's own section rather than the whole settings
    // page: the button exists because something is misconfigured, and landing
    // on three thousand unrelated settings is not an answer.
    await vscode.commands.executeCommand("workbench.action.openSettings", `@ext:${EXTENSION_ID}`);
  });

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
      results?.refreshCurrent();
    }
    await action();
  };

  register(COMMANDS.retry, (argument: never) => onWorkItem(argument, () => controller.retry()));
  register(COMMANDS.openAgentTask, (argument: never) =>
    onWorkItem(argument, () => controller.openArtifact(TASK_ARTIFACT)),
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
  // The manual fallback: the same read every automatic refresh makes, and the
  // trees with it.
  register(COMMANDS.refreshViews, async () => {
    await controller.refreshActiveWorkItem();
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
    // The controller asks (modal) and runs it, because it owns the one guard for
    // artifact writes: no clean over a review or verification recording in
    // flight, and no recording or run while the clean runs (Batch 12).
    const cleaned = await controller.clean(workItemId, async () => {
      await runText(executable, root, ["clean", workItemId], channel, log);
    });
    if (!cleaned) return;
    results?.refresh();
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
      // run.json — which only works if the window remembers which
      // work item to read it from.
      const last = context.workspaceState.get<string>(WORK_ITEM_STATE_KEY);
      if (last === undefined) return undefined;
      // Checked here, quietly, and cleared: `showWorkItem` would refuse it with
      // a warning, and a saved value nobody can see would repeat that warning
      // at every start-up (§37.70).
      if (!isWorkItemId(last)) {
        log.error(`Forgetting a saved work item whose id is not one ${rejectedValueForLog(last)}.`);
        return context.workspaceState.update(WORK_ITEM_STATE_KEY, undefined);
      }
      return controller.showWorkItem(last);
    })
    .catch((error: unknown) => log.error(`Start-up failed: ${(error as Error).message}`));
  // Which AI agents this machine has, for the picker's status line: once, in
  // the background, cached. A `--version` per CLI and a manifest read per
  // extension; never an agent run and never a terminal.
  void controller.detectAgents();
  // Old pasted and dropped attachments nobody references any more (§37.100):
  // once a session, after start-up has settled, in the background. Never on a
  // paste, never on a timer after that.
  const collect = setTimeout(() => {
    void attachmentGcTracking.then((trackingSince) =>
      runAttachmentGc({
        storageRoot,
        registry: attachmentReferences,
        current: restoreForm(context.workspaceState.get<FormState>(FORM_STATE_KEY)).attachments,
        trackingSince,
        log,
      }),
    );
  }, ATTACHMENT_GC_DELAY_MS);
  // Waited for by nothing: a host shutting down does not stay up for it.
  collect.unref();
  context.subscriptions.push({ dispose: () => clearTimeout(collect) });
}

/** How long after activation the one attachment collection waits. */
const ATTACHMENT_GC_DELAY_MS = 30_000;

/**
 * This window's workspace, as a key that names no path: the workspace file, or
 * its folders, hashed. A window whose folders change gets a new key, and the
 * old one's references stay recorded — kept, never collected.
 */
function workspaceReferenceId(): string {
  const workspace = vscode.workspace.workspaceFile?.toString()
    ?? (vscode.workspace.workspaceFolders ?? []).map((folder) => folder.uri.toString()).join("\n");
  return createHash("sha256").update(workspace === "" ? "no-folder" : workspace).digest("hex").slice(0, 16);
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
  // Through the same rule as the panel's runs: a work item typed into the
  // palette's box is shown only if it is one (§37.95).
  channel.appendLine(`$ ${commandForLog(args)}`);
  try {
    const result = await new Runner(executable).run(args, { cwd: root, timeoutMs: 120_000 });
    for (const line of `${result.stdout}${result.stderr}`.split("\n")) {
      if (line.trim() !== "") channel.appendLine(`  ${line}`);
    }
    channel.appendLine(`  exit ${result.code ?? "aborted"}`);
    channel.show(true);
  } catch (error) {
    const reason = redactKnown((error as Error).message, sensitiveValues(args));
    log.error(`${commandForLog(args)} failed: ${reason}`);
    vscode.window.showErrorMessage(`BugPilot could not run ${args[0]}: ${reason}`);
  }
}

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}
