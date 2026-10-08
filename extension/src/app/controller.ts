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

import { buildPrepareArgs, buildRetryArgs, DEFAULT_FORM, isWorkItemId, preparationFingerprint, workItemScopeOf, MANUAL_WORK_ITEM_SCOPE, JIRA_ISSUE_KEY_RE } from "./form.ts";
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
import { gitHistoryOf } from "./gitHistory.ts";
import type { GitHistoryResult } from "./gitHistory.ts";
import { ISSUE_ARTIFACT, parseIssue } from "./issue.ts";
import type { IssueSummary } from "./issue.ts";
import { parseFixReport } from "./fixReport.ts";
import type { FixReportPreview } from "./fixReport.ts";
import { reviewPackageArgs, reviewPackageFromEnvelope } from "./reviewPackage.ts";
import { parseReviewReport } from "./reviewReport.ts";
import type { ReviewReportPreview } from "./reviewReport.ts";
import { REVIEW_NOT_SAVED, hasReviewContent, recordReviewArgs, recordingOutcome, reviewPayload } from "./reviewCapture.ts";
import type { ReviewCapture, ReviewEntry } from "./reviewCapture.ts";
import { parseReviewOutput } from "./reviewOutput.ts";
import type { ReviewPrefill } from "./reviewOutput.ts";
import { capturedReviewOutcome, fixReportIdentity } from "./reviewRun.ts";
import type { CapturedRun } from "./reviewRun.ts";
import { parseVerificationReport } from "./verificationReport.ts";
import type { VerificationCheckEntry, VerificationReportPreview } from "./verificationReport.ts";
import {
  VERIFICATION_NOT_RECORDED,
  recordVerificationArgs,
  verificationOutcome,
  verificationPayload,
  verificationProblem,
} from "./verificationCapture.ts";
import { VERIFICATION_AUTOSAVE_MS, isBlankCheck } from "./verificationCapture.ts";
import type { VerificationAutosave, VerificationCapture } from "./verificationCapture.ts";
import type { PayloadCommandRequest } from "./fixModeTransport.ts";
import type { ReviewPackage } from "./reviewPackage.ts";
import type { ContextCounts, RelevantFile } from "./contextSummary.ts";
import type { FieldProblem, FormState } from "./form.ts";
import { AgentService, capturedReviewOf } from "./agents.ts";
import { commandForLog, redactKnown, rejectedValueForLog, sensitiveValues, stderrForLog } from "./logSafety.ts";
import type {
  AgentLaunch,
  AgentResolution,
  AiFixRequest,
  CapturedReviewInvocation,
  InstalledExtension,
  LastAgentStore,
} from "./agents.ts";
import { buildWorkflow, canOpenFolder, canStartReview, overallStatus } from "./workflow.ts";
import type { AttemptDraft, AttemptView, FixWithAiOutcome, ReviewHandoff, ValidationView, VerificationEdit } from "./workflow.ts";
import type { DiagnosticsView } from "./diagnostics.ts";
import { GITIGNORE_NAME, addGitignoreRules, rulesFor, unignoredArtifactDirectories } from "./gitignore.ts";
import type { GitignoreEntry, GitignoreIo } from "./gitignore.ts";
import { handoffError, reviewHandoffError, runError } from "./failures.ts";
import { retrievalTerms } from "./retrievalDetails.ts";
import { diagnostics } from "./diagnostics.ts";
import { JIRA_API_TOKENS_URL, JIRA_AUTH_FAILED, jiraConnection, jiraSetupProblem } from "./jiraConnection.ts";
import type { JiraSiteOutcome } from "./jiraSite.ts";
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
import { outdatedCliActions } from "./environment.ts";
import {
  CLI_OUTDATED_ACTION,
  CLI_OUTDATED_SUMMARY,
  isMissingCli,
  outdatedCliDetail,
  rejectedByOutdatedCli,
} from "./cliCompatibility.ts";
import {
  formWithRepositoryProfile,
  repositoryProfileOfForm,
  repositoryProfileView,
  sameRepositoryProfile,
} from "./repositoryProfile.ts";
import type {
  RepositoryProfileOutcome,
  RepositoryProfilePayload,
  RepositoryProfileSnapshot,
} from "./repositoryProfile.ts";
import {
  INSTRUCTION_SCOPES,
  INSTRUCTION_TEXT,
  MAX_INSTRUCTION_CHARS,
  instructionsFingerprint,
  instructionsStatusLine,
} from "./instructions.ts";
import type { InstructionScope, InstructionsOutcome, InstructionsSnapshot } from "./instructions.ts";
import { formWithProjectSettings, projectSettingsOfForm, sameProjectSettings } from "./projectSettings.ts";
import type { ProjectSettingsOutcome, ProjectSettingsPayload, ProjectSettingsSnapshot } from "./projectSettings.ts";
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
import { MAX_ATTACHMENTS, MAX_ATTACHMENT_BYTES } from "../panel/messages.ts";
import type { AttachmentData } from "../panel/messages.ts";
import { attachmentDigest, attachmentFileName, holdsDigest } from "./attachmentFiles.ts";
import {
  RESET_CANCELS_REVIEW,
  RESET_LEAVES_AGENT,
  RESET_STOPS_RUN,
  SESSION_RESET,
  SESSION_RESET_DELETED,
  SESSION_RESET_NOTHING_TO_DELETE,
  deletionProblem,
  resetSessionForm,
} from "./sessionReset.ts";
import type { ArtifactDeletion, ResetSessionOptions } from "./sessionReset.ts";
import type {
  CreatedFixMode,
  Notice,
  PanelAction,
  PanelMessage,
  PanelState,
  SessionFeedback,
  SessionResetView,
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
 * empty list is what made the "`.ai/` is unreadable" state of §5.4 unreachable.
 */
export type DirectoryListing =
  | { readonly kind: "ok"; readonly names: readonly string[] }
  | { readonly kind: "missing" }
  | { readonly kind: "unreadable"; readonly detail: string };

/** The instruction editor while it is open (pre-release Batch 2): which scope, what it opened with. */
interface InstructionsEditorState {
  readonly scope: InstructionScope;
  readonly token: number;
  readonly text: string;
  readonly saving: boolean;
  readonly error?: { readonly token: number; readonly message: string };
}

export interface FilesPort {
  listDirectory(directory: string): Promise<DirectoryListing>;
  readFile(file: string): Promise<string | undefined>;
  /**
   * `workItem`, when `file` is in `.ai/<work item>/`: the host then writes it
   * only through real directories inside the repository, never through a link
   * (pre-release Batch 2, D; `writeWorkItemFile` in `sessionReset.ts`).
   */
  writeFile(file: string, contents: string, workItem?: WorkItemFolder): Promise<void>;
}

/** The repository and work item a file in `.ai/<work item>/` belongs to. */
export interface WorkItemFolder {
  readonly root: string;
  readonly workItemId: string;
}

export interface UiPort {
  /** Push a new state to the panel. */
  render(state: PanelState): void;
  openFile(file: string): Promise<void>;
  copyToClipboard(text: string): Promise<void>;
  /** A yes/no the developer must answer before something destructive happens. */
  confirm(message: string, confirmLabel: string, keepLabel?: string): Promise<boolean>;
  notify(kind: "info" | "warning" | "error", message: string): void;
  /** Ask the host to re-read the trees, after a run changed `.ai/`. */
  refreshViews(): void;
  /**
   * Open an address in the developer's browser, through the editor (§37.124):
   * only Jira Setup's fixed Atlassian page, never a URL the page names.
   */
  openExternal(url: string): Promise<void>;
  /** Open a terminal in `cwd` and run one command line in it. */
  runInTerminal(name: string, cwd: string, commandLine: string): void;
  /**
   * Bring forward the most recently opened terminal, still open, whose name
   * `matches` — Open AI Session's way back to the agent a handoff started.
   *
   * Returns false when there is none: closed, or never opened in this window.
   * Nothing is started in its place; the caller says so instead. Throws when
   * there is one and the editor could not show it.
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
  /**
   * Jira Setup's store (§37.124): the host's existing credential store, by
   * its two safe operations — whether a credential is stored and for which
   * email, and saving a new pair in one write. Nothing here yields a token.
   */
  readonly jiraCredentials: {
    status(): Promise<{ readonly configured: boolean; readonly email?: string }>;
    /** An empty token keeps the stored one (Batch 3); the store refuses when there is none. */
    save(credentials: { readonly email: string; readonly token: string }): Promise<void>;
  };
  /**
   * The Jira site, through `bugpilot jira-site` (pre-release Batch 3): read
   * when Jira Setup opens, written by its Save. Absent: the dialog cannot set
   * the site, and says so if asked to.
   */
  readonly jiraSite?: {
    readonly load: () => Promise<JiraSiteOutcome>;
    readonly save: (site: string) => Promise<JiraSiteOutcome>;
  };
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
   * The installed AI extensions, through VS Code's extension API, and a way to
   * run their commands (§37.94). Only `agents.ts` names an extension or a
   * command, and only commands the installed manifest declares are run — never
   * one the page named. Absent: every extension agent is "not installed".
   */
  readonly extensions?: {
    readonly get: (id: string) => InstalledExtension | undefined;
    readonly executeCommand: (command: string, ...args: readonly unknown[]) => Promise<void>;
  };
  /** The last agent a handoff reached, for Auto-detect; kept across reloads by the host. */
  readonly lastAgent?: LastAgentStore;
  /**
   * Keep a pasted or dropped file: write its bytes under the extension's own
   * storage, in a directory named by `digest`, as `name`, and return the path.
   * The host's path, never the page's. Absent: such a file cannot be kept.
   */
  readonly storeAttachment?: (digest: string, name: string, bytes: Uint8Array) => Promise<string>;
  /**
   * Persist which work item is being shown — or, after Reset Session, that none
   * is (`undefined`), so a restart does not bring the old one back.
   *
   * §5.4 requires the progress view to come back after a restart, and
   * `run.json` is the only record that survives the process — but
   * only if the window remembers *which* work item to read it from.
   */
  readonly saveWorkItem?: (workItemId: string | undefined) => void;
  /**
   * Reset Session's Delete generated files (§37.103): remove `.ai/<work item>/`
   * — checked to be the repository's own, then the CLI's `clean`, then looked
   * at again (`deleteWorkItemArtifacts` in `sessionReset.ts`). Absent: this host
   * cannot delete them, and a reset that asks to is refused.
   */
  readonly deleteWorkItemArtifacts?: (root: string, workItemId: string) => Promise<ArtifactDeletion>;
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
   * The repository's Repository Profile, through `bugpilot repository-profile`
   * (pre-release Batch 1): read when the environment resolves, written on
   * Apply. A port so the spawn stays with the host; absent, the form's copy is
   * all there is and Apply cannot save a change to it.
   */
  readonly repositoryProfile?: {
    readonly load: () => Promise<RepositoryProfileOutcome>;
    readonly save: (profile: RepositoryProfilePayload) => Promise<RepositoryProfileOutcome>;
  };
  /**
   * The repository's project settings — Verification Policy and branch naming —
   * through `bugpilot project-settings` (pre-release Batch 3): read when the
   * environment resolves, written on Apply, like the Repository Profile.
   */
  readonly projectSettings?: {
    readonly load: () => Promise<ProjectSettingsOutcome>;
    readonly save: (settings: ProjectSettingsPayload) => Promise<ProjectSettingsOutcome>;
  };
  /**
   * The User and Project / Team Instructions, through `bugpilot instructions`
   * (pre-release Batch 2): read when the environment resolves, before a Run and
   * when the editor opens; written by the editor's Save, the text on stdin.
   * Absent: the rows say nothing and Edit does not open.
   */
  readonly instructions?: {
    readonly load: () => Promise<InstructionsOutcome>;
    readonly save: (scope: InstructionScope, text: string) => Promise<InstructionsOutcome>;
  };
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
  /**
   * A captured one-shot review (§37.80): the agent's fixed argv, the prompt on
   * stdin, the repository root as cwd, and the process's own stdout back when it
   * exits. No shell and no terminal. Absent means Review with AI can only hand
   * the prompt over in a terminal.
   */
  readonly runCapturedReview?: (request: {
    readonly command: string;
    readonly args: readonly string[];
    readonly cwd: string;
    readonly input: string;
    /** Cancel Review: ends the process tree. */
    readonly signal?: AbortSignal;
    /** Called once the process has started — "running", not "starting". */
    readonly onStarted?: () => void;
  }) => Promise<CapturedRun>;
  /**
   * Which fix each work item's last review attempt was for — the fix report's
   * content identity, by work item — kept by the host across reloads (VS Code's
   * workspace state), never in the repository. Absent keeps it for the session.
   */
  readonly reviewedFixes?: {
    readonly get: (workItemId: string) => string | undefined;
    readonly set: (workItemId: string, fix: string | undefined) => void;
  };
  /**
   * Watch one work item's artifact directory — `.ai/<id>/`, its files only, not
   * recursive — and call back with the file name on every create, change or
   * delete (§37.81). The host's file watcher; absent, only the other refresh
   * triggers apply.
   */
  readonly watchArtifacts?: (directory: string, onEvent: (name: string) => void) => { dispose(): void };
  /** A timer, so a test can run the debounce by hand. Absent: `setTimeout`. */
  readonly schedule?: (callback: () => void, delayMs: number) => { cancel(): void };
  /**
   * The repository's `.gitignore`, through the editor and VS Code's file
   * system (§37.85): Repository Files' quick fix. Absent, the warning is shown
   * without it.
   */
  readonly gitignore?: GitignoreIo;
}

/** Artifact events closer together than this are one refresh. */
export const ARTIFACT_REFRESH_DEBOUNCE_MS = 250;

/** How long "AI session focused" stays under the button (§37.87). */
export const SESSION_FEEDBACK_MS = 1800;

export const SESSION_FOCUSED = "AI session focused";
export const SESSION_FOCUS_FAILED = "Could not open the existing AI session.";
/** A terminal this panel opened, since closed. Neutral: the fix did not fail. */
export const SESSION_CLOSED =
  "AI session is no longer available — its terminal was closed. To continue, use ⋯ → Start New Attempt.";
/** An attempt this window never saw start (a reload, another window). */
export const SESSION_NOT_IN_WINDOW =
  "AI session is no longer available in this window. To continue, use ⋯ → Start New Attempt.";
/** A read that failed mid-write is tried once more, this much later. */
export const ARTIFACT_REFRESH_RETRY_MS = 750;

/**
 * The artifact writes the host performs itself, one at a time (Batch 12): recording
 * a review result, recording verification evidence, cleaning a work item, and
 * preparing a retry package (release stabilization: it writes into the folder too)
 * — which Start New Attempt does too, when it carries feedback — and Reset Session
 * (§37.103), which may delete the folder and always detaches from it.
 */
type ArtifactMutation = "review" | "verification" | "clean" | "retry" | "attempt" | "aiReview" | "reset";

/** What a run that has to wait is told, per mutation in flight. */
const RUN_WAITS_FOR: Readonly<Record<ArtifactMutation, string>> = {
  review: "Wait for the review result recording to finish before starting a run.",
  verification: "Wait for the verification evidence recording to finish before starting a run.",
  clean: "Wait for the clean to finish before starting a run.",
  retry: "Wait for the retry to finish before starting a run.",
  attempt: "Wait for the new attempt to be prepared before starting a run.",
  aiReview: "Wait for the AI review to finish before starting a run.",
  reset: "Wait for the session reset to finish before starting a run.",
};

/** What Retry is told, per artifact write in flight. */
const RETRY_WAITS_FOR: Readonly<Record<ArtifactMutation, string>> = {
  review: "Wait for artifact recording to finish before retrying.",
  verification: "Wait for artifact recording to finish before retrying.",
  clean: "Wait for the clean to finish before retrying.",
  retry: "Wait for the retry to finish before retrying.",
  attempt: "Wait for the new attempt to be prepared before retrying.",
  aiReview: "Wait for the AI review to finish before retrying.",
  reset: "Wait for the session reset to finish before retrying.",
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
  aiReview: "Wait for the AI review to finish before cleaning this work item.",
  reset: "Wait for the session reset to finish before cleaning this work item.",
};

/** What a handoff is told, per artifact write in flight: it would read a folder being written. */
const HANDOFF_WAITS_FOR: Readonly<Record<ArtifactMutation, string>> = {
  review: "Wait for the review result recording to finish before handing this work item to an agent.",
  verification: "Wait for the verification evidence recording to finish before handing this work item to an agent.",
  clean: "Wait for the clean to finish before handing this work item to an agent.",
  retry: "Wait for the retry to finish before handing this work item to an agent.",
  attempt: "Wait for the new attempt to be prepared before handing this work item to an agent.",
  aiReview: "Wait for the AI review to finish before handing this work item to an agent.",
  reset: "Wait for the session reset to finish before handing this work item to an agent.",
};

/** What the primary action is waiting for, per artifact write in flight. */
const BUSY_WITH: Readonly<Record<ArtifactMutation, string>> = {
  review: "Wait for the review result recording to finish.",
  verification: "Wait for the verification evidence recording to finish.",
  clean: "Wait for the clean to finish.",
  retry: "Wait for the retry to finish.",
  attempt: "Wait for the new attempt to be prepared.",
  aiReview: "Wait for the AI review to finish.",
  reset: "Wait for the session reset to finish.",
};

/** Why Reset Session waits for a handoff being worked out: it may open a terminal at any moment. */
export const RESET_WAITS_FOR_HANDOFF = "Wait for BugPilot to finish handing this work item to an agent.";
/** Why Reset Session waits for Review with AI being prepared: it may open a terminal at any moment. */
export const RESET_WAITS_FOR_REVIEW = "Wait for Review with AI to start.";

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
export function warningsFromReport(report: Record<string, unknown>, fix: GitignoreFix = { kind: "idle" }): Notice[] {
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
        "No Jira site is configured, so an issue key cannot be fetched. Set it in Jira Setup (the Jira row's Configure), or set JIRA_BASE_URL. A bug you describe by hand needs neither.",
    });
  }
  if (report["ai_artifacts_ignored"] === false) {
    // `docs/safety.md` forbids the *agent* from committing these; nothing
    // stopped a developer, and one of the files holds fetched Jira content.
    warnings.push({
      title: "Repository Files",
      message:
        "This repository does not ignore .ai/ and .ai_memory/. Add both to .gitignore, or generated artifacts — including fetched Jira content — may appear in your commits.",
      ...repositoryFilesFix(report, fix),
    });
  }
  return warnings;
}

