/**
 * The extension's state machine: what happens when the developer presses Run.
 *
 * Everything the panel can ask for arrives here as a validated `PanelMessage`,
 * and everything the panel shows leaves here as a `PanelState`. The editor is
 * reached through four narrow ports (run a process, touch files, talk to the
 * developer, log), so this whole flow — including cancellation, failure
 * rendering, and the retry loop — is testable without VS Code.
 *
 * The retry path is the part worth reading twice. `bug --retry` is not a second
 * Run: the first invocation only creates `user_feedback.md` and stops, because
 * the developer's account of what went wrong is the single input that loop
 * exists to carry (§5.6). Handing an agent an unfilled template would defeat
 * the point, so the controller opens the file and waits for a second press.
 */

import path from "node:path";

import { buildPrepareArgs, buildRetryArgs, canFixWithAI, effectivePlan, DEFAULT_FORM, workItemScopeOf, MANUAL_WORK_ITEM_SCOPE } from "./form.ts";
import type { FieldProblem, FormState } from "./form.ts";
import { resolveAgent } from "./agents.ts";
import { buildWorkflow, overallStatus } from "./workflow.ts";
import type { FixWithAiOutcome } from "./workflow.ts";
import { ProgressTracker, viewFromStatus } from "./progress.ts";
import type { ProgressView } from "./progress.ts";
import { buildArtifactList } from "./artifacts.ts";
import type { ArtifactList } from "./artifacts.ts";
import { COMMANDS } from "../commands.ts";
import { diagnose } from "../errors.ts";
import type { Environment } from "./environment.ts";
import {
  deleteArgsFor,
  draftFromDefinition,
  payloadFromDraft,
  preparedFixModeFromStatus,
  saveArgsForDraft,
  selectedFixModeId,
  suggestedCopyId,
} from "./fixModes.ts";
import type {
  FixModeCatalog,
  FixModeDraft,
  ManagedFixMode,
  ManagedFixModes,
  PreparedFixMode,
} from "./fixModes.ts";
import type { Log } from "./log.ts";
import type { Envelope, StreamEvent } from "../protocol.ts";
import { MAX_ATTACHMENTS } from "../panel/messages.ts";
import type { Notice, PanelMessage, PanelState, Readiness } from "../panel/messages.ts";

export interface RunOptions {
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
}

/** The slice of `Runner` this needs, so a test can supply a scripted process. */
export interface RunnerPort {
  runStreaming(
    args: readonly string[],
    options: RunOptions,
    onEvent: (event: StreamEvent) => void,
  ): Promise<{
    result: { code: number | null; stdout: string; stderr: string; aborted: boolean };
    terminated: boolean;
    events: StreamEvent[];
    foreignVersion?: number;
  }>;
  runJson(args: readonly string[], options: RunOptions): Promise<Envelope>;
}

/**
 * The result of listing an artifact directory.
 *
 * `missing` and `unreadable` are kept apart because they mean opposite things
 * to a developer: the first is the normal state before a run, the second is a
 * permission or filesystem problem they have to fix. Collapsing both into an
 * empty list is what made the "`.ai/` 不可读" state of §5.4 unreachable.
 */
export type DirectoryListing =
  | { readonly kind: "ok"; readonly names: readonly string[] }
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable"; readonly detail: string };

export interface FilesPort {
  listDirectory(directory: string): Promise<DirectoryListing>;
  readFile(file: string): Promise<string | undefined>;
  writeFile(file: string, contents: string): Promise<void>;
}

export interface UiPort {
  /** Push a new state to the panel. */
  render(state: PanelState): void;
  openFile(file: string): Promise<void>;
  copyToClipboard(text: string): Promise<void>;
  /** A yes/no the developer must answer before something destructive happens. */
  confirm(message: string, confirmLabel: string): Promise<boolean>;
  notify(kind: "info" | "warning" | "error", message: string): void;
  /** Ask the host to re-read the trees, after a run changed `.ai/`. */
  refreshViews(): void;
  /** Run the credential prompt, which lives in the host with SecretStorage. */
  editCredentials(): Promise<void>;
  /** Open a terminal in `cwd` and run one command line in it. */
  runInTerminal(name: string, cwd: string, commandLine: string): void;
  /** Reveal a directory in the editor's own explorer. */
  openFolder(directory: string): Promise<void>;
  /**
   * Ask the developer for files to attach, through the editor's own dialog.
   *
   * In the host, not the page: a webview must never be able to name a path on
   * disk, and this way every attachment traces back to a dialog somebody
   * clicked through.
   */
  pickFiles(): Promise<readonly string[]>;
  /**
   * Bring an installed agent's own view forward, if there is one.
   *
   * Returns false when there is nothing to reveal. Which commands those are is
   * the host's business: the ids belong to other extensions, and keeping them
   * there also keeps them out of the command allowlist the page is checked
   * against.
   */
  revealAgentPanel(): Promise<boolean>;
  /**
   * Execute one of the extension's own commands.
   *
   * Used for the buttons on the blocked card, whose command ids the host itself
   * put into `readiness.actions`. The controller re-checks the id against
   * `COMMANDS` before calling this, because the round trip goes through the
   * page and a page is not to be trusted with the editor's command registry.
   */
  runCommand(commandId: string): Promise<void>;
}

