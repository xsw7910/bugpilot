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

import { buildPrepareArgs, buildRetryArgs, canFixWithAI, effectivePlan, DEFAULT_FORM, isWorkItemId, preparationFingerprint, workItemScopeOf, MANUAL_WORK_ITEM_SCOPE, JIRA_ISSUE_KEY_RE } from "./form.ts";
import {
  MAX_ATTEMPT_FEEDBACK,
  USER_FEEDBACK_ARTIFACT,
  feedbackFromReview,
  feedbackFromVerification,
  hasUnsettledChecks,
  offeredActions,
  primaryView,
  retryHandoffText,
  userFeedbackMarkdown,
} from "./nextAction.ts";
import type { FeedbackHelperId, NextActionId, PrimaryView } from "./nextAction.ts";
import { settingsSummaries } from "./workflowSettings.ts";
import {
  MAX_LISTED_FILES,
  contextCounts,
  isSafeRelativePath,
  relevantFiles,
} from "./contextSummary.ts";
import { RETRIEVAL_ARTIFACT, parseRetrieval } from "./retrieval.ts";
import { ISSUE_ARTIFACT, parseIssue } from "./issue.ts";
import type { IssueSummary } from "./issue.ts";
import { parseFixReport } from "./fixReport.ts";
import type { FixReportPreview } from "./fixReport.ts";
import { reviewPackageArgs, reviewPackageFromEnvelope } from "./reviewPackage.ts";
import { parseReviewReport } from "./reviewReport.ts";
import type { ReviewReportPreview } from "./reviewReport.ts";
import { REVIEW_NOT_RECORDED, hasReviewContent, recordReviewArgs, recordingOutcome, reviewPayload } from "./reviewCapture.ts";
import type { ReviewCapture, ReviewEntry } from "./reviewCapture.ts";
import { parseVerificationReport } from "./verificationReport.ts";
import type { VerificationCheckEntry, VerificationReportPreview } from "./verificationReport.ts";
import {
  VERIFICATION_NOT_RECORDED,
  recordVerificationArgs,
  verificationOutcome,
  verificationPayload,
  verificationProblem,
} from "./verificationCapture.ts";
import type { VerificationCapture } from "./verificationCapture.ts";
import type { PayloadCommandRequest } from "./fixModeTransport.ts";
import type { ReviewPackage } from "./reviewPackage.ts";
import type { ContextCounts, RelevantFile } from "./contextSummary.ts";
import type { FieldProblem, FormState } from "./form.ts";
import { resolveAgent } from "./agents.ts";
import type { AgentPlan } from "./agents.ts";
import { buildWorkflow, canOpenFolder, canStartReview, overallStatus } from "./workflow.ts";
import type { AttemptDraft, AttemptView, FixWithAiOutcome, ReviewHandoff, ValidationView, VerificationEdit } from "./workflow.ts";
import type { DiagnosticsView } from "./diagnostics.ts";
import { handoffError, reviewHandoffError, runError } from "./failures.ts";
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
import {
  CONTEXT_ARTIFACT,
  FIX_REPORT_ARTIFACT,
  REVIEW_REPORT_ARTIFACT,
  RUN_ARTIFACT,
  TASK_ARTIFACT,
  VERIFICATION_REPORT_ARTIFACT,
  buildArtifactList,
} from "./artifacts.ts";
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
  /**
   * Bring forward the most recently opened terminal, still open, whose name
   * `matches` — Open AI Session's way back to the agent a handoff started.
   *
   * Returns false when there is none: closed, or never opened in this window.
   * Nothing is started in its place; the caller says so instead.
   */
  revealTerminal(matches: (name: string) => boolean): boolean;
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
  /**
   * `record-review`, with the review in a temporary file (Batch 11). The one way
   * the extension records a review: it never writes `review_report.md` itself.
   */
  readonly runReviewCommand?: (request: PayloadCommandRequest) => Promise<Envelope>;
  /**
   * `record-verification`, with the checks in a temporary file (Batch 12). The one
   * way the extension records verification evidence: it never writes
   * `verification_report.md` itself, and never runs a check.
   */
  readonly runVerificationCommand?: (request: PayloadCommandRequest) => Promise<Envelope>;
}

/**
 * The artifact writes the host performs itself, one at a time (Batch 12): recording
 * a review result, recording verification evidence, cleaning a work item, and
 * preparing a retry package (release stabilization: it writes into the folder too)
 * — which Start New Attempt does too, when it carries feedback.
 */
type ArtifactMutation = "review" | "verification" | "clean" | "retry" | "attempt";

/** What a run that has to wait is told, per mutation in flight. */
const RUN_WAITS_FOR: Readonly<Record<ArtifactMutation, string>> = {
  review: "Wait for the review result recording to finish before starting a run.",
  verification: "Wait for the verification evidence recording to finish before starting a run.",
  clean: "Wait for the clean to finish before starting a run.",
  retry: "Wait for the retry to finish before starting a run.",
  attempt: "Wait for the new attempt to be prepared before starting a run.",
};

/** What Retry is told, per artifact write in flight. */
const RETRY_WAITS_FOR: Readonly<Record<ArtifactMutation, string>> = {
  review: "Wait for artifact recording to finish before retrying.",
  verification: "Wait for artifact recording to finish before retrying.",
  clean: "Wait for the clean to finish before retrying.",
  retry: "Wait for the retry to finish before retrying.",
  attempt: "Wait for the new attempt to be prepared before retrying.",
};

/** What Clean is told while a recording is in flight. */
export const CLEAN_WAITS = "Wait for artifact recording to finish before cleaning this work item.";

/** What Clean is told, per artifact write in flight. */
const CLEAN_WAITS_FOR: Readonly<Record<ArtifactMutation, string>> = {
  review: CLEAN_WAITS,
  verification: CLEAN_WAITS,
  clean: "Wait for the clean to finish before cleaning this work item.",
  retry: "Wait for the retry to finish before cleaning this work item.",
  attempt: "Wait for the new attempt to be prepared before cleaning this work item.",
};

/** What a handoff is told, per artifact write in flight: it would read a folder being written. */
const HANDOFF_WAITS_FOR: Readonly<Record<ArtifactMutation, string>> = {
  review: "Wait for the review result recording to finish before handing this work item to an agent.",
  verification: "Wait for the verification evidence recording to finish before handing this work item to an agent.",
  clean: "Wait for the clean to finish before handing this work item to an agent.",
  retry: "Wait for the retry to finish before handing this work item to an agent.",
  attempt: "Wait for the new attempt to be prepared before handing this work item to an agent.",
};

/** What the primary action is waiting for, per artifact write in flight. */
const BUSY_WITH: Readonly<Record<ArtifactMutation, string>> = {
  review: "Wait for the review result recording to finish.",
  verification: "Wait for the verification evidence recording to finish.",
  clean: "Wait for the clean to finish.",
  retry: "Wait for the retry to finish.",
  attempt: "Wait for the new attempt to be prepared.",
};

/** Why a handoff refuses a context the form no longer describes. */
export const STALE_HANDOFF =
  "The form changed since this context was prepared, so nothing was handed over. Press Rebuild Context first, or undo the change.";

/**
 * The AI session a handoff started, as this panel saw it: which terminal, which
 * agent, and how many handoffs it has made for the work item.
 */
interface SessionRecord {
  readonly terminal: string;
  readonly agent: string;
  readonly attempts: number;
}