/**
 * Where Repository Files' quick fix stands (§37.85).
 *
 * `unsaved`: the rules went into an open `.gitignore` with unsaved changes,
 * which only the developer saves. `notIgnored`: they are on disk, and git still
 * does not ignore the directories — a later `!` rule, say. Neither offers the
 * button again: pressing it could not change the answer.
 */
export type GitignoreFix =
  | { readonly kind: "idle" }
  | { readonly kind: "busy" }
  | { readonly kind: "failed" }
  | { readonly kind: "unsaved"; readonly added: readonly string[] }
  | { readonly kind: "notIgnored" };

export const GITIGNORE_ACTION_LABEL = "Add to .gitignore";
export const GITIGNORE_ACTION_NAME = "Add .ai and .ai_memory to .gitignore";
export const GITIGNORE_FAILED = "Could not update .gitignore. The BugPilot output has the details.";

/** Why a Git history Supporting file did not open: the checkout no longer has it as a file. */
export const SUPPORTING_FILE_MISSING = "This file is no longer in the current checkout.";
export const SUPPORTING_FILE_NOT_A_FILE = "This supporting file is not a regular file in the current checkout.";
export const SUPPORTING_FILE_UNCHECKED =
  "Could not check this supporting file in the current checkout. The BugPilot output has the details.";

/** The rules the quick fix would write now: git's per-directory answer, nothing else. */
export function gitignoreRulesFromReport(report: Record<string, unknown> | undefined): readonly string[] {
  if (report === undefined || report["ai_artifacts_ignored"] !== false) return [];
  return rulesFor(unignoredArtifactDirectories(report) ?? []);
}

function repositoryFilesFix(report: Record<string, unknown>, fix: GitignoreFix): Pick<Notice, "action" | "status"> {
  const rules = gitignoreRulesFromReport(report);
  const action = {
    id: "addArtifactsToGitignore",
    label: GITIGNORE_ACTION_LABEL,
    accessibleName: GITIGNORE_ACTION_NAME,
  } as const;
  switch (fix.kind) {
    case "unsaved":
      return {
        status:
          fix.added.length === 0
            ? "Your open .gitignore already has the rules, but it has unsaved changes. Save it to apply them."
            : `Added ${fix.added.join(" and ")} to your open .gitignore, which has unsaved changes. Save it to apply them.`,
      };
    case "notIgnored":
      return {
        status: `The rules are in .gitignore, but Git still does not ignore ${missingNames(report)}. Another ignore rule may be excluding them again.`,
      };
    case "failed":
      return rules.length === 0 ? { status: GITIGNORE_FAILED } : { action, status: GITIGNORE_FAILED };
    case "busy":
      return { action: { ...action, label: "Adding to .gitignore…", busy: true } };
    case "idle":
      // No per-directory answer (an older bugpilot): the warning, and no guess.
      return rules.length === 0 ? {} : { action };
  }
}