export interface ControllerPorts {
  readonly runner: RunnerPort;
  readonly files: FilesPort;
  readonly ui: UiPort;
  readonly log: Log;
  /** Re-resolved per run: a folder can be added or the setting changed. */
  readonly environment: () => Promise<Environment>;
  readonly credentials: () => Promise<{ configured: boolean; environment: Record<string, string> }>;
  /** Where a description too long for argv is written. */
  readonly descriptionFilePath: () => string;
  readonly now?: () => number;
  /** Persist the form so a reopened window starts where the developer left off. */
  readonly saveForm?: (form: FormState) => void;
  /**
   * Whether an executable can be started at all.
   *
   * Asked before offering to run an agent in a terminal: a terminal that prints
   * "command not found" reads as a bug in this extension.
   */
  readonly canRun?: (executable: string) => Promise<boolean>;
  /**
   * Persist which work item is being shown.
   *
   * §5.4 requires the progress view to come back after a restart, and
   * `workflow_status.json` is the only record that survives the process — but
   * only if the window remembers *which* work item to read it from.
   */
  readonly saveWorkItem?: (workItemId: string) => void;
  /**
   * The AI Fix Modes this bugpilot offers.
   *
   * A port rather than a `runner.runJson` call inline, for the same reason the
   * history list is one: the spawn belongs to the host, and this way exactly one
   * place in the extension knows the discovery command. Absent — an older host,
   * or a test that does not care — means the catalog is unavailable, never a
   * list invented here.
   */
  readonly listFixModes?: () => Promise<FixModeCatalog>;
  /** Every physical definition, for the management view. */
  readonly listManagedFixModes?: () => Promise<ManagedFixModes>;
  /** One management command, with its definition written to a temporary file. */
  readonly runFixModeCommand?: (request: FixModeRequest) => Promise<Envelope>;
}

/**
 * A Fix Mode management command, and the definition it carries.
 *
 * `args` is a function of the payload's path because the host decides where
 * that file goes: six multiline sections have no business on a command line,
 * and a path is the only part of them the process ever sees.
 */
export interface FixModeRequest {
  readonly args: (payloadPath: string) => readonly string[];
  readonly payload?: unknown;
}

/** What the management list can ask for. Delete is the only destructive one. */
export const FIX_MODE_ACTIONS = ["view", "edit", "duplicate", "delete"] as const;
export type FixModeActionId = (typeof FIX_MODE_ACTIONS)[number];

const RUN_TIMEOUT_MS = 15 * 60 * 1000;

/**
 * What `doctor`'s report is worth saying out loud.
 *
 * Only things that are true, actionable, and cheaper to hear now than later.
 * A missing ripgrep is not here: the run reports that itself, per step.
 */
export function warningsFromReport(report: Record<string, unknown>): Notice[] {
  const warnings: Notice[] = [];
  // There is no built-in Jira site any more — a package anyone can install must
  // not ship one company's tenant as everyone's default. The consequence lands
  // here: setting the credentials in this panel is no longer enough on its own,
  // and finding that out from a failed fetch step would be a worse way to learn
  // it than a card that is already on screen.
  if (report["jira_base_url_present"] === false) {
    warnings.push({
      title: "Jira Site",
      message:
        "No Jira site is configured, so an issue key cannot be fetched. Run `bugpilot setup`, or set JIRA_BASE_URL. A bug you describe by hand needs neither.",
    });
  }
  if (report["ai_artifacts_ignored"] === false) {
    // `docs/safety.md` forbids the *agent* from committing these; nothing
    // stopped a developer, and one of the files holds fetched Jira content.
    warnings.push({
      title: "Repository Files",
      message:
        "This repository does not ignore .ai/ and .ai_memory/. Add both to .gitignore, or generated artifacts — including fetched Jira content — may appear in your commits.",
    });
  }
  return warnings;
}

export class Controller {
  readonly #ports: ControllerPorts;
  #form: FormState;
  #revision = 0;
  #problems: readonly FieldProblem[] = [];
  #progress: ProgressView = { state: "idle", rows: viewFromStatus(undefined).rows, artifacts: [] };
  #artifacts: ArtifactList = { kind: "empty", detail: "No work item selected yet." };
  /**
   * The file names in the current work item's directory.
   *
   * Kept beside the grouped list because the workflow rows ask a different
   * question of it — "is the file this icon opens there?" — and the grouped
   * form has already thrown the flat list away.
   */
  #artifactNames: readonly string[] = [];
  #workItemId: string | undefined;
  /**
   * How the AI step ended, when it has been attempted.
   *
   * Undefined rather than a neutral value, because "not attempted" and
   * "attempted and did nothing" are different rows on screen.
   */
  #fix: FixWithAiOutcome | undefined;
  #canRetry = false;
  #readiness: Readiness = { kind: "checking" };
  #root: string | undefined;
  #jiraConfigured = false;
  #warnings: readonly Notice[] = [];
  /**
   * The Fix Mode catalog, read once per environment resolution.
   *
   * Not per render and not per keystroke: this spawns a process, and the answer
   * only changes when the executable does — which is exactly when the
   * environment is re-probed.
   */
  #fixModes: FixModeCatalog = { kind: "loading" };
  /** What the work item on screen was actually prepared with, if anything. */
  #preparedFixMode: PreparedFixMode | undefined;
  /** Whether the management view is open, and what it is showing. */
  #manageOpen = false;
  #managed: ManagedFixModes = { kind: "loading" };
  /** The mode being viewed or edited, if any. */
  #editor: FixModeDraft | undefined;
  /** Why the last management command was refused, kept beside the editor. */
  #manageError: string | undefined;
  /**
   * The work item the current Fix Mode selection was derived for.
   *
   * A Fix Mode belongs to a bug, not to the panel. Without this, changing the
   * issue key in the form left the previous work item's mode selected, and the
   * next run prepared a different bug under a workflow nobody chose for it —
   * while the tree-driven path re-derived correctly, so the two ways of
   * switching disagreed.
   */
  #fixModeWorkItem: string | undefined;
  #abort: AbortController | undefined;
  #running = false;
  /**
   * Whether this run's abort came from the developer.
   *
   * The Runner reports `aborted` for both a Stop and a timeout, so without
   * this a run that took longer than `RUN_TIMEOUT_MS` is reported as if
   * someone had clicked Stop — which hides the real problem and suggests the
   * developer did something they did not.
   */
  #stoppedByUser = false;
  /**
   * The command ids the host actually handed the page.
   *
   * The page can only ask for these. Validating against the whole `COMMANDS`
   * table would also accept `bugpilot.clean` and `bugpilot.clearCredentials`,
   * which the page is never offered and has no business requesting.
   */
  #offered = new Set<string>();
  /**
   * The environment probe in flight, if any.
   *
   * The probe spawns `doctor --json`. Folder changes, configuration changes,
   * activation and every Run can all ask for one within a few milliseconds of
   * each other, and a frozen executable takes seconds to answer — so callers
   * share one answer instead of starting a queue of identical processes.
   */
  #probe: Promise<void> | undefined;

