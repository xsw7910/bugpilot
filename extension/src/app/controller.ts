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

import { isWithin } from "../workspace.ts";

import { buildPrepareArgs, buildRetryArgs, canFixWithAI, effectivePlan, DEFAULT_FORM, workItemScopeOf, MANUAL_WORK_ITEM_SCOPE } from "./form.ts";
import {
  MAX_LISTED_FILES,
  contextCounts,
  isSafeRelativePath,
  relevantFiles,
} from "./contextSummary.ts";
import { RETRIEVAL_ARTIFACT, parseRetrieval } from "./retrieval.ts";
import { ISSUE_ARTIFACT, parseIssue } from "./issue.ts";
import type { IssueSummary } from "./issue.ts";
import type { ContextCounts, RelevantFile } from "./contextSummary.ts";
import type { FieldProblem, FormState } from "./form.ts";
import { resolveAgent } from "./agents.ts";
import { buildWorkflow, canOpenFolder, overallStatus } from "./workflow.ts";
import type { FixWithAiOutcome } from "./workflow.ts";
import type { DiagnosticsView } from "./diagnostics.ts";
import { handoffError, runError } from "./failures.ts";
import { retrievalTerms } from "./retrievalDetails.ts";
import { diagnostics } from "./diagnostics.ts";
import type { ResolvedAgent } from "./diagnostics.ts";
import type { RetrievalTerm } from "./retrievalDetails.ts";
import type { UserFacingError } from "./failures.ts";
import {
  buildHintPrompt,
  cleanImprovedHint,
  hintCacheKey,
  resolveHintProvider,
} from "./hintImprovement.ts";
import type { HintContext, HintProvider, IssueDetails } from "./hintImprovement.ts";
import { ProgressTracker, viewFromStatus } from "./progress.ts";
import type { ProgressView } from "./progress.ts";
import { CONTEXT_ARTIFACT, RUN_ARTIFACT, TASK_ARTIFACT, buildArtifactList } from "./artifacts.ts";
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
import type {
  CreatedFixMode,
  Notice,
  PanelAction,
  PanelMessage,
  PanelState,
  Readiness,
} from "../panel/messages.ts";

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
   * `run.json` is the only record that survives the process — but
   * only if the window remembers *which* work item to read it from.
   */
  readonly saveWorkItem?: (workItemId: string) => void;
  /**
   * This extension's own version, which is not the CLI's.
   *
   * Passed in rather than read here: `context.extension.packageJSON` is VS
   * Code's, and the controller knows nothing about VS Code.
   */
  readonly extensionVersion?: string | undefined;
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
  /**
   * One issue's title and description, for improving a hint.
   *
   * `bugpilot issue-details --json`: the same Jira client a run uses, reading
   * only, writing nothing. A port rather than an inline call so the spawn stays
   * with the host, and so a test can answer it without a process.
   */
  readonly loadIssueDetails?: (issueKey: string) => Promise<IssueDetails | undefined>;
  /**
   * Ask an AI CLI to rewrite a hint, and read what it says.
   *
   * The prompt goes to the child on stdin, never in argv. Absent means the
   * host cannot do this at all, which the panel reports rather than pretends.
   */
  readonly improveHint?: (request: {
    readonly provider: HintProvider;
    readonly prompt: string;
  }) => Promise<{ readonly ok: true; readonly text: string } | { readonly ok: false; readonly reason: string }>;
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
  /**
   * Code search's two numbers, as the last artifact refresh read them.
   *
   * Held rather than re-read per push: `#push` runs on every stream event, and
   * a file read per event would be a lot of syscalls for a number that only
   * changes when the directory does.
   */
  #searchCounts: ContextCounts = {};
  /** `issue.json`, for the Issue details row, as the last refresh read it. */
  #issue: IssueSummary | undefined;
  /** The rows of the Relevant Files list, as the last refresh read them. */
  #files: readonly RelevantFile[] = [];
  /** How many the artifact held beyond the ones being shown. */
  #moreFiles = 0;
  /** The searched terms, as the last artifact refresh read them. */
  #terms: readonly RetrievalTerm[] = [];
  /**
   * Why the last handoff could not start.
   *
   * Held separately from `#fix`, which records what happened to the workflow's
   * last row. The same event feeds both — one as a status, one as a card — and
   * a card is what a developer can act on.
   */
  #handoffError: UserFacingError | undefined;
  /**
   * True while a handoff is being worked out.
   *
   * Resolving an agent spawns a probe per candidate and reads the handoff file,
   * so the press is not instant. Without this the button sits there looking
   * ignored, which is the thing UI-A1 fixed for Run.
   */
  #handoffBusy = false;
  #readiness: Readiness = { kind: "checking" };
  #root: string | undefined;
  #jiraConfigured = false;
  /**
   * What a handoff actually resolved, when one has run.
   *
   * Recorded where resolution already happens rather than derived from the
   * sentence it produced, and never filled in by anything else: Diagnostics
   * opening must not spend a process per candidate to answer a question nobody
   * pressed a button about.
   */
  #resolvedAgent: ResolvedAgent | undefined;
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
  /** The mode the last successful create wrote, until the developer moves on. */
  #created: CreatedFixMode | undefined;

  // --- improving a hint ------------------------------------------------------

  /** The suggestion on screen, which has not touched the form. */
  #hintSuggestion: string | undefined;
  /** True while one request is in flight, which is what stops a second. */
  #hintBusy = false;
  #hintError: string | undefined;
  /** Said when the improvement ran on the hint alone, and why. */
  #hintNotice: string | undefined;
  /** Same inputs, same answer: a repeat press costs nothing. */
  readonly #hintCache = new Map<string, string>();
  /** Issue text already fetched this session, keyed by work item. */
  readonly #issueDetails = new Map<string, IssueDetails>();
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
      case "openRelevantFile":
        await this.openRelevantFile(message.path);
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
      case "improveHint":
        await this.improveHint(message.form);
        return;
      case "useImprovedHint":
        this.useImprovedHint();
        return;
      case "dismissImprovedHint":
        this.dismissImprovedHint();
        return;
      case "saveFixMode":
        await this.saveFixMode(message.draft);
        return;
      case "action":
        if (message.id === "openContext") await this.openArtifact(CONTEXT_ARTIFACT);
        else if (message.id === "copyContext") await this.copyContext();
        else if (message.id === "openFolder") await this.openArtifactsFolder();
        else if (message.id === "fixWithAI") await this.fixWithAI();
        else await this.#ports.ui.editCredentials();
        return;
      case "command": {
        // Only ids this host is currently offering, and only while the offer
        // stands. Executing an arbitrary editor command on a webview's word is
        // a privilege the page must not have.
        if (!this.#isOffered(message.id)) {
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
        "Delete the previous artifacts for this work item before running? Anything an agent wrote, including fix_report.md, is removed.",
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
    this.#forgetSummary();
    // Both, before anything is pushed: a stale card beside a Running… button
    // reads as the new run having failed instantly.
    this.#handoffError = undefined;
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

  /** The handoff sentence, for the "Copy Handoff Prompt" command. */
  async copyHandoff(): Promise<void> {
    const workItemId = this.#workItemId;
    if (!workItemId) return;
    await this.#ports.ui.copyToClipboard(this.#handoffText(workItemId));
    this.#ports.ui.notify("info", "Handoff prompt copied. Paste it into your agent.");
  }

  /**
   * The panel's Copy: `context.md` itself, for pasting wherever it is needed.
   *
   * Read when pressed rather than cached, so it is the file on disk now — a
   * refinement may have rewritten it since the panel last looked.
   */
  async copyContext(): Promise<void> {
    const workItemId = this.#workItemId;
    if (!workItemId) return;
    const context = await this.#ports.files.readFile(this.#itemFile(workItemId, CONTEXT_ARTIFACT));
    if (context === undefined) {
      this.#ports.ui.notify("warning", `There is no ${CONTEXT_ARTIFACT} for ${workItemId} to copy yet.`);
      return;
    }
    await this.#ports.ui.copyToClipboard(context);
    this.#ports.ui.notify("info", `${CONTEXT_ARTIFACT} copied.`);
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
   * `task.md` itself insists on.
   *
   * This is a step a person ticks, which is the whole point. The CLI's
   * automatic launch was deprecated in phase 7 because it involved a model *by
   * default* (R5); choosing it in the workflow is precisely the separate act
   * that requirement asks for, which is why the box starts empty.
   */
  async fixWithAI(): Promise<void> {
    // Cleared as the attempt starts rather than when it succeeds: the developer
    // pressed the button, and the old reason is about the press before it.
    if (this.#handoffError) {
      this.#handoffError = undefined;
      this.#push();
    }
    const workItemId = this.#workItemId;
    const root = this.#root;
    if (!workItemId || !root) {
      this.#ports.ui.notify("warning", "Prepare a bug first; there is nothing to hand over yet.");
      return;
    }

    // Said before the probe rather than after it: resolving an agent spawns a
    // process per candidate, and a button that does nothing visible for half a
    // second reads as a click that was dropped.
    this.#handoffBusy = true;
    this.#push();
    try {
      await this.#handOver(workItemId, root);
    } finally {
      this.#handoffBusy = false;
      this.#push();
    }
  }

  /** The handoff itself, wrapped by `fixWithAI` so the busy flag always clears. */
  async #handOver(workItemId: string, root: string): Promise<void> {
    // The prompt points at task.md, so a package without one has nothing to
    // hand over: an agent told to read a missing file starts by looking for it.
    if (!this.#artifactNames.includes(TASK_ARTIFACT)) {
      this.#fix = {
        status: "skipped",
        detail: `No ${TASK_ARTIFACT} was prepared, so nothing was handed to an agent.`,
      };
      this.#ports.ui.notify(
        "warning",
        `There is no ${TASK_ARTIFACT} for ${workItemId}. Run BugPilot with Build context enabled first.`,
      );
      return;
    }
    const text = this.#handoffText(workItemId);
    const plan = await resolveAgent({
      choice: this.#form.agent,
      customCommand: this.#form.agentCommand,
      prompt: text,
      canRun: async (command) => (await this.#ports.canRun?.(command)) ?? false,
    });

    if (plan.kind === "run") {
      // A retry that works clears the card the previous attempt left behind.
      this.#handoffError = undefined;
      this.#resolvedAgent = { kind: "resolved", label: plan.label };
      this.#ports.log.info(`Handing ${workItemId} to ${plan.label}: ${plan.commandLine}`);
      this.#ports.ui.runInTerminal(`Fix with AI · ${workItemId}`, root, plan.commandLine);
      // "success" means handed over, and the detail says so. The agent runs in
      // a terminal this extension does not own, so whether it *fixed* anything
      // is not knowable here and is not claimed.
      this.#fix = { status: "success", detail: `Handed to ${plan.label} in a terminal.` };
      // No push here: `fixWithAI`'s `finally` does one, and pushing before it
      // would put a state on screen that is both busy and finished at once.
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
    // The same event, said twice on purpose: a status on the workflow row, and
    // a card beside the result that says what to do about it. `plan.reason` is
    // `resolveAgent`'s own sentence and is the Details text, never the headline.
    this.#resolvedAgent = { kind: "unavailable" };
    this.#handoffError = handoffError(plan.reason);
    // The push is `fixWithAI`'s, for the same reason as the success branch. A
    // notification is a toast rather than panel state, so its order is its own.
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

  /**
   * The sentence that tells an agent what to do with this package.
   *
   * One sentence, the same one the CLI launches its agent with: everything else
   * the agent needs is in `task.md`. Kept identical to `handoff_prompt()` in
   * bugpilot/core/handoff.py, which a cross-language test compares against.
   */
  #handoffText(workItemId: string): string {
    return `Read .ai/${workItemId}/${TASK_ARTIFACT} and complete the workflow.`;
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
      this.#forgetSummary();
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
    await this.#readSummary(workItemId, names);
    // Retry needs a package to retry: `bug --retry` reads the prepared
    // artifacts, so offering it after a run that was stopped before producing
    // any would send the developer into WORK_ITEM_NOT_FOUND.
    this.#canRetry = names.includes(TASK_ARTIFACT);
    // Pushed here rather than only by the callers: `refreshArtifacts` is also a
    // command of its own, and without this the panel keeps showing "loading".
    this.#push();
  }

  /**
   * Show a work item that was prepared earlier.
   *
   * Progress comes from `run.json`, which is the only record that
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
    // Another bug entirely: nothing of the previous one's handoff belongs to
    // it — not the error, and not the outcome either.
    this.#handoffError = undefined;
    this.#fix = undefined;
    // Nor its issue or its search: `refreshArtifacts` pushes before it reads,
    // and that push must not name the previous work item on these rows.
    this.#forgetSummary();
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


  // --- improving a hint --------------------------------------------------------

  /**
   * Rewrite the developer's hint with the configured AI CLI.
   *
   * Deliberately not a step of a run: no repository is read, no context is
   * built, nothing is written, and the form is not touched. The result is a
   * suggestion the developer accepts or discards.
   */
  async improveHint(form: FormState): Promise<void> {
    // A second press while the first is still out would spend another model
    // call on the same question.
    if (this.#hintBusy) return;
    this.#form = form;
    this.#hintError = undefined;
    this.#hintNotice = undefined;

    const hint = form.hint.trim();
    if (hint === "") {
      this.#hintSuggestion = undefined;
      this.#hintError = "Enter a hint first.";
      this.#push();
      return;
    }
    if (!this.#ports.improveHint || !this.#ports.canRun) {
      this.#hintError = "This BugPilot version cannot improve hints.";
      this.#push();
      return;
    }

    const plan = await resolveHintProvider(form.agent, this.#ports.canRun);
    if (plan.kind === "unavailable") {
      this.#hintError = plan.reason;
      this.#push();
      return;
    }

    const context = await this.#hintContext(form);
    const key = hintCacheKey({ hint, context, provider: plan.provider.id });
    const remembered = this.#hintCache.get(key);
    if (remembered !== undefined) {
      this.#hintSuggestion = remembered;
      this.#push();
      return;
    }

    this.#hintBusy = true;
    this.#hintSuggestion = undefined;
    this.#push();
    let outcome;
    try {
      outcome = await this.#ports.improveHint({
        provider: plan.provider,
        prompt: buildHintPrompt(hint, context),
      });
    } catch (error) {
      outcome = { ok: false as const, reason: `${plan.provider.label} could not be run: ${(error as Error).message}` };
    }
    this.#hintBusy = false;

    if (!outcome.ok) {
      this.#hintError = outcome.reason;
      this.#push();
      return;
    }
    const improved = cleanImprovedHint(outcome.text);
    if (improved === "") {
      this.#hintError = `${plan.provider.label} returned nothing to use.`;
      this.#push();
      return;
    }
    this.#hintCache.set(key, improved);
    this.#hintSuggestion = improved;
    this.#push();
  }

  /**
   * What the improver is allowed to read.
   *
   * The issue's own words when the developer allows it, and nothing else — no
   * repository, no history, no files. A Jira lookup that fails is a reason to
   * improve the wording alone, said out loud, not a reason to refuse.
   */
  async #hintContext(form: FormState): Promise<HintContext> {
    if (!form.useIssueDetails) return { kind: "hint-only" };
    if (form.source === "manual") {
      const title = form.title.trim();
      const description = form.description.trim();
      if (title === "" && description === "") return { kind: "hint-only" };
      return { kind: "issue", title, description };
    }
    const key = form.issueKey.trim().toUpperCase();
    if (key === "") return { kind: "hint-only" };
    const remembered = this.#issueDetails.get(key);
    if (remembered) return { kind: "issue", ...remembered };
    if (!this.#ports.loadIssueDetails) return { kind: "hint-only" };
    let details: IssueDetails | undefined;
    try {
      details = await this.#ports.loadIssueDetails(key);
    } catch {
      details = undefined;
    }
    if (!details) {
      this.#hintNotice = "Issue details unavailable — improving from hint only.";
      return { kind: "hint-only" };
    }
    // Kept for the rest of the session, so pressing Improve twice, or running
    // afterwards, does not ask Jira the same question again.
    this.#issueDetails.set(key, details);
    return { kind: "issue", ...details };
  }

  /** Take the suggestion into the editable hint, where it can still be edited. */
  useImprovedHint(): void {
    const improved = this.#hintSuggestion;
    if (improved === undefined) return;
    this.#hintSuggestion = undefined;
    this.#hintNotice = undefined;
    this.#hintError = undefined;
    // The revision bump is what makes the page write the new hint into the
    // field; without the push it would never see it.
    this.#replaceForm({ ...this.#form, hint: improved });
    this.#push();
  }

  /** Drop the suggestion. The developer's own hint was never touched. */
  dismissImprovedHint(): void {
    this.#hintSuggestion = undefined;
    this.#hintNotice = undefined;
    this.#hintError = undefined;
    this.#push();
  }

  /** The suggestion belongs to the hint it was made from, and to no other. */
  #forgetHintSuggestion(): boolean {
    if (this.#hintSuggestion === undefined && this.#hintError === undefined) return false;
    this.#hintSuggestion = undefined;
    this.#hintError = undefined;
    this.#hintNotice = undefined;
    return true;
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
    this.#created = undefined;
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
    // Whatever was created a moment ago has been acknowledged by doing
    // something else, so its confirmation stops following the developer around.
    this.#created = undefined;
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
        // `view` means read it, whatever owns it — the preview is a place a
        // custom mode can be read from too. And a built-in is only ever read:
        // it is packaged, and the developer's own version of it is what
        // `duplicate` is for.
        intent: action === "view" || scope === "builtin" ? "view" : "edit",
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
    this.#created = undefined;
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
    // From the draft that was accepted, not from the refreshed catalog: the id
    // and scope that were written are exactly what the page has to point at,
    // and re-deriving them from a list would be a second, weaker answer.
    this.#created =
      draft.intent === "create"
        ? { id: draft.id, scope: draft.scope, name: draft.name }
        : undefined;
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
    const previous = this.#form;
    this.#form = form;
    this.#ports.saveForm?.(form);
    // Editing the hint, or moving to another issue, makes the suggestion an
    // answer to a question nobody asked any more.
    let changed = false;
    if (previous.hint !== form.hint || workItemScopeOf(previous) !== workItemScopeOf(form)) {
      changed = this.#forgetHintSuggestion();
    }
    // Diagnostics reports the agent selection, and this method deliberately
    // does not push for every keystroke. A comparison rather than a push per
    // change: the selection moves when somebody picks from a list, not while
    // they type, so this costs nothing and stops the row lagging a push behind.
    if (previous.agent !== form.agent) changed = true;
    const scope = workItemScopeOf(form);
    // `undefined` is a half-typed key: not yet any work item, so not yet a
    // reason to conclude the developer moved to another one.
    if (scope === undefined || scope === this.#fixModeWorkItem) {
      if (changed) this.#push();
      return;
    }
    const prepared =
      scope === MANUAL_WORK_ITEM_SCOPE
        ? undefined
        : preparedFixModeFromStatus(await this.#readStatus(scope), this.#fixModes);
    // Only the selection follows the typed key. `#preparedFixMode` keeps
    // describing the work item whose artifacts and progress are on screen,
    // which is still the one that was opened.
    if (this.#deriveFixModeFor(scope, prepared) || changed) this.#push();
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
      path.join(this.#root, ".ai", workItemId, RUN_ARTIFACT),
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

  /**
   * Whether the page is allowed to ask for this command right now.
   *
   * Two sources, because there are two surfaces that offer one: the blocked
   * readiness card, and the failure cards UI-B2 added. The second was missed —
   * the cards rendered a button, the page posted the command, and this refused
   * it, so "Set Jira Credentials" and "Open Settings" did nothing at all. The
   * page test saw the message go out and the host test never received it.
   *
   * Derived on each call rather than cached in a set, which is what let the two
   * drift apart in the first place: an offer is a button being on screen, and
   * the state that puts it there is right here.
   */
  #isOffered(command: string): boolean {
    if (this.#offered.has(command)) return true;
    const cards = [this.#runFailure(), this.#handoffError];
    return cards.some((card) => card?.action?.command === command);
  }

  /**
   * What BugPilot is configured with, from state it already holds.
   *
   * Built per push rather than cached, because every field here is already a
   * field of this object — and because a cached copy of "what is configured" is
   * exactly the thing that goes stale when somebody sets a credential.
   */
  #diagnostics(): DiagnosticsView {
    const ready = this.#readiness.kind === "ready" ? this.#readiness : undefined;
    return diagnostics({
      root: this.#root,
      executable: ready?.executable,
      cliVersion: ready?.version,
      extensionVersion: this.#ports.extensionVersion,
      jiraConfigured: this.#jiraConfigured,
      agent: this.#form.agent,
      resolvedAgent: this.#resolvedAgent,
      workItemId: this.#workItemId,
      source: this.#form.source,
    });
  }

  #itemFile(workItemId: string, name: string): string {
    return path.join(this.#root ?? "", ".ai", workItemId, name);
  }

  /** Drop what the rows report about a work item that is no longer shown. */
  #forgetSummary(): void {
    this.#issue = undefined;
    this.#searchCounts = {};
    this.#files = [];
    this.#moreFiles = 0;
    this.#terms = [];
  }

  /**
   * What the rows report: the issue, and what the search found.
   *
   * Two artifacts, each read once and parsed once. The retrieval's counts,
   * files and terms are projections of the same `retrieval.json`, so they cannot
   * describe different searches. Each file is only opened when the listing names
   * it, so the before-the-first-run case costs no syscalls at all. Everything
   * past the parse is the projections' business, which omit a number and drop
   * an entry rather than guess at either.
   */
  async #readSummary(workItemId: string, names: readonly string[]): Promise<void> {
    const issueText = names.includes(ISSUE_ARTIFACT)
      ? await this.#ports.files.readFile(this.#itemFile(workItemId, ISSUE_ARTIFACT))
      : undefined;
    this.#issue = parseIssue(issueText);
    const text = names.includes(RETRIEVAL_ARTIFACT)
      ? await this.#ports.files.readFile(this.#itemFile(workItemId, RETRIEVAL_ARTIFACT))
      : undefined;
    const retrieval = parseRetrieval(text);
    this.#searchCounts = contextCounts(retrieval);
    this.#terms = retrievalTerms(retrieval);
    const found = relevantFiles(retrieval);
    this.#files = found.slice(0, MAX_LISTED_FILES);
    this.#moreFiles = Math.max(0, found.length - this.#files.length);
  }

  /**
   * Open one file from the Relevant Files list.
   *
   * The path came out of `retrieval.json` and went through a webview, which
   * is the part that matters: by the time it arrives here it is untrusted input
   * that happens to look like something BugPilot wrote. So it is resolved
   * against the repository and checked with the same `isWithin` the focus-file
   * and ignore-path validation uses, and a path that lands outside is refused
   * and logged rather than opened.
   */
  async openRelevantFile(relativePath: string): Promise<void> {
    const root = this.#root;
    if (!root) return;
    if (!isSafeRelativePath(relativePath)) {
      this.#ports.log.error(`Refusing to open a suspicious file path: ${relativePath}`);
      return;
    }
    const target = path.resolve(root, relativePath);
    if (!isWithin(root, target)) {
      // Belt and braces: `isSafeRelativePath` already rejects `..` and absolute
      // forms, and this catches whatever a symlink or an odd separator turned
      // them into after resolution.
      this.#ports.log.error(`Refusing to open a file outside the repository: ${relativePath}`);
      return;
    }
    await this.#ports.ui.openFile(target);
  }

  /**
   * Why the last run did not finish, as a card.
   *
   * Nothing is classified while a run is in flight: the tracker's failure is
   * from the attempt before this one, and showing it next to a Running… button
   * would read as this run having failed instantly.
   */
  #runFailure(): UserFacingError | undefined {
    if (this.#running) return undefined;
    return runError(this.#progress.failure, this.#workItemId);
  }

  /**
   * The mode the package was prepared with, as one line.
   *
   * Moved here from the page in UI-A3, unchanged in substance: three states,
   * because "this mode is gone" and "BugPilot could not check" look alike and
   * mean opposite things.
   */
  #strategyLine(): string | undefined {
    const prepared = this.#preparedFixMode;
    if (!prepared) return undefined;
    const suffix =
      prepared.availability === "unavailable"
        ? " (unavailable)"
        : prepared.availability === "unknown"
          ? " · availability unknown"
          : prepared.executionKind === "investigate"
            ? " · investigation only"
            : "";
    return `${prepared.name}${suffix}`;
  }

  #push(): void {
    // Computed here rather than in the page: the page cannot import the model,
    // and a status the page derived for itself would be a second opinion about
    // what the run did.
    const failed = this.#runFailure();
    const strategy = this.#strategyLine();
    const workflow = buildWorkflow({
      source: this.#form.source,
      plan: effectivePlan(this.#form.plan),
      fixWithAI: canFixWithAI(this.#form),
      progress: this.#progress,
      artifacts: this.#artifactNames,
      ...(this.#fix === undefined ? {} : { fix: this.#fix }),
      ...(this.#workItemId === undefined ? {} : { workItemId: this.#workItemId }),
      ...(this.#issue === undefined ? {} : { issue: this.#issue }),
      search: {
        ...this.#searchCounts,
        content: {
          files: this.#files,
          ...(this.#moreFiles > 0 ? { moreFiles: this.#moreFiles } : {}),
          terms: this.#terms,
        },
      },
      handoffBusy: this.#handoffBusy,
      ...(this.#handoffError === undefined ? {} : { handoffError: this.#handoffError }),
      ...(failed === undefined ? {} : { runError: failed }),
      ...(strategy === undefined ? {} : { strategy }),
    });
    // The run's card goes on the row that failed; only a failure no row owns —
    // before any step started, or from the extension itself — stands alone.
    const owned = failed !== undefined && workflow.some((step) => step.error === failed);
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
              ...(this.#created === undefined ? {} : { created: this.#created }),
            },
          }
        : {}),
      hintImprovement: {
        busy: this.#hintBusy,
        ...(this.#hintSuggestion === undefined ? {} : { suggestion: this.#hintSuggestion }),
        ...(this.#hintError === undefined ? {} : { error: this.#hintError }),
        ...(this.#hintNotice === undefined ? {} : { notice: this.#hintNotice }),
      },
      readiness: this.#readiness,
      form: this.#form,
      problems: this.#problems,
      progress: this.#progress,
      workflow,
      overall: overallStatus(workflow, this.#progress),
      // Work-item level, not Build context's: the directory holds every artifact.
      workItemActions: !this.#running && canOpenFolder(this.#artifactNames) ? ["openFolder"] : [],
      artifacts: this.#artifacts,
      // Classified here, where the code and the operation that produced it are
      // both known. The page receives a rendered card and decides nothing.
      ...(failed === undefined || owned ? {} : { runError: failed }),
      diagnostics: this.#diagnostics(),
      warnings: this.#warnings,
      jiraConfigured: this.#jiraConfigured,
      canRetry: this.#canRetry,
      ...(this.#workItemId === undefined ? {} : { workItemId: this.#workItemId }),
    });
  }
}
