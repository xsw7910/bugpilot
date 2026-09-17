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

import { buildPrepareArgs, buildRetryArgs, canFixWithAI, effectivePlan, DEFAULT_FORM } from "./form.ts";
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
}

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
        this.#form = message.form;
        this.#ports.saveForm?.(message.form);
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
    const directory = path.join(this.#root, ".ai", workItemId);
    const status = await this.#ports.files.readFile(path.join(directory, "workflow_status.json"));
    let parsed: unknown;
    try {
      parsed = status === undefined ? undefined : JSON.parse(status);
    } catch {
      // A truncated status file must not stop the artifacts from being listed.
      parsed = undefined;
    }
    this.#progress = viewFromStatus(parsed);
    await this.refreshArtifacts();
    this.#push();
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