  constructor(ports: ControllerPorts, initialForm: FormState = DEFAULT_FORM) {
    this.#ports = ports;
    this.#form = initialForm;
  }

  get workItemId(): string | undefined {
    return this.#workItemId;
  }

  get root(): string | undefined {
    return this.#root;
  }

  /** The artifact list the tree view renders. */
  get artifacts(): ArtifactList {
    return this.#artifacts;
  }

  /** Resolve the environment and push a first state. Safe to call repeatedly. */
  refreshEnvironment(): Promise<void> {
    if (this.#probe) return this.#probe;
    const probe = this.#resolveEnvironment().finally(() => {
      if (this.#probe === probe) this.#probe = undefined;
    });
    this.#probe = probe;
    return probe;
  }

  async #resolveEnvironment(): Promise<void> {
    const environment = await this.#ports.environment();
    const credentials = await this.#ports.credentials();
    this.#jiraConfigured = credentials.configured;
    this.#warnings = environment.kind === "ready" ? warningsFromReport(environment.report) : [];
    if (environment.kind === "ready") {
      this.#root = environment.root;
      this.#readiness = {
        kind: "ready",
        executable: environment.executable,
        root: environment.root,
        ...(environment.version === undefined ? {} : { version: environment.version }),
      };
    } else if (environment.kind === "unusable-cli") {
      this.#root = environment.root;
      this.#readiness = {
        kind: "blocked",
        summary: environment.summary,
        action: environment.action,
        actions: environment.actions,
      };
    } else if (environment.kind === "no-folder") {
      this.#root = undefined;
      this.#readiness = { kind: "blocked", summary: environment.summary, actions: [] };
    } else {
      this.#root = undefined;
      this.#readiness = {
        kind: "blocked",
        summary: "Several repositories are open. Pick the one BugPilot should work on.",
        actions: [{ title: "Choose Repository", command: COMMANDS.checkEnvironment }],
      };
    }
    this.#offered =
      this.#readiness.kind === "blocked"
        ? new Set(this.#readiness.actions.map((action) => action.command))
        : new Set();
    await this.#loadFixModes();
    // The revision is deliberately *not* bumped here. Bumping it makes the page
    // rewrite every field from the host's copy, which moves the caret and
    // discards anything typed inside the 400ms `formChanged` debounce — and
    // this runs on credential changes, executable changes and every Run. The
    // page asks for the form itself when it loads, with a `ready` message.
    this.#push();
  }

  async handle(message: PanelMessage): Promise<void> {
    switch (message.type) {
      case "ready":
        this.#revision += 1;
        this.#push();
        return;
      case "formChanged":
        await this.#formChanged(message.form);
        return;
      case "addAttachments":
        await this.addAttachments(message.form);
        return;
      case "run":
        await this.run(message.form);
        return;
      case "stop":
        this.stop();
        return;
      case "retry":
        await this.retry();
        return;
      case "openArtifact":
        await this.openArtifact(message.name);
        return;
      case "manageFixModes":
        await this.openFixModeManager();
        return;
      case "closeFixModes":
        this.closeFixModeManager();
        return;
      case "fixModeAction":
        await this.fixModeAction(message.action, message.id, message.scope);
        return;
      case "saveFixMode":
        await this.saveFixMode(message.draft);
        return;
      case "action":
        if (message.id === "openContext") await this.openArtifact("bug_context.md");
        else if (message.id === "copyHandoff") await this.copyHandoff();
        else if (message.id === "openFolder") await this.openArtifactsFolder();
        else if (message.id === "fixWithAI") await this.fixWithAI();
        else await this.#ports.ui.editCredentials();
        return;
      case "command": {
        // Only ids this host offered in `readiness.actions`, and only while the
        // offer stands. Executing an arbitrary editor command on a webview's
        // word is a privilege the page must not have.
        if (!this.#offered.has(message.id)) {
          this.#ports.log.error(`Refusing to run a command the page asked for: ${message.id}`);
          return;
        }
        await this.#ports.ui.runCommand(message.id);
        return;
      }
    }
  }

  /** Prepare a bug. Rejects nothing: problems are rendered, not thrown. */
  async run(form: FormState): Promise<void> {
    if (this.#running) return;
    this.#form = form;
    this.#ports.saveForm?.(form);

    if (this.#readiness.kind !== "ready" || !this.#root) {
      // Re-check first: the developer may have installed bugpilot since the
      // panel was opened, and refusing on stale state would be infuriating.
      await this.refreshEnvironment();
      if (this.#readiness.kind !== "ready" || !this.#root) return;
    }
    const root = this.#root;

    const built = buildPrepareArgs(form, {
      root,
      descriptionFilePath: this.#ports.descriptionFilePath(),
    });
    if (!built.ok) {
      this.#problems = built.problems;
      this.#push();
      return;
    }
    this.#problems = [];

    if (form.fresh) {
      const confirmed = await this.#ports.ui.confirm(
        "Delete the previous artifacts for this work item before running? Anything an agent wrote, including fix_summary.md, is removed.",
        "Delete and run",
      );
      if (!confirmed) return;
    }

    for (const file of built.files) await this.#ports.files.writeFile(file.path, file.contents);

    const tracker = new ProgressTracker(effectivePlan(form.plan), this.#ports.now);
    let runWarnings: readonly string[] = [];
    const abort = new AbortController();
    this.#abort = abort;
    this.#running = true;
    this.#stoppedByUser = false;
    if (form.source === "jira") this.#setWorkItem(form.issueKey.trim().toUpperCase());
    else {
      // A hand-written bug's id arrives with the `started` event. Until then
      // there is no current work item — and leaving the previous one's artifact
      // list on screen would offer files that `openArtifact` then refuses.
      this.#workItemId = undefined;
      this.#artifacts = { kind: "empty", detail: "Preparing…" };
      this.#artifactNames = [];
    }
    this.#canRetry = false;
    // A previous run's handoff says nothing about this one.
    this.#fix = undefined;
    this.#progress = tracker.view();
    this.#push();

    const credentials = await this.#ports.credentials();
    this.#jiraConfigured = credentials.configured;
    this.#ports.log.info(`bugpilot ${built.args.join(" ")}`);

    try {
      const outcome = await this.#ports.runner.runStreaming(
        built.args,
        {
          cwd: root,
          // The token reaches the CLI here and nowhere else; it never appears in
          // argv and never crosses into the webview.
          env: credentials.environment,
          signal: abort.signal,
          timeoutMs: RUN_TIMEOUT_MS,
        },
        (event) => {
          tracker.apply(event);
          // Things the run did differently than asked — an attachment that had
          // vanished by the time it was copied, so far. Not a failure, and not
          // something to leave in a log file: the developer chose three files
          // and got two.
          if (event.type === "completed" && event.warnings) {
            runWarnings = event.warnings.filter((entry) => typeof entry === "string");
          }
          if (event.type === "started" && typeof event.work_item_id === "string") {
            // A hand-written bug's id is minted by the CLI, so this is the only
            // place the extension learns it.
            this.#setWorkItem(event.work_item_id);
          }
          this.#progress = tracker.view();
          this.#push();
        },
      );

      if (outcome.foreignVersion !== undefined) tracker.foreign(outcome.foreignVersion);
      else if (!outcome.terminated) {
        tracker.interrupted(
          outcome.result.aborted ? (this.#stoppedByUser ? "stopped" : "timeout") : "crashed",
        );
        if (!outcome.result.aborted && outcome.result.stderr.trim() !== "") {
          this.#ports.log.error(outcome.result.stderr.trim());
        }
      }
      this.#progress = tracker.view();
    } catch (error) {
      // A spawn failure, or output that broke the contract outright.
      tracker.interrupted("crashed");
      this.#progress = tracker.view();
      this.#ports.log.error(`bugpilot could not run: ${(error as Error).message}`);
      this.#ports.ui.notify("error", `bugpilot could not run: ${(error as Error).message}`);
    } finally {
      this.#running = false;
      this.#abort = undefined;
    }

    for (const warning of runWarnings) this.#ports.ui.notify("warning", warning);

    // canRetry is decided by refreshArtifacts, from whether a package exists.
    await this.refreshArtifacts();
    // What the run actually prepared, read back from its own status file rather
    // than assumed from the form: the two agree here, and the panel should be
    // reporting the package either way.
    if (this.#workItemId) await this.#loadPreparedFixMode(this.#workItemId);
    this.#ports.ui.refreshViews();

    // The last row of the workflow, and the only one this extension performs
    // itself. Reached only when the developer ticked it *and* the run produced
    // something to hand over — a prompt pointing at artifacts that a failed run
    // never wrote would send an agent looking for a missing file.
    if (canFixWithAI(form)) {
      if (this.#progress.state === "done") await this.fixWithAI();
      else {
        this.#fix = {
          status: "skipped",
          detail: "The run did not finish, so nothing was handed to an agent.",
        };
      }
    }
    this.#push();
  }

  stop(): void {
    if (!this.#abort) return;
    this.#ports.log.info("Stopping the bugpilot run.");
    this.#stoppedByUser = true;
    this.#abort.abort();
  }

  /**
   * Second attempt: `bug <id> --retry`.
   *
   * The CLI reports `feedback_created` when it had to create the template. That
   * is the signal to stop and let the developer write what went wrong, rather
   * than handing an agent a file full of placeholders.
   */
  async retry(): Promise<void> {
    const workItemId = this.#workItemId;
    if (!workItemId || !this.#root || this.#running) return;

    const credentials = await this.#ports.credentials();
    try {
      const envelope = await this.#ports.runner.runJson(buildRetryArgs(workItemId), {
        cwd: this.#root,
        env: credentials.environment,
        timeoutMs: 60_000,
      });
      if (!envelope.ok) {
        const diagnosis = diagnose(envelope.error.code, envelope.error.message);
        this.#ports.ui.notify("error", diagnosis.action ? `${diagnosis.summary} ${diagnosis.action}` : diagnosis.summary);
        return;
      }
      const created = envelope["feedback_created"] === true;
      // First press: the template was just written, so that is the file to open
      // and the developer's account of the failure is what the loop is waiting
      // for. Second press: the package is built, so open the package — telling
      // someone to hand off agent_retry_prompt.md while opening a different
      // file makes them go looking for it.
      const next = created ? "user_feedback.md" : "agent_retry_prompt.md";
      await this.#ports.ui.openFile(this.#itemFile(workItemId, next));
      await this.refreshArtifacts();
      this.#ports.ui.refreshViews();
      this.#push();
      this.#ports.ui.notify(
        "info",
        created
          ? "Describe what the previous attempt got wrong in user_feedback.md, save it, then press Retry again."
          : "Retry package ready. Hand agent_retry_prompt.md to your agent to try again.",
      );
    } catch (error) {
      this.#ports.ui.notify("error", `Retry failed: ${(error as Error).message}`);
    }
  }

  /** Open one artifact of the current work item. */
  async openArtifact(name: string): Promise<void> {
    const workItemId = this.#workItemId;
    if (!workItemId || !this.#root) {
      this.#ports.ui.notify("warning", "Run BugPilot first; there are no artifacts to open yet.");
      return;
    }
    // Checked again here even though the message parser already refused
    // separators: this is the call that actually opens a path, and it is also
    // reachable from the tree views.
    if (name.includes("/") || name.includes("\\") || name.includes("..")) {
      this.#ports.log.error(`Refusing to open a suspicious artifact name: ${name}`);
      return;
    }
    await this.#ports.ui.openFile(this.#itemFile(workItemId, name));
  }

  /** Put the agent handoff on the clipboard. */
  async copyHandoff(): Promise<void> {
    const workItemId = this.#workItemId;
    if (!workItemId) return;
    await this.#ports.ui.copyToClipboard(await this.#handoffText(workItemId));
    this.#ports.ui.notify("info", "Handoff prompt copied. Paste it into your agent.");
  }

  /**
   * Hand the prepared package to a coding agent and let it start working.
   *
   * A terminal, not text pushed into an agent's own panel. Claude Code — the
   * one agent extension whose manifest was actually read — contributes
   * twenty-six commands and not one of them takes a prompt, so the only way in
   * would be guessing at an undocumented argument shape that breaks on its next
   * update. A terminal is the mechanism `resumeAgentSession` already uses, it
   * works for any CLI, and it runs in the repository root — which is what
   * `agent_task.md` itself insists on.
   *
   * This is a step a person ticks, which is the whole point. The CLI's
   * automatic launch was deprecated in phase 7 because it involved a model *by
   * default* (R5); choosing it in the workflow is precisely the separate act
   * that requirement asks for, which is why the box starts empty.
   */
  async fixWithAI(): Promise<void> {
    const workItemId = this.#workItemId;
    const root = this.#root;
    if (!workItemId || !root) {
      this.#ports.ui.notify("warning", "Prepare a bug first; there is nothing to hand over yet.");
      return;
    }
    const text = await this.#handoffText(workItemId);
    const plan = await resolveAgent({
      choice: this.#form.agent,
      customCommand: this.#form.agentCommand,
      prompt: text,
      canRun: async (command) => (await this.#ports.canRun?.(command)) ?? false,
    });

    if (plan.kind === "run") {
      this.#ports.log.info(`Handing ${workItemId} to ${plan.label}: ${plan.commandLine}`);
      this.#ports.ui.runInTerminal(`Fix with AI · ${workItemId}`, root, plan.commandLine);
      // "success" means handed over, and the detail says so. The agent runs in
      // a terminal this extension does not own, so whether it *fixed* anything
      // is not knowable here and is not claimed.
      this.#fix = { status: "success", detail: `Handed to ${plan.label} in a terminal.` };
      this.#push();
      return;
    }

    // Nothing to run. Copy the prompt and put the developer in front of
    // whatever agent they do have, rather than opening a terminal that prints
    // "command not found" and reads as our failure.
    await this.#ports.ui.copyToClipboard(text);
    const revealed = await this.#ports.ui.revealAgentPanel();
    this.#fix = {
      status: "skipped",
      detail: `${plan.reason} The handoff prompt is on the clipboard instead.`,
    };
    this.#push();
    this.#ports.ui.notify(
      "info",
      revealed
        ? `${plan.reason} The handoff prompt is on the clipboard — paste it into your agent.`
        : `${plan.reason} The handoff prompt is on the clipboard; paste it into your agent, or install one.`,
    );
  }

  /**
   * Add files to the form through the editor's file dialog.
   *
   * The form arrives from the page because the host's copy can be a debounce
   * interval stale, and merging onto a stale copy would discard whatever was
   * typed in that window. Appending rather than replacing, and de-duplicated,
   * so picking the same log twice does not attach it twice.
   */
  async addAttachments(form: FormState): Promise<void> {
    const picked = await this.#ports.ui.pickFiles();
    // Cancelled. Nothing to merge, and no revision bump — which would rewrite
    // every field in the page for no reason.
    if (picked.length === 0) return;

    const merged = [...form.attachments];
    for (const path of picked) {
      if (!merged.includes(path)) merged.push(path);
    }
    this.#form = { ...form, attachments: merged.slice(0, MAX_ATTACHMENTS) };
    if (merged.length > MAX_ATTACHMENTS) {
      this.#ports.ui.notify(
        "warning",
        `BugPilot attaches at most ${MAX_ATTACHMENTS} files; the rest were not added.`,
      );
    }
    this.#ports.saveForm?.(this.#form);
    // The page owns the form, so the only way to put a picked path into it is
    // to replace the form — which is what a revision bump means.
    this.#revision += 1;
    this.#push();
  }

  /** Reveal `.ai/<work_item>/` in the explorer. */
  async openArtifactsFolder(): Promise<void> {
    const workItemId = this.#workItemId;
    if (!workItemId || !this.#root) {
      this.#ports.ui.notify("warning", "Run BugPilot first; there are no artifacts to open yet.");
      return;
    }
    await this.#ports.ui.openFolder(path.join(this.#root, ".ai", workItemId));
  }

  /** The sentence that tells an agent what to do with this package. */
  async #handoffText(workItemId: string): Promise<string> {
    const handoff = await this.#ports.files.readFile(this.#itemFile(workItemId, "agent_handoff.md"));
    return (
      handoff?.trim() ||
      // Not every plan writes a handoff file, so fall back to the instruction
      // that file would have contained rather than handing over nothing. Kept
      // identical to `handoff_prompt()` in bugpilot/core/handoff.py, which a
      // cross-language test compares against.
      `Read .ai/${workItemId}/agent_task.md and complete the workflow.`
    );
  }

  /** Re-read the artifact directory of the current work item. */
  async refreshArtifacts(): Promise<void> {
    const workItemId = this.#workItemId;
    if (!workItemId || !this.#root) return;
    // Shown while the directory is being read: on a large repository over a
    // network share this is not instant, and an empty list in the meantime
    // reads as "this run produced nothing".
    this.#artifacts = { kind: "loading" };
    this.#push();
    const listing = await this.#ports.files.listDirectory(
      path.join(this.#root, ".ai", workItemId),
    );
    if (listing.kind === "unreadable") {
      this.#artifactNames = [];
      this.#artifacts = {
        kind: "error",
        detail: `.ai/${workItemId}/ could not be read: ${listing.detail}`,
      };
      this.#push();
      return;
    }
    const names = listing.kind === "ok" ? listing.names : [];
    this.#artifactNames = names;
    this.#artifacts = buildArtifactList({ names });
    // Retry needs a package to retry: `bug --retry` reads the prepared
    // artifacts, so offering it after a run that was stopped before producing
    // any would send the developer into WORK_ITEM_NOT_FOUND.
    this.#canRetry = names.includes("agent_task.md");
    // Pushed here rather than only by the callers: `refreshArtifacts` is also a
    // command of its own, and without this the panel keeps showing "loading".
    this.#push();
  }

  /**
   * Show a work item that was prepared earlier.
   *
   * Progress comes from `workflow_status.json`, which is the only record that
   * outlives the process (§5.1) — the event stream is gone once the run ends.
   */
  async showWorkItem(workItemId: string): Promise<void> {
    if (!this.#root) return;
    if (this.#running) {
      // Silently ignoring the click looks like a broken tree; the run owns the
      // panel until it ends.
      this.#ports.ui.notify(
        "warning",
        "A BugPilot run is in progress. Wait for it to finish, or press Stop, before opening another work item.",
      );
      return;
    }
    this.#setWorkItem(workItemId);
    const parsed = await this.#readStatus(workItemId);
    this.#progress = viewFromStatus(parsed);
    this.#preparedFixMode = preparedFixModeFromStatus(parsed, this.#fixModes);
    this.#deriveFixModeFor(workItemId, this.#preparedFixMode);
    await this.refreshArtifacts();
    this.#push();
  }

  /**
   * Read the Fix Mode catalog, and keep the developer's choice if it survived.
   *
   * Only when the CLI is usable: asking a blocked environment for a mode list
   * spawns a process that is already known to fail, and the answer would be an
   * error card the blocked card already showed.
   */
  async #loadFixModes(): Promise<void> {
    if (this.#readiness.kind !== "ready") {
      this.#fixModes = {
        kind: "unavailable",
        detail: "BugPilot is not ready, so its AI Fix Modes could not be read.",
      };
      return;
    }
    if (!this.#ports.listFixModes) {
      this.#fixModes = {
        kind: "unavailable",
        detail: "This BugPilot version does not expose AI Fix Modes. Update BugPilot to choose one.",
      };
      return;
    }
    this.#fixModes = await this.#ports.listFixModes();
    // The selection is normalized against the catalog that just arrived: an id
    // the registry no longer offers falls back to the CLI's declared default
    // rather than being sent to a run that would reject it.
    const selected = selectedFixModeId(this.#fixModes, this.#form.fixModeId);
    if (selected !== this.#form.fixModeId) this.#replaceForm({ ...this.#form, fixModeId: selected });
  }

  // --- managing custom Fix Modes ---------------------------------------------

  /** Open the management view and read what is on disk. */
  async openFixModeManager(): Promise<void> {
    this.#manageOpen = true;
    this.#editor = undefined;
    this.#manageError = undefined;
    this.#managed = { kind: "loading" };
    this.#push();
    await this.#refreshManaged();
  }

  closeFixModeManager(): void {
    this.#manageOpen = false;
    this.#editor = undefined;
    this.#manageError = undefined;
    this.#push();
  }

  /**
   * View, edit, duplicate or delete one definition.
   *
   * Addressed by id *and* scope, never by id alone: when a project mode shadows
   * a user mode of the same name, resolving through the effective registry
   * would make the shadowed one impossible to open or remove.
   */
  async fixModeAction(action: FixModeActionId, id: string, scope: string): Promise<void> {
    if (action === "delete") {
      await this.#deleteFixMode(id, scope);
      return;
    }
    const definition = await this.#showFixMode(id, scope);
    if (!definition) return;
    if (action === "duplicate") {
      const taken = this.#knownModeIds();
      // A suggestion, not a decision: core validates the id the developer keeps.
      this.#editor = {
        ...definition,
        intent: "create",
        id: suggestedCopyId(definition.id, taken),
        name: `${definition.name} (copy)`,
        scope: scope === "project" ? "project" : "user",
        version: 0,
        basedOn: definition.id,
        basedOnVersion: definition.version,
      };
    } else {
      this.#editor = {
        ...definition,
        // A built-in can be read and copied, never written: it is packaged, and
        // the developer's own version of it is what `duplicate` is for.
        intent: scope === "builtin" ? "view" : "edit",
      };
    }
    this.#manageError = undefined;
    this.#push();
  }

  /**
   * Write a draft back, and keep the editor open if core refuses it.
   *
   * A rejected save — a stale version, a heading in a section, an id already
   * taken — must not cost the developer what they typed. The draft stays on
   * screen with the reason beside it.
   */
  async saveFixMode(draft: FixModeDraft): Promise<void> {
    if (draft.intent === "view") return;
    const envelope = await this.#runFixMode({
      args: (payloadPath) => saveArgsForDraft(draft, payloadPath),
      payload: payloadFromDraft(draft),
    });
    if (!envelope) return;
    if (!envelope.ok) {
      this.#editor = draft;
      this.#manageError = envelope.error.message;
      this.#push();
      return;
    }
    this.#editor = undefined;
    this.#manageError = undefined;
    await this.#refreshAfterFixModeChange();
    this.#ports.ui.notify(
      "info",
      draft.intent === "edit"
        ? `Saved Fix Mode ${draft.id}.`
        : `Created Fix Mode ${draft.id} in ${draft.scope} scope.`,
    );
  }

  async #deleteFixMode(id: string, scope: string): Promise<void> {
    const mode = this.#managedMode(id, scope);
    if (!mode) return;
    const confirmed = await this.#ports.ui.confirm(
      `Delete the ${scope} Fix Mode "${mode.name}"? Existing prepared work items using this ` +
        "Fix Mode may no longer regenerate until another mode is selected.",
      "Delete Fix Mode",
    );
    if (!confirmed) return;
    const envelope = await this.#runFixMode({ args: () => deleteArgsFor(mode) });
    if (!envelope) return;
    if (!envelope.ok) {
      // A refused delete leaves the mode where it was, and says why.
      this.#manageError = envelope.error.message;
      this.#push();
      return;
    }
    this.#manageError = undefined;
    await this.#refreshAfterFixModeChange();
  }

  /** One definition in full, from the scope that owns it. */
  async #showFixMode(id: string, scope: string): Promise<FixModeDraft | undefined> {
    const args = ["fix-mode", "show", id, "--json"];
    if (scope === "user" || scope === "project") args.splice(3, 0, `--scope=${scope}`);
    const envelope = await this.#runFixMode({ args: () => args });
    if (!envelope) return undefined;
    if (!envelope.ok) {
      this.#manageError = envelope.error.message;
      this.#push();
      return undefined;
    }
    const draft = draftFromDefinition(
      envelope,
      "view",
      scope === "project" ? "project" : "user",
    );
    if (!draft) {
      this.#manageError = "BugPilot did not describe that Fix Mode.";
      this.#push();
    }
    return draft;
  }

  async #runFixMode(request: FixModeRequest): Promise<Envelope | undefined> {
    if (!this.#ports.runFixModeCommand) {
      this.#manageError = "This BugPilot version cannot manage custom Fix Modes.";
      this.#push();
      return undefined;
    }
    try {
      return await this.#ports.runFixModeCommand(request);
    } catch (error) {
      this.#manageError = `BugPilot could not run that command: ${(error as Error).message}`;
      this.#push();
      return undefined;
    }
  }

  /**
   * Both catalogs, after anything on disk changed.
   *
   * The selector's list and the management list are two reads of the same
   * files; refreshing one would leave the other describing a mode that is gone
   * or missing one that just arrived.
   */
  async #refreshAfterFixModeChange(): Promise<void> {
    await this.#loadFixModes();
    await this.#refreshManaged();
  }

  async #refreshManaged(): Promise<void> {
    this.#managed = this.#ports.listManagedFixModes
      ? await this.#ports.listManagedFixModes()
      : { kind: "unavailable", detail: "This BugPilot version cannot manage custom Fix Modes." };
    this.#push();
  }

  #managedMode(id: string, scope: string): ManagedFixMode | undefined {
    if (this.#managed.kind !== "ready") return undefined;
    const group =
      scope === "user"
        ? this.#managed.user
        : scope === "project"
          ? this.#managed.project
          : this.#managed.builtin;
    return group.find((mode) => mode.id === id);
  }

  #knownModeIds(): string[] {
    if (this.#managed.kind !== "ready") return [];
    return [...this.#managed.builtin, ...this.#managed.user, ...this.#managed.project].map(
      (mode) => mode.id,
    );
  }

  /**
   * Store what the developer typed, and notice when it is about another bug.
   *
   * The mode is re-derived only when the work item identity actually changes —
   * not on every keystroke. Editing a hint, a keyword or a focus file leaves a
   * deliberate choice exactly where the developer put it; changing the issue
   * key is a different bug, and a different bug gets its own mode.
   */
  async #formChanged(form: FormState): Promise<void> {
    this.#form = form;
    this.#ports.saveForm?.(form);
    const scope = workItemScopeOf(form);
    // `undefined` is a half-typed key: not yet any work item, so not yet a
    // reason to conclude the developer moved to another one.
    if (scope === undefined || scope === this.#fixModeWorkItem) return;
    const prepared =
      scope === MANUAL_WORK_ITEM_SCOPE
        ? undefined
        : preparedFixModeFromStatus(await this.#readStatus(scope), this.#fixModes);
    // Only the selection follows the typed key. `#preparedFixMode` keeps
    // describing the work item whose artifacts and progress are on screen,
    // which is still the one that was opened.
    if (this.#deriveFixModeFor(scope, prepared)) this.#push();
  }

  /**
   * Point the selector at the mode this work item would run under.
   *
   * The one rule, shared by both ways of switching: a prepared mode that is
   * still available, otherwise the default the CLI declared. Returns whether
   * the selection changed, so a caller can decide whether the page needs a push.
   */
  #deriveFixModeFor(
    workItemId: string | undefined,
    prepared: PreparedFixMode | undefined,
  ): boolean {
    this.#fixModeWorkItem = workItemId;
    const inherited = prepared?.availability === "available" ? prepared.id : undefined;
    const selected = selectedFixModeId(this.#fixModes, inherited);
    if (selected === this.#form.fixModeId) return false;
    this.#replaceForm({ ...this.#form, fixModeId: selected });
    return true;
  }

  /**
   * Replace the form the page shows, which needs a new revision to take effect.
   *
   * Used sparingly: the page owns the form while the developer types, and a
   * revision bump rewrites every field. Both callers here change something the
   * developer cannot have typed — the mode a stored package was prepared with,
   * or a selection the registry no longer offers.
   */
  #replaceForm(form: FormState): void {
    this.#form = form;
    this.#revision += 1;
    this.#ports.saveForm?.(form);
  }

  /** What the work item's own status file says it was prepared with. */
  async #loadPreparedFixMode(workItemId: string): Promise<void> {
    this.#preparedFixMode = preparedFixModeFromStatus(
      await this.#readStatus(workItemId),
      this.#fixModes,
    );
  }

  async #readStatus(workItemId: string): Promise<unknown> {
    if (!this.#root) return undefined;
    const text = await this.#ports.files.readFile(
      path.join(this.#root, ".ai", workItemId, "workflow_status.json"),
    );
    try {
      return text === undefined ? undefined : JSON.parse(text);
    } catch {
      // A truncated status file is not worth failing over: it costs the mode
      // line, and the artifacts still list.
      return undefined;
    }
  }

  #setWorkItem(workItemId: string): void {
    this.#workItemId = workItemId;
    this.#ports.saveWorkItem?.(workItemId);
  }

  #itemFile(workItemId: string, name: string): string {
    return path.join(this.#root ?? "", ".ai", workItemId, name);
  }

  #push(): void {
    // Computed here rather than in the page: the page cannot import the model,
    // and a status the page derived for itself would be a second opinion about
    // what the run did.
    const workflow = buildWorkflow({
      source: this.#form.source,
      plan: effectivePlan(this.#form.plan),
      fixWithAI: canFixWithAI(this.#form),
      progress: this.#progress,
      artifacts: this.#artifactNames,
      ...(this.#fix === undefined ? {} : { fix: this.#fix }),
    });
    this.#ports.ui.render({
      revision: this.#revision,
      fixModes: this.#fixModes,
      ...(this.#preparedFixMode === undefined ? {} : { preparedFixMode: this.#preparedFixMode }),
      ...(this.#manageOpen
        ? {
            manage: {
              catalog: this.#managed,
              ...(this.#editor === undefined ? {} : { editor: this.#editor }),
              ...(this.#manageError === undefined ? {} : { error: this.#manageError }),
            },
          }
        : {}),
      readiness: this.#readiness,
      form: this.#form,
      problems: this.#problems,
      progress: this.#progress,
      workflow,
      overall: overallStatus(workflow, this.#progress),
      artifacts: this.#artifacts,
      warnings: this.#warnings,
      jiraConfigured: this.#jiraConfigured,
      canRetry: this.#canRetry,
      ...(this.#workItemId === undefined ? {} : { workItemId: this.#workItemId }),
    });
  }
}