/** What a handoff hands over, and what the row says once it has. */
interface Launch {
  readonly prompt: string;
  readonly detail: (agent: string) => string;
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
  /**
   * The AI sessions this panel started, by work item, for the life of the window.
   *
   * By work item rather than one slot: opening another bug from History and
   * coming back must not turn Open AI Session back into Fix with AI — pressing
   * that would start a second agent on a package one is already working on.
   * Dropped by Clean and by a Fresh run, which delete what the agent was given.
   */
  readonly #sessions = new Map<string, SessionRecord>();
  /**
   * The form the package on screen was prepared from, fingerprinted — the
   * baseline that tells the primary action the context went stale.
   *
   * Set when a run starts (from the form it was given, so no push after it can
   * compare against an older one) and when a work item is opened (from the form
   * the panel then shows: what built a package on disk is not recorded, and the
   * form is what Rebuild Context would use).
   */
  #preparedWith: string | undefined;
  /** Start New Attempt, from the press until it has started or said why not. */
  #attempt: AttemptView | undefined;
  /** A feedback helper's text, held for exactly one push. */
  #attemptDraft: AttemptDraft | undefined;
  #attemptDraftToken = 0;
  /** The settings page's attachment list after the file dialog, held for exactly one push. */
  #attachmentPick: { readonly token: number; readonly attachments: readonly string[] } | undefined;
  #attachmentPickToken = 0;
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
  /**
   * `fix_report.md`, projected for the Fix result row, as the last refresh read
   * it. Two bounded lines, never the report: the editor opens the file itself.
   */
  #fixReport: FixReportPreview | undefined;
  /** Fix result's Validation checklist, for the work item on screen; undefined until asked for. */
  #validation: ValidationView | undefined;
  #copyingReviewPrompt = false;
  /**
   * Bumped whenever the checklist's sources may have changed — another work
   * item, a run starting, the folder read again. A checklist that arrives under
   * an older epoch is dropped: nothing of work item A may land on B. (Copy
   * Review Prompt checks the work item itself: its prompt depends on nothing
   * else.)
   */
  #validationEpoch = 0;
  /**
   * Review with AI, for the report on screen (Batch 10). Transient: held here
   * and nowhere else, so a reopened work item offers the button again. Its own
   * state — Fix with AI's `#fix`, `#handoffBusy` and `#handoffError` are
   * another action's.
   */
  #review: ReviewHandoff | undefined;
  /**
   * Bumped whenever a review handoff in flight stops being wanted: another work
   * item, a run starting, or the report no longer listed. Every path that takes
   * the report off the listing goes through one of those, which is what lets a
   * handoff check this alone. Not bumped by the folder merely being read again:
   * the prompt depends on the work item alone.
   */
  #reviewEpoch = 0;
  /** `review_report.md`, projected, while the listing names it (Batch 11). */
  #reviewReport: ReviewReportPreview | undefined;
  /** A recording in flight, or why the last one did not record. Never persisted. */
  #reviewCapture: ReviewCapture | undefined;
  /** `verification_report.md`, projected, while the listing names it (Batch 12). */
  #verificationReport: VerificationReportPreview | undefined;
  /** A verification recording in flight, or its outcome. Never persisted. */
  #verificationCapture: VerificationCapture | undefined;
  /** The recorded checks for Edit, held for exactly one push. */
  #verificationEdit: VerificationEdit | undefined;
  #verificationEditToken = 0;
  /** The report text as last read, so an Edit's save can tell whether it changed. */
  #verificationText: string | undefined;
  /** The last Edit answer and the text it was parsed from. */
  #verificationEditBasis: { readonly token: number; readonly text: string | undefined } | undefined;
  /**
   * The artifact write in flight, if any (Batch 11, generalized in Batch 12): a
   * record-review, a record-verification or a clean process, or the confirmation
   * before one. Set before the first wait and cleared only in that operation's
   * `finally`. In flight is not the same as its outcome still being wanted:
   * another work item or a reopen drops the outcome (the epoch) but cannot stop
   * the process, and until it has ended no run starts, no recording starts and
   * no clean either.
   */
  #mutation: ArtifactMutation | undefined;
  /**
   * Bumped whenever a recording in flight stops being wanted: another work item,
   * a reopen, a run, or the report gone. A recording that resumes under an older
   * epoch shows nothing, least of all under another work item.
   */
  #captureEpoch = 0;
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
  /**
   * Bumped whenever a Fix with AI handoff in flight stops being wanted: a work
   * item opened — another, or the same one again — or a run starting (§37.70). The handoff checks it after each
   * wait, so a press for A never lands on B — the rule Review with AI already
   * keeps, with a counter of its own: the two are separate actions.
   */
  #fixEpoch = 0;
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
   * True from the moment a run is asked for until it is running or has given up.
   *
   * `#running` is set only once the process is about to start — after the
   * environment check, the Fresh confirmation and any file a long description
   * needs — and a second press in that window used to start a second run.
   */
  #runPending = false;
  /** How many runs have started, so `run()` can tell whether its own did. */
  #runsStarted = 0;
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
    const previousRoot = this.#root;
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
    // The trees read the repository from here: one drawn before it was known —
    // at start-up, History says to open a repository — is re-read once it is.
    if (this.#root !== previousRoot) this.#ports.ui.refreshViews();
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
      case "applySettings":
        await this.applySettings(message.form);
        return;
      case "pickAttachments":
        await this.pickAttachments(message.attachments);
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
      case "nextAction":
        await this.nextAction(message.action, message.form);
        return;
      case "startAttempt":
        await this.startNewAttempt(message.feedback, message.form);
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
      case "recordReview":
        await this.recordReview(message.review);
        return;
      case "recordVerification":
        await this.recordVerification(message.checks, message.replace, message.basis);
        return;
      case "action":
        if (message.id === "openContext") await this.openArtifact(CONTEXT_ARTIFACT);
        else if (message.id === "copyContext") await this.copyContext();
        else if (message.id === "openFolder") await this.openArtifactsFolder();
        else if (message.id === "fixWithAI") await this.fixWithAI();
        else if (message.id === "copyReviewPrompt") await this.copyReviewPrompt();
        else if (message.id === "loadValidation") await this.loadValidation();
        else if (message.id === "reviewWithAI") await this.reviewWithAI();
        else if (message.id === "openReviewReport") await this.openReviewReport();
        else if (message.id === "openVerificationReport") await this.openVerificationReport();
        else if (message.id === "editVerification") this.editVerification();
        else if (message.id === "useReviewFindings" || message.id === "useVerificationEvidence") {
          await this.useFeedbackHelper(message.id);
        } else await this.#ports.ui.editCredentials();
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

  /**
   * Do what the primary button — or its ⋯ menu — offered, if it still offers it.
   *
   * The form comes first, because the answer depends on it and the page's copy
   * is the freshest there is: the label the developer pressed was computed from
   * the host's copy, up to one debounce interval older. When the two disagree —
   * a hint edited and Fix with AI pressed before the panel caught up — nothing
   * happens except the button being corrected: an agent handed a context the
   * form no longer describes is the one outcome this must never produce.
   */
  async nextAction(action: NextActionId, form: FormState): Promise<void> {
    await this.#formChanged(form);
    const view = this.#primaryView();
    if (!offeredActions(view).includes(action)) {
      this.#ports.log.error(
        `Refusing ${action}: the panel offers ${offeredActions(view).join(", ") || "nothing"} for this form.`,
      );
      if (view.busy) this.#ports.ui.notify("info", this.#busyReason());
      else if (view.enabled) {
        this.#ports.ui.notify(
          "info",
          `Nothing was started: the form changed before the panel caught up. The button now reads “${view.label}”.`,
        );
      }
      this.#push();
      return;
    }
    switch (action) {
      case "run":
        await this.run(this.#form);
        return;
      case "rebuildContext":
        // The same preparation as Run, and never Fresh unless the developer
        // ticked it — in which case run() asks before deleting anything. Not a
        // handoff: an attempt that exists is continued or restarted on purpose.
        await this.run(this.#form, { handOff: false });
        return;
      case "fixWithAI":
        await this.fixWithAI();
        return;
      case "openSession":
        this.openSession();
        return;
      case "startNewAttempt":
        // Opens the page's form; the attempt itself arrives as `startAttempt`.
        return;
    }
  }

  /** Why nothing can start right now, in a sentence. */
  #busyReason(): string {
    if (this.#running || this.#runPending) return "A BugPilot run is in progress. Wait for it to finish, or press Stop.";
    if (this.#mutation !== undefined) return BUSY_WITH[this.#mutation];
    return "BugPilot is still handing this work item to an agent.";
  }

  /**
   * Prepare a bug. Rejects nothing: problems are rendered, not thrown.
   *
   * `handOff: false` is Rebuild Context: the same preparation, without the
   * Fix with AI box starting a handoff at the end of it.
   */
  async run(form: FormState, options: { readonly handOff?: boolean } = {}): Promise<void> {
    if (this.#running || this.#runPending) return;
    // No run while an artifact write is in flight (Batches 11–12). A Fresh run
    // deletes the work item folder, and a recording's late write would put its
    // report back into the new package; any run would drop the recording's
    // outcome, and one racing a clean prepares into a folder being deleted.
    // Refused here, the one door every run goes through — not by a page button.
    // Nothing is marked: the run simply has not begun.
    if (this.#refuseRunForMutation()) return;
    this.#runPending = true;
    const before = this.#runsStarted;
    try {
      await this.#prepare(form, options);
    } finally {
      const started = this.#runsStarted !== before;
      this.#runPending = false;
      // A run that never began — declined, invalid, refused — may have been
      // pushed as busy while it was being set up; say it is not any more.
      if (!started) this.#push();
    }
  }

  async #prepare(form: FormState, options: { readonly handOff?: boolean }): Promise<void> {
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

    // Checked again at the door: a recording or a clean pressed while this run
    // was still being set up (the environment, the Fresh confirmation, the files
    // above) must not have a run start over it.
    if (this.#refuseRunForMutation()) return;
    const tracker = new ProgressTracker(effectivePlan(form.plan), this.#ports.now);
    let runWarnings: readonly string[] = [];
    const abort = new AbortController();
    this.#abort = abort;
    this.#running = true;
    this.#runPending = false;
    this.#runsStarted += 1;
    this.#stoppedByUser = false;
    // The baseline the primary action compares the form against, from the form
    // this run was given — set now, so no push after the run can compare against
    // the one before it and flicker Rebuild Context.
    this.#preparedWith = preparationFingerprint(form);
    // A re-prepare of the same Jira work item keeps fix_report.md — only Fresh
    // deletes it, and the retry flow reads it — so the Fix result row stays
    // through the run. Nothing else is known to survive: Fresh may delete it,
    // another key or a hand-written bug is another work item.
    const report =
      form.source === "jira" &&
      !form.fresh &&
      form.issueKey.trim().toUpperCase() === this.#workItemId &&
      this.#artifactNames.includes(FIX_REPORT_ARTIFACT)
        ? this.#fixReport
        : undefined;
    // A recorded review and recorded evidence survive exactly when their fix
    // report does (Batches 11–12): Fresh deletes the folder, and nothing else in a
    // run touches any of the three.
    const review =
      report !== undefined && this.#artifactNames.includes(REVIEW_REPORT_ARTIFACT) ? this.#reviewReport : undefined;
    const evidence =
      report !== undefined && this.#artifactNames.includes(VERIFICATION_REPORT_ARTIFACT)
        ? this.#verificationReport
        : undefined;
    if (form.source === "jira") {
      this.#setWorkItem(form.issueKey.trim().toUpperCase());
      // Fresh deletes everything the agent was given and wrote; the session it
      // started is not one to reopen for the package this run builds.
      if (form.fresh) this.#sessions.delete(form.issueKey.trim().toUpperCase());
    } else {
      // A hand-written bug's id arrives with the `started` event. Until then
      // there is no current work item — and leaving the previous one's artifact
      // list on screen would offer files that `openArtifact` then refuses.
      this.#workItemId = undefined;
      this.#artifacts = { kind: "empty", detail: "Preparing…" };
    }
    // For a Jira run too: the listing is the previous package's — or another
    // work item's — until the run ends and the folder is read again. Kept, it
    // let the push at `completed` offer a report a fresh run had just deleted.
    // The entries kept are the reports that are known to survive.
    this.#artifactNames =
      report === undefined
        ? []
        : [
            FIX_REPORT_ARTIFACT,
            ...(review === undefined ? [] : [REVIEW_REPORT_ARTIFACT]),
            ...(evidence === undefined ? [] : [VERIFICATION_REPORT_ARTIFACT]),
          ];
    this.#forgetSummary();
    if (report !== undefined) this.#fixReport = report;
    if (review !== undefined) this.#reviewReport = review;
    if (evidence !== undefined) this.#verificationReport = evidence;
    // Before anything is pushed: a stale card beside a Running… button reads as
    // the new run having failed instantly, and a previous run's handoff says
    // nothing about this one — nor may one still being worked out land on it.
    this.#forgetFix();
    this.#progress = tracker.view();
    this.#push();

    try {
      // Inside the try: a keyring that fails to answer must not leave the panel
      // running forever (release stabilization).
      const credentials = await this.#ports.credentials();
      this.#jiraConfigured = credentials.configured;
      this.#ports.log.info(`bugpilot ${built.args.join(" ")}`);
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
          if (
            event.type === "started" &&
            typeof event.work_item_id === "string" &&
            isWorkItemId(event.work_item_id)
          ) {
            // A hand-written bug's id is minted by the CLI, so this is the only
            // place the extension learns it — and, like every id that arrives
            // from outside a form, it is checked before it is used (§37.70).
            this.#setWorkItem(event.work_item_id);
          } else if (event.type === "started" && typeof event.work_item_id === "string") {
            this.#ports.log.error(
              `Ignoring a work item id from bugpilot that is not one: ${JSON.stringify(event.work_item_id)}`,
            );
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
    if (options.handOff !== false && canFixWithAI(form)) {
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
    // Retry writes user_feedback.md and agent_retry_prompt.md into the work item
    // folder, so it takes its turn with the other artifact writes: never during a
    // clean (it would write into a folder being deleted) or a recording, and none
    // of them — nor a run — starts while it is being prepared.
    if (this.#mutation !== undefined) {
      this.#ports.ui.notify("warning", RETRY_WAITS_FOR[this.#mutation]);
      return;
    }
    this.#mutation = "retry";
    this.#push();

    try {
      // Inside the try, so a keyring that fails releases the guard in `finally`.
      const credentials = await this.#ports.credentials();
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
    } finally {
      this.#mutation = undefined;
      this.#push();
    }
  }

  /**
   * Bring the AI session back: the terminal the last handoff for this work item
   * opened.
   *
   * A terminal is the only kind of session a handoff starts, and the only one
   * this can find. When it is gone — closed, or never opened in this window —
   * the answer is said, and nothing is started in its place: reopening a
   * session is not the same act as starting another, and Start New Attempt is
   * one press away for that.
   */
  openSession(): void {
    const workItemId = this.#workItemId;
    if (!workItemId) {
      this.#ports.ui.notify("warning", "Run BugPilot first; there is no AI session to open yet.");
      return;
    }
    const session = this.#sessions.get(workItemId);
    const base = fixTerminalName(workItemId);
    const shown = this.#ports.ui.revealTerminal((name) =>
      session ? name === session.terminal : name === base || name.startsWith(`${base} (`),
    );
    if (shown) return;
    this.#ports.ui.notify(
      "info",
      session
        ? `The terminal BugPilot opened for ${workItemId} has been closed, so there is no session to bring back. To continue, use ⋯ → Start New Attempt: it starts a new session with the prepared context.`
        : `No AI session terminal for ${workItemId} is open in this window, so there is none to bring back. Use ⋯ → Start New Attempt to start a new session with the prepared context.`,
    );
  }

  /**
   * Start a new AI session on the prepared context — Start New Attempt.
   *
   * Not the way to continue a conversation (Open AI Session is), and offered
   * only once an attempt exists: this is for an agent that stopped, went the
   * wrong way, or left findings a review or a check turned up.
   *
   * Empty feedback writes nothing: the new session gets the same `task.md`
   * handoff the first one did. Feedback is written to `user_feedback.md` —
   * replacing what an earlier attempt left there — and `bug --retry` builds
   * `agent_retry_prompt.md` from it, the package the CLI's own retry loop hands
   * over. That write takes its turn with the other artifact writes: no run, no
   * clean and no recording while it is in progress, and none of them under it.
   */
  async startNewAttempt(feedback: string, form: FormState): Promise<void> {
    await this.#formChanged(form);
    const view = this.#primaryView();
    if (!offeredActions(view).includes("startNewAttempt")) {
      this.#ports.log.error("Refusing to start a new attempt: the panel is not offering one for this form.");
      this.#attempt = {
        state: "failed",
        message: view.busy
          ? `Not started. ${this.#busyReason()}`
          : this.#prepared() && this.#stale()
            ? "Not started: the form changed since this context was prepared. Press Rebuild Context first, or undo the change."
            : "Not started: a new attempt is offered once an AI attempt exists for a prepared work item.",
      };
      this.#push();
      return;
    }
    const workItemId = this.#workItemId!;
    const root = this.#root!;
    const text = feedback.trim();
    if (text.length > MAX_ATTEMPT_FEEDBACK) {
      this.#attempt = {
        state: "failed",
        message: `Not started: the feedback is ${text.length} characters. Keep it under ${MAX_ATTEMPT_FEEDBACK}, and attach anything longer as a file.`,
      };
      this.#push();
      return;
    }

    const epoch = this.#fixEpoch;
    this.#handoffError = undefined;
    this.#attempt = { state: "starting" };
    this.#handoffBusy = true;
    if (text !== "") this.#mutation = "attempt";
    this.#push();
    try {
      let launch: Launch = {
        prompt: this.#handoffText(workItemId),
        detail: (agent) => `New attempt handed to ${agent} in a terminal.`,
      };
      if (text !== "") {
        if (!(await this.#prepareRetryPackage(workItemId, root, text, epoch))) return;
        launch = {
          prompt: retryHandoffText(workItemId),
          detail: (agent) => `New attempt, with your feedback, handed to ${agent} in a terminal.`,
        };
      }
      if (epoch !== this.#fixEpoch) return;
      await this.#handOver(workItemId, root, epoch, launch);
      // Started, or said why not on the row's own card: either way the form's
      // press has been answered, and the page may close it.
      if (epoch === this.#fixEpoch) this.#attempt = undefined;
    } catch (error) {
      if (epoch === this.#fixEpoch) {
        this.#attempt = { state: "failed", message: `Not started: ${oneSentence((error as Error).message)}` };
      }
    } finally {
      if (this.#mutation === "attempt") this.#mutation = undefined;
      // Like Fix with AI's: dropped by a switch or a run, the busy flag was reset
      // where that happened and may belong to another press by now.
      if (epoch === this.#fixEpoch) this.#handoffBusy = false;
      this.#push();
    }
  }

  /**
   * Write the developer's feedback and have `bug --retry` build the package
   * from it. False when it did not happen — said on the form — or when the
   * work item on screen changed meanwhile, in which case nothing is said.
   */
  async #prepareRetryPackage(workItemId: string, root: string, text: string, epoch: number): Promise<boolean> {
    try {
      await this.#ports.files.writeFile(
        this.#itemFile(workItemId, USER_FEEDBACK_ARTIFACT),
        userFeedbackMarkdown(workItemId, text),
      );
      if (epoch !== this.#fixEpoch) return false;
      const credentials = await this.#ports.credentials();
      const envelope = await this.#ports.runner.runJson(buildRetryArgs(workItemId), {
        cwd: root,
        env: credentials.environment,
        timeoutMs: 60_000,
      });
      if (epoch !== this.#fixEpoch) return false;
      if (!envelope.ok) {
        const diagnosis = diagnose(envelope.error.code, envelope.error.message);
        this.#attempt = {
          state: "failed",
          message: `Not started: ${diagnosis.action ? `${diagnosis.summary} ${diagnosis.action}` : diagnosis.summary}`,
        };
        return false;
      }
      // The CLI creates a template only when there is no feedback file, so this
      // means the file just written is not the one it read: hand over nothing.
      if (envelope["feedback_created"] === true) {
        this.#attempt = {
          state: "failed",
          message: `Not started: bugpilot did not find the feedback just written to ${USER_FEEDBACK_ARTIFACT}.`,
        };
        return false;
      }
    } catch (error) {
      if (epoch === this.#fixEpoch) {
        this.#attempt = { state: "failed", message: `Not started: ${oneSentence((error as Error).message)}` };
      }
      return false;
    } finally {
      // The folder is written; the handoff that follows reads it and writes nothing.
      if (this.#mutation === "attempt") this.#mutation = undefined;
    }
    // The two files are in the folder now, and the tree should say so.
    await this.refreshArtifacts();
    this.#ports.ui.refreshViews();
    return epoch === this.#fixEpoch;
  }

  /**
   * The feedback helpers Start New Attempt's form may offer: each while its
   * source is listed — and, for verification, while a check recorded there did
   * not pass — and only while a new attempt could start at all.
   */
  #feedbackHelpers(view: PrimaryView): FeedbackHelperId[] {
    if (!offeredActions(view).includes("startNewAttempt")) return [];
    const helpers: FeedbackHelperId[] = [];
    if (this.#artifactNames.includes(REVIEW_REPORT_ARTIFACT)) helpers.push("useReviewFindings");
    if (this.#artifactNames.includes(VERIFICATION_REPORT_ARTIFACT) && hasUnsettledChecks(this.#verificationReport)) {
      helpers.push("useVerificationEvidence");
    }
    return helpers;
  }

  /**
   * Put what a review or a recorded check said into the feedback form — when the
   * developer asks, never on its own.
   *
   * Read from the file when pressed, like Copy: somebody may have edited it
   * since the panel last looked. The text is sent once, for the page to add to
   * what is already typed; nothing is written and nothing reaches an agent until
   * Start Attempt, and nothing here says reviewed, approved or verified.
   */
  async useFeedbackHelper(helper: FeedbackHelperId): Promise<void> {
    const workItemId = this.#workItemId;
    if (!workItemId || !this.#feedbackHelpers(this.#primaryView()).includes(helper)) {
      this.#ports.log.error(`Refusing ${helper}: the feedback form is not offering it.`);
      return;
    }
    const review = helper === "useReviewFindings";
    const file = await this.#ports.files.readFile(
      this.#itemFile(workItemId, review ? REVIEW_REPORT_ARTIFACT : VERIFICATION_REPORT_ARTIFACT),
    );
    if (this.#workItemId !== workItemId) return;
    const text = review ? feedbackFromReview(file) : feedbackFromVerification(parseVerificationReport(file));
    if (text === undefined) {
      this.#ports.ui.notify(
        "info",
        review
          ? `${REVIEW_REPORT_ARTIFACT} has no Findings or Recommendations recorded.`
          : `${VERIFICATION_REPORT_ARTIFACT} has no check recorded as Failed or Not Run.`,
      );
      return;
    }
    this.#attemptDraftToken += 1;
    this.#attemptDraft = { token: this.#attemptDraftToken, text };
    this.#push();
    // One push carries it: the page keeps the text from here.
    this.#attemptDraft = undefined;
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
    // One handoff at a time, refused here and not only by the page: the
    // palette, the History menu and the end of a run all reach this without
    // the button, and two presses must never open two terminals (§37.70).
    if (this.#handoffBusy) {
      this.#ports.log.error("Refusing a second Fix with AI while one is being handed over.");
      // Said, because the palette and the History menu have no button to show it.
      this.#ports.ui.notify("info", "Fix with AI is already handing this work item over.");
      return;
    }
    // Cleared as the attempt starts rather than when it succeeds: the developer
    // pressed the button, and the old reason is about the press before it — as
    // is a new attempt's refusal, which a handoff answers just as well.
    if (this.#handoffError || this.#attempt?.state === "failed") {
      this.#handoffError = undefined;
      this.#attempt = undefined;
      this.#push();
    }
    const workItemId = this.#workItemId;
    const root = this.#root;
    if (!workItemId || !root) {
      this.#ports.ui.notify("warning", "Prepare a bug first; there is nothing to hand over yet.");
      return;
    }
    // The prompt is built from the id, and it goes on a command line: an id
    // that is not one is refused, never cleaned up into one (§37.70).
    if (!isWorkItemId(workItemId)) {
      this.#ports.log.error(`Refusing to hand over a work item whose id is not one: ${JSON.stringify(workItemId)}`);
      this.#ports.ui.notify("warning", "BugPilot will not hand over this work item: its id is not one BugPilot could have created.");
      return;
    }

    // Not while task.md may be rewritten or deleted under the agent: a run
    // prepares it again, a clean removes it. Refused here, the one door every
    // handoff goes through — the palette and History reach it without a button.
    if (this.#running || this.#runPending) {
      this.#ports.ui.notify("warning", "A BugPilot run is in progress. Wait for it to finish before handing this work item to an agent.");
      return;
    }
    if (this.#mutation !== undefined) {
      this.#ports.ui.notify("warning", HANDOFF_WAITS_FOR[this.#mutation]);
      return;
    }
    // Nor a package the form no longer describes: the developer changed what
    // the context is about and has not rebuilt it.
    if (this.#stale()) {
      this.#ports.ui.notify("warning", STALE_HANDOFF);
      return;
    }

    // Said before the probe rather than after it: resolving an agent spawns a
    // process per candidate, and a button that does nothing visible for half a
    // second reads as a click that was dropped. Set before the first wait, so a
    // second press finds it set.
    const epoch = this.#fixEpoch;
    this.#handoffBusy = true;
    this.#push();
    try {
      await this.#handOver(workItemId, root, epoch, {
        prompt: this.#handoffText(workItemId),
        detail: (agent) => `Handed to ${agent} in a terminal.`,
      });
    } finally {
      // A handoff dropped by a switch or a run leaves the state alone: it was
      // reset where it changed, and may already belong to another press.
      if (epoch === this.#fixEpoch) {
        this.#handoffBusy = false;
        this.#push();
      }
    }
  }

  /** Drop Fix with AI's outcome, its card, and any handoff or new attempt still being worked out. */
  #forgetFix(): void {
    this.#fix = undefined;
    this.#handoffError = undefined;
    this.#handoffBusy = false;
    this.#attempt = undefined;
    this.#attemptDraft = undefined;
    this.#fixEpoch += 1;
  }

  /**
   * The handoff itself, wrapped by `fixWithAI` so the busy flag always clears.
   *
   * After every wait it asks whether the press is still wanted: another work
   * item or a run since, and nothing of it — a terminal, a clipboard copy, an
   * outcome, a card — may reach the screen.
   */
  async #handOver(workItemId: string, root: string, epoch: number, launch: Launch): Promise<void> {
    // The prompt points at task.md, so a package without one has nothing to
    // hand over: an agent told to read a missing file starts by looking for it.
    if (this.#noTaskToHandOver(workItemId)) return;
    const text = launch.prompt;
    const plan = await this.#resolveSelectedAgent(text);
    if (epoch !== this.#fixEpoch) return;
    // The folder may have been read again while the agent was looked for, and
    // task.md gone with it (a Clean, say): the same answer as before the probe.
    if (this.#noTaskToHandOver(workItemId)) return;

    if (plan.kind === "refused") {
      // Not reachable with a valid id — the sentence is plain — but the gate is
      // shared with Review with AI, and a refusal is said, not swallowed.
      this.#fix = {
        status: "skipped",
        detail: "The handoff prompt is not one BugPilot puts on a command line, so nothing was handed to an agent.",
      };
      this.#ports.ui.notify("warning", `BugPilot will not hand ${workItemId} over: ${plan.reason}`);
      return;
    }

    if (plan.kind === "run") {
      // A retry that works clears the card the previous attempt left behind.
      this.#handoffError = undefined;
      this.#resolvedAgent = { kind: "resolved", label: plan.label };
      // Numbered from the second, so Open AI Session — and the developer, in
      // the terminal list — can tell this attempt's terminal from the last one.
      const attempts = (this.#sessions.get(workItemId)?.attempts ?? 0) + 1;
      const terminal = attempts === 1 ? fixTerminalName(workItemId) : `${fixTerminalName(workItemId)} (${attempts})`;
      this.#ports.log.info(`Handing ${workItemId} to ${plan.label}: ${plan.commandLine}`);
      this.#ports.ui.runInTerminal(terminal, root, plan.commandLine);
      this.#sessions.set(workItemId, { terminal, agent: plan.label, attempts });
      // "success" means handed over, and the detail says so. The agent runs in
      // a terminal this extension does not own, so whether it *fixed* anything
      // is not knowable here and is not claimed.
      this.#fix = { status: "success", detail: launch.detail(plan.label) };
      // No push here: `fixWithAI`'s `finally` does one, and pushing before it
      // would put a state on screen that is both busy and finished at once.
      return;
    }

    // Nothing to run. Copy the prompt and put the developer in front of
    // whatever agent they do have, rather than opening a terminal that prints
    // "command not found" and reads as our failure.
    await this.#ports.ui.copyToClipboard(text);
    // Copied while this work item was on screen; if it is not any more, do not
    // bring an agent's panel forward for it either.
    if (epoch !== this.#fixEpoch) return;
    const revealed = await this.#ports.ui.revealAgentPanel();
    if (epoch !== this.#fixEpoch) return;
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

  /** Whether the package has no task.md to hand over — said on the row and in a notice when so. */
  #noTaskToHandOver(workItemId: string): boolean {
    if (this.#artifactNames.includes(TASK_ARTIFACT)) return false;
    this.#fix = {
      status: "skipped",
      detail: `No ${TASK_ARTIFACT} was prepared, so nothing was handed to an agent.`,
    };
    this.#ports.ui.notify(
      "warning",
      `There is no ${TASK_ARTIFACT} for ${workItemId}. Run BugPilot with Build context enabled first.`,
    );
    return true;
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

  /**
   * Take what the Workflow Settings page applied.
   *
   * The page edits a draft and sends nothing until Apply, so this is the one
   * moment its settings reach the host — and, through `#formChanged`, the one
   * moment they can make a prepared context stale. The rules are the ones any
   * form change goes through; nothing here decides staleness itself.
   *
   * Refused while a run, a handoff or an artifact write is in flight — the page
   * disables Apply then, and a press that raced it is answered by putting the
   * host's form back on the page, so the page never shows settings the host
   * does not hold.
   */
  async applySettings(form: FormState): Promise<void> {
    if (this.#busy()) {
      this.#ports.log.error("Refusing to apply Workflow Settings while an operation is in flight.");
      this.#ports.ui.notify("info", `Workflow Settings were not applied. ${this.#busyReason()}`);
      this.#revision += 1;
      this.#push();
      return;
    }
    const before = JSON.stringify(this.#primaryView());
    await this.#formChanged(form);
    // Pushed whether or not the primary action moved: the rows' summaries are
    // the settings just applied, and they are on screen now.
    if (JSON.stringify(this.#primaryView()) === before) this.#push();
  }

  /**
   * The file dialog, for the settings page's draft list.
   *
   * Like `addAttachments`, the dialog is the host's and every path in the list
   * traces back to it; unlike it, the form is not touched — the merged list goes
   * back to the page, once, and becomes the form's only if the page is applied.
   */
  async pickAttachments(current: readonly string[]): Promise<void> {
    const picked = await this.#ports.ui.pickFiles();
    if (picked.length === 0) return;
    const merged = [...current];
    for (const path of picked) {
      if (!merged.includes(path)) merged.push(path);
    }
    if (merged.length > MAX_ATTACHMENTS) {
      this.#ports.ui.notify("warning", `BugPilot attaches at most ${MAX_ATTACHMENTS} files; the rest were not added.`);
    }
    this.#attachmentPickToken += 1;
    this.#attachmentPick = { token: this.#attachmentPickToken, attachments: merged.slice(0, MAX_ATTACHMENTS) };
    this.#push();
    this.#attachmentPick = undefined;
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
    // The report may have been rewritten since the checklist was read. A copy
    // in flight is not affected: the prompt depends on the work item alone.
    this.#forgetValidation();
    // Nor is a review handoff, while the report is still there. Without one,
    // a handoff in flight is about a report that is gone — and so is an
    // outcome, which must not reappear with the next report.
    if (!names.includes(FIX_REPORT_ARTIFACT)) {
      this.#forgetReview();
      // A recording is about the report on screen; without one it is stale.
      this.#forgetCapture();
    }
    await this.#readSummary(workItemId, names);
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
    // History, the saved work item and the command argument all arrive here,
    // and none of them is trusted to name a work item (§37.70). Logged, not
    // echoed into the notice: the name is not ours.
    if (!isWorkItemId(workItemId)) {
      this.#ports.log.error(`Refusing to open a work item whose id is not one: ${JSON.stringify(workItemId)}`);
      this.#ports.ui.notify("warning", "BugPilot will not open this work item: its id is not one BugPilot could have created.");
      return;
    }
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
    // Another bug entirely: nothing of the previous one's handoff belongs to
    // it — not the error, not the outcome, and not one still being worked out.
    // Nor its issue, its search, its report, its review aids or its file
    // listing: `refreshArtifacts` pushes before it reads, and that push must
    // not name the previous work item on these rows — nor offer its files,
    // which is what the listing decides. All before the first wait below, so a
    // handoff or query of the previous item that resumes during it already
    // finds itself stale (§37.70).
    this.#forgetFix();
    this.#forgetSummary();
    this.#artifactNames = [];
    const parsed = await this.#readStatus(workItemId);
    this.#progress = viewFromStatus(parsed);
    this.#preparedFixMode = preparedFixModeFromStatus(parsed, this.#fixModes);
    // The reopened item is the subject of the next Run too, as far as that can
    // be true without discarding what the developer typed (release
    // stabilization). The selection follows whatever the next Run prepares:
    // - a key (or nothing) in the field: a reopened Jira item's key replaces it,
    //   Fresh is cleared — the next Run is about a different item — and the mode
    //   it was prepared with is selected again;
    // - a bug description being typed: never replaced, and its selection is its own;
    // - a hand-written (local) item cannot come back into the field from its id,
    //   so its mode is re-selected only while the field is empty.
    const jira = JIRA_ISSUE_KEY_RE.test(workItemId);
    const typed = (this.#form.source === "jira" ? this.#form.issueKey : this.#form.description).trim();
    const keyOrEmpty = this.#form.source === "jira" || typed === "";
    if (jira && keyOrEmpty) {
      if (workItemScopeOf(this.#form) !== workItemId) {
        this.#replaceForm({ ...this.#form, source: "jira", issueKey: workItemId, fresh: false });
        this.#forgetHintSuggestion();
      }
      this.#deriveFixModeFor(workItemId, this.#preparedFixMode);
    } else if (!jira && typed === "") {
      this.#deriveFixModeFor(workItemId, this.#preparedFixMode);
    }
    // What built the package on disk is not recorded anywhere the panel can
    // read, so the baseline is the form as it now stands — what Rebuild Context
    // would use. A form about another bug still reads as stale: that is decided
    // by which work item it names, not by this.
    this.#preparedWith = preparationFingerprint(this.#form);
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
    // Read, never kept: the hint being improved is the settings page's draft,
    // which is the host's form only once it is applied.
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
    // The page has already put the suggestion into the settings page's Hint —
    // a draft, like every field there — so the form is not replaced here. The
    // hint reaches the host, and can make a context stale, only on Apply.
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
    // Compared after, so an edit that makes the context stale — or undoes that —
    // is on the button with the next push, and not only on the next Run.
    const primaryBefore = JSON.stringify(this.#primaryView());
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
      if (changed || JSON.stringify(this.#primaryView()) !== primaryBefore) this.#push();
      return;
    }
    const prepared =
      scope === MANUAL_WORK_ITEM_SCOPE
        ? undefined
        : preparedFixModeFromStatus(await this.#readStatus(scope), this.#fixModes);
    // Only the selection follows the typed key. `#preparedFixMode` keeps
    // describing the work item whose artifacts and progress are on screen,
    // which is still the one that was opened.
    const derived = this.#deriveFixModeFor(scope, prepared);
    if (derived || changed || JSON.stringify(this.#primaryView()) !== primaryBefore) this.#push();
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
    const cards = [this.#runFailure(), this.#handoffError, this.#reviewError()];
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
    this.#fixReport = undefined;
    this.#reviewReport = undefined;
    this.#verificationReport = undefined;
    this.#verificationText = undefined;
    this.#forgetPostFix();
    this.#searchCounts = {};
    this.#files = [];
    this.#moreFiles = 0;
    this.#terms = [];
  }

  /** Drop Fix result's review aids: another work item, or a run starting. */
  #forgetPostFix(): void {
    this.#forgetValidation();
    this.#copyingReviewPrompt = false;
    this.#forgetReview();
    this.#forgetCapture();
  }

  /**
   * Drop the Validation checklist and any load of it in flight — the report or
   * retrieval.json it was built from may have changed.
   */
  #forgetValidation(): void {
    this.#validation = undefined;
    this.#validationEpoch += 1;
  }

  /**
   * Whether Fix result's review aids are on offer right now.
   *
   * The same condition as the row itself: a work item, and its report in the
   * listing. A page that asks for them otherwise is refused, like any action
   * nothing offered.
   */
  #offersPostFix(): boolean {
    return (
      this.#workItemId !== undefined &&
      this.#root !== undefined &&
      this.#artifactNames.includes(FIX_REPORT_ARTIFACT)
    );
  }

  /**
   * Copy the final-review prompt to the clipboard, for whichever reviewer the
   * developer uses.
   *
   * Prepared by `review-package --json`, the read-only query: nothing is
   * written, marked, posted or launched. The prompt asks for a review; copying
   * it is not one, and nothing records that it happened.
   */
  async copyReviewPrompt(): Promise<void> {
    const workItemId = this.#workItemId;
    const root = this.#root;
    if (!workItemId || !root || !this.#offersPostFix()) {
      this.#ports.log.error("Refusing to copy a review prompt: no fix report is on screen.");
      return;
    }
    if (this.#copyingReviewPrompt) return;
    this.#copyingReviewPrompt = true;
    this.#push();
    const result = await this.#reviewPackage(workItemId, root);
    // The prompt is a function of the work item alone, so the folder read again
    // or a re-run of the same one does not stale it. Another work item on
    // screen, or its report gone, does: nothing is copied, and nothing said.
    const sameItem = this.#workItemId === workItemId;
    if (sameItem) this.#copyingReviewPrompt = false;
    if (!sameItem || !this.#offersPostFix()) {
      if (sameItem) this.#push();
      return;
    }
    if (typeof result === "string") {
      this.#push();
      this.#ports.ui.notify("error", `Could not prepare the review prompt: ${result}`);
      return;
    }
    try {
      await this.#ports.ui.copyToClipboard(result.prompt);
    } catch (error) {
      this.#push();
      this.#ports.ui.notify("error", `Could not copy the review prompt: ${oneSentence((error as Error).message)}`);
      return;
    }
    this.#push();
    this.#ports.ui.notify("info", "Review prompt copied. Paste it into the reviewer you use.");
  }

  /**
   * Fetch Fix result's Validation checklist, when the developer opens it.
   *
   * Once per report on screen: loading or loaded, a second ask is ignored; a
   * failure can be retried. Guidance only — nothing here records a check.
   */
  async loadValidation(): Promise<void> {
    const workItemId = this.#workItemId;
    const root = this.#root;
    if (!workItemId || !root || !this.#offersPostFix()) {
      this.#ports.log.error("Refusing to load a validation checklist: no fix report is on screen.");
      return;
    }
    if (this.#validation?.state === "loading" || this.#validation?.state === "ready") return;
    const epoch = this.#validationEpoch;
    this.#validation = { state: "loading" };
    this.#push();
    const result = await this.#reviewPackage(workItemId, root);
    // Another work item, a run, or the folder read again since: this list is
    // about files nobody is looking at any more.
    if (epoch !== this.#validationEpoch) return;
    this.#validation =
      typeof result === "string" ? { state: "failed", message: result } : { state: "ready", checklist: result.validation };
    this.#push();
  }

  /**
   * Drop Review with AI's outcome, and any handoff in flight — dropped where it
   * next looks. Starting, started or failed, it belongs to what is gone.
   */
  #forgetReview(): void {
    this.#review = undefined;
    this.#reviewEpoch += 1;
  }

  /** Whether Review with AI may start now: a report on screen, and none starting or started. */
  #offersReview(): boolean {
    return this.#offersPostFix() && canStartReview(this.#review);
  }

  /** Review with AI's card, while it is on screen. */
  #reviewError(): UserFacingError | undefined {
    return this.#offersPostFix() && this.#review?.state === "failed" ? this.#review.error : undefined;
  }

  /**
   * Hand the canonical review prompt to the selected agent, in a terminal.
   *
   * The prompt is `review-package --json`'s, byte for byte — the CLI's builder,
   * not a copy of it here — and the agent is whichever Fix with AI would use.
   * The terminal opens in the repository root, where the prompt's `.ai/<id>/`
   * paths and the current diff are. Nothing is written, marked or posted, the
   * clipboard is left alone, and nothing waits for the reviewer: "AI review
   * started" is the whole claim, as "AI fix started" is Fix with AI's.
   */
  async reviewWithAI(): Promise<void> {
    const workItemId = this.#workItemId;
    const root = this.#root;
    if (!workItemId || !root || !this.#offersReview()) {
      this.#ports.log.error("Refusing to start a review: no fix report is on screen, or a review is already under way.");
      return;
    }
    const epoch = this.#reviewEpoch;
    this.#review = { state: "starting" };
    this.#push();

    const result = await this.#reviewPackage(workItemId, root);
    if (!this.#reviewStillWanted(epoch)) return;
    if (typeof result === "string") {
      this.#reviewFailed(reviewHandoffError("prompt", result));
      return;
    }
    let plan: AgentPlan;
    try {
      plan = await this.#resolveSelectedAgent(result.prompt);
    } catch (error) {
      // Not expected — `canRun` answers rather than throws — but a probe that
      // failed must not leave the button waiting for ever.
      if (!this.#reviewStillWanted(epoch)) return;
      this.#reviewFailed(reviewHandoffError("agent", oneSentence((error as Error).message)));
      return;
    }
    if (!this.#reviewStillWanted(epoch)) return;
    // The shared prompt gate (`isPlainPrompt`, applied by `resolveAgent` before
    // any probe): had, but not put on a command line.
    if (plan.kind === "refused") {
      this.#reviewFailed(reviewHandoffError("command-line", plan.reason));
      return;
    }
    if (plan.kind === "unavailable") {
      this.#resolvedAgent = { kind: "unavailable" };
      this.#reviewFailed(reviewHandoffError("agent", plan.reason));
      return;
    }
    this.#resolvedAgent = { kind: "resolved", label: plan.label };
    this.#ports.log.info(`Handing the review of ${workItemId} to ${plan.label}: ${plan.commandLine}`);
    try {
      this.#ports.ui.runInTerminal(`Review with AI · ${workItemId}`, root, plan.commandLine);
    } catch (error) {
      this.#reviewFailed(reviewHandoffError("terminal", oneSentence((error as Error).message)));
      return;
    }
    this.#review = { state: "started", agent: plan.label };
    this.#push();
  }

  /**
   * Whether a review handoff begun under `epoch` may still act.
   *
   * Another work item, a run, or the report gone since: no — and that state was
   * reset where it changed, so nothing is touched here. The folder merely read
   * again, the report still listed: yes.
   */
  #reviewStillWanted(epoch: number): boolean {
    return epoch === this.#reviewEpoch;
  }

  #reviewFailed(error: UserFacingError): void {
    this.#review = { state: "failed", error };
    this.#push();
  }

  /**
   * The selected agent, resolved for a prompt: the one place both handoffs ask,
   * so Fix with AI and Review with AI can never disagree about which agent the
   * developer chose.
   */
  #resolveSelectedAgent(prompt: string): Promise<AgentPlan> {
    return resolveAgent({
      choice: this.#form.agent,
      customCommand: this.#form.agentCommand,
      prompt,
      canRun: async (command) => (await this.#ports.canRun?.(command)) ?? false,
    });
  }

  /** `review-package --json`, read: the package, or why there is none, in one sentence. */
  async #reviewPackage(workItemId: string, root: string): Promise<ReviewPackage | string> {
    try {
      const envelope = await this.#ports.runner.runJson(reviewPackageArgs(workItemId), {
        cwd: root,
        timeoutMs: 60_000,
      });
      if (!envelope.ok) return oneSentence(envelope.error.message);
      return reviewPackageFromEnvelope(envelope) ?? "bugpilot returned a review package this extension could not read.";
    } catch (error) {
      return oneSentence((error as Error).message);
    }
  }

  /**
   * Drop a recording in flight and its outcome — dropped where it next looks.
   * Recording or failed, it belongs to what is gone.
   */
  #forgetCapture(): void {
    this.#reviewCapture = undefined;
    this.#verificationCapture = undefined;
    this.#verificationEdit = undefined;
    this.#verificationEditBasis = undefined;
    // Not `#mutation`: a process in flight is still in flight.
    this.#captureEpoch += 1;
  }

  /**
   * Whether an artifact recording — Record or Replace Review Result, Record or
   * Edit Verification Evidence — may start now: Fix result is on screen, no run
   * is in flight, and no artifact write is.
   */
  #offersRecording(): boolean {
    return this.#offersPostFix() && !this.#running && this.#mutation === undefined;
  }

  /** Refuse a run, saying why, while an artifact write is in flight. */
  #refuseRunForMutation(): boolean {
    if (this.#mutation === undefined) return false;
    this.#ports.ui.notify("warning", RUN_WAITS_FOR[this.#mutation]);
    return true;
  }

  /**
   * Record what a completed review said, in `review_report.md` (Batch 11).
   *
   * The review happened elsewhere — Review with AI's terminal, another tool, a
   * person — and nothing here knows how it went; the developer is telling us.
   * So this records their four sections and says so, and no more: not reviewed,
   * not passed, not verified. `record-review` does the writing, with the text in
   * a temporary file. A report already recorded is replaced only after the
   * developer confirms, and only then is `--replace` passed.
   */
  async recordReview(entry: ReviewEntry): Promise<void> {
    const workItemId = this.#workItemId;
    const root = this.#root;
    if (!workItemId || !root || !this.#offersRecording()) {
      this.#ports.log.error(
        "Refusing to record a review result: no fix report is on screen, a run is in flight, or an artifact write is.",
      );
      return;
    }
    // A new press is a new attempt: the last failure or success is not about it.
    this.#reviewCapture = undefined;
    if (!hasReviewContent(entry)) {
      this.#reviewCapture = { state: "failed", message: `${REVIEW_NOT_RECORDED}: enter at least one section.` };
      this.#push();
      return;
    }
    const port = this.#ports.runReviewCommand;
    if (!port) {
      this.#reviewCapture = { state: "failed", message: `${REVIEW_NOT_RECORDED}: this host cannot run record-review.` };
      this.#push();
      return;
    }
    this.#mutation = "review";
    const epoch = this.#captureEpoch;
    try {
      const replace = this.#artifactNames.includes(REVIEW_REPORT_ARTIFACT);
      if (replace) {
        // Pushed first so Save stops offering itself while the question is open.
        this.#push();
        let confirmed = false;
        try {
          confirmed = await this.#ports.ui.confirm(
            `Replace the review result recorded for ${workItemId}? review_report.md will be overwritten.`,
            "Replace",
          );
        } catch {
          confirmed = false;
        }
        if (epoch !== this.#captureEpoch || !confirmed) return;
      }
      this.#reviewCapture = { state: "recording" };
      this.#push();

      let envelope: Envelope;
      try {
        envelope = await port({
          args: (payloadPath) => recordReviewArgs(workItemId, payloadPath, replace),
          payload: reviewPayload(entry),
        });
      } catch (error) {
        envelope = {
          ok: false,
          command: "record-review",
          error: { code: "INTERNAL_ERROR", message: (error as Error).message },
        };
      }
      // Another work item, a reopen, a run or the report gone since: whatever the
      // CLI did, it is not this panel's to report now.
      if (epoch !== this.#captureEpoch) return;
      // Ended: what is pushed from here offers Record, Replace and Run again.
      this.#mutation = undefined;
      const outcome = recordingOutcome(envelope);
      if (!outcome.recorded) {
        this.#reviewCapture = { state: "failed", message: `${REVIEW_NOT_RECORDED}: ${oneSentence(outcome.reason)}` };
        this.#push();
        // Recorded elsewhere meanwhile — a terminal, another window: read the folder
        // again so the row offers that report's Open and Replace instead of a Record
        // that can only fail the same way. The failure stays said.
        if (!envelope.ok && envelope.error.code === "ARTIFACT_EXISTS" && epoch === this.#captureEpoch) {
          await this.refreshArtifacts();
        }
        return;
      }
      // Said by the host, once the CLI answered for this work item: the one signal
      // that lets the page close the form. The file is the result — read it back the
      // way a reopen would. The row's status announces it; no second notification.
      this.#reviewCapture = { state: "recorded", replaced: replace };
      await this.refreshArtifacts();
    } finally {
      // The one place the flag clears. If it was still set, this recording ended
      // unreported (declined, or no longer wanted): push once, so whatever is on
      // screen now offers Record and Run again.
      if (this.#mutation === "review") {
        this.#mutation = undefined;
        this.#push();
      }
    }
  }

  /**
   * Record the checks the developer entered as verification evidence, in
   * `verification_report.md` (Batch 12).
   *
   * Nothing here runs a check or reads a result: every status is the one the
   * developer chose, and the report says so. `record-verification` does the
   * writing, with the checks in a temporary file. `replace` is the page saying
   * the form was opened by Edit — choosing Edit is the consent to overwrite, so
   * there is no second question — and `--replace` is passed only when that is so
   * and a report is listed, and only over the report that Edit answer (`basis`)
   * was read from: one changed since — by a terminal, an agent, another window —
   * is kept and said, never overwritten unseen. A Record that meets a report
   * written meanwhile is refused by the CLI and the folder is read again.
   */
  async recordVerification(
    checks: readonly VerificationCheckEntry[],
    replace: boolean,
    basis?: number,
  ): Promise<void> {
    const workItemId = this.#workItemId;
    const root = this.#root;
    if (!workItemId || !root || !this.#offersRecording()) {
      this.#ports.log.error(
        "Refusing to record verification evidence: no fix report is on screen, a run is in flight, or an artifact write is.",
      );
      return;
    }
    // A new press is a new attempt: the last failure or success is not about it.
    this.#verificationCapture = undefined;
    const problem = verificationProblem(checks);
    if (problem !== undefined) {
      this.#verificationCapture = { state: "failed", message: `${VERIFICATION_NOT_RECORDED}: ${problem}` };
      this.#push();
      return;
    }
    const port = this.#ports.runVerificationCommand;
    if (!port) {
      this.#verificationCapture = {
        state: "failed",
        message: `${VERIFICATION_NOT_RECORDED}: this host cannot run record-verification.`,
      };
      this.#push();
      return;
    }
    const overwrite = replace && this.#artifactNames.includes(VERIFICATION_REPORT_ARTIFACT);
    this.#mutation = "verification";
    const epoch = this.#captureEpoch;
    try {
      this.#verificationCapture = { state: "recording" };
      this.#push();

      if (overwrite) {
        const edited = this.#verificationEditBasis;
        const current = await this.#ports.files.readFile(this.#itemFile(workItemId, VERIFICATION_REPORT_ARTIFACT));
        if (epoch !== this.#captureEpoch) return;
        if (edited === undefined || basis !== edited.token || current !== edited.text) {
          this.#mutation = undefined;
          this.#verificationCapture = {
            state: "failed",
            message:
              `${VERIFICATION_NOT_RECORDED}: verification_report.md changed since Edit was opened, and it was kept. ` +
              "Press Edit Verification Evidence again to load it.",
          };
          await this.refreshArtifacts();
          return;
        }
      }

      let envelope: Envelope;
      try {
        envelope = await port({
          args: (payloadPath) => recordVerificationArgs(workItemId, payloadPath, overwrite),
          payload: verificationPayload(checks),
        });
      } catch (error) {
        envelope = {
          ok: false,
          command: "record-verification",
          error: { code: "INTERNAL_ERROR", message: (error as Error).message },
        };
      }
      // Another work item, a reopen, a run or the report gone since: whatever the
      // CLI did, it is not this panel's to report now.
      if (epoch !== this.#captureEpoch) return;
      // Ended: what is pushed from here offers Record, Edit and Run again.
      this.#mutation = undefined;
      const outcome = verificationOutcome(envelope);
      if (!outcome.recorded) {
        this.#verificationCapture = {
          state: "failed",
          message: `${VERIFICATION_NOT_RECORDED}: ${oneSentence(outcome.reason)}`,
        };
        this.#push();
        // Recorded elsewhere meanwhile: read the folder again so the row offers
        // that report's Open and Edit instead of a Record that can only fail the
        // same way. The failure stays said, and the form keeps what was typed.
        if (!envelope.ok && envelope.error.code === "ARTIFACT_EXISTS" && epoch === this.#captureEpoch) {
          await this.refreshArtifacts();
        }
        return;
      }
      // Said by the host, once the CLI answered for this work item: the one signal
      // that lets the page close the form. The file is the result — read it back.
      this.#verificationCapture = { state: "recorded", replaced: overwrite };
      this.#verificationEditBasis = undefined;
      await this.refreshArtifacts();
    } finally {
      // The one place the guard clears for this recording. Still set means it
      // ended unreported: push once, so the screen offers Record and Run again.
      if (this.#mutation === "verification") {
        this.#mutation = undefined;
        this.#push();
      }
    }
  }

  /**
   * Send the recorded checks to the page for Edit — once, parsed from the file
   * the host read. A report that is not in BugPilot's shape is sent as no checks,
   * and the form says saving will replace it. Offered on the same terms as a
   * recording: nothing to edit while something else is writing.
   */
  editVerification(): void {
    if (!this.#offersRecording() || !this.#artifactNames.includes(VERIFICATION_REPORT_ARTIFACT)) {
      this.#ports.log.error(
        "Refusing to edit verification evidence: none is recorded for the work item on screen, or a write is in flight.",
      );
      return;
    }
    const checks = this.#verificationReport?.checks;
    this.#verificationEditToken += 1;
    this.#verificationEdit = {
      token: this.#verificationEditToken,
      checks: checks ?? [],
      structured: checks !== undefined,
      unreadable: this.#verificationReport?.readable === false,
    };
    this.#verificationEditBasis = { token: this.#verificationEditToken, text: this.#verificationText };
    this.#verificationCapture = undefined;
    this.#push();
    // One push carries it: the page keeps the form from here, and the next push
    // must not open it again or ship every check with each progress event.
    this.#verificationEdit = undefined;
  }

  /** Open the recorded evidence — the canonical file, and only while it is listed. */
  async openVerificationReport(): Promise<void> {
    if (!this.#workItemId || !this.#artifactNames.includes(VERIFICATION_REPORT_ARTIFACT)) {
      this.#ports.log.error("Refusing to open a verification report: none is recorded for the work item on screen.");
      return;
    }
    await this.openArtifact(VERIFICATION_REPORT_ARTIFACT);
  }

  /**
   * Clean a work item's artifacts — the Clean command — never over an artifact
   * recording in flight (Batch 12). A clean that raced a recording could delete
   * the folder under it, or the recording's late write could put a report back
   * into a folder the developer just emptied. Refused before the confirmation and
   * again after it, since a recording may be pressed while the question is open.
   * While the clean runs it holds the same guard: no recording and no run start.
   * `perform` is the CLI's `clean`; the host owns the process.
   */
  async clean(workItemId: string, perform: () => Promise<void>): Promise<boolean> {
    if (this.#running) {
      this.#ports.ui.notify(
        "warning",
        "A BugPilot run is in progress. Wait for it to finish, or press Stop, before cleaning a work item.",
      );
      return false;
    }
    if (this.#mutation !== undefined) {
      this.#ports.ui.notify("warning", CLEAN_WAITS_FOR[this.#mutation]);
      return false;
    }
    const confirmed = await this.#ports.ui.confirm(
      `Delete every artifact for ${workItemId}? Anything an agent wrote, including fix_report.md, is removed.`,
      "Delete",
    );
    if (!confirmed) return false;
    if (this.#running) return false;
    if (this.#mutation !== undefined) {
      this.#ports.ui.notify("warning", CLEAN_WAITS_FOR[this.#mutation]);
      return false;
    }
    this.#mutation = "clean";
    this.#push();
    try {
      await perform();
    } finally {
      this.#mutation = undefined;
    }
    // Everything the agent was given is gone; so is the session to reopen.
    this.#sessions.delete(workItemId);
    await this.refreshArtifacts();
    this.#push();
    return true;
  }

  /** Open the recorded review — the canonical file, and only while it is listed. */
  async openReviewReport(): Promise<void> {
    if (!this.#workItemId || !this.#artifactNames.includes(REVIEW_REPORT_ARTIFACT)) {
      this.#ports.log.error("Refusing to open a review report: none is recorded for the work item on screen.");
      return;
    }
    await this.openArtifact(REVIEW_REPORT_ARTIFACT);
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
    // Only when listed: the listing decides whether there is a Fix result row,
    // and a listed report that cannot be read is projected as unreadable.
    this.#fixReport = names.includes(FIX_REPORT_ARTIFACT)
      ? parseFixReport(await this.#ports.files.readFile(this.#itemFile(workItemId, FIX_REPORT_ARTIFACT)))
      : undefined;
    // The same rule for the recorded review: listed, a Review Result; listed but
    // unreadable, one with "Preview unavailable".
    this.#reviewReport = names.includes(REVIEW_REPORT_ARTIFACT)
      ? parseReviewReport(await this.#ports.files.readFile(this.#itemFile(workItemId, REVIEW_REPORT_ARTIFACT)))
      : undefined;
    // And for recorded evidence: listed, a Verification Evidence section.
    this.#verificationText = names.includes(VERIFICATION_REPORT_ARTIFACT)
      ? await this.#ports.files.readFile(this.#itemFile(workItemId, VERIFICATION_REPORT_ARTIFACT))
      : undefined;
    this.#verificationReport = names.includes(VERIFICATION_REPORT_ARTIFACT)
      ? parseVerificationReport(this.#verificationText)
      : undefined;
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
   * Whether the work item on screen has a context ready to hand over: task.md
   * listed, from a Build context that finished, and no run rewriting it — the
   * same condition as the Fix with AI row's Ready.
   */
  #prepared(): boolean {
    if (this.#running || this.#workItemId === undefined) return false;
    const build = this.#progress.rows.find((row) => row.capability === "build_context");
    return build?.state === "done" && this.#artifactNames.includes(TASK_ARTIFACT);
  }

  /**
   * Whether the form no longer describes the prepared context.
   *
   * Two questions. Is it about the same work item — a Jira key names one, a
   * description names a new hand-written one, a half-typed key names none? And
   * if so, did any preparation input change since the baseline? Only what a
   * run would read counts (`preparationFingerprint`), so the agent picker, the
   * Fix with AI box or Fresh never make a context stale.
   */
  #stale(form: FormState = this.#form): boolean {
    const workItemId = this.#workItemId;
    if (!this.#prepared() || workItemId === undefined) return false;
    const preparedScope = JIRA_ISSUE_KEY_RE.test(workItemId) ? workItemId : MANUAL_WORK_ITEM_SCOPE;
    if (workItemScopeOf(form) !== preparedScope) return true;
    return this.#preparedWith !== undefined && preparationFingerprint(form) !== this.#preparedWith;
  }

  /**
   * Whether an AI attempt exists for the work item on screen: this panel
   * started one, or an agent wrote fix_report.md. Either way the next step is
   * to continue it — or to start another on purpose — not Fix with AI again.
   */
  #attempted(): boolean {
    const workItemId = this.#workItemId;
    if (workItemId === undefined) return false;
    return this.#sessions.has(workItemId) || this.#artifactNames.includes(FIX_REPORT_ARTIFACT);
  }

  /** A run, a handoff, a new attempt or an artifact write in flight: nothing else may start. */
  #busy(): boolean {
    return this.#running || this.#runPending || this.#handoffBusy || this.#mutation !== undefined;
  }

  /** The primary action and its menu, for the form and work item on screen. */
  #primaryView(): PrimaryView {
    const workItemId = this.#workItemId;
    return primaryView({
      ready: this.#readiness.kind === "ready" && this.#root !== undefined,
      busy: this.#busy(),
      prepared: this.#prepared(),
      stale: this.#stale(),
      attempted: this.#attempted(),
      sessionKnown: workItemId !== undefined && this.#sessions.has(workItemId),
      fresh: this.#form.fresh,
      settled: this.#progress.state === "done" || this.#progress.state === "failed",
    });
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
    const primary = this.#primaryView();
    const session = this.#workItemId === undefined ? undefined : this.#sessions.get(this.#workItemId);
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
      ...(this.#fixReport === undefined ? {} : { fixReport: this.#fixReport }),
      ...(this.#validation === undefined ? {} : { validation: this.#validation }),
      copyingReviewPrompt: this.#copyingReviewPrompt,
      ...(this.#review === undefined ? {} : { review: this.#review }),
      ...(this.#reviewReport === undefined ? {} : { reviewReport: this.#reviewReport }),
      ...(this.#reviewCapture === undefined ? {} : { reviewCapture: this.#reviewCapture }),
      canRecordReview: this.#offersRecording(),
      ...(this.#verificationReport === undefined ? {} : { verificationReport: this.#verificationReport }),
      ...(this.#verificationCapture === undefined ? {} : { verificationCapture: this.#verificationCapture }),
      canRecordVerification: this.#offersRecording(),
      ...(this.#verificationEdit === undefined ? {} : { verificationEdit: this.#verificationEdit }),
      ...(session === undefined ? {} : { session: { agent: session.agent, attempts: session.attempts } }),
      ...(this.#attempt === undefined ? {} : { attempt: this.#attempt }),
      ...(this.#attemptDraft === undefined ? {} : { attemptDraft: this.#attemptDraft }),
      feedbackHelpers: this.#feedbackHelpers(primary),
      settingsSummaries: settingsSummaries(this.#form, this.#fixModes),
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
      primary,
      ...(this.#attachmentPick === undefined ? {} : { attachmentPick: this.#attachmentPick }),
      ...(this.#workItemId === undefined ? {} : { workItemId: this.#workItemId }),
    });
  }
}

/**
 * The terminal Fix with AI opens for a work item; later attempts add " (2)",
 * " (3)". Open AI Session looks for it by this name.
 */
function fixTerminalName(workItemId: string): string {
  return `Fix with AI · ${workItemId}`;
}

/** A CLI message, bounded for a notification or a panel line. */
function oneSentence(message: string): string {
  const text = message.replace(/\s+/g, " ").trim() || "bugpilot gave no reason.";
  return text.length > 300 ? `${text.slice(0, 299).trimEnd()}…` : text;
}