function missingNames(report: Record<string, unknown>): string {
  const missing = unignoredArtifactDirectories(report);
  const names = (missing === undefined || missing.length === 0 ? [".ai", ".ai_memory"] : missing).map((name) => `${name}/`);
  return names.join(" and ");
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
   * Open AI Session's acknowledgement (§37.87): presentation only — never
   * persisted, never an artifact, and never a change to the attempt. One at a
   * time, for the work item it was pressed on, with at most one timer.
   */
  #sessionFeedback: (SessionFeedback & { readonly workItemId: string }) | undefined;
  #sessionFeedbackTimer: { cancel(): void } | undefined;
  #sessionFeedbackSeq = 0;
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
  /** `retrieval.json.git_history`, read with the rest of the file; absent when there is none to trust. */
  #gitHistory: GitHistoryResult | undefined;
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
  /**
   * The Review Result draft — a paste read, or a captured review's reply — held
   * for the work item on screen until it is saved, discarded (Cancel) or about
   * something no longer shown, and sent with every push so a recreated panel
   * fills its form again. Never persisted and never saved from here: only Save
   * Review Result records it.
   */
  #reviewDraft: Extract<ReviewPrefill, { entry: unknown }> | undefined;
  /** Why the last paste could not be read, held for exactly one push. */
  #reviewPasteError: Extract<ReviewPrefill, { error: string }> | undefined;
  #reviewDraftToken = 0;
  /**
   * `fix_report.md`'s content identity (`fixReportIdentity`), while it is listed:
   * the fix a review attempt is for. Two reads of the same text are the same fix.
   */
  #fixReportIdentity: string | undefined;
  /** The session's copy of which fix each work item's last review attempt was for. */
  readonly #reviewedFixes = new Map<string, string>();
  /**
   * The watcher on the shown work item's artifact directory, and which
   * directory it is for — replaced whenever the work item or the repository
   * changes, disposed with the controller (§37.81).
   */
  #artifactWatch: { readonly directory: string; readonly handle: { dispose(): void } } | undefined;
  /** The debounced refresh waiting to run, if any. */
  #artifactRefreshTimer: { cancel(): void } | undefined;
  /** An artifact changed while something was in flight; refresh when it ends. */
  #artifactRefreshPending = false;
  #disposed = false;
  /** The captured review process in flight, for Cancel Review. */
  #reviewRun: { readonly abort: AbortController; cancelled: boolean; started: boolean } | undefined;
  /** Which work item `#artifacts` was last listed for: a listing shown is only "known" for it. */
  #artifactsListedFor: string | undefined;
  /**
   * A run or a clean may delete and recreate `.ai/<id>/`, and a watcher on a
   * deleted directory can go quiet. Set when one starts; the first push after
   * it ends builds the watcher again, on the directory as it is now.
   */
  #artifactWatchStale = false;
  /** `verification_report.md`, projected, while the listing names it (Batch 12). */
  #verificationReport: VerificationReportPreview | undefined;
  /** A verification recording in flight, or its outcome. Never persisted. */
  #verificationCapture: VerificationCapture | undefined;
  /** The recorded checks for Edit, held for exactly one push. */
  #verificationEdit: VerificationEdit | undefined;
  /**
   * Verification Evidence auto-save (§37.83): the form's latest content, as
   * the page sent it with each edit, for the work item it was typed for; the
   * revision last saved, and what was saved (so an unchanged form writes
   * nothing); the debounce; and the state the page shows. Held here, not in the
   * page, so a panel hidden mid-edit — its webview destroyed — still saves, and
   * a switch to another work item can save first.
   */
  #verificationDraft:
    | { readonly workItemId: string; readonly checks: readonly VerificationCheckEntry[]; readonly revision: number }
    | undefined;
  #verificationDraftRevision = 0;
  #verificationSavedRevision = 0;
  #verificationSavedContent: string | undefined;
  #verificationSaveTimer: { cancel(): void } | undefined;
  #verificationAutosave: VerificationAutosave | undefined;
  /** A save held back because something else was writing; tried when it ends. */
  #verificationSavePending = false;
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
  /**
   * The Repository Profile as the repository's own file last said it, from
   * `bugpilot repository-profile` — `undefined` until read, or when it could not
   * be. The form holds the copy the page edits; this is what Apply compares it
   * with, and what a failed save puts back.
   */
  #savedProfile: RepositoryProfileSnapshot | undefined;
  /** A save of the Repository Profile in flight: a Run waits for it, so it reads the new file. */
  #profileSave: Promise<void> | undefined;
  /** The project settings as the repository's file last said them; `undefined` until read (Batch 3). */
  #savedProjectSettings: ProjectSettingsSnapshot | undefined;
  /** A save of the project settings in flight: a Run waits for it too. */
  #projectSettingsSave: Promise<void> | undefined;
  /**
   * An Apply that writes either file, from its first await to its last
   * (pre-release Batch 4.1). The two saves above run one after the other, so a
   * Run waiting on the first resumed before the second had begun and read the
   * old file; it waits for the whole Apply instead.
   */
  #settingsApply: Promise<void> | undefined;
  /**
   * What `bugpilot instructions` last said: each scope's state, text and hash
   * (pre-release Batch 2). `undefined` until read. The text is held for the
   * editor only — no log line, notice or state push outside it carries it.
   */
  #instructions: InstructionsSnapshot | undefined;
  /**
   * The instructions' fingerprint when the package on screen was prepared:
   * `#preparedWith`'s partner, set and cleared with it. `undefined` when it was
   * not known then — a stale check needs both sides.
   */
  #preparedInstructions: string | undefined;
  /** The instruction editor while it is open: its scope, the text it opened with, a save in flight. */
  #instructionsEditor: InstructionsEditorState | undefined;
  #instructionsEditorToken = 0;
  #instructionsErrorToken = 0;
  #root: string | undefined;
  #jiraConfigured = false;
  /**
   * Whether the last run this session that asked Jira was turned away with
   * `JIRA_AUTH_FAILED` (§37.110). The Jira row says "Authentication failed"
   * while it is; saving credentials, or a Jira run that gets its issue, clears
   * it. Never read from an old work item's files: it describes this session's
   * last exchange with Jira, and nothing older.
   */
  #jiraRejected = false;
  /**
   * Jira Setup's dialog while it is open (§37.124), else undefined. Holds the
   * stored email and whether a token is stored — the token itself never: it
   * passes through `saveJiraCredentials` into the store and is not kept.
   */
  #jiraSetup:
    | {
        readonly request: number;
        readonly email?: string;
        readonly site?: string;
        readonly siteFromEnvironment: boolean;
        readonly tokenStored: boolean;
        readonly saving: boolean;
        readonly error?: { readonly token: number; readonly field?: "site" | "email" | "token"; readonly message: string };
      }
    | undefined;
  #jiraSetupRequests = 0;
  #jiraSetupAnswers = 0;
  /**
   * What a handoff actually resolved, when one has run.
   *
   * Recorded where resolution already happens rather than derived from the
   * sentence it produced, and never filled in by anything else: Diagnostics
   * opening must not spend a process per candidate to answer a question nobody
   * pressed a button about.
   */
  #resolvedAgent: ResolvedAgent | undefined;
  /**
   * The AI Agent layer: every handoff resolves its agent here and hands the
   * request to the adapter it gets back. Nothing in this file names an agent.
   */
  readonly #agents: AgentService;
  /** `doctor`'s last report, when the environment was ready. The notices come from it. */
  #report: Record<string, unknown> | undefined;
  /** Repository Files' quick fix (§37.85). */
  #gitignoreFix: GitignoreFix = { kind: "idle" };
  /**
   * The report the notices showed when the fix started. While it runs they are
   * drawn from this, so the re-check's own push does not take the card away
   * before the fix can say what happened — the page would have nowhere to put
   * the focus that was on its button.
   */
  #gitignoreFixReport: Record<string, unknown> | undefined;
  /** What a quick fix that made its notice go away did. Cleared by the next environment check. */
  #noticeStatus: string | undefined;
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

  // --- Reset Session (§37.103) -------------------------------------------------

  /**
   * Which session this is: bumped by every completed Reset Session. Anything that
   * waits — a run, a folder read, a work item being opened, a hint being
   * improved, a key's Fix Mode being looked up — takes it before the wait and
   * drops its result if it changed, so nothing of the old session reappears on
   * the fresh one.
   */
  #sessionEpoch = 0;
  /** A reset in flight, from the press until it reset or said why not. */
  #reset: { readonly deleting: boolean } | undefined;
  /** Why the last press reset nothing, held for exactly one push. */
  #resetError: { readonly token: number; readonly message: string } | undefined;
  #resetErrorToken = 0;
  /** The run in flight — the whole of it, handoff included — so a reset can wait for it to end. */
  #runTask: Promise<void> | undefined;
  /** The captured review in flight, so a reset that cancelled it can wait for it to end. */
  #reviewTask: Promise<void> | undefined;

  constructor(ports: ControllerPorts, initialForm: FormState = DEFAULT_FORM) {
    this.#ports = ports;
    this.#form = initialForm;
    const extensions = ports.extensions;
    this.#agents = new AgentService({
      probes: {
        canRun: async (command) => (await ports.canRun?.(command)) ?? false,
        ...(extensions ? { extension: (id: string) => extensions.get(id) } : {}),
      },
      log: ports.log,
      ...(ports.lastAgent ? { lastAgent: ports.lastAgent } : {}),
      ...(ports.now ? { now: ports.now } : {}),
    });
  }

  /**
   * Find out which AI agents this machine has, for the picker's status line
   * (§37.94): at startup, when Advanced Settings opens, after the custom
   * command changes. Cached — a second call within a couple of minutes spawns
   * nothing — and never a handoff: a run asks again for itself.
   */
  async detectAgents(): Promise<void> {
    const pending = this.#agents.refresh(this.#form.agentCommand);
    this.#push();
    try {
      await pending;
    } catch (error) {
      // Not expected — detection answers rather than throws — but a picker
      // status is never worth an unhandled rejection.
      this.#ports.log.error(`Detecting AI agents failed: ${(error as Error).message}`);
    }
    this.#push();
  }

  /** An extension was installed, removed, enabled or disabled: what was detected may be wrong now. */
  async agentsChanged(): Promise<void> {
    this.#agents.invalidate();
    await this.detectAgents();
  }

  get workItemId(): string | undefined {
    return this.#workItemId;
  }

  /**
   * What BugPilot is configured with, for Results > Diagnostics (§37.110). The
   * tree asks for it when Diagnostics is drawn, and after each push to see
   * whether it changed.
   */
  get diagnostics(): DiagnosticsView {
    return this.#diagnostics();
  }

  /**
   * Jira credentials were just saved by the credential prompt: whatever Jira
   * said about the old ones no longer applies. Then the usual re-read.
   */
  async credentialsSaved(): Promise<void> {
    this.#jiraRejected = false;
    await this.refreshEnvironment();
  }

  /**
   * Open Jira Setup (§37.124) — the one dialog every way in reaches: the Jira
   * row's Configure or Replace, a failed run's Set Jira Credentials and the
   * command palette. It starts with the stored email, if any, and says
   * whether a token is stored; it is never given the token.
   */
  async openJiraSetup(): Promise<void> {
    const status = await this.#ports.jiraCredentials.status();
    const site = await this.#readJiraSite();
    this.#jiraSetupRequests += 1;
    this.#jiraSetup = {
      request: this.#jiraSetupRequests,
      ...(status.email === undefined ? {} : { email: status.email }),
      ...(site.site === undefined ? {} : { site: site.site }),
      siteFromEnvironment: site.fromEnvironment,
      tokenStored: status.configured,
      saving: false,
    };
    this.#push();
  }

  /** The site the dialog starts with: the CLI's answer, or nothing it could say. */
  async #readJiraSite(): Promise<{ readonly site?: string; readonly fromEnvironment: boolean }> {
    const port = this.#ports.jiraSite;
    if (!port || this.#readiness.kind !== "ready") return { fromEnvironment: false };
    const outcome = await port.load();
    if (outcome.kind !== "loaded") return { fromEnvironment: false };
    return { ...(outcome.site === undefined ? {} : { site: outcome.site }), fromEnvironment: outcome.fromEnvironment };
  }

  /**
   * Jira Setup's Save: the site through the CLI first — its check is the one
   * every Jira request uses, and a refusal stores nothing at all — then the
   * email and token in one SecretStorage write. A blank token keeps the stored
   * one; with none stored it is required. A site that `JIRA_BASE_URL` sets is
   * not this dialog's to change and is not written.
   */
  async saveJiraCredentials(email: string, token: string, site = ""): Promise<void> {
    const setup = this.#jiraSetup;
    if (setup === undefined || setup.saving) return;
    const fail = (field: "site" | "email" | "token" | undefined, message: string): void => {
      this.#jiraSetup = {
        ...(this.#jiraSetup ?? setup),
        saving: false,
        error: { token: ++this.#jiraSetupAnswers, ...(field === undefined ? {} : { field }), message },
      };
      this.#push();
    };
    const problem = jiraSetupProblem({ site, email, token }, setup);
    if (problem) {
      fail(problem.field, problem.message);
      return;
    }
    const { error: _previous, ...rest } = setup;
    this.#jiraSetup = { ...rest, saving: true };
    this.#push();
    if (!setup.siteFromEnvironment) {
      const port = this.#ports.jiraSite;
      if (!port || this.#readiness.kind !== "ready") {
        fail("site", "The Jira site could not be saved: BugPilot is not ready in this repository.");
        return;
      }
      const outcome = await port.save(site.trim());
      if (outcome.kind !== "loaded") {
        fail(
          "site",
          outcome.kind === "outdated" ? `The Jira site was not saved. ${CLI_OUTDATED_SUMMARY}` : oneSentence(outcome.message),
        );
        return;
      }
    }
    try {
      await this.#ports.jiraCredentials.save({ email: email.trim(), token: token.trim() });
    } catch (error) {
      fail(undefined, `The credentials could not be stored: ${redactKnown((error as Error).message, [token.trim()])}`);
      return;
    }
    this.#ports.log.info("Jira setup saved for this machine.");
    this.#jiraSetup = undefined;
    await this.credentialsSaved();
  }

  /** Jira Setup's Cancel or Escape: closed, nothing stored, nothing else changed. */
  closeJiraSetup(): void {
    if (this.#jiraSetup === undefined || this.#jiraSetup.saving) return;
    this.#jiraSetup = undefined;
    this.#push();
  }

  get root(): string | undefined {
    return this.#root;
  }

  /** The artifact list the tree view renders. */
  get artifacts(): ArtifactList {
    return this.#artifacts;
  }

  /**
   * Repository Files' quick fix (§37.85): add the rules git says are missing to
   * `<root>/.gitignore`, then ask `doctor` again.
   *
   * The rules are the report's, per directory, so a directory git already
   * ignores — by whatever spelling, in whatever file — gets nothing. Only that
   * one file, at the repository root the diagnostics ran in. The notice goes
   * away only when the re-check says git ignores both; a write that succeeded
   * is not the same thing.
   */
  async addBugPilotPathsToGitignore(): Promise<void> {
    const root = this.#root;
    const rules = gitignoreRulesFromReport(this.#report);
    const io = this.#ports.gitignore;
    const offered = this.#gitignoreFix.kind === "idle" || this.#gitignoreFix.kind === "failed";
    if (root === undefined || io === undefined || rules.length === 0 || !offered) {
      this.#ports.log.info("Add to .gitignore is not on offer; nothing was written.");
      return;
    }
    this.#gitignoreFix = { kind: "busy" };
    this.#gitignoreFixReport = this.#report;
    this.#noticeStatus = undefined;
    this.#push();

    const file = path.join(root, GITIGNORE_NAME);
    const outcome = await addGitignoreRules(io, file, rules);
    if (outcome.kind === "failed") {
      // The reason and the path; never the file's contents.
      this.#ports.log.error(`Could not update ${file}: ${outcome.detail}`);
      this.#gitignoreFix = { kind: "failed" };
      this.#gitignoreFixReport = undefined;
      this.#push();
      return;
    }
    if (outcome.kind === "unsaved" || (outcome.kind === "unchanged" && outcome.unsaved)) {
      // The disk has not changed, so neither has git's answer: nothing to re-check
      // until the developer saves.
      this.#ports.log.info(`${file} has unsaved changes; the rules were added to the editor, not saved.`);
      this.#gitignoreFix = { kind: "unsaved", added: outcome.kind === "unsaved" ? outcome.added : [] };
      this.#gitignoreFixReport = undefined;
      this.#push();
      return;
    }
    if (outcome.kind === "written") {
      this.#ports.log.info(`${outcome.created ? "Created" : "Updated"} ${file}: added ${outcome.added.join(", ")}.`);
    } else {
      this.#ports.log.info(`${file} already lists the rules; nothing was written.`);
    }
    await this.#recheckGitignore(outcome.kind === "written" ? outcome.added : []);
  }

  /**
   * The root `.gitignore` was saved in the editor: what git ignores may have
   * changed, so ask again — and, for a save of rules the quick fix put in the
   * buffer, say how it came out.
   */
  async gitignoreSaved(): Promise<void> {
    // The quick fix's own save of a clean buffer; it re-checks when it is done.
    if (this.#gitignoreFix.kind === "busy") return;
    const pending = this.#gitignoreFix.kind === "unsaved" ? this.#gitignoreFix.added : undefined;
    this.#gitignoreFix = { kind: "idle" };
    if (pending === undefined) {
      await this.#freshEnvironment();
      return;
    }
    this.#gitignoreFix = { kind: "busy" };
    this.#gitignoreFixReport = this.#report;
    await this.#recheckGitignore(pending);
  }

  /** The notice cards, from `doctor`'s report — the one at the press while a quick fix runs. */
  #notices(): readonly Notice[] {
    const report = this.#gitignoreFix.kind === "busy" ? (this.#gitignoreFixReport ?? this.#report) : this.#report;
    return report === undefined ? [] : warningsFromReport(report, this.#gitignoreFix);
  }

  /** `doctor` again, after a write: git's answer, not the write's. */
  async #recheckGitignore(added: readonly string[]): Promise<void> {
    try {
      await this.#freshEnvironment();
    } finally {
      const ignored = this.#report?.["ai_artifacts_ignored"] !== false;
      this.#gitignoreFix = ignored ? { kind: "idle" } : { kind: "notIgnored" };
      this.#gitignoreFixReport = undefined;
      if (ignored && this.#report !== undefined) {
        this.#noticeStatus =
          added.length === 0
            ? "Git now ignores .ai/ and .ai_memory/."
            : `Added ${added.join(" and ")} to .gitignore. Git now ignores .ai/ and .ai_memory/.`;
      }
      this.#push();
    }
  }

  /**
   * An environment check that starts after this call: one already in flight
   * began before a write, so its answer could predate it.
   */
  async #freshEnvironment(): Promise<void> {
    const inFlight = this.#probe;
    if (inFlight) await inFlight.catch(() => {});
    await this.refreshEnvironment();
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
    this.#report = environment.kind === "ready" ? environment.report : undefined;
    this.#noticeStatus = undefined;
    // Another repository, or git ignores both now: whatever the quick fix said
    // is about something that is no longer on screen.
    const nextRoot = environment.kind === "ready" || environment.kind === "unusable-cli" ? environment.root : undefined;
    if (
      this.#gitignoreFix.kind !== "busy" &&
      (nextRoot !== previousRoot || this.#report?.["ai_artifacts_ignored"] !== false)
    ) {
      this.#gitignoreFix = { kind: "idle" };
    }
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
    await this.#loadRepositoryProfile();
    await this.#loadProjectSettings();
    await this.#loadInstructions();
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
        // A rebuilt page starts on the form: an editor it no longer shows is closed.
        this.#instructionsEditor = undefined;
        this.#push();
        // The page loads whenever the panel is shown again — a hidden webview is
        // destroyed — so this is the "visible again" safety net for an artifact
        // event the watcher missed. Debounced like any other trigger.
        this.requestArtifactRefresh("panel shown");
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
      case "addAttachmentData":
        await this.addAttachmentData(message.origin, message.files, message.attachments);
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
      case "openSupportingFile":
        await this.openSupportingFile(message.path);
        return;
      case "manageFixModes":
        await this.openFixModeManager();
        return;
      case "detectAgents":
        await this.detectAgents();
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
      case "resetSession":
        await this.resetSession({ deleteGeneratedFiles: message.deleteGeneratedFiles });
        return;
      case "saveJiraCredentials":
        await this.saveJiraCredentials(message.email, message.token, message.site);
        return;
      case "closeJiraSetup":
        this.closeJiraSetup();
        return;
      case "openInstructions":
        await this.openInstructions(message.scope);
        return;
      case "closeInstructions":
        this.closeInstructions();
        return;
      case "saveInstructions":
        await this.saveInstructions(message.scope, message.text);
        return;
      case "parseReviewOutput":
        this.parseReviewOutput(message.text);
        return;
      case "discardReviewDraft":
        this.discardReviewDraft();
        return;
      case "recordVerification":
        await this.recordVerification(message.checks, message.replace, message.basis);
        return;
      case "verificationDraft":
        this.verificationDraftChanged(message.checks);
        return;
      case "flushVerification":
        await this.saveVerificationDraft();
        return;
      case "overwriteVerification":
        await this.overwriteVerification();
        return;
      case "discardVerificationDraft":
        this.#dropVerificationDraft();
        this.#push();
        return;
      case "action":
        if (message.id === "addArtifactsToGitignore") await this.addBugPilotPathsToGitignore();
        else if (message.id === "openContext") await this.openArtifact(CONTEXT_ARTIFACT);
        else if (message.id === "copyContext") await this.copyContext();
        else if (message.id === "openFolder") await this.openArtifactsFolder();
        else if (message.id === "fixWithAI") await this.fixWithAI();
        else if (message.id === "copyReviewPrompt") await this.copyReviewPrompt();
        else if (message.id === "loadValidation") await this.loadValidation();
        else if (message.id === "reviewWithAI") await this.reviewWithAI();
        else if (message.id === "cancelReview") await this.cancelReview();
        else if (message.id === "openReviewReport") await this.openReviewReport();
        else if (message.id === "openVerificationReport") await this.openVerificationReport();
        else if (message.id === "editVerification") this.editVerification();
        else if (message.id === "useReviewFindings" || message.id === "useVerificationEvidence") {
          await this.useFeedbackHelper(message.id);
        } else if (message.id === "openJiraTokenPage") await this.#ports.ui.openExternal(JIRA_API_TOKENS_URL);
        else await this.openJiraSetup();
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
    if (this.#reset !== undefined) return BUSY_WITH.reset;
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
    // The session this run was asked for in (§37.103): a reset before it starts
    // means the form it was given belongs to a session that is gone.
    const epoch = this.#sessionEpoch;
    // A run can delete the folder the verification form is saving into: save
    // it first, or go on only if the developer says so (§37.83).
    // Awaited only when there is something to save, so a run with nothing
    // unsaved begins in the same turn it was asked for, as before.
    if (this.#hasUnsavedVerification() && !(await this.#settleVerificationDraft("Run"))) return;
    this.#runPending = true;
    const before = this.#runsStarted;
    const task = this.#prepare(form, options, epoch);
    // The whole run, handoff included: what Reset Session waits for after Stop.
    this.#runTask = task;
    try {
      await task;
    } finally {
      if (this.#runTask === task) this.#runTask = undefined;
      const started = this.#runsStarted !== before;
      this.#runPending = false;
      // A run that never began — declined, invalid, refused — may have been
      // pushed as busy while it was being set up; say it is not any more.
      if (!started) this.#push();
    }
  }

  async #prepare(form: FormState, options: { readonly handOff?: boolean }, epoch: number): Promise<void> {
    this.#form = form;
    this.#ports.saveForm?.(form);

    if (this.#readiness.kind !== "ready" || !this.#root) {
      // Re-check first: the developer may have installed bugpilot since the
      // panel was opened, and refusing on stale state would be infuriating.
      await this.refreshEnvironment();
      if (this.#readiness.kind !== "ready" || !this.#root) return;
    }
    // An Apply is still writing the profile or the project settings: the run
    // reads both files, so it waits for the whole Apply (Batch 4.1) — and then
    // records the settings the files now hold. A refused save put the file's
    // values back on the host's form; the run uses those, so its baseline must
    // say so rather than claim the refused ones. Only the run's copy is
    // rebased: the host's form already holds the files' values, and any edit
    // made while the run waited stays there, to read as stale afterwards.
    if (this.#settingsApply) {
      await this.#settingsApply;
      if (this.#readiness.kind !== "ready") return;
      form = formWithProjectSettings(
        formWithRepositoryProfile(form, repositoryProfileOfForm(this.#form)),
        projectSettingsOfForm(this.#form),
      );
    }
    // A profile Apply is still writing: the run reads the file, so it waits for
    // the one on screen to be there.
    if (this.#profileSave) {
      await this.#profileSave;
      if (this.#readiness.kind !== "ready") return;
    }
    // Likewise the project settings: the run reads that file too.
    if (this.#projectSettingsSave) {
      await this.#projectSettingsSave;
      if (this.#readiness.kind !== "ready") return;
    }
    // The instructions as this run will read them, so the baseline below is
    // what the task gets — an edit made outside BugPilot since the last check
    // included (pre-release Batch 2). Only where there is something to read: a
    // host without the port starts its run without waiting a turn for nothing.
    if (this.#ports.instructions !== undefined) {
      await this.#loadInstructions();
      if (this.#readiness.kind !== "ready") return;
    }
    // Reset while the environment was checked, or being reset now: this form's
    // problems are not the fresh session's to show, and its Fresh question is not
    // one to ask (§37.103).
    if (epoch !== this.#sessionEpoch || this.#reset !== undefined) return;
    const root = this.#root;
    if (root === undefined) return;

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
    // above) must not have a run start over it — nor a reset, which this run's
    // form no longer describes (§37.103): dropped quietly, since the developer
    // chose the reset after pressing Run.
    if (this.#reset !== undefined || epoch !== this.#sessionEpoch) {
      this.#ports.log.info("Run not started: the session was reset while it was being set up.");
      return;
    }
    if (this.#refuseRunForMutation()) return;
    const tracker = new ProgressTracker(form.plan, this.#ports.now);
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
    this.#preparedInstructions = this.#instructionsFingerprint();
    // Fresh deletes the folder being watched: watch it again once the run ends.
    this.#artifactWatchStale = true;
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
    // The kept report is the same fix: its identity is kept with it.
    const reportIdentity = report === undefined ? undefined : this.#fixReportIdentity;
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
    this.#fixReportIdentity = reportIdentity;
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
      // The flags, never the text: a description, a hint or a keyword is
      // `<redacted>` in the log (§37.95).
      this.#ports.log.info(commandForLog(built.args));
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
          // A reset waits for this run to end, so this is only ever a process
          // the Runner gave up on still talking (§37.103): not this session's.
          if (epoch !== this.#sessionEpoch) return;
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
              `Ignoring a work item id from bugpilot that is not one ${rejectedValueForLog(event.work_item_id)}.`,
            );
          }
          this.#progress = tracker.view();
          this.#push();
        },
      );

      // A CLI too old for this Run's flags exits 2 with argparse's "unrecognized
      // arguments" (pre-release Batch 1, D): said as that, with the update
      // actions, rather than as a crash with a Retry that would fail the same way.
      const rejected = outcome.result.aborted ? undefined : rejectedByOutdatedCli(outcome.result);
      if (outcome.foreignVersion !== undefined) tracker.foreign(outcome.foreignVersion);
      else if (!outcome.terminated) {
        if (rejected !== undefined) {
          tracker.cliUnusable("outdated", outdatedCliDetail(rejected));
          this.#blockOutdatedCli(rejected);
        } else {
          tracker.interrupted(
            outcome.result.aborted ? (this.#stoppedByUser ? "stopped" : "timeout") : "crashed",
          );
        }
        if (!outcome.result.aborted && outcome.result.stderr.trim() !== "") {
          // Its tail, scrubbed: argparse and a traceback can both quote the
          // argv back, description and all.
          this.#ports.log.error(
            `bugpilot ${built.args[0] ?? ""} ended without a result (exit ${outcome.result.code ?? "none"}):\n${stderrForLog(outcome.result.stderr, sensitiveValues(built.args))}`,
          );
        }
      }
      this.#progress = tracker.view();
      this.#noteJiraOutcome(this.#progress, form);
    } catch (error) {
      // A spawn failure, or output that broke the contract outright.
      if (isMissingCli(error)) {
        // Gone since the environment was checked: said as that, and the check
        // run again so the environment card offers the way to fix it.
        tracker.cliUnusable("missing");
        this.#progress = tracker.view();
        this.#ports.log.error(`bugpilot ${built.args[0] ?? ""} could not run: the executable was not found.`);
        void this.#freshEnvironment();
      } else {
        tracker.interrupted("crashed");
        this.#progress = tracker.view();
        const reason = redactKnown((error as Error).message, sensitiveValues(built.args));
        this.#ports.log.error(`bugpilot ${built.args[0] ?? ""} could not run: ${reason}`);
        this.#ports.ui.notify("error", `bugpilot could not run: ${reason}`);
      }
    } finally {
      this.#running = false;
      this.#abort = undefined;
    }
    // Belt and braces for the same case: nothing of a run from before a reset
    // reaches the fresh session.
    if (epoch !== this.#sessionEpoch) {
      this.#push();
      return;
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
    // never wrote would send an agent looking for a missing file. Never while a
    // reset is waiting for this run to end: an agent started now would be
    // working on a session the developer just asked to leave (§37.103).
    if (options.handOff !== false && form.fixWithAI && this.#reset === undefined) {
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
    let shown: boolean;
    try {
      shown = this.#ports.ui.revealTerminal((name) =>
        session ? name === session.terminal : name === base || name.startsWith(`${base} (`),
      );
    } catch (error) {
      // The terminal is there and the editor would not show it. Said, and
      // nothing else: the attempt, its terminal and the row stay as they are.
      this.#ports.log.error(`Could not show the AI session terminal for ${workItemId}: ${(error as Error)?.message ?? String(error)}`);
      this.#showSessionFeedback(workItemId, "failed", SESSION_FOCUS_FAILED);
      return;
    }
    // Always said, found or not: a terminal already in front changes nothing
    // visible, and a press that changes nothing looks like one that did nothing.
    // VS Code cannot tell "brought forward" from "already in front" reliably
    // (`activeTerminal` is the panel's current tab, shown or not), so both are
    // "focused".
    if (shown) this.#showSessionFeedback(workItemId, "focused", SESSION_FOCUSED);
    else this.#showSessionFeedback(workItemId, "unavailable", session ? SESSION_CLOSED : SESSION_NOT_IN_WINDOW);
  }

  /** One acknowledgement at a time: a press replaces the last one, and its timer. */
  #showSessionFeedback(workItemId: string, kind: SessionFeedback["kind"], message: string): void {
    this.#sessionFeedbackTimer?.cancel();
    this.#sessionFeedbackTimer = undefined;
    this.#sessionFeedbackSeq += 1;
    this.#sessionFeedback = { kind, message, seq: this.#sessionFeedbackSeq, workItemId };
    if (kind === "focused") {
      const seq = this.#sessionFeedbackSeq;
      this.#sessionFeedbackTimer = this.#schedule(() => {
        this.#sessionFeedbackTimer = undefined;
        if (this.#sessionFeedback?.seq !== seq || this.#disposed) return;
        this.#sessionFeedback = undefined;
        this.#push();
      }, SESSION_FEEDBACK_MS);
    }
    this.#push();
  }

  #clearSessionFeedback(): void {
    this.#sessionFeedbackTimer?.cancel();
    this.#sessionFeedbackTimer = undefined;
    this.#sessionFeedback = undefined;
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
        { root, workItemId },
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
      this.#ports.log.error(`Refusing to hand over a work item whose id is not one ${rejectedValueForLog(workItemId)}.`);
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
    const resolution = await this.#resolveSelectedAgent(text);
    if (epoch !== this.#fixEpoch) return;
    // The folder may have been read again while the agent was looked for, and
    // task.md gone with it (a Clean, say): the same answer as before the probe.
    if (this.#noTaskToHandOver(workItemId)) return;

    if (resolution.kind === "refused") {
      // Not reachable with a valid id — the sentence is plain — but the gate is
      // shared with Review with AI, and a refusal is said, not swallowed.
      this.#fix = {
        status: "skipped",
        detail: "The handoff prompt is not one BugPilot puts on a command line, so nothing was handed to an agent.",
      };
      this.#ports.ui.notify("warning", `BugPilot will not hand ${workItemId} over: ${resolution.reason}`);
      return;
    }
    if (resolution.kind === "unavailable") {
      await this.#noAgentForHandoff(text, resolution.reason, epoch);
      return;
    }

    // Numbered from the second, so Open AI Session — and the developer, in
    // the terminal list — can tell this attempt's terminal from the last one.
    const attempts = (this.#sessions.get(workItemId)?.attempts ?? 0) + 1;
    const terminal = attempts === 1 ? fixTerminalName(workItemId) : `${fixTerminalName(workItemId)} (${attempts})`;
    const request: AiFixRequest = {
      workspacePath: root,
      workItemId,
      prompt: text,
      preparedContextPath: path.join(root, ".ai", workItemId, TASK_ARTIFACT),
      purpose: "fix",
    };
    const wanted = () => epoch === this.#fixEpoch;
    const result = await resolution.adapter.run(
      request,
      this.#agentLaunch(wanted, (commandLine) => {
        // The agent, never the command line: a custom command can carry a
        // token, and the prompt is not the log's business (§37.95).
        this.#ports.log.info(`Handing ${workItemId} to ${resolution.adapter.label} in a terminal.`);
        this.#ports.ui.runInTerminal(terminal, root, commandLine);
      }),
    );
    if (!wanted()) return;

    if (result.kind === "failed") {
      this.#fix = { status: "skipped", detail: `${result.reason} Nothing was handed to an agent.` };
      this.#resolvedAgent = { kind: "unavailable" };
      this.#handoffError = handoffError(result.reason);
      return;
    }
    // A retry that works clears the card the previous attempt left behind.
    this.#handoffError = undefined;
    this.#resolvedAgent = { kind: "resolved", label: result.label };
    this.#agents.succeeded(resolution.adapter.id);
    if (result.kind === "terminal") {
      this.#sessions.set(workItemId, { terminal, agent: result.label, attempts });
      // A new session: what the last Open AI Session press said is about the old one.
      this.#clearSessionFeedback();
      // "success" means handed over, and the detail says so. The agent runs in
      // a terminal this extension does not own, so whether it *fixed* anything
      // is not knowable here and is not claimed.
      this.#fix = { status: "success", detail: launch.detail(result.label) };
      // No push here: `fixWithAI`'s `finally` does one, and pushing before it
      // would put a state on screen that is both busy and finished at once.
      return;
    }
    // Native or bridge: in another extension's own view, not a terminal this
    // panel could bring back, so no session is recorded — Open AI Session has
    // nothing to reopen, and the next step is the fix report arriving.
    this.#fix = { status: "success", detail: result.message };
    this.#ports.ui.notify("info", result.message);
  }

  /**
   * What an adapter may do for a press, each step guarded: once the press is not
   * wanted any more, a copy, a command and a terminal all do nothing.
   */
  #agentLaunch(wanted: () => boolean, runInTerminal: (commandLine: string) => void): AgentLaunch {
    const extensions = this.#ports.extensions;
    return {
      runInTerminal: (commandLine) => {
        if (wanted()) runInTerminal(commandLine);
      },
      copyToClipboard: async (text) => {
        if (wanted()) await this.#ports.ui.copyToClipboard(text);
      },
      executeCommand: async (command, ...args) => {
        if (!wanted() || !extensions) return false;
        try {
          await extensions.executeCommand(command, ...args);
          return wanted();
        } catch (error) {
          this.#ports.log.error(`${command} did not run: ${(error as Error).message}`);
          return false;
        }
      },
    };
  }

  /**
   * No agent to hand to: copy the prompt and say so, rather than opening a
   * terminal that prints "command not found" and reads as our failure. No
   * other agent's view is brought forward — for an explicit choice that would
   * be the silent switch it must never make.
   */
  async #noAgentForHandoff(text: string, reason: string, epoch: number): Promise<void> {
    await this.#ports.ui.copyToClipboard(text);
    // Copied while this work item was on screen; if it is not any more, say
    // nothing about it on the one that is.
    if (epoch !== this.#fixEpoch) return;
    this.#fix = {
      status: "skipped",
      detail: `${reason} The handoff prompt is on the clipboard instead.`,
    };
    // The same event, said twice on purpose: a status on the workflow row, and
    // a card beside the result that says what to do about it. `reason` is the
    // agent layer's own sentence and is the Details text, never the headline.
    this.#resolvedAgent = { kind: "unavailable" };
    this.#handoffError = handoffError(reason);
    // The push is `fixWithAI`'s, for the same reason as the success branch. A
    // notification is a toast rather than panel state, so its order is its own.
    this.#ports.ui.notify(
      "info",
      `${reason} The handoff prompt is on the clipboard; paste it into your agent, or install one.`,
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
      `There is no ${TASK_ARTIFACT} for ${workItemId}. Press Run to prepare it first.`,
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
    const epoch = this.#sessionEpoch;
    const picked = await this.#ports.ui.pickFiles();
    // Cancelled. Nothing to merge, and no revision bump — which would rewrite
    // every field in the page for no reason. Nor after a reset: `form` is the
    // old session's (§37.103).
    if (picked.length === 0 || epoch !== this.#sessionEpoch) return;

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
      this.#ports.ui.notify("info", `Advanced Settings were not applied. ${this.#busyReason()}`);
      this.#revision += 1;
      this.#push();
      return;
    }
    // Registered before the first await, so a Run pressed at any point of the
    // Apply finds it (Batch 4.1).
    const apply = this.#applySettings(form);
    this.#settingsApply = apply;
    try {
      await apply;
    } finally {
      if (this.#settingsApply === apply) this.#settingsApply = undefined;
    }
  }

  async #applySettings(form: FormState): Promise<void> {
    const before = JSON.stringify(this.#primaryView());
    const previous = this.#form;
    await this.#formChanged(form);
    // The Repository Profile is the repository's file, not the form: a change
    // to it is written there, where every run reads it. So are the project
    // settings, in their own file (Batch 3).
    const baseline = this.#savedProfile?.profile ?? repositoryProfileOfForm(previous);
    const profileChanged = !sameRepositoryProfile(form, baseline);
    const settingsBaseline = this.#savedProjectSettings?.settings ?? projectSettingsOfForm(previous);
    const settingsChanged = !sameProjectSettings(form, settingsBaseline);
    if (profileChanged) await this.#saveRepositoryProfile(previous);
    if (settingsChanged) await this.#saveProjectSettings(previous);
    if (profileChanged || settingsChanged) return;
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
    const epoch = this.#sessionEpoch;
    const picked = await this.#ports.ui.pickFiles();
    // A reset meanwhile: `current` is the old session's draft (§37.103).
    if (picked.length === 0 || epoch !== this.#sessionEpoch) return;
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

  /**
   * Files pasted or dropped onto the settings page, for its draft list.
   *
   * The page sends bytes and the host keeps them, so every attachment is still
   * a path the host chose. Answered like the file dialog: the merged list goes
   * back to the page once and becomes the form's only on Apply. A file already
   * attached — the same content, by digest — is not attached twice, so a second
   * paste or a drop after a paste changes nothing.
   *
   * The log gets the kind, the size and the count. Never the name, the bytes or
   * anything the developer wrote about them.
   */
  async addAttachmentData(origin: "paste" | "drop", files: readonly AttachmentData[], current: readonly string[]): Promise<void> {
    const store = this.#ports.storeAttachment;
    if (!store) {
      this.#ports.ui.notify("warning", "This editor cannot keep pasted or dropped files. Use Add files… instead.");
      return;
    }
    const epoch = this.#sessionEpoch;
    const merged = [...current];
    const refused = new Set<string>();
    let added = 0;
    for (const file of files) {
      if (merged.length >= MAX_ATTACHMENTS) {
        refused.add(`BugPilot attaches at most ${MAX_ATTACHMENTS} files`);
        break;
      }
      const bytes = Buffer.from(file.data, "base64");
      if (bytes.length === 0) {
        refused.add("an empty file");
        continue;
      }
      if (bytes.length > MAX_ATTACHMENT_BYTES) {
        refused.add(`a file larger than ${MAX_ATTACHMENT_BYTES / (1024 * 1024)} MB`);
        continue;
      }
      const digest = attachmentDigest(bytes);
      if (holdsDigest(merged, digest)) {
        refused.add("a file that is already attached");
        continue;
      }
      let stored: string;
      try {
        stored = await store(digest, attachmentFileName(file.name, file.type, merged), bytes);
      } catch (error) {
        // The code only: the message would carry the path, and with it the name.
        this.#ports.log.error(`A ${origin === "paste" ? "pasted" : "dropped"} attachment could not be stored (${(error as { code?: string }).code ?? "error"}).`);
        refused.add("a file that could not be stored");
        continue;
      }
      merged.push(stored);
      added += 1;
      const kind = /^[\w.+-]+\/[\w.+-]+$/.test(file.type) ? file.type : "unknown type";
      this.#ports.log.info(`Attachment added by ${origin} (${kind}, ${Math.max(1, Math.round(bytes.length / 1024))} KB); ${merged.length} attached.`);
    }
    if (refused.size > 0) {
      this.#ports.ui.notify(added === 0 && refused.size === 1 && refused.has("a file that is already attached") ? "info" : "warning", `Not attached: ${[...refused].join("; ")}.`);
    }
    // Kept, but not added to a draft that a reset replaced meanwhile (§37.103).
    if (added === 0 || epoch !== this.#sessionEpoch) return;
    this.#attachmentPickToken += 1;
    this.#attachmentPick = { token: this.#attachmentPickToken, attachments: merged };
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
    await this.#readArtifacts(false);
  }

  /**
   * Re-read the shown work item from disk and re-render: the listing, the
   * small files the rows are built from, and so Review with AI's eligibility
   * (the fix report's content identity). Read-only — nothing is written,
   * prepared, searched or run — so a write it notices cannot start another.
   *
   * The one path every refresh takes: the Refresh command (`tolerant` false),
   * and — through `requestArtifactRefresh`, debounced — the artifact watcher,
   * the panel being shown again, and an operation ending with an event still
   * pending (`tolerant` true, so a file caught mid-write keeps the last known
   * state and is read again once rather than shown as missing or unreadable).
   */
  async refreshActiveWorkItem(options: { readonly tolerant?: boolean } = {}): Promise<boolean> {
    const complete = await this.#readArtifacts(options.tolerant ?? false);
    this.#ports.ui.refreshViews();
    return complete;
  }

  /**
   * Ask for a refresh of the shown work item, soon: events closer together
   * than `ARTIFACT_REFRESH_DEBOUNCE_MS` are one refresh. Nothing to refresh,
   * or disposed: nothing is scheduled.
   */
  requestArtifactRefresh(reason: string): void {
    if (this.#disposed || !this.#workItemId || !this.#root) return;
    if (this.#artifactRefreshTimer !== undefined) return;
    this.#ports.log.info(`Artifact refresh scheduled (${reason}).`);
    this.#artifactRefreshTimer = this.#schedule(() => {
      this.#artifactRefreshTimer = undefined;
      void this.#runScheduledRefresh(false);
    }, ARTIFACT_REFRESH_DEBOUNCE_MS);
  }

  /**
   * The scheduled refresh. Held back — and remembered — while a run, a
   * handoff, a new attempt or an artifact write is in flight: each of those
   * reads the folder itself when it ends, and a listing read under a run would
   * offer files the run is replacing. A read that was incomplete is tried once
   * more, then shown as it is.
   */
  async #runScheduledRefresh(retry: boolean): Promise<void> {
    if (this.#disposed) return;
    if (this.#running || this.#runPending || this.#handoffBusy || this.#mutation !== undefined) {
      this.#artifactRefreshPending = true;
      this.#ports.log.info("Artifact refresh deferred until the operation in flight ends.");
      return;
    }
    const workItemId = this.#workItemId;
    let complete: boolean;
    try {
      complete = await this.refreshActiveWorkItem({ tolerant: !retry });
    } catch (error) {
      // A refresh is a safety net: a failure is logged, never shown as fatal.
      this.#ports.log.error(`Artifact refresh failed: ${(error as Error).message}`);
      complete = false;
    }
    if (!complete && !retry && !this.#disposed && workItemId === this.#workItemId) {
      this.#ports.log.info("Artifact refresh was incomplete (a file may be mid-write); trying once more.");
      this.#artifactRefreshTimer ??= this.#schedule(() => {
        this.#artifactRefreshTimer = undefined;
        void this.#runScheduledRefresh(true);
      }, ARTIFACT_REFRESH_RETRY_MS);
      return;
    }
    this.#ports.log.info(`Artifact refresh completed for ${workItemId ?? "no work item"}.`);
  }

  #schedule(callback: () => void, delayMs: number): { cancel(): void } {
    if (this.#ports.schedule) return this.#ports.schedule(callback, delayMs);
    const timer = setTimeout(callback, delayMs);
    // Never what keeps the extension host — or a test run — alive.
    (timer as { unref?: () => void }).unref?.();
    return { cancel: () => clearTimeout(timer) };
  }

  /**
   * Keep the watcher on the shown work item's directory: a new one when the
   * work item or the repository changed, none when nothing is shown. Called
   * with every push, so every path that changes the work item is covered; a
   * push that changes neither costs one comparison.
   */
  #syncArtifactWatch(): void {
    if (this.#disposed) return;
    const workItemId = this.#workItemId;
    const directory = workItemId && this.#root ? path.join(this.#root, ".ai", workItemId) : undefined;
    const same = directory === this.#artifactWatch?.directory;
    if (same && !this.#artifactWatchStale) return;
    // The same directory, possibly being deleted and written again: rebuilt
    // once the run or the clean has ended, not while it is under way.
    if (same && (this.#running || this.#runPending || this.#mutation === "clean")) return;
    this.#artifactWatchStale = false;
    if (this.#artifactWatch !== undefined) {
      this.#artifactWatch.handle.dispose();
      this.#ports.log.info("Artifact watcher disposed.");
    }
    this.#artifactWatch = undefined;
    // A refresh scheduled for the last work item is not this one's.
    this.#artifactRefreshTimer?.cancel();
    this.#artifactRefreshTimer = undefined;
    this.#artifactRefreshPending = false;
    const watch = this.#ports.watchArtifacts;
    if (directory === undefined || workItemId === undefined || !watch) return;
    const handle = watch(directory, (name) => {
      // An event from a watcher already replaced is about another work item.
      if (this.#artifactWatch?.handle !== handle || this.#workItemId !== workItemId) return;
      this.requestArtifactRefresh(`${name} changed`);
    });
    this.#artifactWatch = { directory, handle };
    this.#ports.log.info(`Artifact watcher started for .ai/${workItemId}/.`);
  }

  /** Stop watching and forget any scheduled refresh: the extension is going away. */
  dispose(): void {
    this.#disposed = true;
    // A save not yet started is not started now: a CLI spawned while the
    // extension host is going away may be killed half-way.
    this.#verificationSaveTimer?.cancel();
    this.#verificationSaveTimer = undefined;
    this.#artifactRefreshTimer?.cancel();
    this.#artifactRefreshTimer = undefined;
    this.#artifactWatch?.handle.dispose();
    this.#artifactWatch = undefined;
    this.#clearSessionFeedback();
  }

  /**
   * The read itself. `tolerant`: a failure to read something that was known a
   * moment ago keeps what was known, and says so by returning false. Without
   * it, a failure is shown as it is.
   */
  async #readArtifacts(tolerant: boolean): Promise<boolean> {
    const workItemId = this.#workItemId;
    if (!workItemId || !this.#root) return true;
    // The same work item again after a reset is still another session's read.
    const epoch = this.#sessionEpoch;
    const known = this.#artifacts.kind === "ready" && this.#artifactsListedFor === workItemId;
    // Shown while the directory is being read: on a large repository over a
    // network share this is not instant, and an empty list in the meantime
    // reads as "this run produced nothing". Not over a listing already shown,
    // which a background refresh would only make flicker.
    if (!known) {
      this.#artifacts = { kind: "loading" };
      this.#push();
    }
    const listing = await this.#ports.files.listDirectory(
      path.join(this.#root, ".ai", workItemId),
    );
    // Another work item was shown while the directory was read, or the session
    // was reset.
    if (this.#workItemId !== workItemId || epoch !== this.#sessionEpoch) return true;
    if (listing.kind === "unreadable") {
      if (tolerant && known) {
        this.#ports.log.info(`.ai/${workItemId}/ could not be read just now (${listing.detail}); kept what was shown.`);
        return false;
      }
      this.#artifactNames = [];
      this.#forgetSummary();
      this.#artifacts = {
        kind: "error",
        detail: `.ai/${workItemId}/ could not be read: ${listing.detail}`,
      };
      this.#push();
      return true;
    }
    const names = listing.kind === "ok" ? listing.names : [];
    this.#artifactNames = names;
    this.#artifacts = buildArtifactList({ names });
    this.#artifactsListedFor = workItemId;
    // Nor is a review handoff, while the report is still there. Without one,
    // a handoff in flight is about a report that is gone — and so is an
    // outcome, which must not reappear with the next report.
    if (!names.includes(FIX_REPORT_ARTIFACT)) {
      this.#forgetReview();
      // A recording is about the report on screen; without one it is stale.
      this.#forgetCapture();
    }
    const fixBefore = this.#fixReportIdentity;
    const complete = await this.#readSummary(workItemId, names, tolerant, epoch);
    if (complete === undefined) return true;
    // The report may have been rewritten since the checklist was read — a new
    // fix, by content. The same report read again keeps it. A copy in flight is
    // not affected: the prompt depends on the work item alone.
    if (this.#fixReportIdentity !== fixBefore) {
      this.#forgetValidation();
      // Said only for a change seen after a listing was shown — not for the
      // first read of a work item just opened.
      if (known) this.#ports.log.info(
        this.#fixReportIdentity === undefined
          ? `fix_report.md for ${workItemId} is gone.`
          : `fix_report.md for ${workItemId} is a new fix, by content.`,
      );
    }
    // Pushed here rather than only by the callers: `refreshArtifacts` is also a
    // command of its own, and without this the panel keeps showing "loading".
    this.#push();
    return complete;
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
      this.#ports.log.error(`Refusing to open a work item whose id is not one ${rejectedValueForLog(workItemId)}.`);
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
    if (this.#reset !== undefined) {
      this.#ports.ui.notify("warning", "Wait for the session reset to finish before opening a work item.");
      return;
    }
    // A reset during any wait below means the developer left this session, and
    // what was being opened with it (§37.103).
    const epoch = this.#sessionEpoch;
    // Unsaved verification changes are saved first — or, if they cannot be,
    // lost only after the developer says so (§37.83).
    if (this.#hasUnsavedVerification() && !(await this.#settleVerificationDraft("Open the other work item"))) return;
    if (epoch !== this.#sessionEpoch || this.#reset !== undefined) return;
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
    if (epoch !== this.#sessionEpoch) return;
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
    this.#preparedInstructions = this.#instructionsFingerprint();
    // The tree too: Results' Current group follows the shown work item, and
    // without this it kept whatever it last read — "Scanning .ai/ …" if that
    // was mid-load (§37.82, seen in a real window).
    await this.refreshActiveWorkItem();
    this.#push();
  }

  /**
   * Read the Fix Mode catalog, and keep the developer's choice if it survived.
   *
   * Only when the CLI is usable: asking a blocked environment for a mode list
   * spawns a process that is already known to fail, and the answer would be an
   * error card the blocked card already showed.
   */
  /**
   * Read the repository's profile and put it on the form (pre-release Batch 1).
   *
   * The file is the setting and the form a copy, so the file wins: a profile a
   * teammate committed, or one edited by hand, is what the settings page shows
   * after the next environment check. The form is replaced only when the two
   * differ — replacing it rewrites every field on the page.
   *
   * A CLI too old to have the command is too old for this extension: its runs
   * would ignore the profile, and its Run rejects this extension's flags. That
   * blocks here, before a Run, with the update actions.
   */
  async #loadRepositoryProfile(): Promise<void> {
    this.#savedProfile = undefined;
    if (this.#readiness.kind !== "ready" || !this.#ports.repositoryProfile) return;
    this.#applyProfileOutcome(await this.#ports.repositoryProfile.load());
  }

  /** What a read or a save of the profile came back with, applied. False when it was not read. */
  #applyProfileOutcome(outcome: RepositoryProfileOutcome): boolean {
    if (outcome.kind === "outdated") {
      this.#savedProfile = undefined;
      this.#blockOutdatedCli(outcome.rejected);
      return false;
    }
    if (outcome.kind === "failed") {
      this.#ports.log.error(`Reading the repository profile failed: ${oneSentence(outcome.message)}`);
      return false;
    }
    this.#savedProfile = outcome.snapshot;
    for (const warning of outcome.snapshot.warnings) this.#ports.log.info(`Repository profile: ${warning}`);
    if (!sameRepositoryProfile(this.#form, outcome.snapshot.profile)) {
      this.#replaceForm(formWithRepositoryProfile(this.#form, outcome.snapshot.profile));
    }
    return true;
  }

  /**
   * The CLI turned out to be too old for this extension (pre-release Batch 1, D):
   * the environment card says so, with Update Instructions, Choose Executable
   * and Retry, and the form waits until it is fixed. Retry re-checks, and an
   * old CLI is caught again by reading the profile.
   */
  #blockOutdatedCli(rejected: readonly string[]): void {
    this.#readiness = {
      kind: "blocked",
      summary: CLI_OUTDATED_SUMMARY,
      action: `${CLI_OUTDATED_ACTION} ${outdatedCliDetail(rejected)}`,
      actions: outdatedCliActions(),
    };
    this.#offered = new Set(this.#readiness.actions.map((action) => action.command));
  }

  /**
   * Write the form's Repository Profile to the repository's file, on Apply.
   *
   * The other settings were applied already: a profile that could not be saved
   * is said so, and the form's copy goes back to what the file holds, so the
   * page never shows a profile no run will use.
   */
  async #saveRepositoryProfile(previous: FormState): Promise<void> {
    const port = this.#ports.repositoryProfile;
    const saved = this.#savedProfile;
    const restore = (): void => {
      this.#replaceForm(formWithRepositoryProfile(this.#form, saved?.profile ?? repositoryProfileOfForm(previous)));
    };
    if (!port || this.#readiness.kind !== "ready" || !this.#root) {
      this.#ports.ui.notify(
        "warning",
        "The repository profile was not saved: BugPilot is not ready in this repository. The other settings were applied.",
      );
      restore();
      this.#push();
      return;
    }
    const save = (async () => {
      const outcome = await port.save(repositoryProfileOfForm(this.#form));
      if (this.#applyProfileOutcome(outcome)) return;
      this.#ports.ui.notify(
        "error",
        outcome.kind === "outdated"
          ? `The repository profile was not saved. ${CLI_OUTDATED_SUMMARY}`
          : `The repository profile was not saved: ${outcome.kind === "failed" ? oneSentence(outcome.message) : ""}`,
      );
      restore();
    })();
    this.#profileSave = save;
    try {
      await save;
    } finally {
      if (this.#profileSave === save) this.#profileSave = undefined;
    }
    this.#push();
  }

  /**
   * Read the User and Project Instructions (pre-release Batch 2): their state
   * for the settings rows and their hash for the stale check. A CLI without
   * the command is too old for this extension — its runs would leave the
   * instructions out — and is blocked like one without the profile.
   */
  async #loadInstructions(): Promise<void> {
    if (this.#readiness.kind !== "ready" || !this.#ports.instructions) return;
    this.#applyInstructionsOutcome(await this.#ports.instructions.load());
  }

  /** What a read or a save of the instructions came back with, applied. False when nothing was read. */
  #applyInstructionsOutcome(outcome: InstructionsOutcome): boolean {
    if (outcome.kind === "outdated") {
      this.#instructions = undefined;
      this.#instructionsEditor = undefined;
      this.#blockOutdatedCli(outcome.rejected);
      return false;
    }
    if (outcome.kind === "failed") {
      // The last good read is kept: a failed read says nothing about the files.
      this.#ports.log.error(`Reading the instructions failed: ${oneSentence(outcome.message)}`);
      return false;
    }
    this.#instructions = outcome.snapshot;
    // The state, never the text.
    for (const scope of INSTRUCTION_SCOPES) {
      const problem = outcome.snapshot[scope].problem;
      if (problem) this.#ports.log.info(`${INSTRUCTION_TEXT[scope].title} are not used: ${problem}`);
    }
    return true;
  }

  /**
   * An instruction row's Edit: read the file again — it may have changed since
   * the environment check — and open the editor on what it holds. Nothing is
   * written: an editor opened and closed leaves no file behind.
   */
  async openInstructions(scope: InstructionScope): Promise<void> {
    const port = this.#ports.instructions;
    if (!port || this.#readiness.kind !== "ready") {
      this.#ports.ui.notify("warning", "Instructions can be edited once BugPilot is ready in this repository.");
      return;
    }
    const outcome = await port.load();
    if (!this.#applyInstructionsOutcome(outcome) || this.#instructions === undefined) {
      if (outcome.kind === "failed") {
        this.#ports.ui.notify("error", `${INSTRUCTION_TEXT[scope].title} could not be read: ${oneSentence(outcome.message)}`);
      }
      this.#push();
      return;
    }
    this.#instructionsEditorToken += 1;
    this.#instructionsEditor = {
      scope,
      token: this.#instructionsEditorToken,
      text: this.#instructions[scope].text,
      saving: false,
    };
    this.#push();
  }

  /** Back, Cancel or Escape in the editor: nothing is written. */
  closeInstructions(): void {
    if (this.#instructionsEditor === undefined) return;
    this.#instructionsEditor = undefined;
    this.#push();
  }

  /**
   * The editor's Save: the CLI writes the file — or removes it, for empty text
   * — and reads both back. A prepared context goes stale through its hash, the
   * way any other preparation input does. A refusal keeps the editor open with
   * the reason, and the text as typed.
   */
  async saveInstructions(scope: InstructionScope, text: string): Promise<void> {
    const editor = this.#instructionsEditor;
    if (editor === undefined || editor.scope !== scope || editor.saving) return;
    const title = INSTRUCTION_TEXT[scope].title;
    const fail = (message: string): void => {
      const current = this.#instructionsEditor;
      if (current === undefined || current.token !== editor.token) return;
      this.#instructionsErrorToken += 1;
      this.#instructionsEditor = { ...current, saving: false, error: { token: this.#instructionsErrorToken, message } };
    };
    if (text.length > MAX_INSTRUCTION_CHARS) {
      fail(
        `${title} were not saved: they are ${text.length.toLocaleString("en-US")} characters or more, ` +
          `more than the ${MAX_INSTRUCTION_CHARS.toLocaleString("en-US")} BugPilot includes. Shorten them.`,
      );
      this.#push();
      return;
    }
    const port = this.#ports.instructions;
    if (!port || this.#readiness.kind !== "ready") {
      fail(`${title} were not saved: BugPilot is not ready in this repository.`);
      this.#push();
      return;
    }
    this.#instructionsEditor = { ...editor, saving: true };
    this.#push();
    const outcome = await port.save(scope, text);
    if (outcome.kind === "loaded") {
      this.#instructions = outcome.snapshot;
      // Closed only if it is still the editor that saved; a Back pressed
      // meanwhile already closed it.
      if (this.#instructionsEditor?.token === editor.token) this.#instructionsEditor = undefined;
      this.#push();
      return;
    }
    if (outcome.kind === "outdated") {
      this.#applyInstructionsOutcome(outcome);
    } else {
      fail(oneSentence(outcome.message));
    }
    this.#push();
  }

  /**
   * Read the repository's project settings and put them on the form (Batch 3),
   * as the profile is: the file wins, and an old CLI without the command is
   * blocked as out of date before any Run.
   */
  async #loadProjectSettings(): Promise<void> {
    this.#savedProjectSettings = undefined;
    if (this.#readiness.kind !== "ready" || !this.#ports.projectSettings) return;
    this.#applyProjectSettingsOutcome(await this.#ports.projectSettings.load());
  }

  #applyProjectSettingsOutcome(outcome: ProjectSettingsOutcome): boolean {
    if (outcome.kind === "outdated") {
      this.#savedProjectSettings = undefined;
      this.#blockOutdatedCli(outcome.rejected);
      return false;
    }
    if (outcome.kind === "failed") {
      this.#ports.log.error(`Reading the project settings failed: ${oneSentence(outcome.message)}`);
      return false;
    }
    this.#savedProjectSettings = outcome.snapshot;
    for (const warning of outcome.snapshot.warnings) this.#ports.log.info(`Project settings: ${warning}`);
    if (!sameProjectSettings(this.#form, outcome.snapshot.settings)) {
      this.#replaceForm(formWithProjectSettings(this.#form, outcome.snapshot.settings));
    }
    return true;
  }

  /**
   * Write the form's project settings to the repository's file, on Apply. A
   * refusal — a branch template the CLI will not accept, a link — is said in
   * the CLI's words, and the form goes back to the file's settings.
   */
  async #saveProjectSettings(previous: FormState): Promise<void> {
    const port = this.#ports.projectSettings;
    const saved = this.#savedProjectSettings;
    const restore = (): void => {
      this.#replaceForm(formWithProjectSettings(this.#form, saved?.settings ?? projectSettingsOfForm(previous)));
    };
    if (!port || this.#readiness.kind !== "ready" || !this.#root) {
      this.#ports.ui.notify(
        "warning",
        "The project settings were not saved: BugPilot is not ready in this repository. The other settings were applied.",
      );
      restore();
      this.#push();
      return;
    }
    const save = (async () => {
      const outcome = await port.save(projectSettingsOfForm(this.#form));
      if (this.#applyProjectSettingsOutcome(outcome)) return;
      this.#ports.ui.notify(
        "error",
        outcome.kind === "outdated"
          ? `The project settings were not saved. ${CLI_OUTDATED_SUMMARY}`
          : `The project settings were not saved: ${outcome.kind === "failed" ? oneSentence(outcome.message) : ""}`,
      );
      restore();
    })();
    this.#projectSettingsSave = save;
    try {
      await save;
    } finally {
      if (this.#projectSettingsSave === save) this.#projectSettingsSave = undefined;
    }
    this.#push();
  }

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

    // An answer that arrives after a reset is about a hint the fresh session
    // does not have (§37.103): dropped, wherever it was waiting.
    const epoch = this.#sessionEpoch;
    const plan = await resolveHintProvider(form.agent, this.#ports.canRun);
    if (epoch !== this.#sessionEpoch) return;
    if (plan.kind === "unavailable") {
      this.#hintError = plan.reason;
      this.#push();
      return;
    }

    const context = await this.#hintContext(form, epoch);
    if (epoch !== this.#sessionEpoch) return;
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
    // The reset cleared the busy flag itself; a press since may have set it again.
    if (epoch !== this.#sessionEpoch) return;
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
  async #hintContext(form: FormState, epoch: number): Promise<HintContext> {
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
      // Not said on a session reset meanwhile: it is about a hint that is gone.
      if (epoch === this.#sessionEpoch) this.#hintNotice = "Issue details unavailable — improving from hint only.";
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
    // Deleted from its own detail page: the page is closed with it, so the
    // panel returns to the list rather than showing a definition that no
    // longer exists (seen in the real window, §37.115).
    if (this.#editor && this.#editor.id === id && this.#editor.source === scope) this.#editor = undefined;
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
    // A new custom command is a new candidate for Auto-detect and a new status
    // line — asked about only once the picker's lines are on show at all, and
    // in the background: the form's own push does not wait for a probe.
    if (previous.agentCommand !== form.agentCommand && this.#agents.detected) void this.detectAgents();
    const scope = workItemScopeOf(form);
    // `undefined` is a half-typed key: not yet any work item, so not yet a
    // reason to conclude the developer moved to another one.
    if (scope === undefined || scope === this.#fixModeWorkItem) {
      if (changed || JSON.stringify(this.#primaryView()) !== primaryBefore) this.#push();
      return;
    }
    const epoch = this.#sessionEpoch;
    const prepared =
      scope === MANUAL_WORK_ITEM_SCOPE
        ? undefined
        : preparedFixModeFromStatus(await this.#readStatus(scope), this.#fixModes);
    // Reset while the status was read: the key it was read for is gone, and its
    // mode is not the fresh session's (§37.103).
    if (epoch !== this.#sessionEpoch) return;
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
  /**
   * What a finished run said about the Jira credentials (§37.110): turned away
   * (`JIRA_AUTH_FAILED`) sets the Jira row's Authentication failed; a Jira run
   * that got its issue through clears it. Anything else — a run that never
   * asked Jira, a timeout, a missing issue — says nothing about them.
   */
  #noteJiraOutcome(progress: ProgressView, form: FormState): void {
    if (progress.failure?.code === JIRA_AUTH_FAILED) {
      this.#jiraRejected = true;
      return;
    }
    const issueRead = progress.rows.some((row) => row.capability === "issue_details" && row.state === "done");
    if (form.source === "jira" && issueRead) this.#jiraRejected = false;
  }

  #diagnostics(): DiagnosticsView {
    const ready = this.#readiness.kind === "ready" ? this.#readiness : undefined;
    return diagnostics({
      root: this.#root,
      executable: ready?.executable,
      cliVersion: ready?.version,
      extensionVersion: this.#ports.extensionVersion,
      jiraConfigured: this.#jiraConfigured,
      jiraRejected: this.#jiraRejected,
      agent: this.#form.agent,
      resolvedAgent: this.#resolvedAgent,
      workItemId: this.#workItemId,
      source: this.#form.source,
    });
  }

  #itemFile(workItemId: string, name: string): string {
    return path.join(this.#root ?? "", ".ai", workItemId, name);
  }

  #instructionsView(): PanelState["instructions"] {
    const editable = this.#ports.instructions !== undefined && this.#readiness.kind === "ready";
    return {
      user: { status: instructionsStatusLine("user", this.#instructions?.user), editable },
      project: { status: instructionsStatusLine("project", this.#instructions?.project), editable },
    };
  }

  #instructionsEditorView(editor: InstructionsEditorState): NonNullable<PanelState["instructionsEditor"]> {
    const problem = this.#instructions?.[editor.scope].problem;
    return {
      token: editor.token,
      scope: editor.scope,
      title: INSTRUCTION_TEXT[editor.scope].title,
      scopeLine: INSTRUCTION_TEXT[editor.scope].scopeLine,
      empty: INSTRUCTION_TEXT[editor.scope].empty,
      text: editor.text,
      maxCharacters: this.#instructions?.maxCharacters ?? MAX_INSTRUCTION_CHARS,
      ...(problem ? { problem: `The saved file is not used: ${problem} Saving replaces it.` } : {}),
      saving: editor.saving,
      ...(editor.error ? { error: editor.error } : {}),
    };
  }

  /** Drop what the rows report about a work item that is no longer shown. */
  #forgetSummary(): void {
    this.#issue = undefined;
    this.#fixReport = undefined;
    this.#fixReportIdentity = undefined;
    this.#reviewReport = undefined;
    this.#verificationReport = undefined;
    this.#verificationText = undefined;
    this.#forgetPostFix();
    this.#searchCounts = {};
    this.#files = [];
    this.#moreFiles = 0;
    this.#terms = [];
    this.#gitHistory = undefined;
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

  /**
   * Whether Review with AI may start now: a report on screen, this fix never
   * had a review attempt started, none is being started, and nothing else is
   * in flight that a reviewer would read the folder under.
   */
  #offersReview(): boolean {
    return (
      this.#offersPostFix() &&
      !this.#running &&
      this.#mutation === undefined &&
      canStartReview(this.#review, this.#reviewedCurrentFix())
    );
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
    // The fix this attempt is for: the report as read when the button was pressed.
    const fix = this.#fixReportIdentity;
    this.#review = { state: "starting" };
    this.#push();

    // The prompt alone: the current changes are collected only for a review
    // that reads them (below). A terminal or clipboard reviewer looks at the
    // diff itself, and a large repository's `git status` and `git diff` are not
    // worth running for nothing (pre-release Batch 4.1).
    const result = await this.#reviewPackage(workItemId, root);
    if (!this.#reviewStillWanted(epoch)) return;
    if (typeof result === "string") {
      this.#reviewFailed(reviewHandoffError("prompt", result));
      return;
    }
    let resolution: AgentResolution;
    try {
      resolution = await this.#resolveSelectedAgent(result.prompt);
    } catch (error) {
      // Not expected — detection answers rather than throws — but a probe that
      // failed must not leave the button waiting for ever.
      if (!this.#reviewStillWanted(epoch)) return;
      this.#reviewFailed(reviewHandoffError("agent", oneSentence((error as Error).message)));
      return;
    }
    if (!this.#reviewStillWanted(epoch)) return;
    // The shared prompt gate (`isPlainPrompt`, applied before any probe): had,
    // but not handed over.
    if (resolution.kind === "refused") {
      this.#reviewFailed(reviewHandoffError("command-line", resolution.reason));
      return;
    }
    if (resolution.kind === "unavailable") {
      this.#resolvedAgent = { kind: "unavailable" };
      this.#reviewFailed(reviewHandoffError("agent", resolution.reason));
      return;
    }
    const captured = capturedReviewOf(resolution, this.#ports.runCapturedReview !== undefined);
    if (captured) {
      // The captured reviewer has no shell (`CLAUDE_CAPTURED_REVIEW`), so the
      // changes it reviews are the ones BugPilot collects, on stdin after the
      // prompt — asked for now that it is known to be this reviewer, with the
      // prompt they go with. Without them there is nothing to review: said,
      // not guessed at.
      const withChanges = await this.#reviewPackage(workItemId, root, { includeChanges: true });
      if (!this.#reviewStillWanted(epoch)) return;
      if (typeof withChanges === "string") {
        this.#reviewFailed(reviewHandoffError("prompt", withChanges));
        return;
      }
      if (withChanges.changes === undefined) {
        this.#reviewFailed(reviewHandoffError("prompt", "bugpilot did not return the current changes for the review."));
        return;
      }
      this.#resolvedAgent = { kind: "resolved", label: captured.label };
      this.#agents.succeeded(resolution.adapter.id);
      // Held so Reset Session, having cancelled it, can wait for it to end.
      const task = this.#runCapturedReview(
        workItemId,
        root,
        epoch,
        fix,
        captured,
        `${withChanges.prompt}\n${withChanges.changes}`,
      );
      this.#reviewTask = task;
      try {
        await task;
      } finally {
        if (this.#reviewTask === task) this.#reviewTask = undefined;
      }
      return;
    }

    const wanted = () => this.#reviewStillWanted(epoch);
    let handed;
    try {
      handed = await resolution.adapter.run(
        { workspacePath: root, workItemId, prompt: result.prompt, purpose: "review" },
        this.#agentLaunch(wanted, (commandLine) => {
          // The agent, never the command line or the review prompt (§37.95).
          this.#ports.log.info(`Handing the review of ${workItemId} to ${resolution.adapter.label} in a terminal.`);
          this.#ports.ui.runInTerminal(`Review with AI · ${workItemId}`, root, commandLine);
        }),
      );
    } catch (error) {
      if (!wanted()) return;
      this.#reviewFailed(reviewHandoffError("terminal", oneSentence((error as Error).message)));
      return;
    }
    if (!wanted()) return;
    if (handed.kind === "failed") {
      this.#resolvedAgent = { kind: "unavailable" };
      this.#reviewFailed(reviewHandoffError("agent", handed.reason));
      return;
    }
    this.#resolvedAgent = { kind: "resolved", label: handed.label };
    this.#agents.succeeded(resolution.adapter.id);
    // Started: this fix has had its attempt, whatever the agent does next.
    this.#markReviewed(workItemId, fix);
    this.#review =
      handed.kind === "terminal"
        ? { state: "started", agent: handed.label }
        : { state: "started", agent: handed.label, detail: handed.message };
    this.#push();
  }

  /**
   * A captured one-shot review: the agent run once with the prompt on stdin,
   * in the repository root, its stdout read when it exits (`reviewRun.ts`).
   *
   * While it runs it is an operation like a recording — `#mutation` is
   * `aiReview` — so no run, Rebuild Context, handoff, new attempt, Clean or
   * recording starts under it. It is `starting` until the operating system has
   * started the child (the `spawn` event), then `reviewing` with the time it
   * started, and only then is the fix marked as having had its attempt: a
   * command that never started is not an attempt, and the button stays.
   *
   * What comes back becomes a draft only if the process finished and the
   * parser read the four sections; nothing is ever saved from here. A Cancel
   * Review (`cancelReview`) ends the process tree, discards whatever it had
   * printed, and takes the mark back: the developer abandoned that attempt.
   */
  async #runCapturedReview(
    workItemId: string,
    root: string,
    epoch: number,
    fix: string | undefined,
    plan: { readonly label: string; readonly command: string; readonly invocation: CapturedReviewInvocation },
    prompt: string,
  ): Promise<void> {
    const port = this.#ports.runCapturedReview;
    if (!port || fix === undefined) {
      this.#reviewFailed(reviewHandoffError("agent", "This host cannot run a captured review."));
      return;
    }
    // Asked again here: a recording may have started while the prompt was prepared.
    if (this.#running || this.#mutation !== undefined) {
      this.#reviewFailed(reviewHandoffError("busy", this.#busyReason()));
      return;
    }
    const previous = this.#reviewedFix(workItemId);
    const abort = new AbortController();
    const attempt = { abort, cancelled: false, started: false };
    this.#reviewRun = attempt;
    this.#mutation = "aiReview";
    this.#push();
    this.#ports.log.info(`Captured review of ${workItemId} starting with ${plan.label}, one-shot, in ${root}.`);
    let run: CapturedRun;
    try {
      run = await port({
        command: plan.command,
        args: plan.invocation.args,
        cwd: root,
        input: prompt,
        signal: abort.signal,
        onStarted: () => {
          attempt.started = true;
          // Started: this fix has had its attempt, whatever it prints next.
          this.#markReviewed(workItemId, fix);
          this.#ports.log.info(`Captured review process started for ${workItemId}.`);
          if (!this.#reviewStillWanted(epoch) || attempt.cancelled) return;
          this.#review = { state: "reviewing", agent: plan.label, startedAt: this.#ports.now?.() ?? Date.now() };
          this.#push();
        },
      });
    } catch (error) {
      if (this.#reviewRun === attempt) this.#reviewRun = undefined;
      // Never started — the spawn itself failed — so this fix had no attempt.
      if (this.#mutation === "aiReview") this.#mutation = undefined;
      this.#setReviewed(workItemId, previous);
      if (!this.#reviewStillWanted(epoch)) {
        this.#push();
        return;
      }
      this.#reviewFailed(reviewHandoffError("agent", oneSentence((error as Error).message)));
      return;
    }
    if (this.#reviewRun === attempt) this.#reviewRun = undefined;
    if (this.#mutation === "aiReview") this.#mutation = undefined;
    if (attempt.cancelled) {
      // Abandoned by the developer: nothing it printed is kept, no draft, no
      // file, and the fix is offered for review again.
      this.#setReviewed(workItemId, previous);
      this.#ports.log.info(`Captured review of ${workItemId} cancelled by the developer; its output was discarded.`);
      if (this.#reviewStillWanted(epoch)) this.#review = { state: "cancelled", agent: plan.label };
      this.#push();
      return;
    }
    // Another work item, a reopen or the report gone since: the reply is not
    // this screen's. The attempt still happened, and stays marked.
    if (!this.#reviewStillWanted(epoch)) {
      this.#push();
      return;
    }
    const outcome = capturedReviewOutcome(run, plan.invocation);
    if (outcome.ok) {
      this.#ports.log.info(`Captured review of ${workItemId} completed; its result parsed into the four sections.`);
      this.#reviewDraftToken += 1;
      this.#reviewDraft = {
        token: this.#reviewDraftToken,
        entry: outcome.entry,
        ...(outcome.leftOut ? { leftOut: true as const } : {}),
        source: "ai",
      };
      this.#review = { state: "captured", agent: plan.label };
    } else {
      this.#ports.log.info(
        run.aborted
          ? `Captured review of ${workItemId} timed out.`
          : `Captured review of ${workItemId} completed without a usable result: ${outcome.title}`,
      );
      this.#review = {
        state: "captureFailed",
        agent: plan.label,
        title: outcome.title,
        detail: outcome.detail,
        ...(outcome.reply === undefined ? {} : { reply: outcome.reply }),
      };
    }
    this.#push();
  }

  /**
   * Cancel Review: ask, then end the captured review process — the whole tree
   * BugPilot started, through `Runner`'s abort — and discard what it printed.
   * Keep Reviewing, Escape or closing the question leave it running. Only
   * while a captured review is running; one that finished while the question
   * was open is kept as it finished.
   */
  async cancelReview(): Promise<void> {
    const attempt = this.#reviewRun;
    if (attempt === undefined || attempt.cancelled || this.#review?.state !== "reviewing") {
      this.#ports.log.error("Refusing to cancel a review: no captured review is running.");
      return;
    }
    let confirmed = false;
    try {
      confirmed = await this.#ports.ui.confirm(
        "Cancel current AI review? The current review result will be discarded.",
        "Cancel Review",
        "Keep Reviewing",
      );
    } catch {
      confirmed = false;
    }
    if (!confirmed) {
      this.#ports.log.info("Kept reviewing.");
      return;
    }
    if (this.#reviewRun !== attempt || attempt.cancelled) return;
    attempt.cancelled = true;
    this.#ports.log.info("Cancelling the captured review.");
    attempt.abort.abort();
  }

  /** The fix the work item's last review attempt was for, from this session or a persisted one. */
  #reviewedFix(workItemId: string): string | undefined {
    return this.#ports.reviewedFixes?.get(workItemId) ?? this.#reviewedFixes.get(workItemId);
  }

  #markReviewed(workItemId: string, fix: string | undefined): void {
    if (fix !== undefined) this.#setReviewed(workItemId, fix);
  }

  #setReviewed(workItemId: string, fix: string | undefined): void {
    if (fix === undefined) this.#reviewedFixes.delete(workItemId);
    else this.#reviewedFixes.set(workItemId, fix);
    this.#ports.reviewedFixes?.set(workItemId, fix);
  }

  /** Whether the fix report on screen, by content, has already had a review attempt started. */
  #reviewedCurrentFix(): boolean {
    const workItemId = this.#workItemId;
    if (workItemId === undefined || this.#fixReportIdentity === undefined) return false;
    if (!this.#artifactNames.includes(FIX_REPORT_ARTIFACT)) return false;
    return this.#reviewedFix(workItemId) === this.#fixReportIdentity;
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
  #resolveSelectedAgent(prompt: string): Promise<AgentResolution> {
    return this.#agents.resolve({ choice: this.#form.agent, customCommand: this.#form.agentCommand, prompt });
  }

  /** `review-package --json`, read: the package, or why there is none, in one sentence. */
  async #reviewPackage(
    workItemId: string,
    root: string,
    options: { readonly includeChanges?: boolean } = {},
  ): Promise<ReviewPackage | string> {
    try {
      const envelope = await this.#ports.runner.runJson(reviewPackageArgs(workItemId, options), {
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
    this.#reviewDraft = undefined;
    this.#reviewPasteError = undefined;
    this.#verificationCapture = undefined;
    this.#verificationEdit = undefined;
    this.#verificationEditBasis = undefined;
    this.#dropVerificationDraft();
    this.#verificationSavedContent = undefined;
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

  /**
   * Refuse a run, saying why, while an artifact write is in flight — or a reset,
   * from its press on: it holds the artifact-write guard only once what it
   * stopped has ended, and no run starts in between.
   */
  #refuseRunForMutation(): boolean {
    const waiting = this.#reset !== undefined ? "reset" : this.#mutation;
    if (waiting === undefined) return false;
    this.#ports.ui.notify("warning", RUN_WAITS_FOR[waiting]);
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
      this.#reviewCapture = { state: "failed", message: `${REVIEW_NOT_SAVED}: enter at least one section.` };
      this.#push();
      return;
    }
    const port = this.#ports.runReviewCommand;
    if (!port) {
      this.#reviewCapture = { state: "failed", message: `${REVIEW_NOT_SAVED}: this host cannot run record-review.` };
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
            `Replace the review result saved for ${workItemId}? review_report.md will be overwritten.`,
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
        this.#reviewCapture = { state: "failed", message: `${REVIEW_NOT_SAVED}: ${oneSentence(outcome.reason)}` };
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
      // Saved: the draft is the report now, and the form it filled has closed.
      this.#reviewDraft = undefined;
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
   * Read a pasted review into Review Result's four sections, for the form.
   *
   * Only what the developer pasted: BugPilot does not read the reviewer's
   * terminal, and a review having started says nothing about a reply existing.
   * The parse is the canonical-section one (`reviewOutput.ts`) — no verdict,
   * no guessing at another shape. The answer goes to the page once; nothing is
   * written, nothing is recorded, and Start New Attempt's helpers still read
   * only the saved review_report.md. Offered on the same terms as a recording,
   * so a form being saved is never refilled underneath it.
   */
  parseReviewOutput(text: string): void {
    if (!this.#workItemId || !this.#offersRecording()) {
      this.#ports.log.error(
        "Refusing to read review output: no fix report is on screen, a run is in flight, or an artifact write is.",
      );
      return;
    }
    const parsed = parseReviewOutput(text);
    this.#reviewDraftToken += 1;
    const token = this.#reviewDraftToken;
    if (parsed.ok) {
      this.#reviewDraft = { token, entry: parsed.entry, ...(parsed.leftOut ? { leftOut: true as const } : {}) };
      this.#push();
      return;
    }
    // A refusal rides on one push; a draft already held stays as it was.
    this.#reviewPasteError = { token, error: parsed.message };
    this.#push();
    this.#reviewPasteError = undefined;
  }

  /**
   * Cancel on a prefilled form: the draft is gone. Saves nothing and says
   * nothing — the page has already emptied its form — and does not bring
   * Review with AI back: this fix still had its attempt.
   */
  discardReviewDraft(): void {
    this.#reviewDraft = undefined;
    this.#push();
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
            conflict: true,
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
          ...(!envelope.ok && envelope.error.code === "ARTIFACT_EXISTS" ? { conflict: true as const } : {}),
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
    // The form is the saved report now: nothing unsaved, and saving it
    // unchanged would write nothing.
    this.#dropVerificationDraft();
    this.#verificationSavedContent = checks === undefined ? undefined : JSON.stringify(checks);
    this.#push();
    // One push carries it: the page keeps the form from here, and the next push
    // must not open it again or ship every check with each progress event.
    this.#verificationEdit = undefined;
  }

  /**
   * An edit in the verification form (§37.83): the rows as they now stand.
   * Nothing is written here — the host marks the form dirty and saves after
   * `VERIFICATION_AUTOSAVE_MS` without another edit. While a conflict is shown
   * the draft is kept, but not saved until the developer chooses.
   */
  verificationDraftChanged(checks: readonly VerificationCheckEntry[]): void {
    const workItemId = this.#workItemId;
    if (!workItemId || !this.#offersPostFix()) {
      this.#ports.log.error("Refusing a verification draft: no fix report is on screen.");
      return;
    }
    this.#verificationDraftRevision += 1;
    this.#verificationDraft = { workItemId, checks: [...checks], revision: this.#verificationDraftRevision };
    if (this.#verificationAutosave?.state === "conflict") {
      this.#push();
      return;
    }
    this.#verificationAutosave = { state: "dirty" };
    this.#verificationSaveTimer?.cancel();
    this.#verificationSaveTimer = this.#schedule(() => {
      this.#verificationSaveTimer = undefined;
      void this.saveVerificationDraft();
    }, VERIFICATION_AUTOSAVE_MS);
    this.#push();
  }

  /**
   * Save the verification draft now, if there is anything to save: the
   * debounce firing, Retry Save, Done, or a flush before the work item goes.
   * Returns whether nothing unsaved is left.
   *
   * Only a structurally valid draft is written: blank rows (an Add Check not
   * yet used) are left out; no check at all writes nothing — no empty report,
   * and a saved one is kept rather than deleted; a check that cannot be
   * recorded as it stands (no name, too long) is said, not written, and the
   * draft stays. A draft identical to what was last saved writes nothing. The
   * write is `recordVerification`'s — the one path — replacing the report only
   * over the version the form last read or wrote; one changed outside the form
   * is a conflict, never overwritten.
   */
  async saveVerificationDraft(): Promise<boolean> {
    this.#verificationSaveTimer?.cancel();
    this.#verificationSaveTimer = undefined;
    const draft = this.#verificationDraft;
    if (draft === undefined || draft.revision === this.#verificationSavedRevision) return true;
    if (draft.workItemId !== this.#workItemId) return false;
    if (this.#verificationAutosave?.state === "conflict") return false;
    if (!this.#offersRecording()) {
      // A run or another write in flight: tried again once it ends.
      this.#verificationSavePending = true;
      return false;
    }
    const listed = this.#artifactNames.includes(VERIFICATION_REPORT_ARTIFACT);
    const checks = draft.checks.filter((check) => !isBlankCheck(check));
    if (checks.length === 0) {
      this.#verificationAutosave = {
        state: "incomplete",
        message: listed
          ? "No checks in the form: the saved evidence is kept until at least one check is entered."
          : "Nothing to save yet: enter a check.",
      };
      this.#push();
      return false;
    }
    const problem = verificationProblem(checks);
    if (problem !== undefined) {
      this.#verificationAutosave = { state: "incomplete", message: `Not saved yet: ${problem}` };
      this.#push();
      return false;
    }
    const content = JSON.stringify(checks);
    if (content === this.#verificationSavedContent && listed) {
      this.#verificationSavedRevision = draft.revision;
      this.#verificationAutosave = { state: "saved" };
      this.#push();
      return true;
    }
    // Replace only over a version this form read or wrote; with none, a first
    // save that the CLI refuses if a report appeared meanwhile.
    const basis = listed ? this.#verificationEditBasis : undefined;
    this.#verificationAutosave = { state: "saving" };
    this.#push();
    await this.recordVerification(checks, basis !== undefined, basis?.token);
    if (this.#workItemId !== draft.workItemId) return false;
    const capture = this.#verificationCapture;
    if (capture?.state === "recorded") {
      this.#verificationSavedRevision = draft.revision;
      this.#verificationSavedContent = content;
      // The next save replaces what was just written: its text is the version.
      this.#verificationEditToken += 1;
      this.#verificationEditBasis = { token: this.#verificationEditToken, text: this.#verificationText };
      this.#ports.log.info(`Verification evidence for ${draft.workItemId} auto-saved.`);
      // Edited again while it was being written: those changes are still unsaved.
      if (this.#verificationDraft !== undefined && this.#verificationDraft.revision !== draft.revision) {
        this.verificationDraftChanged(this.#verificationDraft.checks);
        return false;
      }
      this.#verificationAutosave = { state: "saved" };
      this.#push();
      return true;
    }
    if (capture?.state === "failed" && capture.conflict) {
      this.#verificationAutosave = {
        state: "conflict",
        message:
          "verification_report.md changed outside this form, so your changes were not saved over it. " +
          "Reload Saved Version to see it, or Overwrite Saved Version to keep yours.",
      };
      this.#ports.log.info(`Verification auto-save for ${draft.workItemId} stopped: the report changed outside the form.`);
    } else {
      this.#verificationAutosave = {
        state: "error",
        message: capture?.state === "failed" ? capture.message : `${VERIFICATION_NOT_RECORDED}.`,
      };
    }
    this.#push();
    return false;
  }

  /**
   * Overwrite Saved Version, after a conflict: the developer chose the form's
   * checks over the report on disk. The version to replace is the one there
   * now, read at the press; then the draft is saved as usual.
   */
  async overwriteVerification(): Promise<void> {
    const workItemId = this.#workItemId;
    if (!workItemId || this.#verificationAutosave?.state !== "conflict" || this.#verificationDraft === undefined) {
      this.#ports.log.error("Refusing to overwrite verification evidence: there is no conflict to resolve.");
      return;
    }
    const current = await this.#ports.files.readFile(this.#itemFile(workItemId, VERIFICATION_REPORT_ARTIFACT));
    if (this.#workItemId !== workItemId) return;
    this.#verificationEditToken += 1;
    this.#verificationEditBasis = { token: this.#verificationEditToken, text: current };
    this.#verificationSavedContent = undefined;
    this.#verificationAutosave = { state: "dirty" };
    this.#ports.log.info(`Overwriting verification evidence for ${workItemId} at the developer's choice.`);
    await this.saveVerificationDraft();
  }

  /**
   * Before the work item on screen goes — another opened, a run — save the
   * verification draft if it has unsaved changes; if they cannot be saved, ask
   * before they are lost. Returns whether to go on.
   */
  async #settleVerificationDraft(goingTo: string): Promise<boolean> {
    const draft = this.#verificationDraft;
    if (draft === undefined || !this.#hasUnsavedVerification()) return true;
    if (await this.saveVerificationDraft()) return true;
    let proceed = false;
    try {
      proceed = await this.#ports.ui.confirm(
        `Verification evidence for ${draft.workItemId} has changes that could not be saved. ${goingTo} anyway? They will be lost.`,
        goingTo,
        "Keep Editing",
      );
    } catch {
      proceed = false;
    }
    if (proceed) this.#ports.log.info(`Unsaved verification changes for ${draft.workItemId} were discarded.`);
    return proceed;
  }

  /** Whether the verification form holds typed changes that are not saved. */
  #hasUnsavedVerification(): boolean {
    const draft = this.#verificationDraft;
    return (
      draft !== undefined &&
      draft.revision !== this.#verificationSavedRevision &&
      !draft.checks.every(isBlankCheck)
    );
  }

  #dropVerificationDraft(): void {
    this.#verificationSaveTimer?.cancel();
    this.#verificationSaveTimer = undefined;
    this.#verificationDraft = undefined;
    this.#verificationSavedRevision = this.#verificationDraftRevision;
    this.#verificationAutosave = undefined;
    this.#verificationSavePending = false;
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
    this.#artifactWatchStale = true;
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

  /**
   * Reset Session (§37.103): put the current session back to a fresh first-use
   * state — the one operation that does, so nothing in the page clears a field
   * and hopes the host follows.
   *
   * In order, each step only once the one before it is done:
   *
   *  1. Refuse, changing nothing, while a write or a handoff that cannot be
   *     stopped is in flight (`#resetBlocker`).
   *  2. Keep: unsaved verification evidence is saved first, as on any switch
   *     away from the work item — or lost only if the developer says so.
   *  3. Stop what BugPilot itself runs for this session — the run (as Stop
   *     does), a captured AI review (as Cancel Review does) — and wait for each
   *     to end, so no event of theirs can land on the fresh session. An agent
   *     already handed the work item runs in a terminal or another extension and
   *     is not BugPilot's to stop; the dialog says so beforehand.
   *  4. Delete, if asked: `.ai/<work item>/` and nothing else, through
   *     `deleteWorkItemArtifacts`. A refusal or a failure resets nothing: the
   *     session is as it was (bar what step 3 stopped), the folder is read again
   *     to show what is left, and the dialog says why. Deletion is never claimed
   *     unless the folder is gone.
   *  5. Reset, in one synchronous step (`#applyReset`): the form to the product
   *     defaults with the AI Agent preference kept, the work item detached — on
   *     disk too, so a restart opens nothing — and every result, error and draft
   *     of the old session dropped. History is not touched; Keep leaves the old
   *     folder, and so its History row, exactly where it was.
   *
   * From the press to the end it is busy like a run, and from step 4 it holds the
   * artifact-write guard, so nothing else starts under it.
   */
  async resetSession(options: ResetSessionOptions): Promise<void> {
    const deleting = options.deleteGeneratedFiles;
    if (this.#reset !== undefined) {
      this.#ports.log.error("Refusing a second Reset Session while one is in progress.");
      return;
    }
    const blocker = this.#resetBlocker();
    if (blocker !== undefined) {
      this.#ports.log.info("Session reset refused: an operation that cannot be stopped is in flight.");
      this.#resetFailed(`Session not reset. ${blocker}`);
      return;
    }
    this.#reset = { deleting };
    this.#push();
    try {
      // Saved first only when the files stay; deleted with them otherwise.
      if (!deleting && this.#hasUnsavedVerification() && !(await this.#settleVerificationDraft("Reset the session"))) {
        this.#ports.log.info("Session reset cancelled: unsaved verification changes were kept.");
        return;
      }
      await this.#stopForReset();
      this.#mutation = "reset";
      this.#push();
      // The work item as it stands now: a hand-written bug's run may have
      // named it while it was being stopped.
      const workItemId = this.#workItemId;
      let deleted: ArtifactDeletion | undefined;
      if (deleting && workItemId !== undefined) {
        deleted = await this.#deleteGeneratedFiles(workItemId);
        if (deleted.kind === "refused" || deleted.kind === "failed") {
          this.#ports.log.error(`Session reset deletion failed: ${deleted.kind === "refused" ? `refused (${deleted.reason})` : deleted.reason}.`);
          this.#resetFailed(deletionProblem(deleted, workItemId));
          // What is on disk now, which may be less than before.
          await this.refreshArtifacts();
          this.#ports.ui.refreshViews();
          return;
        }
      }
      this.#applyReset(workItemId, deleting, deleted);
    } finally {
      if (this.#mutation === "reset") this.#mutation = undefined;
      this.#reset = undefined;
      this.#push();
    }
  }

  /**
   * Why a reset cannot start now — one sentence — or nothing. What BugPilot can
   * stop does not block it: a run, a captured review. What it cannot stop part
   * way does: an artifact write (a recording, a clean, a retry package, a new
   * attempt's feedback), and a handoff being worked out, which may open an
   * agent's terminal at any moment and would then be working on a session the
   * developer has left.
   */
  #resetBlocker(): string | undefined {
    if (this.#mutation !== undefined && this.#mutation !== "aiReview") return BUSY_WITH[this.#mutation];
    if (this.#handoffBusy) return RESET_WAITS_FOR_HANDOFF;
    if (this.#review?.state === "starting" && this.#reviewRun === undefined) return RESET_WAITS_FOR_REVIEW;
    return undefined;
  }

  /** Stop the run and the captured review BugPilot owns, and wait for both to end. */
  async #stopForReset(): Promise<void> {
    const review = this.#reviewRun;
    if (review !== undefined && !review.cancelled) {
      review.cancelled = true;
      this.#ports.log.info("Cancelling the captured review: the session is being reset.");
      review.abort.abort();
    }
    if (this.#abort !== undefined) {
      this.#ports.log.info("Stopping the bugpilot run: the session is being reset.");
      this.#stoppedByUser = true;
      this.#abort.abort();
    }
    // A run still being set up has no process to stop: it finds the reset at its
    // door and does not start. Each task settles; neither throws past here.
    await Promise.all([this.#runTask, this.#reviewTask].map((task) => task?.catch(() => {})));
  }

  /** The work item's generated files, gone — or why not. Never throws. */
  async #deleteGeneratedFiles(workItemId: string): Promise<ArtifactDeletion> {
    const root = this.#root;
    if (root === undefined || this.#readiness.kind !== "ready") return { kind: "failed", reason: "not-ready" };
    if (!this.#ports.deleteWorkItemArtifacts) return { kind: "failed", reason: "unsupported" };
    this.#artifactWatchStale = true;
    try {
      return await this.#ports.deleteWorkItemArtifacts(root, workItemId);
    } catch (error) {
      const code = (error as { code?: unknown } | undefined)?.code;
      return { kind: "failed", reason: typeof code === "string" ? code : "error" };
    }
  }

  /**
   * The reset itself: synchronous, so nothing interleaves with it. Everything
   * that waits elsewhere took `#sessionEpoch` before it waited, and drops what
   * it brings back once this bumps it.
   */
  #applyReset(workItemId: string | undefined, deleting: boolean, deleted: ArtifactDeletion | undefined): void {
    this.#sessionEpoch += 1;
    // The form: the product defaults, Fix Mode at the catalog's own default, the
    // AI Agent preference kept (`FORM_FIELD_SCOPE`). A new revision puts it on
    // the page; `#replaceForm` persists it, so a restart shows the fresh form.
    this.#replaceForm(resetSessionForm(this.#form, selectedFixModeId(this.#fixModes, undefined)));
    this.#fixModeWorkItem = undefined;
    this.#problems = [];
    // The work item: detached here and in the saved state.
    this.#workItemId = undefined;
    this.#ports.saveWorkItem?.(undefined);
    this.#artifacts = { kind: "empty", detail: "No work item selected yet." };
    this.#artifactNames = [];
    this.#artifactsListedFor = undefined;
    this.#progress = { state: "idle", rows: viewFromStatus(undefined).rows, artifacts: [] };
    this.#preparedWith = undefined;
    this.#preparedInstructions = undefined;
    this.#preparedFixMode = undefined;
    this.#stoppedByUser = false;
    // Every result and draft of the old session: the rows' summaries, Fix
    // result's aids and recordings, the handoff's outcome and card, a new
    // attempt's form, the Open AI Session line, an attachment answer, the hint
    // suggestion.
    this.#forgetSummary();
    this.#forgetFix();
    this.#clearSessionFeedback();
    this.#attachmentPick = undefined;
    this.#hintSuggestion = undefined;
    this.#hintError = undefined;
    this.#hintNotice = undefined;
    this.#hintBusy = false;
    // A deleted folder took what the agent was given; the session record with
    // it. Kept, the folder keeps its record too, for a reopen from History.
    if (deleted !== undefined && workItemId !== undefined) this.#sessions.delete(workItemId);
    // Results' Current group follows the work item; History, after a delete,
    // has one row fewer.
    this.#ports.ui.refreshViews();
    const message =
      deleted === undefined
        ? deleting
          ? SESSION_RESET_NOTHING_TO_DELETE
          : SESSION_RESET
        : deleted.kind === "deleted"
          ? SESSION_RESET_DELETED
          : SESSION_RESET_NOTHING_TO_DELETE;
    this.#ports.log.info(deleted?.kind === "deleted" ? "Session reset; generated artifacts deleted." : "Session reset.");
    this.#ports.ui.notify("info", message);
  }

  /** Say, once, why the press reset nothing. */
  #resetFailed(message: string): void {
    this.#resetErrorToken += 1;
    this.#resetError = { token: this.#resetErrorToken, message };
    this.#push();
    this.#resetError = undefined;
  }

  /** Reset Session's dialog, from the state already held here. */
  #sessionResetView(): SessionResetView {
    const workItemId = this.#workItemId;
    const notes: string[] = [];
    if (this.#running || this.#runPending) notes.push(RESET_STOPS_RUN);
    if (this.#reviewRun !== undefined && !this.#reviewRun.cancelled) notes.push(RESET_CANCELS_REVIEW);
    // Handed over and running somewhere BugPilot cannot reach: a terminal this
    // panel opened, another extension's view, or a review terminal.
    const agent =
      workItemId !== undefined &&
      (this.#sessions.has(workItemId) || this.#fix?.status === "success" || this.#review?.state === "started");
    if (agent) notes.push(RESET_LEAVES_AGENT);
    const blocked = this.#reset === undefined ? this.#resetBlocker() : undefined;
    return {
      epoch: this.#sessionEpoch,
      busy: this.#reset !== undefined,
      ...(this.#reset === undefined ? {} : { deleting: this.#reset.deleting }),
      ...(blocked === undefined ? {} : { blocked }),
      notes,
      ...(workItemId === undefined ? {} : { workItemId }),
      ...(this.#resetError === undefined ? {} : { error: this.#resetError }),
    };
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
  async #readSummary(
    workItemId: string,
    names: readonly string[],
    tolerant: boolean,
    epoch: number,
  ): Promise<boolean | undefined> {
    let complete = true;
    // Each file only when listed — the listing decides whether there is a Fix
    // result row, and a listed report that cannot be read is projected as
    // unreadable — and all of them before any is projected, so a reset or
    // another work item during a read leaves nothing half-written (§37.103):
    // that is `undefined`.
    const read = (name: string) => this.#ports.files.readFile(this.#itemFile(workItemId, name));
    const issueText = names.includes(ISSUE_ARTIFACT) ? await read(ISSUE_ARTIFACT) : undefined;
    const fixText = names.includes(FIX_REPORT_ARTIFACT) ? await read(FIX_REPORT_ARTIFACT) : undefined;
    const reviewText = names.includes(REVIEW_REPORT_ARTIFACT) ? await read(REVIEW_REPORT_ARTIFACT) : undefined;
    const verificationText = names.includes(VERIFICATION_REPORT_ARTIFACT)
      ? await read(VERIFICATION_REPORT_ARTIFACT)
      : undefined;
    const text = names.includes(RETRIEVAL_ARTIFACT) ? await read(RETRIEVAL_ARTIFACT) : undefined;
    if (this.#workItemId !== workItemId || epoch !== this.#sessionEpoch) return undefined;

    this.#issue = parseIssue(issueText);
    // Listed but not read, while a readable report was known: in a tolerant
    // read that is a file caught mid-write, not an unreadable one — and above
    // all not a new fix. Keep the last reading; the caller reads once more.
    const keepFix =
      tolerant &&
      names.includes(FIX_REPORT_ARTIFACT) &&
      fixText === undefined &&
      this.#fixReport?.readable === true &&
      this.#fixReportIdentity !== undefined;
    if (keepFix) complete = false;
    this.#fixReport = keepFix ? this.#fixReport : names.includes(FIX_REPORT_ARTIFACT) ? parseFixReport(fixText) : undefined;
    const identity = keepFix
      ? this.#fixReportIdentity
      : names.includes(FIX_REPORT_ARTIFACT)
        ? fixReportIdentity(fixText)
        : undefined;
    // A different fix on screen — a new attempt's report — is a fix no attempt
    // this session saw was for: what the last one did is no longer this row's
    // to say. One still running keeps going; its reply is still a draft.
    if (identity !== this.#fixReportIdentity && this.#review !== undefined) {
      const inFlight = this.#review.state === "starting" || this.#review.state === "reviewing";
      if (!inFlight) this.#forgetReview();
    }
    this.#fixReportIdentity = identity;
    // The same rule for the recorded review: listed, a Review Result; listed but
    // unreadable, one with "Preview unavailable".
    const keepReview =
      tolerant && names.includes(REVIEW_REPORT_ARTIFACT) && reviewText === undefined && this.#reviewReport?.readable === true;
    if (keepReview) complete = false;
    else {
      this.#reviewReport = names.includes(REVIEW_REPORT_ARTIFACT) ? parseReviewReport(reviewText) : undefined;
    }
    // And for recorded evidence: listed, a Verification Evidence section.
    const keepVerification =
      tolerant &&
      names.includes(VERIFICATION_REPORT_ARTIFACT) &&
      verificationText === undefined &&
      this.#verificationReport?.readable === true;
    if (keepVerification) complete = false;
    else {
      this.#verificationText = verificationText;
      this.#verificationReport = names.includes(VERIFICATION_REPORT_ARTIFACT)
        ? parseVerificationReport(this.#verificationText)
        : undefined;
    }
    const retrieval = parseRetrieval(text);
    this.#searchCounts = contextCounts(retrieval);
    this.#terms = retrievalTerms(retrieval);
    this.#gitHistory = gitHistoryOf(retrieval);
    const found = relevantFiles(retrieval);
    this.#files = found.slice(0, MAX_LISTED_FILES);
    this.#moreFiles = Math.max(0, found.length - this.#files.length);
    return complete;
  }

  /**
   * Open one file from the Relevant Files list.
   *
   * The path came out of `retrieval.json` and went through a webview, which
   * is the part that matters: by the time it arrives here it is untrusted input
   * that happens to look like something BugPilot wrote. So it goes through
   * `#repositoryFile`, and a path that lands outside is refused and logged
   * rather than opened. Code Search's files are this run's search results, so
   * nothing else is asked before the editor opens one.
   */
  async openRelevantFile(relativePath: string): Promise<void> {
    const target = this.#repositoryFile(relativePath);
    if (target !== undefined) await this.#ports.ui.openFile(target);
  }

  /**
   * Open one file from Git history's Supporting files — if it is still there.
   *
   * A supporting file is historical evidence: it was a file in the checkout
   * when the run recorded it, and it stays listed, because that is still true
   * of the run. The checkout may have moved on since, so this open asks first:
   * the same path checks as a Relevant file, then the editor's own stat (the
   * one the `.gitignore` fix uses). Only a regular file is opened. A missing
   * one, a directory, a symbolic link (which could lead anywhere) or a stat
   * that cannot answer is not, and the developer is told which; the record,
   * the context and the panel's list are left exactly as they are.
   *
   * Without the stat port — a host that has none — it is the plain checked
   * open, as it was before.
   */
  async openSupportingFile(relativePath: string): Promise<void> {
    const target = this.#repositoryFile(relativePath);
    if (target === undefined) return;
    const stat = this.#ports.gitignore?.stat;
    if (stat === undefined) {
      await this.#ports.ui.openFile(target);
      return;
    }
    let entry: GitignoreEntry;
    try {
      entry = await stat(target);
    } catch (error) {
      this.#ports.log.error(`Could not check a supporting file: ${(error as Error)?.message || String(error)}`);
      this.#ports.ui.notify("warning", SUPPORTING_FILE_UNCHECKED);
      return;
    }
    if (entry === "file") {
      await this.#ports.ui.openFile(target);
      return;
    }
    this.#ports.log.info(`Not opening a supporting file: ${entry === "missing" ? "no longer in the checkout" : `not a regular file (${entry})`}.`);
    this.#ports.ui.notify("warning", entry === "missing" ? SUPPORTING_FILE_MISSING : SUPPORTING_FILE_NOT_A_FILE);
  }

  /**
   * A repository-relative path from the page, as a path inside the repository.
   *
   * The path came out of `retrieval.json` and went through a webview, so it is
   * untrusted input by the time it arrives: the same `isSafeRelativePath` the
   * page and the message parser use, then resolved and checked with the
   * `isWithin` the focus-file and ignore-path validation uses. Anything else is
   * refused and logged.
   */
  #repositoryFile(relativePath: string): string | undefined {
    const root = this.#root;
    if (!root) return undefined;
    if (!isSafeRelativePath(relativePath)) {
      this.#ports.log.error(`Refusing to open a suspicious file path: ${relativePath}`);
      return undefined;
    }
    const target = path.resolve(root, relativePath);
    if (!isWithin(root, target)) {
      // Belt and braces: `isSafeRelativePath` already rejects `..` and absolute
      // forms, and this catches whatever a symlink or an odd separator turned
      // them into after resolution.
      this.#ports.log.error(`Refusing to open a file outside the repository: ${relativePath}`);
      return undefined;
    }
    return target;
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
    if (this.#preparedWith !== undefined && preparationFingerprint(form) !== this.#preparedWith) return true;
    // The instructions are files, not form fields: compared by content hash,
    // never by file time, and only when both sides are known (pre-release Batch 2).
    const instructions = this.#instructionsFingerprint();
    return this.#preparedInstructions !== undefined && instructions !== undefined && instructions !== this.#preparedInstructions;
  }

  #instructionsFingerprint(): string | undefined {
    return this.#instructions === undefined ? undefined : instructionsFingerprint(this.#instructions);
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

  /** A run, a handoff, a new attempt, an artifact write or a reset in flight: nothing else may start. */
  #busy(): boolean {
    return this.#running || this.#runPending || this.#handoffBusy || this.#mutation !== undefined || this.#reset !== undefined;
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
    this.#syncArtifactWatch();
    // An artifact changed while something was in flight: now that nothing is,
    // read the folder once more.
    if (
      this.#artifactRefreshPending &&
      !this.#running &&
      !this.#runPending &&
      !this.#handoffBusy &&
      this.#mutation === undefined
    ) {
      this.#artifactRefreshPending = false;
      this.requestArtifactRefresh("an operation ended");
    }
    // A verification save held back by a write in flight: now that none is, try it.
    if (this.#verificationSavePending && !this.#running && this.#mutation === undefined) {
      this.#verificationSavePending = false;
      this.#verificationSaveTimer ??= this.#schedule(() => {
        this.#verificationSaveTimer = undefined;
        void this.saveVerificationDraft();
      }, VERIFICATION_AUTOSAVE_MS);
    }
    // Computed here rather than in the page: the page cannot import the model,
    // and a status the page derived for itself would be a second opinion about
    // what the run did.
    const failed = this.#runFailure();
    const strategy = this.#strategyLine();
    const primary = this.#primaryView();
    // Open AI Session's word lasts only while it is about what is on screen:
    // another work item, or a panel no longer offering the press, drops it.
    if (
      this.#sessionFeedback !== undefined &&
      (this.#sessionFeedback.workItemId !== this.#workItemId || !offeredActions(primary).includes("openSession"))
    ) {
      this.#clearSessionFeedback();
    }
    const session = this.#workItemId === undefined ? undefined : this.#sessions.get(this.#workItemId);
    const workflow = buildWorkflow({
      source: this.#form.source,
      plan: this.#form.plan,
      fixWithAI: this.#form.fixWithAI,
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
      ...(this.#gitHistory === undefined ? {} : { gitHistory: this.#gitHistory }),
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
      ...(this.#reviewPasteError !== undefined
        ? { reviewPrefill: this.#reviewPasteError }
        : this.#reviewDraft === undefined
          ? {}
          : { reviewPrefill: this.#reviewDraft }),
      reviewedCurrentFix: this.#reviewedCurrentFix(),
      canRecordReview: this.#offersRecording(),
      ...(this.#verificationReport === undefined ? {} : { verificationReport: this.#verificationReport }),
      ...(this.#verificationCapture === undefined ? {} : { verificationCapture: this.#verificationCapture }),
      canRecordVerification: this.#offersRecording(),
      ...(this.#verificationEdit === undefined ? {} : { verificationEdit: this.#verificationEdit }),
      ...(this.#verificationAutosave === undefined ? {} : { verificationAutosave: this.#verificationAutosave }),
      ...(session === undefined ? {} : { session: { agent: session.agent, attempts: session.attempts } }),
      ...(this.#attempt === undefined ? {} : { attempt: this.#attempt }),
      ...(this.#attemptDraft === undefined ? {} : { attemptDraft: this.#attemptDraft }),
      feedbackHelpers: this.#feedbackHelpers(primary),
      settingsSummaries: settingsSummaries(this.#form),
    });
    // The run's card goes on the row that failed; only a failure no row owns —
    // before any step started, or from the extension itself — stands alone.
    const owned = failed !== undefined && workflow.some((step) => step.error === failed);
    this.#ports.ui.render({
      revision: this.#revision,
      fixModes: this.#fixModes,
      repositoryProfile: repositoryProfileView(this.#savedProfile),
      instructions: this.#instructionsView(),
      ...(this.#instructionsEditor === undefined ? {} : { instructionsEditor: this.#instructionsEditorView(this.#instructionsEditor) }),
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
      overall: overallStatus(workflow, this.#progress, { stale: this.#stale() }),
      // Work-item level, not Build context's: the directory holds every artifact.
      workItemActions: !this.#running && canOpenFolder(this.#artifactNames) ? ["openFolder"] : [],
      artifacts: this.#artifacts,
      // Classified here, where the code and the operation that produced it are
      // both known. The page receives a rendered card and decides nothing.
      ...(failed === undefined || owned ? {} : { runError: failed }),
      agents: this.#agents.status(this.#form.agentCommand),
      warnings: this.#notices(),
      ...(this.#noticeStatus === undefined ? {} : { noticeStatus: this.#noticeStatus }),
      jira: jiraConnection(this.#jiraConfigured, this.#jiraRejected, this.#report?.["jira_base_url_present"] === false),
      ...(this.#jiraSetup === undefined ? {} : { jiraSetup: { ...this.#jiraSetup } }),
      primary,
      ...(this.#sessionFeedback === undefined
        ? {}
        : {
            sessionFeedback: {
              kind: this.#sessionFeedback.kind,
              message: this.#sessionFeedback.message,
              seq: this.#sessionFeedback.seq,
            },
          }),
      ...(this.#attachmentPick === undefined ? {} : { attachmentPick: this.#attachmentPick }),
      ...(this.#workItemId === undefined ? {} : { workItemId: this.#workItemId }),
      sessionReset: this.#sessionResetView(),
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
